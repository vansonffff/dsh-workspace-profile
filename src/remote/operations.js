/**
 * The business operations behind the `workspaceProfile` Remote namespace.
 *
 * ## One write path
 *
 * Every mutation is a set of **path-addressed edits** over the settings
 * document, fenced by the revision the caller read. Nothing here replaces the
 * section wholesale. That matters for a reader holding a *partial* view: the
 * Settings page sees the whole document today, but the same discipline means a
 * concurrent editor adding a field this build does not know about is never
 * silently deleted by a save that had not heard of it.
 *
 * ## Why writes answer instead of throwing
 *
 * A business failure reaches the browser as a message string — the wire error
 * code is a closed set this plugin cannot extend, so `revision-conflict` cannot
 * ride as a code. Rather than force the page to pattern-match prose, every write
 * returns `{ saved: false, code, message, revision }`. The key is deliberately
 * **not** `ok`: the client API already wraps each call in `{ ok, value }`, and a
 * nested `ok` inside `value` reads as though the call itself failed.
 *
 * Genuine faults — no settings provider, a broken revision read — still throw;
 * they are not user-resolvable outcomes and must not look like one.
 *
 * @module dsh-workspace-profile/remote/operations
 */

import { scopeParentOf } from '@deepseek-ai/dsh-scope';

import { WorkspaceProfileError } from '../errors.js';
import {
  PROFILE_IDS,
  PROFILE_LABELS,
  PERSPECTIVE_LABELS,
  SCHEMA_VERSION,
  SKILL_STATES,
  defaultKeyFor,
  enabledSubagents,
  isValidSubagentKey,
  perspectivesFor,
  recommendedSkills,
  resolveWorkspacePolicy,
  validateProfilePerspective,
} from '../policy.js';
import { createDefinition, updateDefinition } from '../subagent-registry.js';
import { buildSkillCatalog } from '../skill-policy.js';
import { probeInstructions } from '../instructions-probe.js';
import { matchMatter } from '../matter-match.js';
import {
  AGENTS_SECTION_NAME,
  AGENTS_SECTION_ORDER,
  PERSPECTIVE_SECTION_NAME,
  PERSPECTIVE_SECTION_ORDER,
  PROFILE_SECTION_NAME,
  PROFILE_SECTION_ORDER,
  composeAgentDirectorySection,
  composePerspectiveSection,
  composeProfileSection,
} from '../profile-runtime.js';

/**
 * Build the operation set the Remote service delegates to.
 *
 * Every dependency is a thunk: the services behind them arrive and depart with
 * the composition, and capturing them at construction would pin an instance the
 * plugin does not own.
 *
 * @param {object} deps - dependencies.
 * @param {() => any} deps.getStore - the composition store, or `undefined`.
 * @param {() => any} deps.getResolver - the Workspace resolver.
 * @param {() => any} deps.getCatalog - the model catalog.
 * @param {() => any} deps.getSkills - the `skills` service, or `undefined`.
 * @param {() => any} deps.getDispatcher - the unified dispatcher.
 * @param {() => string|undefined} deps.getDshHome - the harness home for the AGENTS probe.
 * @param {() => { profiles: Record<string,string>, perspectives: Record<string,Record<string,string>> }} deps.getProfileTexts
 *   the loaded Profile and Perspective bodies. The preview composes from the
 *   *same* texts the prompt sections read, so the two cannot disagree.
 * @param {() => Record<string, boolean>} deps.capabilities - which seams are mounted.
 * @param {() => string} deps.now - ISO-8601 clock.
 * @param {{ warn: Function }} [deps.logger] - diagnostics sink.
 * @returns {Record<string, Function>} the operations, keyed by Remote method name.
 */
export function createOperations({
  getStore,
  getResolver,
  getMatterResolver,
  getCatalog,
  getSkills,
  getAgents,
  getScopeParent,
  getDispatcher,
  getDshHome,
  getProfileTexts,
  capabilities,
  now,
  logger,
}) {
  /**
   * Read the document, or throw a named error when the store is absent.
   *
   * @returns {{ document: any, revision: number|undefined, error: Error|undefined }} the read.
   */
  const readDocument = () => {
    const store = getStore();
    if (store === undefined) {
      throw new WorkspaceProfileError(
        'missing-capability',
        'the `settings` service is not mounted, so Workspace Composition has nowhere to store its configuration. Mount the settings provider and restart the Host.',
      );
    }
    const read = store.read();
    return { document: read.document, revision: store.revision(), error: read.error };
  };

  /**
   * Build the two document-level path ops every write carries.
   *
   * Stamping the version on the first ordinary save is what makes an
   * absent-version section self-describing without a write nobody asked for.
   *
   * @param {any} document - the document as read.
   * @returns {any[]} the ops.
   */
  const versionOps = (document) => {
    const ops = [];
    if (document.schemaVersion !== SCHEMA_VERSION) ops.push(set(['schemaVersion'], SCHEMA_VERSION));
    if (typeof document.initializedAt !== 'string' || document.initializedAt === '') {
      ops.push(set(['initializedAt'], now()));
    }
    return ops;
  };

  /**
   * Ensure the Workspace's record exists and carries timestamps.
   *
   * @param {any} document - the document as read.
   * @param {string} workspaceId - the Workspace being written.
   * @returns {any[]} the ops.
   */
  const ensurePolicy = (document, workspaceId) => {
    const existing = document.workspaces?.[workspaceId];
    const ops = [];
    if (existing === undefined) {
      ops.push(set(['workspaces', workspaceId, 'createdAt'], now()));
    }
    ops.push(set(['workspaces', workspaceId, 'updatedAt'], now()));
    return ops;
  };

  /**
   * Run a guarded write and answer with the fresh snapshot.
   *
   * @param {object} input - the write request.
   * @param {any[]} input.ops - the path ops.
   * @param {number} input.expectedRevision - the revision the caller read.
   * @returns {Promise<any>} `{ saved: true, revision, snapshot }` or a refusal.
   */
  const write = async ({ ops, expectedRevision }) => {
    const store = getStore();
    if (typeof expectedRevision !== 'number') {
      return {
        saved: false,
        code: 'missing-revision',
        message:
          'this save did not carry the revision it was based on, so it was refused rather than risk overwriting a concurrent change. Reload the page and try again.',
        revision: store?.revision() ?? null,
      };
    }
    try {
      const revision = await store.write(ops, expectedRevision);
      return { saved: true, revision, snapshot: await operations.snapshot() };
    } catch (error) {
      if (error instanceof WorkspaceProfileError) {
        return {
          saved: false,
          code: error.code,
          message: error.message,
          revision: store?.revision() ?? null,
          ...(error.code === 'revision-conflict' ? { snapshot: await operations.snapshot().catch(() => undefined) } : {}),
        };
      }
      throw error;
    }
  };

  /** @type {Record<string, Function>} */
  const operations = {
    /**
     * Everything the Settings page needs, in one round trip.
     *
     * One call rather than five keeps the page's states coherent: a Workspace
     * list, a model catalog and a skill catalog fetched separately can disagree
     * with each other while they land, and the disagreement is visible.
     *
     * @returns {Promise<any>} the snapshot.
     */
    async snapshot() {
      const caps = capabilities();
      const { document, revision, error } = readDocument();
      const resolver = getResolver();
      const live = resolver.list();
      const known = new Set(live.map((workspace) => workspace.id));
      const dshHome = getDshHome();

      const workspaces = [];
      for (const workspace of live) {
        const { policy, configured } = resolveWorkspacePolicy(document, workspace.id, now());
        workspaces.push({
          workspaceId: workspace.id,
          title: workspace.title,
          path: workspace.path,
          sessionCount: workspace.sessionIds.length,
          configured,
          policy: projectPolicy(policy),
          instructions: await probeInstructions({ workspacePath: workspace.path, dshHome }).catch(() => undefined),
        });
      }

      const orphans = Object.entries(document.workspaces ?? {})
        .filter(([workspaceId]) => !known.has(workspaceId))
        .map(([workspaceId, policy]) => ({
          workspaceId,
          policy: projectPolicy(policy),
          /** The title the record was last seen under, when it was stamped. */
          lastKnownTitle: typeof policy?.lastKnownTitle === 'string' ? policy.lastKnownTitle : undefined,
        }));

      return {
        ready: true,
        revision: typeof revision === 'number' ? revision : null,
        schemaVersion: document.schemaVersion,
        initializedAt: document.initializedAt,
        readError: error === undefined ? null : { code: error.code ?? 'read-error', message: error.message },
        capabilities: caps,
        workspaces,
        orphans,
        vocabulary: {
          profiles: PROFILE_IDS.map((id) => ({ id, label: PROFILE_LABELS[id], perspectives: perspectivesFor(id).map((p) => ({ id: p, label: PERSPECTIVE_LABELS[p] ?? p })) })),
          skillStates: SKILL_STATES,
          // Every Perspective id the plugin knows, for label lookup. Derived from
          // the label table rather than from a Profile's vocabulary: the page
          // resolves a *stored* id, which may belong to a Profile the Workspace no
          // longer uses, and an unknown id must still render as its own name
          // rather than as `undefined`.
          perspectives: Object.entries(PERSPECTIVE_LABELS).map(([id, label]) => ({ id, label })),
        },
      };
    },

    /**
     * Skill catalog rows for one Workspace.
     *
     * @param {{ workspaceId?: unknown }} args - the Workspace to inspect.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns {Promise<any>} `{ available, rows, missing, complete, message? }`.
     */
    async skills(args, signal) {
      const workspaceId = String(args?.workspaceId ?? '');
      const skills = getSkills();
      if (skills === undefined) {
        return { available: false, rows: [], missing: [], complete: false, message: 'the `skills` service is not mounted in this deployment' };
      }
      const workspace = getResolver().describe(workspaceId);
      if (workspace === undefined) {
        return { available: false, rows: [], missing: [], complete: false, message: `workspace "${workspaceId}" is not registered` };
      }
      const { document } = readDocument();
      const { policy } = resolveWorkspacePolicy(document, workspaceId, now());
      // Both sources, and never a disabled name: the same list the prompt section
      // renders, from one function, so the page and the model cannot disagree
      // about what this Workspace recommends.
      const recommendations = recommendedSkills(policy);
      const recommended = recommendations.map((entry) => entry.name);
      // The preset layers of whatever agents are live in this Workspace. See
      // `buildSkillCatalog` for why the preset layer and not the agent's own.
      const scopes = presetScopesFor(getAgents(), workspaceId);
      const result = await buildSkillCatalog({ skills, workspace, policy, recommended, scopes, signal });
      return {
        available: true,
        ...result,
        /**
         * Where each recommendation came from, keyed by Skill name.
         *
         * Sent alongside the rows rather than folded into them because
         * `buildSkillCatalog` answers "is this row recommended", which is a fact
         * about one Skill, while the source is a fact about the *configuration*
         * and stays meaningful for a recommended Skill that is not installed
         * (it has no row at all, but the page still lists it under `missing`).
         */
        recommendationSources: Object.fromEntries(recommendations.map((entry) => [entry.name, entry.source])),
        /**
         * How many layers the answer was merged from, and whether any of them was
         * an agent preset's.
         *
         * Reported rather than hidden because it changes what the list *means*. In
         * a Web deployment the local filesystem provider is mounted by an agent
         * preset, so with no live session in this Workspace only the deployment's
         * own Skills are visible — and the page must say that instead of letting
         * "recommended but not installed" read as a fact.
         */
        scoped: scopes.length > 0,
        note:
          scopes.length > 0
            ? null
            : '当前工作区没有正在运行的会话，因此这里只列出了部署级 Skill。项目与用户目录下的 Skill 由会话的 Agent 预设提供，在该工作区打开一个会话后刷新即可看到。',
      };
    },

    /**
     * The literal text this Workspace contributes to the system prompt.
     *
     * ## Why this exists
     *
     * "Is the Profile actually in effect, or is this just a UI?" is a fair
     * question that had an unfair answer before this method existed: the sections
     * are registered against `systemPrompt`, and the only way to see them was to
     * read a session transcript. This composes exactly what those three sections
     * compose, **by calling the same functions**, so the page can show the text
     * instead of asking to be believed.
     *
     * ## Stored, not draft — and the draft is answered separately
     *
     * The runtime injects what is *stored*. The form on the same page edits a
     * draft, so `saved` is composed from the stored policy, and `draft` — when a
     * legal pair is supplied — answers "what would be injected after saving".
     * That pair is validated with {@link validateProfilePerspective} first: a
     * draft the write path would refuse must not be composed, or the page would
     * preview a stance that can never be stored.
     *
     * ## What it deliberately cannot answer
     *
     * The session `/perspective` override is per session and is not readable from
     * a Workspace-scoped read, so `saved` shows the **Workspace default** and the
     * page says so. Nothing here is authoritative for a live prompt that holds an
     * override.
     *
     * @param {{ workspaceId?: unknown, profile?: unknown, perspective?: unknown }} args
     *   the Workspace, and optionally a draft Profile/Perspective pair.
     * @returns {Promise<any>} the composed sections, or why they cannot be shown.
     */
    /**
     * Read the Matter a Workspace's directory sits inside, and compare it against
     * this Workspace's configuration.
     *
     * Read-only by construction: it returns a comparison, and nothing here writes a
     * Profile, a Perspective or a Matter. Applying a recommendation stays a user
     * action in the Settings form — a plugin that silently re-pointed a Workspace
     * because a file on disk changed would be making a professional judgement on
     * the user's behalf.
     *
     * A Workspace whose directory holds no `matter.yaml` is not a failure. It
     * answers `discovered: false`, which is what an ordinary project directory is.
     *
     * @param {any} args - `{ workspaceId }`.
     * @returns {Promise<object>} the Matter facts, the comparison, and any problem.
     */
    async matter(args) {
      const workspaceId = String(args?.workspaceId ?? '');
      const workspace = getResolver().describe(workspaceId);
      if (workspace === undefined) {
        return { available: false, workspaceId, message: `workspace "${workspaceId}" is not registered` };
      }

      const matterResolver = getMatterResolver?.();
      if (matterResolver === undefined) {
        return { available: false, workspaceId, message: 'the Matter resolver is not mounted' };
      }

      // The Workspace path is both the start and the boundary. It is the same
      // directory the Agent walk stops at, so the two reads of one Workspace
      // cannot disagree: without the boundary this walked to the filesystem root,
      // and a Workspace that is an ordinary project directory inside a directory
      // holding a `matter.yaml` was reported here as that Matter while the Agent —
      // correctly bounded — reported none.
      const { facts, problem } = await matterResolver.resolvePath(workspace.path, workspace.path);
      const { document } = readDocument();
      const { policy } = resolveWorkspacePolicy(document, workspaceId, now());

      return {
        available: true,
        workspaceId,
        // `discovered` separates "this directory has no Matter" from "the read
        // failed": both leave `matter` null, and the page must not call the first
        // one an error.
        discovered: facts !== null,
        matter: facts,
        problem,
        match: matchMatter({ matter: { facts, problem }, policy }),
        // Named so the page never has to guess what the stored values were.
        policy: { profile: policy.profile, defaultPerspective: policy.defaultPerspective },
      };
    },

    async previewInjection(args) {
      const workspaceId = String(args?.workspaceId ?? '');
      const workspace = getResolver().describe(workspaceId);
      if (workspace === undefined) {
        return { available: false, workspaceId, message: `workspace "${workspaceId}" is not registered` };
      }

      const { document } = readDocument();
      const texts = getProfileTexts();
      const { policy, configured } = resolveWorkspacePolicy(document, workspaceId, now());

      const saved = summarizeInjection({
        sections: composeInjectionSections({ policy, configured, workspace, texts }),
        gate: configured === true ? 'ok' : policy.onboardingStatus === 'skipped' ? 'skipped' : 'unconfigured',
      });

      let draft = null;
      if (args?.profile !== undefined || args?.perspective !== undefined) {
        const invalid = validateProfilePerspective(args.profile, args.perspective);
        draft = invalid !== null
          ? { requested: true, valid: false, invalidReason: invalid }
          : {
              requested: true,
              valid: true,
              // Saving a Profile is what marks a Workspace configured, so the
              // draft is previewed through the gate a save would leave behind.
              ...summarizeInjection({
                sections: composeInjectionSections({
                  policy: { ...policy, profile: args.profile, defaultPerspective: args.perspective },
                  configured: true,
                  workspace,
                  texts,
                }),
                gate: 'ok',
              }),
            };
      }

      return {
        available: true,
        workspaceId,
        workspaceTitle: workspace.title,
        /**
         * Whether the Profile bodies finished loading.
         *
         * Reported because the sections are composed from files read
         * asynchronously at activation: before that read lands, a configured
         * Workspace legitimately composes almost nothing, and an empty preview
         * would otherwise read as "nothing is configured".
         */
        textsLoaded: Object.keys(texts?.profiles ?? {}).length > 0,
        onboardingStatus: policy.onboardingStatus,
        profile: policy.profile,
        defaultPerspective: policy.defaultPerspective,
        saved,
        draft,
        note:
          '这里显示的是已保存的配置，以及工作区的默认立场。会话内用 `/perspective` 做的临时覆盖不在此列，'
          + '以上方表单的改动在点击保存之前也不会生效。',
      };
    },

    /**
     * The provider / model / reasoning-effort catalog.
     *
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns {Promise<any>} the catalog, or a reason it is unavailable.
     */
    async models(signal) {
      try {
        return { available: true, providers: await getCatalog().catalog(signal) };
      } catch (error) {
        return { available: false, providers: [], message: messageOf(error) };
      }
    },

    /**
     * Non-throwing verdict for one saved route.
     *
     * @param {{ provider?: unknown, model?: unknown, reasoningEffort?: unknown }} args - the route.
     * @param {AbortSignal} [signal] - caller cancellation.
     * @returns {Promise<any>} `{ available, reason? }`.
     */
    async validateRoute(args, signal) {
      return getCatalog().routeStatus(
        { provider: args?.provider, model: args?.model, reasoningEffort: args?.reasoningEffort },
        signal,
      );
    },

    /**
     * Save Profile / Perspective / onboarding state for one Workspace.
     *
     * @param {any} args - `{ workspaceId, expectedRevision, patch }`.
     * @returns {Promise<any>} the write outcome.
     */
    async savePolicy(args) {
      const workspaceId = requireWorkspaceId(args);
      const expectedRevision = args?.expectedRevision;
      const patch = args?.patch ?? {};
      const { document } = readDocument();
      const { policy } = resolveWorkspacePolicy(document, workspaceId, now());

      const nextProfile = 'profile' in patch ? patch.profile : policy.profile;
      const nextPerspective = 'defaultPerspective' in patch ? patch.defaultPerspective : policy.defaultPerspective;

      const problem = validateProfilePerspective(nextProfile, nextPerspective);
      if (problem !== null) {
        return { saved: false, code: 'invalid-policy', message: problem, revision: getStore().revision() ?? null };
      }

      const ops = [...versionOps(document), ...ensurePolicy(document, workspaceId)];
      if ('profile' in patch) ops.push(set(['workspaces', workspaceId, 'profile'], nextProfile));
      if ('defaultPerspective' in patch) {
        ops.push(set(['workspaces', workspaceId, 'defaultPerspective'], nextPerspective));
        // A Profile without Perspectives must not leave a stale stance behind:
        // the pair is validated as a pair, so it is written as a pair.
        if (!perspectivesFor(nextProfile).includes(nextPerspective)) {
          ops.push(set(['workspaces', workspaceId, 'defaultPerspective'], 'none'));
        }
      }
      if ('onboardingStatus' in patch) {
        if (!['unconfigured', 'configured', 'skipped'].includes(patch.onboardingStatus)) {
          return { saved: false, code: 'invalid-policy', message: `unknown onboarding status "${String(patch.onboardingStatus)}"`, revision: getStore().revision() ?? null };
        }
        ops.push(set(['workspaces', workspaceId, 'onboardingStatus'], patch.onboardingStatus));
      }
      // A save that changed only the record's timestamps is still a save: it is
      // how an untouched Workspace is marked configured.
      if (patch.onboardingStatus === undefined && !('profile' in patch) && !('defaultPerspective' in patch)) {
        return { saved: false, code: 'empty-patch', message: 'nothing to save', revision: getStore().revision() ?? null };
      }
      return write({ ops, expectedRevision });
    },

    /**
     * Create or update one Subagent definition.
     *
     * @param {any} args - `{ workspaceId, expectedRevision, subagent }`.
     * @returns {Promise<any>} the write outcome.
     */
    async putSubagent(args) {
      const workspaceId = requireWorkspaceId(args);
      const expectedRevision = args?.expectedRevision;
      const input = args?.subagent ?? {};
      const { document } = readDocument();
      const { policy } = resolveWorkspacePolicy(document, workspaceId, now());
      const existing = policy.subagents ?? {};

      try {
        const definition =
          typeof input.id === 'string' && input.id !== ''
            ? updateDefinition(existing[input.id], input, existing, now())
            : createDefinition(input, existing, now());
        const ops = [
          ...versionOps(document),
          ...ensurePolicy(document, workspaceId),
          set(['workspaces', workspaceId, 'subagents', definition.id], definition),
        ];
        return await write({ ops, expectedRevision });
      } catch (error) {
        if (error instanceof WorkspaceProfileError) {
          return { saved: false, code: error.code, message: error.message, revision: getStore().revision() ?? null };
        }
        throw error;
      }
    },

    /**
     * Duplicate a definition under a new key.
     *
     * The only sanctioned way to change a key: the old definition stays until it
     * is deleted, so a delegation text that named it keeps working while the user
     * migrates.
     *
     * @param {any} args - `{ workspaceId, expectedRevision, subagentId, key, name? }`.
     * @returns {Promise<any>} the write outcome.
     */
    async duplicateSubagent(args) {
      const workspaceId = requireWorkspaceId(args);
      const expectedRevision = args?.expectedRevision;
      const { document } = readDocument();
      const { policy } = resolveWorkspacePolicy(document, workspaceId, now());
      const existing = policy.subagents ?? {};
      const source = existing[String(args?.subagentId ?? '')];
      if (source === undefined) {
        return { saved: false, code: 'unknown-subagent', message: 'the Subagent to duplicate no longer exists', revision: getStore().revision() ?? null };
      }
      const requestedKey = typeof args?.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined;
      try {
        const definition = createDefinition(
          {
            ...source,
            id: undefined,
            key: requestedKey,
            name: typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : `${source.name}（副本）`,
            enabled: false,
          },
          existing,
          now(),
        );
        const ops = [
          ...versionOps(document),
          ...ensurePolicy(document, workspaceId),
          set(['workspaces', workspaceId, 'subagents', definition.id], definition),
        ];
        return await write({ ops, expectedRevision });
      } catch (error) {
        if (error instanceof WorkspaceProfileError) {
          return { saved: false, code: error.code, message: error.message, revision: getStore().revision() ?? null };
        }
        throw error;
      }
    },

    /**
     * Delete one Subagent definition.
     *
     * @param {any} args - `{ workspaceId, expectedRevision, subagentId }`.
     * @returns {Promise<any>} the write outcome.
     */
    async removeSubagent(args) {
      const workspaceId = requireWorkspaceId(args);
      const expectedRevision = args?.expectedRevision;
      const subagentId = String(args?.subagentId ?? '');
      const { document } = readDocument();
      const ops = [
        ...versionOps(document),
        ...ensurePolicy(document, workspaceId),
        unset(['workspaces', workspaceId, 'subagents', subagentId]),
      ];
      return write({ ops, expectedRevision });
    },

    /**
     * Set one Skill's state for one Workspace.
     *
     * `enabled` is stored as the **absence** of an override rather than an
     * explicit `'enabled'` value: the map records deliberate departures from the
     * catalog, so returning a Skill to the ordinary state clears the field
     * instead of pinning a value that would survive a change of default.
     * `disabled` and `recommended` are both real departures and are stored.
     *
     * @param {any} args - `{ workspaceId, expectedRevision, skill, state }`.
     * @returns {Promise<any>} the write outcome.
     */
    async setSkillState(args) {
      const workspaceId = requireWorkspaceId(args);
      const expectedRevision = args?.expectedRevision;
      const skill = String(args?.skill ?? '');
      const state = String(args?.state ?? '');
      if (skill === '') {
        return { saved: false, code: 'invalid-skill', message: 'no Skill name was supplied', revision: getStore().revision() ?? null };
      }
      if (!SKILL_STATES.includes(state)) {
        return {
          saved: false,
          code: 'invalid-skill',
          message: `unknown Skill state "${state}"; expected one of ${SKILL_STATES.join(', ')}`,
          revision: getStore().revision() ?? null,
        };
      }
      const { document } = readDocument();
      const ops = [
        ...versionOps(document),
        ...ensurePolicy(document, workspaceId),
        state === 'enabled'
          ? unset(['workspaces', workspaceId, 'skillOverrides', skill])
          : set(['workspaces', workspaceId, 'skillOverrides', skill], state),
      ];
      return write({ ops, expectedRevision });
    },

    /**
     * Drop the stored policy of a Workspace the registry no longer knows.
     *
     * Explicit, never automatic: a Workspace can disappear because its directory
     * was moved, and deleting its configuration on that evidence would be
     * destroying the user's work in response to a rename.
     *
     * @param {any} args - `{ workspaceId, expectedRevision }`.
     * @returns {Promise<any>} the write outcome.
     */
    async pruneOrphan(args) {
      const workspaceId = requireWorkspaceId(args);
      const expectedRevision = args?.expectedRevision;
      const { document } = readDocument();
      if (!(workspaceId in (document.workspaces ?? {}))) {
        return { saved: false, code: 'unknown-workspace', message: `no stored policy exists for "${workspaceId}"`, revision: getStore().revision() ?? null };
      }
      const ops = [...versionOps(document), unset(['workspaces', workspaceId])];
      return write({ ops, expectedRevision });
    },

    /**
     * Enabled Subagent definitions for the calling Agent's Workspace.
     *
     * The `/agent` command's read path. Present here rather than in the command
     * module so the dispatcher stays the single authority on what "available"
     * means.
     *
     * @param {any} agent - the calling Agent.
     * @returns {{ context: any, subagents: any[] }} the Workspace context and its agents.
     */
    listFor(agent) {
      return getDispatcher().listFor(agent);
    },
  };

  return operations;
}

/**
 * The preset-layer scope keys of the live Agents working in one Workspace.
 *
 * `scopeParentOf(agent)` is the standing mount the Agent joined — an agent
 * preset's scope — and it is that layer's Skill contributions a Settings page
 * has to show. The Agent's own layer is deliberately excluded: it is where this
 * plugin's disable-shadows live, and a shadow wins the name.
 *
 * Deduplicated by identity, and bounded: a process with many live agents in one
 * Workspace contributes one read per distinct preset, not one per agent.
 *
 * @param {any} agents - the `agents` registry, or `undefined`.
 * @param {string} workspaceId - the Workspace being inspected.
 * @returns {object[]} the distinct preset scope keys.
 */
function presetScopesFor(agents, workspaceId) {
  if (agents === undefined || typeof agents.list !== 'function') return [];
  let live;
  try {
    live = agents.list();
  } catch {
    return [];
  }
  const scopes = [];
  for (const agent of live ?? []) {
    const parent = getScopeParentOf(agent);
    if (parent === undefined) continue;
    if (scopes.includes(parent)) continue;
    scopes.push(parent);
  }
  return scopes;

  /** Resolve one Agent's enclosing scope, tolerating an unmounted scope service. */
  function getScopeParentOf(agent) {
    try {
      return scopeParentOf(agent);
    } catch {
      return undefined;
    }
  }
}

/**
 * Compose the three prompt sections exactly as the runtime composes them.
 *
 * The point of this function is that it does not reimplement anything: each entry
 * calls the same composer the corresponding `systemPrompt.section` calls, with the
 * same `configured` gate. A preview built from a second copy of this logic would
 * eventually disagree with the thing it claims to show, and the disagreement
 * would be invisible — which is the failure this whole method exists to end.
 *
 * The Perspective is composed **without** a session override on purpose: this is
 * a Workspace-scoped read and the override lives on a session. See
 * {@link previewInjection}.
 *
 * @param {object} input - the inputs.
 * @param {any} input.policy - the resolved policy to compose from.
 * @param {boolean} input.configured - whether Profile/Perspective may be injected.
 * @param {{ id: string, title: string, path: string }} input.workspace - the Workspace projection.
 * @param {any} input.texts - the loaded Profile and Perspective bodies.
 * @param {string} [input.override] - a session Perspective override; omitted here.
 * @returns {Array<{ id: string, order: number, text: string }>} the three sections, in order.
 */
function composeInjectionSections({ policy, configured, workspace, texts, override }) {
  return [
    {
      id: PROFILE_SECTION_NAME,
      order: PROFILE_SECTION_ORDER,
      text: composeProfileSection({ policy, configured, workspace, texts }),
    },
    {
      id: PERSPECTIVE_SECTION_NAME,
      order: PERSPECTIVE_SECTION_ORDER,
      text: composePerspectiveSection({ policy, configured, override, texts }),
    },
    {
      id: AGENTS_SECTION_NAME,
      order: AGENTS_SECTION_ORDER,
      // Deliberately ungated, exactly as the runtime is: every Subagent in this
      // list was created deliberately, so an enabled one is advertised even
      // before a Profile is chosen.
      text: composeAgentDirectorySection(policy),
    },
  ];
}

/** Which part of the composition each section name answers for. */
const SECTION_PARTS = Object.freeze({
  [PROFILE_SECTION_NAME]: 'profile',
  [PERSPECTIVE_SECTION_NAME]: 'perspective',
  [AGENTS_SECTION_NAME]: 'agents',
});

/**
 * Shape one composition for the browser.
 *
 * `active` is derived from the composed text rather than from the gate, because
 * the two genuinely differ: a Workspace with no Profile still advertises its
 * expert Subagents, so "configured" is not the same question as "does anything
 * get injected". Reporting the gate *and* the per-part verdict lets the page say
 * which of the three is being written instead of collapsing that into one word.
 *
 * @param {{ sections: Array<{ id: string, order: number, text: string }>, gate: string }} input - the composition.
 * @returns {{ active: boolean, gate: string, parts: Record<string, boolean>, totalChars: number, sections: any[] }} the summary.
 */
function summarizeInjection({ sections, gate }) {
  /** @type {Record<string, boolean>} */
  const parts = { profile: false, perspective: false, agents: false };
  const shaped = sections.map((section) => {
    const text = typeof section.text === 'string' ? section.text : '';
    const part = SECTION_PARTS[section.id];
    if (part !== undefined && text !== '') parts[part] = true;
    return { id: section.id, order: section.order, text, chars: text.length };
  });
  const totalChars = shaped.reduce((total, section) => total + section.chars, 0);
  return { active: totalChars > 0, gate, parts, totalChars, sections: shaped };
}

/**
 * Project a stored policy into plain JSON for the wire.
 *
 * @param {any} policy - a normalized policy.
 * @returns {any} the projection.
 */
function projectPolicy(policy) {
  const subagents = enabledSubagents(policy);
  return {
    onboardingStatus: policy.onboardingStatus,
    profile: policy.profile,
    profileLabel: PROFILE_LABELS[policy.profile] ?? policy.profile,
    defaultPerspective: policy.defaultPerspective,
    perspectiveLabel: PERSPECTIVE_LABELS[policy.defaultPerspective] ?? policy.defaultPerspective,
    skillOverrides: { ...policy.skillOverrides },
    subagents: Object.values(policy.subagents ?? {})
      .map((definition) => ({ ...definition }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    enabledSubagentKeys: subagents.map((definition) => definition.key),
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

/** Build a `set` path op. */
function set(path, value) {
  return { op: 'set', path, value };
}

/** Build an `unset` path op. */
function unset(path) {
  return { op: 'unset', path };
}

/**
 * Read the Workspace id from an arguments object.
 *
 * @param {any} args - the Remote arguments.
 * @returns {string} the Workspace id.
 */
function requireWorkspaceId(args) {
  const workspaceId = String(args?.workspaceId ?? '');
  if (workspaceId === '') {
    throw new WorkspaceProfileError('unknown-workspace', 'no Workspace was named in this request');
  }
  return workspaceId;
}

/** Render an unknown thrown value as a message. */
function messageOf(error) {
  if (error instanceof Error) {
    const code = /** @type {any} */ (error).code;
    return typeof code === 'string' && code !== '' ? `${error.message} [${code}]` : error.message;
  }
  return String(error);
}

export { projectPolicy, isValidSubagentKey, defaultKeyFor };

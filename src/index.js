/**
 * dsh-workspace-profile — the Host face.
 *
 * ```
 *   cordis loader row "workspace-profile"
 *            │
 *        apply(ctx, config)
 *            │
 *   ┌────────┴──────────────────────────────────────────────────────────┐
 *   │ settings namespace `workspace-profile`   ← the stored document     │
 *   │ ctx.workspaceRegistry                    ← WorkspaceId resolution  │
 *   │ ctx.systemPrompt                         ← two dynamic sections    │
 *   │ ctx.skills                               ← per-Agent shadows       │
 *   │ ctx.llm                                  ← route catalog + preflight│
 *   │ ctx.subagents + spawn provider           ← the child Agent          │
 *   │ ctx.tools + ctx.commands                 ← the two entry points     │
 *   │ ctx.typert                               ← the browser surface      │
 *   └───────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Everything is acquired through `ctx.inject`, nothing through a static list
 *
 * A static `inject` array makes the whole plugin wait for a service; reading a
 * service that is not there yet poisons the context **permanently**
 * (`cannot get property "x" without inject`), so a `?.` does not save it. Each
 * seam is therefore taken as it arrives, and the plugin degrades honestly when
 * one never does: no `settings` means no configuration, no `subagents` means the
 * tool explains that delegation is unavailable, and no `typert` means the
 * Settings page simply is not served. The `capabilities()` map reports which of
 * those happened, so the page can say so instead of rendering a blank control.
 *
 * ## One loader row
 *
 * `cordis.patch.yml` mounts this package as a **single** row. That is not a
 * simplification: `dsh-client-modules` discovers a package's browser bundle by
 * walking the Loader's *active* entries and keys each source by
 * `baseUrl + loaderName`, so a package reached by two active rows is rejected
 * with `resolves from multiple active Loader sources`. The rejection is a
 * `logger.warn`, not a failure — the package simply gets no browser bundle and
 * the only symptom is a Settings section that never appears.
 *
 * @module dsh-workspace-profile
 */

import Schema from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

import { CompositionStore, SETTINGS_NS } from './settings.js';
import { WorkspaceResolver } from './workspace-resolution.js';
import { MatterResolver } from './matter-resolution.js';
import { ModelCatalog } from './model-catalog.js';
import { ProfileRuntime, loadProfileTexts } from './profile-runtime.js';
import { SkillPolicy, disabledSkillNames } from './skill-policy.js';
import { SubagentDispatcher } from './subagent-dispatch.js';
import { createOperations } from './remote/operations.js';
import { WorkspaceProfileService } from './service.js';
import { registerWorkspaceSubagentTool } from './tools.js';
import { registerAgentCommand, registerPerspectiveCommand } from './commands.js';
import { SessionPerspectiveStore } from './session-perspective.js';
import { emptyDocument, resolveWorkspacePolicy } from './policy.js';

/** Cordis plugin name. Distinct from the package name, which is the loader row's `name`. */
export const name = 'workspace-profile';

/**
 * Plugin configuration.
 *
 * Small on purpose: the things a deployment might reasonably want to switch are
 * the seams it runs, and those are already composition rows. `enabled` exists so
 * an overlay can turn the plugin off without removing the row and losing its
 * configuration.
 */
export const Config = Schema.object({
  /** Whether the plugin activates at all. */
  enabled: Schema.boolean().default(true),
  /** Workspace policy lives in the Profile plugin config on DSH 0.1.7. */
  document: Schema.any().volatile(),
});

/** Absolute path of this package, used to locate the Profile texts. */
const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;

/**
 * Mount the Workspace Composition plugin.
 *
 * @param {any} ctx - the plugin's context.
 * @param {Record<string, any>} [config] - validated configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger?.info?.('workspace-profile: disabled by configuration');
    return;
  }

  const logger = ctx.logger;
  const now = () => new Date().toISOString();
  const dshHome = safeDshHome(logger);

  // ── service holders ───────────────────────────────────────────────────────
  //
  // Deliberately mutable rather than captured: each seam may arrive after this
  // function returns, and may leave again under HMR. Every consumer reads
  // through a thunk, so a late service is picked up without a restart and a
  // departing one degrades to a named error instead of a stale reference.
  /** @type {CompositionStore|undefined} */ let store;
  /** @type {WorkspaceProfileService|undefined} */ let service;
  /**
   * The additional writable directories a Workspace declares, published by
   * `dsh-multi-project` as the `workspaceDirs` service.
   *
   * Optional on purpose: a composition without that plugin has single-directory
   * Workspaces, which is exactly what this plugin assumed before it could read
   * the set — so its absence degrades to the previous behavior rather than to a
   * wrong answer.
   * @type {{ dirsFor?: (workspaceId: string) => { dirs: string[], missingDirs: string[] }|undefined }|undefined}
   */
  let workspaceDirs;

  const getStore = () => store;
  const getRegistry = () => ctx.get('workspaceRegistry');
  const getSkills = () => ctx.get('skills');
  const getLlm = () => ctx.get('llm');
  const getSubagents = () => ctx.get('subagents');
  const getWorkspaceDirs = () => workspaceDirs;

  const resolver = new WorkspaceResolver({ getRegistry, logger });

  /**
   * Every directory one Workspace covers: its own path first, then the ones added
   * to it.
   *
   * One function for both readers of the question — the Agent path and the
   * Settings read — because they disagreeing is the failure this plugin has
   * already had once (the Settings card reported an enclosing Matter that no
   * session had).
   *
   * @param {string} workspaceId - the Workspace.
   * @returns {string[]} the declared directories, the Workspace's own first.
   */
  const rootsFor = (workspaceId) => {
    /** @type {string[]} */
    const roots = [];
    const path = resolver.describe(workspaceId)?.path;
    if (typeof path === 'string' && path !== '') roots.push(path);
    const dirs = getWorkspaceDirs();
    if (dirs !== undefined && typeof dirs.dirsFor === 'function') {
      // A store that cannot be read is *not* narrowed to one directory here:
      // answering "no Matter" for a Workspace whose Matter is in an added
      // directory is the failure this seam exists to remove. The throw travels to
      // whichever reader asked — the page shows it as a load failure, and the
      // Agent path bounds itself to the cwd (see `MatterResolver.resolveAgent`).
      const answer = dirs.dirsFor(workspaceId);
      for (const dir of answer?.dirs ?? []) {
        if (typeof dir === 'string' && dir !== '') roots.push(dir);
      }
    }
    return roots;
  };

  // Resolves the CaseBench Matter a session sits inside. Its synchronous half is
  // what the Settings read uses; nothing in the prompt sections depends on it, so a
  // composition that never resolves one degrades to "no Matter" rather than failing.
  const matterResolver = new MatterResolver({
    logger,
    // The Workspace's directories bound the upward walk, so a Matter above the
    // Workspace is never adopted — and they are searched, so a Matter in a
    // directory added to the Workspace is found. `ensureReady` resolves the
    // Workspace first, so this is a lookup by the time a Matter is asked for.
    workspaceRootsFor: (agent) => {
      const workspaceId = resolver.workspaceIdForAgent(agent);
      return workspaceId === undefined ? [] : rootsFor(workspaceId);
    },
  });
  const catalog = new ModelCatalog({ getLlm, logger });

  /**
   * Per-Agent readiness, memoized until the policy changes.
   *
   * Replaced wholesale on a policy change rather than cleared entry by entry: a
   * `WeakMap` has no iteration, and the entries are keyed by live Agent objects
   * that the old map will not keep alive.
   */
  let readiness = new WeakMap();

  const skillPolicy = new SkillPolicy({
    ctx,
    getSkills,
    disabledForWorkspace: (workspaceId) => {
      const document = store?.read().document ?? emptyDocument(now());
      const { policy } = resolveWorkspacePolicy(document, workspaceId, now());
      return disabledSkillNames(policy);
    },
    logger,
  });

  /** Resolve one Agent's Workspace and apply its Skill policy, once per policy revision. */
  const ensureReady = (agent) => {
    let pending = readiness.get(agent);
    if (pending === undefined) {
      pending = (async () => {
        const workspaceId = await resolver.resolveAgent(agent);
        await skillPolicy.applyFor(agent, workspaceId);
        // Resolved at the same boundary as the Workspace, for the same reason: by
        // the first step the synchronous answer is already memoised, and a
        // delegation can read it without touching the filesystem.
        await matterResolver.resolveAgent(agent);
      })().catch((error) => {
        logger?.warn?.(`workspace-profile: could not prepare the workspace context for an agent: ${messageOf(error)}`);
      });
      readiness.set(agent, pending);
    }
    return pending;
  };

  /**
   * The synchronous policy lookup the prompt sections use.
   *
   * `systemPrompt.section` accepts a *synchronous* text function, so this may
   * not await anything. {@link WorkspaceResolver.workspaceIdForAgent} answers
   * from its index, and {@link ensureReady} — awaited at every step boundary —
   * is what keeps that index and the Skill layer current.
   */
  const resolveFor = (agent) => {
    const workspaceId = resolver.workspaceIdForAgent(agent);
    if (workspaceId === undefined) return { policy: undefined, configured: false, workspace: undefined };
    const document = store?.read().document ?? emptyDocument(now());
    const { policy, configured } = resolveWorkspacePolicy(document, workspaceId, now());
    return { policy, configured, workspace: resolver.describe(workspaceId) };
  };

  /**
   * Session-scoped Perspective overrides.
   *
   * Created unconditionally so `/perspective` exists whether or not a storage
   * backend does; {@link SessionPerspectiveStore#open} only decides whether the
   * value survives a restart. The prompt section reads it through `overrideFor`,
   * which is synchronous by contract because it runs inside a section's text
   * function.
   */
  const sessionPerspectives = new SessionPerspectiveStore({ logger });

  const profileRuntime = new ProfileRuntime({
    texts: { profiles: {}, perspectives: {} },
    resolveFor,
    overrideFor: (agent) => sessionPerspectives.overrideFor(agent),
    logger,
  });

  const dispatcher = new SubagentDispatcher({
    getSubagents,
    getResolver: () => resolver,
    getMatterResolver: () => matterResolver,
    // The same source the prompt section reads, so a dispatched child inherits
    // the session's stance rather than the Workspace's default.
    getSessionPerspective: (agent) => sessionPerspectives.overrideFor(agent),
    getStore,
    getCatalog: () => catalog,
    now,
    logger,
  });

  const operations = createOperations({
    getStore,
    getResolver: () => resolver,
    getMatterResolver: () => matterResolver,
    // The same declared set the Agent path uses, so the Settings card and the
    // session cannot disagree about which directories this Workspace covers.
    getWorkspaceRoots: rootsFor,
    getCatalog: () => catalog,
    getSkills,
    getAgents: () => ctx.get('agents'),
    // 0.1.7's preset registry. Its standing preset scopes answer "which Skills
    // would a session here see" without a live Agent, and — unlike reading
    // scope parents through this package's own dsh-scope copy — its scope keys
    // are produced and consumed inside the platform's module instance, so the
    // lookup also works where the Host embeds its own copy (desktop asar).
    getAgentPresets: () => ctx.get('agentPresets'),
    getDispatcher: () => dispatcher,
    getDshHome: () => dshHome,
    // The same texts the prompt sections read, so the Settings preview composes
    // from one source rather than a copy that can drift.
    getProfileTexts: () => profileRuntime.texts,
    capabilities,
    now,
    logger,
  });

  /**
   * Which seams are mounted, for the Settings page.
   *
   * Reported rather than logged because the page has to explain itself: a
   * deployment without `subagents` must say "delegation is unavailable in this
   * composition", not render a button that fails.
   *
   * @returns {Record<string, boolean>} the capability map.
   */
  function capabilities() {
    return {
      settings: store !== undefined,
      workspace: getRegistry() !== undefined,
      skills: getSkills() !== undefined,
      models: getLlm() !== undefined,
      systemPrompt: ctx.get('systemPrompt') !== undefined,
      subagents: getSubagents() !== undefined,
      spawnProvider: getSubagents()?.getProvider('spawn') !== undefined,
      remote: service !== undefined,
      // Reported even though nothing renders it today: "the Workspace covers more
      // than one directory and this composition cannot see that" is the difference
      // between a Matter that is absent and a Matter that is unlooked-for.
      workspaceDirs: getWorkspaceDirs() !== undefined,
    };
  }

  // ── the Workspace's additional directories ────────────────────────────────
  //
  // `dsh-multi-project` owns the record of directories added to a Workspace and
  // publishes it read-only. Taken as a seam like every other: a composition
  // without that plugin keeps single-directory Workspaces and this callback
  // simply never runs.
  ctx.inject(['workspaceDirs'], (dirsCtx) => {
    workspaceDirs = dirsCtx.workspaceDirs;
    dirsCtx.effect(() => () => {
      workspaceDirs = undefined;
    });
    logger?.info?.('workspace-profile: reading the Workspace directory set from ctx.workspaceDirs');
  });

  // ── Profile texts ─────────────────────────────────────────────────────────
  //
  // Loaded once, asynchronously, and swapped in when ready. A step that assembles
  // its prompt before the read finishes simply gets no Workspace section for that
  // one step — strictly better than blocking activation on file I/O, and the
  // alternative (a synchronous read at module scope) would make the plugin
  // unimportable if a file were missing.
  void loadProfileTexts(PACKAGE_ROOT, logger).then(
    (texts) => {
      profileRuntime.texts = texts;
      logger?.info?.(
        `workspace-profile: loaded ${Object.keys(texts.profiles).length} Profile bodies and ` +
          `${Object.values(texts.perspectives).reduce((total, group) => total + Object.keys(group).length, 0)} Perspective bodies`,
      );
    },
    (error) => logger?.warn?.(`workspace-profile: could not load Profile texts: ${messageOf(error)}`),
  );

  // ── settings ──────────────────────────────────────────────────────────────
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }));
    store = new CompositionStore({ provider: settingsCtx.settings, ctx: settingsCtx, logger, now });

    const read = store.read();
    if (read.error !== undefined) {
      // An unreadable document is reported, not thrown: the plugin still works
      // from its last good value, and the Settings page shows the reason. Taking
      // down the composition over a hand-edited settings file would be worse.
      logger?.error?.(`workspace-profile: ${read.error.message}`);
    }
    if (read.changed) {
      void store.persistNormalized(read.document, store.revision());
    }

    // A committed change invalidates the per-Agent readiness memo and the model
    // catalog: the next step of every Agent then re-reads the new policy, which
    // is exactly the "takes effect from the next Agent step" contract — no
    // history is rewritten and no running turn is interrupted.
    store.watch(() => {
      readiness = new WeakMap();
      catalog.invalidate();
      ctx.emit?.('workspace-profile/policy-changed');
    });
    logger?.info?.(`workspace-profile: settings namespace "${SETTINGS_NS}" registered`);
  });

  // ── agent lifecycle ───────────────────────────────────────────────────────
  //
  // `agent/created` warms the resolution so the ordinary case is already a cache
  // hit, and `agent/pre-step` guarantees it: the waterfall is awaited before the
  // step assembles its prompt, so not even a first step can race the lookup.
  ctx.on('agent/created', ({ agent }) => {
    void ensureReady(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    // Not awaited: the event is a notification, and the Agent's own teardown
    // already owns its ordering. The layer is withdrawn as soon as the disposal
    // settles, and the Agent object is gone either way.
    void skillPolicy.releaseFor(agent);
    readiness.delete(agent);
  });
  ctx.on('agent/pre-step', async (_payload, next) => {
    await ensureReady(_payload.agent);
    return next();
  });

  // ── session Perspective storage ───────────────────────────────────────────
  //
  // Acquired through `ctx.inject` like every other seam. A composition without
  // `storageDomain` still gets `/perspective`; the stance just lives for the
  // process instead of surviving a restart, and the command says so rather than
  // letting the user believe a stance was recorded.
  ctx.inject(['storageDomain'], (storageCtx) => {
    void sessionPerspectives.open(storageCtx.storageDomain).then((durable) => {
      if (durable) logger?.info?.('workspace-profile: session Perspective overrides are persisted');
    });
    // The domain is closed with the plugin so a queued override still lands.
    storageCtx.effect(() => () => {
      void sessionPerspectives.close();
    });
  });

  // ── prompt sections ───────────────────────────────────────────────────────
  ctx.inject(['systemPrompt'], (promptCtx) => {
    profileRuntime.register(promptCtx, promptCtx.systemPrompt);
    logger?.info?.(
      'workspace-profile: registered the Workspace context, Perspective and Subagent directory sections',
    );
  });

  // ── entry points ──────────────────────────────────────────────────────────
  ctx.inject(['tools'], (toolCtx) => {
    registerWorkspaceSubagentTool(toolCtx, { getDispatcher: () => dispatcher });
  });
  ctx.inject(['commands'], (commandCtx) => {
    registerAgentCommand(commandCtx, { getDispatcher: () => dispatcher });
    registerPerspectiveCommand(commandCtx, {
      resolveFor,
      getSessionStore: () => sessionPerspectives,
    });
  });

  // ── browser surface ───────────────────────────────────────────────────────
  //
  // `TypertRemoteService`'s constructor binds the namespace into the Gateway, so
  // constructing it without `typert` throws. Waiting for the service instead
  // means a composition with no Gateway simply has no browser face — and keeps
  // the tool, the command and the prompt sections, which is the right trade.
  ctx.inject(['typert'], (typertCtx) => {
    service = new WorkspaceProfileService(typertCtx, operations);
    typertCtx.effect(() => () => {
      service = undefined;
    });
    logger?.info?.('workspace-profile: registered ctx.remote.workspaceProfile');
  });

  logger?.info?.('workspace-profile: activated');
}

/**
 * Resolve the harness home without letting a failure abort activation.
 *
 * The home is only used to report whether the user-global `AGENTS.md` exists; a
 * deployment whose home cannot be resolved should lose that one row, not the
 * plugin.
 *
 * @param {{ warn: Function }} [logger] - diagnostics sink.
 * @returns {string|undefined} the absolute harness home.
 */
function safeDshHome(logger) {
  try {
    return resolveDshHome();
  } catch (error) {
    logger?.warn?.(`workspace-profile: could not resolve the harness home (${messageOf(error)})`);
    return undefined;
  }
}

/** Render an unknown thrown value as a message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export { SETTINGS_NS, WorkspaceProfileService };
export { WorkspaceResolver } from './workspace-resolution.js';
export { MatterResolver } from './matter-resolution.js';
export { ModelCatalog } from './model-catalog.js';
export { SubagentDispatcher } from './subagent-dispatch.js';
export { CompositionStore } from './settings.js';
export * from './policy.js';
export * from './errors.js';

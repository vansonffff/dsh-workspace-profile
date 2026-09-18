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

import { CompositionStore, CompositionDocumentSchema, SETTINGS_NS } from './settings.js';
import { WorkspaceResolver } from './workspace-resolution.js';
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

  const getStore = () => store;
  const getRegistry = () => ctx.get('workspaceRegistry');
  const getSkills = () => ctx.get('skills');
  const getLlm = () => ctx.get('llm');
  const getSubagents = () => ctx.get('subagents');

  const resolver = new WorkspaceResolver({ getRegistry, logger });
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
    getStore,
    getCatalog: () => catalog,
    now,
    logger,
  });

  const operations = createOperations({
    getStore,
    getResolver: () => resolver,
    getCatalog: () => catalog,
    getSkills,
    getAgents: () => ctx.get('agents'),
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
    };
  }

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
    const scope = settingsCtx.settings.register(SETTINGS_NS, CompositionDocumentSchema, { applies: 'live' });
    store = new CompositionStore({ provider: settingsCtx.settings, scope, logger, now });

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
    scope.watch(() => {
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
export { ModelCatalog } from './model-catalog.js';
export { SubagentDispatcher } from './subagent-dispatch.js';
export { CompositionStore } from './settings.js';
export * from './policy.js';
export * from './errors.js';

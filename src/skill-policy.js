/**
 * Per-Workspace Skill policy: which Skills an Agent in this Workspace may use.
 *
 * ## The mechanism, and why it is the right one
 *
 * `ctx.skills` is a *layered* registry. A read merges the global layer with the
 * viewing scope's chain, and **the nearest layer's entry wins a duplicate name
 * outright** — nearest-first, no rank arbitration across layers. The viewing
 * scope for a Skill read is the Agent object itself, because the agent loop
 * mints each Agent's context as `createScope(loopCtx, agent)` and
 * `dsh-tool-skill` passes `scope: agent`.
 *
 * So a Workspace "disable" is: mint a scope keyed by that Agent, and register a
 * same-named runtime Skill there whose invocation policy refuses both the model
 * and the user. The shadow is the nearest entry, so it wins the name; the
 * catalog filters it out of the model-visible list (`isModelInvocable`), the
 * `skill` tool refuses to load it, and the human-facing catalog drops it too.
 * Nothing is deleted, no global registry is mutated, and disposing the scope
 * restores the original entry exactly.
 *
 * Three properties fall out of this rather than needing to be arranged:
 *
 * - **Workspace isolation** — the shadow lives in one Agent's layer. Agent B in
 *   another Workspace never sees it. There is no shared state to leak.
 * - **Parent/child consistency** — a `spawn` child is its own Agent with its own
 *   scope, so the same rule is applied to it by the same code path. It cannot
 *   see a different catalog from its parent.
 * - **Invalidation** — `ScopedLayers` calls the registry's change callback on
 *   every layer effect, so registering or disposing a shadow invalidates the
 *   catalog cache automatically. No manual invalidation exists to forget.
 *
 * ## Managed versus unmanaged sources
 *
 * The Settings page only offers to *write* an override for roots the user owns
 * (`project-*`, `user-*`, `custom`); a `bundled` Skill ships with the deployment
 * and is shown read-only. Enforcement is deliberately broader: an override that
 * exists is honoured whatever the Skill's current source, because a Skill's
 * source can change under a saved policy (a user root becomes bundled, a plugin
 * moves) and silently re-enabling a Skill the user turned off is the worse
 * failure of the two. The UI reports such a row as disabled-with-an-unmanaged
 * source rather than pretending it is editable.
 *
 * @module dsh-workspace-profile/skill-policy
 */

import { createScope } from '@deepseek-ai/dsh-scope';

import { disabledSkills } from './policy.js';

/**
 * Skill sources this plugin offers to manage.
 *
 * Every value here comes from `dsh-skill-filesystem`'s root table; `bundled` is
 * the one shipped root and is excluded on purpose.
 */
export const MANAGED_SKILL_SOURCES = Object.freeze([
  'project-dsh',
  'project-agents',
  'user-dsh',
  'user-agents',
  'custom',
]);

/** Whether a Skill's source is one Settings will let the user toggle. */
export function isManagedSource(source) {
  return MANAGED_SKILL_SOURCES.includes(String(source));
}

/** The `provider` label our shadows carry, so a catalog row can be recognized as ours. */
export const SHADOW_PROVIDER = 'workspace-profile';

/**
 * Apply and withdraw per-Agent Skill shadows.
 */
export class SkillPolicy {
  /**
   * @param {object} deps - dependencies.
   * @param {any} deps.ctx - the plugin context the scopes are minted under.
   * @param {() => any} deps.getSkills - resolves the `skills` service, or `undefined`.
   * @param {(workspaceId: string) => string[]} deps.disabledForWorkspace - the Workspace's disabled Skill names.
   * @param {{ warn: Function }} [deps.logger] - diagnostics sink.
   */
  constructor({ ctx, getSkills, disabledForWorkspace, logger }) {
    /** @private */ this.ctx = ctx;
    /** @private */ this.getSkills = getSkills;
    /** @private */ this.disabledForWorkspace = disabledForWorkspace;
    /** @private */ this.logger = logger;
    /** @private @type {WeakMap<object, { scope: any, names: string[] }>} */
    this.applied = new WeakMap();
  }

  /**
   * Bring one Agent's Skill layer in line with its Workspace's policy.
   *
   * Idempotent and cheap when nothing changed: the previously applied name set
   * is compared first, so an Agent that takes many steps does not churn scopes.
   *
   * @param {any} agent - the Agent to configure.
   * @param {string|undefined} workspaceId - its Workspace, when known.
   * @returns {Promise<void>} resolution after the layer matches the policy.
   */
  async applyFor(agent, workspaceId) {
    if (workspaceId === undefined) {
      await this.releaseFor(agent);
      return;
    }
    const wanted = this.disabledForWorkspace(workspaceId).slice().sort();
    const current = this.applied.get(agent);
    if (current !== undefined && sameNames(current.names, wanted)) return;

    // Awaited, not fired and forgotten: `scope.dispose()` settles
    // asynchronously, and a layer that has not been withdrawn yet still wins the
    // name — so a re-apply that does not wait would race its own teardown and
    // leave the previous policy in force.
    await this.releaseFor(agent);
    if (wanted.length === 0) return;

    const skills = this.getSkills();
    if (skills === undefined) {
      this.logger?.warn?.(
        'workspace-profile: a Workspace disables Skills but the `skills` service is not mounted, so the policy is not enforced in this composition',
      );
      return;
    }

    // The scope key IS the Agent object, which is exactly the key `dsh-tool-skill`
    // reads with (`scope: agent`). Minting under that key is what makes the shadow
    // the nearest layer rather than a sibling one.
    const scope = createScope(this.ctx, agent);
    const names = [];
    for (const name of wanted) {
      try {
        scope.ctx.skills.register({
          name,
          description: `Disabled by the ${workspaceId} Workspace policy.`,
          content: '',
          source: SHADOW_PROVIDER,
          invocation: { modelInvocable: false, userInvocable: false },
        });
        names.push(name);
      } catch (error) {
        // Registering through `scope.ctx.skills` requires the tracked service
        // access to resolve; a failure here is a composition fact, not a policy
        // one, so report it and keep the remaining names.
        this.logger?.warn?.(
          `workspace-profile: could not shadow skill "${name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.applied.set(agent, { scope, names });
  }

  /**
   * Withdraw one Agent's shadows, restoring the registry to its own catalog.
   *
   * @param {any} agent - the Agent whose layer to clear.
   * @returns {Promise<void>} resolution once the registry no longer holds the shadows.
   */
  async releaseFor(agent) {
    const current = this.applied.get(agent);
    if (current === undefined) return;
    // Deleted first so a concurrent apply cannot observe a scope it is about to
    // lose; the disposal itself is then awaited by the caller.
    this.applied.delete(agent);
    await current.scope.dispose();
  }

  /**
   * The Skill names currently shadowed for one Agent.
   *
   * @param {any} agent - the Agent to inspect.
   * @returns {readonly string[]} the shadowed names, for diagnostics and tests.
   */
  shadowedFor(agent) {
    return this.applied.get(agent)?.names ?? [];
  }
}

/**
 * Build the Skill catalog rows the Settings page renders for one Workspace.
 *
 * Read from the registry **without a viewing scope**, so the result is the
 * deployment's own catalog, and then the Workspace policy is applied on top.
 * Reading with the Agent's scope instead would report a shadowed Skill as
 * "missing" — the shadow wins the name and carries our placeholder description,
 * which would be both confusing and wrong about what exists.
 *
 * ## Which layers it reads, and why that is more than one
 *
 * The registry is layered, and in a Web deployment the local filesystem provider
 * is mounted by an **agent preset**, not by the deployment — the base row is
 * explicitly disabled. An unscoped read therefore returns only the deployment's
 * own contributions, and a Settings page built on it would report every
 * project- or user-root Skill as "not installed" while the agent using it sees
 * them all. That is worse than an empty list: it is a wrong answer to a question
 * the user is about to act on.
 *
 * So the read covers the global layer **plus each live Agent's preset layer**,
 * taken from `scopeParentOf(agent)`. The preset layer rather than the Agent's own
 * layer, deliberately: the Agent's layer is where this plugin's own shadows live,
 * and a shadow wins the name — reading there would make a *disabled* Skill vanish
 * from the very list that is supposed to show it as disabled.
 *
 * @param {object} input - the inputs.
 * @param {any} skills - the `skills` service.
 * @param {{ id: string, path: string }} workspace - the Workspace projection.
 * @param {any} policy - its resolved policy.
 * @param {readonly (object|undefined)[]} [input.scopes] - extra layers to read.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @returns {Promise<{ rows: any[], missing: string[], complete: boolean, layersRead: number }>}
 *   catalog rows, the recommended-but-absent names, whether discovery completed
 *   (an incomplete observation must not be presented as the truth), and how many
 *   layers the answer was merged from.
 */
export async function buildSkillCatalog({ skills, workspace, policy, recommended, scopes, signal }) {
  const lookups = [undefined, ...(scopes ?? [])];
  /** @type {Map<string, any>} */
  const installed = new Map();
  let complete = true;
  for (const scope of lookups) {
    const snapshot = await skills.snapshot({
      cwd: workspace.path,
      ...(scope === undefined ? {} : { scope }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (snapshot.complete !== true) complete = false;
    for (const skill of snapshot.skills) {
      // Our shadows are registry mechanics, never catalog entries. A stale one
      // must not appear as a real Skill.
      if (skill.source === SHADOW_PROVIDER) continue;
      if (!installed.has(skill.name)) installed.set(skill.name, skill);
    }
  }

  const rows = [...installed.values()]
    .map((skill) => {
      const stored = policy?.skillOverrides?.[skill.name];
      const overridden = Object.prototype.hasOwnProperty.call(policy?.skillOverrides ?? {}, skill.name);
      return {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        provider: skill.provider,
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
        managed: isManagedSource(skill.source),
        /**
         * The row's own state, which is three-valued.
         *
         * Reported from the stored override rather than derived from
         * `isSkillEnabled`, because a recommended Skill is *enabled* — collapsing
         * the two would make the page unable to show that a row is flagged, and
         * the user unable to unflag it.
         */
        state: stored === 'disabled' ? 'disabled' : stored === 'recommended' ? 'recommended' : 'enabled',
        /** Whether the stored document mentions this Skill explicitly. */
        overridden,
        /** Whether either the Profile or the Workspace recommends it. */
        recommended: (recommended ?? []).includes(skill.name),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const missing = (recommended ?? []).filter((name) => !installed.has(name));

  return { rows, missing, complete, layersRead: lookups.length };
}

/**
 * The names a Workspace's policy disables, as a plain array.
 *
 * A thin wrapper so callers depend on `policy` rather than reaching into its
 * shape — the shape is this package's business, not theirs.
 *
 * @param {any} policy - a resolved Workspace policy.
 * @returns {string[]} the disabled Skill names.
 */
export function disabledSkillNames(policy) {
  return disabledSkills(policy);
}

/**
 * Compare two sorted name lists.
 *
 * @param {readonly string[]} a - first list.
 * @param {readonly string[]} b - second list.
 * @returns {boolean} whether they hold the same names.
 */
function sameNames(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

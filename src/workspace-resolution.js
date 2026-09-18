/**
 * Resolve the official `WorkspaceId` a Session belongs to.
 *
 * ## Why this is not a path comparison
 *
 * The tempting version — "the workspace whose path is a prefix of the session's
 * cwd" — is wrong twice over. It maps `/work/matter` and `/work/matter-old` to
 * the same Workspace, and it ignores that workspace paths are stored
 * `fs.realpath`-canonicalized while a session's recorded cwd may carry a symlink
 * or a trailing separator. Both spellings then disagree about identity, and the
 * disagreement shows up as one Workspace silently using another one's Profile.
 *
 * So identity comes from the registry, through its own canon:
 *
 * - `registry.resolveByPath(path)` is the authority, and it runs `realpath`
 *   itself;
 * - the synchronous path index built from `registry.list()` is an optimization
 *   over already-canonical stored paths, never the final word.
 *
 * `list()` is documented as a synchronous, persistence-free projection, which is
 * what makes it usable from a prompt-section text function — those are pure and
 * synchronous, so an `await` there is not available.
 *
 * @module dsh-workspace-profile/workspace-resolution
 */

/**
 * Resolve Sessions to Workspaces, with a synchronous fast path and an
 * authoritative asynchronous one.
 */
export class WorkspaceResolver {
  /**
   * @param {object} deps - dependencies.
   * @param {() => any} deps.getRegistry - resolves `ctx.workspaceRegistry`, or `undefined`.
   * @param {{ warn: Function }} [deps.logger] - diagnostics sink.
   */
  constructor({ getRegistry, logger }) {
    /** @private */ this.getRegistry = getRegistry;
    /** @private */ this.logger = logger;
    /** @private @type {Map<string, string>} canonical path → workspace id */
    this.pathIndex = new Map();
    /** @private @type {WeakMap<object, string|undefined>} agent → resolved workspace id */
    this.agentIndex = new WeakMap();
    /** @private @type {Map<string, Promise<string|undefined>>} in-flight resolutions, keyed by cwd */
    this.pending = new Map();
  }

  /**
   * Every registered Workspace, in registry order.
   *
   * @returns {Array<{ id: string, path: string, title: string, createdAt: string, updatedAt: string, sessionIds: readonly string[] }>}
   *   plain projections — the entity objects themselves are live handles and
   *   must not be handed to a wire or cached.
   */
  list() {
    const registry = this.getRegistry();
    if (registry === undefined) return [];
    let entities;
    try {
      entities = registry.list();
    } catch (error) {
      this.logger?.warn?.(`workspace-profile: could not list workspaces: ${messageOf(error)}`);
      return [];
    }
    return entities.map((entity) => ({
      id: String(entity.id),
      path: String(entity.path),
      title: String(entity.title),
      createdAt: String(entity.createdAt),
      updatedAt: String(entity.updatedAt),
      sessionIds: Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [],
    }));
  }

  /**
   * Rebuild the synchronous path index from the registry's own canonical paths.
   *
   * @returns {Map<string, string>} canonical path → workspace id.
   */
  refreshIndex() {
    const index = new Map();
    for (const workspace of this.list()) {
      index.set(workspace.path, workspace.id);
    }
    this.pathIndex = index;
    return index;
  }

  /**
   * Synchronously match an already-canonical path.
   *
   * Returns `undefined` for an unknown path rather than throwing: this runs
   * inside a prompt-section text function, where there is no caller to catch.
   *
   * @param {string|undefined} path - a canonical absolute path.
   * @returns {string|undefined} the owning Workspace id.
   */
  workspaceIdForPath(path) {
    if (typeof path !== 'string' || path === '') return undefined;
    if (this.pathIndex.has(path)) return this.pathIndex.get(path);
    // The registry gained a Workspace since the last refresh. One synchronous
    // re-read is cheap (no persistence) and covers the common case; the async
    // path below covers everything else, including non-canonical spellings.
    const refreshed = this.refreshIndex();
    return refreshed.get(path);
  }

  /**
   * The Workspace id already resolved for one Agent, without touching I/O.
   *
   * @param {any} agent - the Agent.
   * @returns {string|undefined} its Workspace id, when known.
   */
  workspaceIdForAgent(agent) {
    if (agent === null || typeof agent !== 'object') return undefined;
    if (this.agentIndex.has(agent)) return this.agentIndex.get(agent);
    return this.workspaceIdForPath(agent.session?.header?.cwd);
  }

  /**
   * Resolve and memoize one Agent's Workspace through the registry's own canon.
   *
   * Awaited by the `agent/created` observer so that by the time the Agent's
   * first step assembles its prompt, the synchronous lookup is a cache hit. The
   * synchronous index above already answers for the ordinary case — a session
   * created inside a registered Workspace, whose cwd is the Workspace's own
   * canonical path — so a miss here costs one `realpath`, not a wrong answer.
   *
   * @param {any} agent - the Agent to resolve.
   * @returns {Promise<string|undefined>} its Workspace id, or `undefined` when
   *   the session runs outside every registered Workspace.
   */
  async resolveAgent(agent) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') {
      this.agentIndex.set(agent, undefined);
      return undefined;
    }
    const fromIndex = this.workspaceIdForPath(cwd);
    if (fromIndex !== undefined) {
      this.agentIndex.set(agent, fromIndex);
      return fromIndex;
    }
    const resolved = await this.resolvePath(cwd);
    this.agentIndex.set(agent, resolved);
    return resolved;
  }

  /**
   * Resolve a path through `registry.resolveByPath`, de-duplicating concurrent
   * lookups for the same path.
   *
   * @param {string} path - an absolute path, canonical or not.
   * @returns {Promise<string|undefined>} the owning Workspace id.
   */
  async resolvePath(path) {
    const existing = this.pending.get(path);
    if (existing !== undefined) return existing;

    const work = (async () => {
      const registry = this.getRegistry();
      if (registry === undefined) return undefined;
      try {
        const workspace = await registry.resolveByPath(path);
        if (workspace === undefined) return undefined;
        const id = String(workspace.id);
        this.pathIndex.set(String(workspace.path), id);
        return id;
      } catch (error) {
        // `resolveByPath` rejects when `realpath` fails — a moved or deleted
        // directory. That is "this session has no Workspace", not a fault worth
        // a stack: the session may simply predate the directory's removal.
        this.logger?.warn?.(
          `workspace-profile: could not resolve a Workspace for "${path}": ${messageOf(error)}`,
        );
        return undefined;
      }
    })();

    this.pending.set(path, work);
    try {
      return await work;
    } finally {
      this.pending.delete(path);
    }
  }

  /**
   * The full Workspace projection for a caller that wants paths and titles too.
   *
   * @param {string} workspaceId - the Workspace to describe.
   * @returns {{ id: string, path: string, title: string, createdAt: string, updatedAt: string, sessionIds: readonly string[] }|undefined}
   *   the projection, or `undefined` when the Workspace is gone.
   */
  describe(workspaceId) {
    return this.list().find((workspace) => workspace.id === workspaceId);
  }

  /**
   * The Workspace ids the registry currently knows, as a set.
   *
   * Used to tell an orphaned policy (its Workspace was deleted) from a live
   * one, without deleting either.
   *
   * @returns {Set<string>} the live ids.
   */
  knownIds() {
    return new Set(this.list().map((workspace) => workspace.id));
  }
}

/**
 * Render an unknown thrown value as a message.
 *
 * @param {unknown} error - the caught value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

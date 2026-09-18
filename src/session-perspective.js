/**
 * Per-session Perspective override: the `/perspective` command's durable state.
 *
 * ## Why this is not the Workspace settings document
 *
 * The Workspace's default Perspective is *long-term configuration*: the user
 * decides it for the matter, it applies to every session in that Workspace, and
 * it belongs in Settings next to the Profile. A session's override is *current
 * working state*: it applies to one conversation, it is expected to be changed
 * freely, and it dies with the conversation. Writing it into the Workspace
 * document would make "try this from the investor's side for a minute" silently
 * reconfigure the matter for every future session — the exact failure the two
 * layers exist to prevent.
 *
 * So it lives in its own storage domain, keyed by session id.
 *
 * ## Why the domain spec is written out rather than imported
 *
 * `defineDomain` and `domainTable` live in `@deepseek-ai/dsh-storage-domain`,
 * which a plugin only reaches through its own module resolution. Importing it
 * would mean the plugin cannot load at all in a deployment where that package is
 * not linked — an activation failure traded for a cosmetic nicety, since the
 * helpers do nothing the runtime needs: `open()` reads `name`, `version`,
 * `tables`, `layout` and `compatibleVersions` off the spec, and calls
 * `valueSchema.parse` per stored record.
 *
 * The spec below is therefore plain data with a duck-typed schema, and
 * `test/session-perspective.test.js` feeds it through the **real** `defineDomain`
 * when that package is resolvable, so the shape is still checked by the owner of
 * the contract rather than by this file's opinion of it.
 *
 * ## Why `parse` repairs instead of throwing
 *
 * A stored record is a one-field preference. Throwing on a malformed one would
 * make the domain layer back the document aside and start clean, which is
 * correct but noisy for data whose worst case is "the stance is forgotten". The
 * schema normalises: an unusable record is dropped at hydration. The persistence
 * policy is still declared as `backup-and-skip` so that a record this schema
 * *cannot* handle cannot cost the boot.
 *
 * @module dsh-workspace-profile/session-perspective
 */

/**
 * The storage domain name.
 *
 * Must satisfy `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`) — **underscores, not
 * hyphens**. Note this is a *different* rule from the Settings namespace
 * (`/^[a-z][a-z0-9-]*$/`), which is hyphenated and rejects underscores; the two
 * identifiers are validated by different owners and must not be copied from one
 * another.
 */
export const SESSION_DOMAIN_NAME = 'workspace_profile_session';

/** Domain version, bumped when the record shape changes incompatibly. */
export const SESSION_DOMAIN_VERSION = 1;

/** The single table, keyed by session id. */
export const SESSION_TABLE = 'perspectives';

/**
 * One stored override.
 *
 * `updatedAt` is diagnostic, not behavioural: it makes a stale record
 * recognisable when reading a session log, and gives a future "overrides older
 * than N days" cleanup something to sort by.
 */
const SESSION_RECORD_SCHEMA = Object.freeze({
  /**
   * Normalise one stored record.
   *
   * @param {unknown} raw - the persisted value.
   * @returns {{ perspective: string, updatedAt: string }} the usable record.
   * @throws {TypeError} when the record carries no usable Perspective id.
   */
  parse(raw) {
    if (raw === null || typeof raw !== 'object') {
      throw new TypeError('a session Perspective record must be an object');
    }
    const perspective = /** @type {any} */ (raw).perspective;
    if (typeof perspective !== 'string' || perspective === '') {
      throw new TypeError('a session Perspective record must carry a non-empty "perspective" string');
    }
    const updatedAt = /** @type {any} */ (raw).updatedAt;
    return {
      perspective,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : new Date(0).toISOString(),
    };
  },
});

/**
 * The domain declaration handed to `ctx.storageDomain.open()`.
 *
 * `per-record` mirrors what the shipped JSON backend does with a keyed table —
 * one document per session — so a session's override can be read, inspected and
 * deleted without rewriting a shared file.
 */
export const SESSION_DOMAIN_SPEC = Object.freeze({
  name: SESSION_DOMAIN_NAME,
  version: SESSION_DOMAIN_VERSION,
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: Object.freeze({
    [SESSION_TABLE]: Object.freeze({ valueSchema: SESSION_RECORD_SCHEMA }),
  }),
});

/**
 * The session id an Agent writes its override under.
 *
 * Returns `undefined` rather than throwing for an Agent without a session: the
 * Subagent plane and several test harnesses build Agents that never open one,
 * and "this Agent has no session" simply means "no override applies".
 *
 * @param {any} agent - an Agent.
 * @returns {string|undefined} the session id.
 */
export function sessionIdOf(agent) {
  const id = agent?.session?.id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Session-keyed Perspective overrides.
 *
 * Reads are **synchronous** by contract: the Perspective prompt section is
 * composed inside `systemPrompt.section`'s text function, which must return a
 * string. Writes are asynchronous because a durable write is, and the caller
 * (`/perspective`) must be able to report that the change actually landed rather
 * than that it was queued.
 *
 * Without a storage domain the store still works — it degrades to
 * process-lifetime memory and says so through {@link SessionPerspectiveStore#durable},
 * so `/perspective` can tell the user their stance will not survive a restart
 * instead of quietly losing it.
 */
export class SessionPerspectiveStore {
  /**
   * @param {{ warn?: Function }} [deps] - diagnostics sink.
   */
  constructor({ logger } = {}) {
    /** @private */ this.logger = logger;
    /** @private @type {Map<string, string>} */ this.memory = new Map();
    /** @private @type {any} */ this.table = undefined;
    /** @private @type {any} */ this.domain = undefined;
    /** @private */ this.closed = false;
  }

  /**
   * Whether overrides survive a process restart.
   *
   * @returns {boolean} true when a storage domain accepted the spec.
   */
  get durable() {
    return this.table !== undefined;
  }

  /**
   * Attach the persistent table, hydrating memory from it.
   *
   * Called once at activation. A failure is reported and swallowed: losing
   * durability must not cost the plugin, because `/perspective` still works
   * in-memory.
   *
   * @param {any} storageDomain - the `storageDomain` service, or a test double.
   * @returns {Promise<boolean>} whether the store is now durable.
   */
  async open(storageDomain) {
    if (storageDomain === undefined || storageDomain === null) return false;
    try {
      const domain = await storageDomain.open(SESSION_DOMAIN_SPEC);
      const table = domain.table(SESSION_TABLE);
      // Hydrate before publishing `table`, so a read that arrives mid-open
      // cannot observe a durable store that looks emptier than it is.
      for (const [key, value] of table.entries()) {
        /** @type {any} */
        const record = value;
        this.memory.set(key, record.perspective);
      }
      this.table = table;
      this.domain = domain;
      return true;
    } catch (error) {
      this.logger?.warn?.(
        `workspace-profile: session Perspective overrides are memory-only for this run (${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }
  }

  /**
   * The override recorded for one session.
   *
   * @param {string|undefined} sessionId - the session id.
   * @returns {string|undefined} the Perspective id, or `undefined`.
   */
  get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined;
    return this.memory.get(sessionId);
  }

  /**
   * The override that applies to one Agent.
   *
   * @param {any} agent - an Agent.
   * @returns {string|undefined} the Perspective id, or `undefined`.
   */
  overrideFor(agent) {
    return this.get(sessionIdOf(agent));
  }

  /**
   * Record an override for one session.
   *
   * Memory is updated only after the durable write resolves, so a failed write
   * does not leave the running process believing something it will not find
   * again after a restart.
   *
   * @param {string} sessionId - the session id.
   * @param {string} perspective - the Perspective id.
   * @returns {Promise<void>} resolves once the value is visible to {@link get}.
   */
  async set(sessionId, perspective) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new TypeError('a session Perspective override needs a session id');
    }
    if (this.table !== undefined) {
      await this.table.put(sessionId, {
        perspective,
        updatedAt: new Date().toISOString(),
      });
    }
    this.memory.set(sessionId, perspective);
  }

  /**
   * Drop one session's override.
   *
   * @param {string} sessionId - the session id.
   * @returns {Promise<void>} resolves once the override is gone.
   */
  async clear(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (this.table !== undefined) await this.table.delete(sessionId);
    this.memory.delete(sessionId);
  }

  /**
   * Release the domain.
   *
   * Idempotent, and safe to call when nothing was opened.
   *
   * @returns {Promise<void>} resolves once the domain is closed.
   */
  async close() {
    if (this.closed) return;
    this.closed = true;
    const domain = this.domain;
    this.domain = undefined;
    this.table = undefined;
    if (domain === undefined) return;
    // The domain owns the write chain: `close()` rejects new writes and drains
    // the queued ones, so a `/perspective` that is still landing is not lost by
    // unloading the plugin underneath it.
    try {
      await domain.close();
    } catch (error) {
      this.logger?.warn?.(
        `workspace-profile: could not close the session Perspective domain (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

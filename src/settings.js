/**
 * The `workspace-profile` settings namespace and the store around it.
 *
 * ## Why the schema is permissive
 *
 * `SettingsProvider.register` validates the *stored* section and, when it fails,
 * **rejects the registration itself**. A strict schema therefore has a failure
 * mode worse than the corruption it guards against: a user hand-edits
 * `settings.yaml`, registration throws inside a `ctx.inject` callback, Cordis
 * contains the throw, and the namespace silently never exists — so the Settings
 * page that would have let them fix it has nothing to write to.
 *
 * The schema here therefore only declares the document's *shape* and its
 * defaults; every value is `Schema.any()`, so no stored section can fail it.
 * Validation lives in {@link module:dsh-workspace-profile/policy}, runs on every
 * read, and repairs toward safety rather than throwing. Writes are validated
 * before they are issued, so nothing invalid is ever stored by this plugin.
 *
 * A consequence worth naming: `describe()` reports a schema with no field
 * detail, so this namespace contributes no generic schema-driven form. That is
 * intended — the plugin ships its own Settings section — and it is also why
 * `dsh-client-ui-settings-plugins` renders nothing for this namespace (it
 * dispatches one card key per namespace, and no card is registered for ours).
 *
 * @module dsh-workspace-profile/settings
 */

import Schema from '@deepseek-ai/schemastery';

import { SCHEMA_VERSION, SETTINGS_NS, emptyDocument, normalizeDocument } from './policy.js';

/**
 * The namespace schema: shape and defaults only.
 *
 * `workspaces` is keyed by official `WorkspaceId`. Unknown fields at every level
 * survive a round trip — a document written by a newer build that still shares
 * `schemaVersion` must not lose data merely because this build is older.
 */
export const CompositionDocumentSchema = Schema.object({
  /** Contract version. See {@link SCHEMA_VERSION} and the migration runner. */
  schemaVersion: Schema.any().default(SCHEMA_VERSION),
  /** ISO-8601 instant the document was first created. */
  initializedAt: Schema.any().default(''),
  /** `WorkspaceId` → `WorkspacePolicyV1`. */
  workspaces: Schema.any().default({}),
});

export { SETTINGS_NS };

/**
 * The plugin's view of its own settings section.
 *
 * Holds the owner scope (reads and observation) and the provider (revision and
 * path-addressed writes) together, because a revision-aware write needs both and
 * splitting them across call sites is how a stale write gets issued.
 *
 * Every method is total: when the namespace is not registered (no settings
 * provider in this composition, or registration was refused) reads answer with
 * an empty document and writes reject with a named error rather than throwing a
 * property access.
 */
export class CompositionStore {
  /**
   * @param {object} deps - the provider and the owner scope.
   * @param {any} deps.provider - the `ctx.settings` provider.
   * @param {any} deps.scope - the {@link SettingsScope} returned by `register`.
   * @param {{ info: Function, warn: Function, error: Function }} [deps.logger] - diagnostics sink.
   * @param {() => string} [deps.now] - clock, injectable for tests.
   */
  constructor({ provider, scope, logger, now }) {
    /** @private */ this.provider = provider;
    /** @private */ this.scope = scope;
    /** @private */ this.logger = logger;
    /** @private */ this.now = now ?? (() => new Date().toISOString());
    /**
     * The last successful normalization. Kept so a read that throws (an
     * unsupported `schemaVersion`) does not erase the last good document from
     * under a live Settings page.
     * @private
     */
    this.lastGood = emptyDocument(this.now());
    /** @private */ this.registrationError = undefined;
  }

  /**
   * Read the resolved document, normalized to the current schema version.
   *
   * @returns {{ document: any, migratedFrom: number|null, changed: boolean, error: Error|undefined }}
   *   the normalized document plus whether it migrated, whether normalization
   *   changed anything, and a non-fatal read error when the stored document
   *   could not be understood. On error the last good document is returned, so a
   *   caller always has something to render.
   */
  read() {
    let raw;
    try {
      raw = this.scope.get();
    } catch (error) {
      // A getter throw here means the provider is mid-swap; the previous value
      // is still the best answer, and saying so beats an empty document that
      // reads as "no Workspaces configured".
      return { document: this.lastGood, migratedFrom: null, changed: false, error: errorOf(error) };
    }
    try {
      const result = normalizeDocument(raw, this.now());
      this.lastGood = result.document;
      return { ...result, error: undefined };
    } catch (error) {
      return { document: this.lastGood, migratedFrom: null, changed: false, error: errorOf(error) };
    }
  }

  /**
   * The revision of the raw stored section.
   *
   * Read from `describe()` rather than tracked locally: the provider owns the
   * counter, and a locally incremented guess would report a revision that a
   * concurrent external edit (the settings document is watched and hot-reloaded)
   * has already moved past — which is precisely the write this must refuse.
   *
   * @returns {number|undefined} the revision, or `undefined` when the namespace
   *   is not registered (and therefore cannot be written at all).
   */
  revision() {
    try {
      const descriptor = this.provider.describe().find((entry) => entry.ns === SETTINGS_NS);
      return descriptor?.revision;
    } catch {
      return undefined;
    }
  }

  /**
   * Apply path-addressed edits, fenced by the revision the caller read.
   *
   * Path ops, not a wholesale replacement: a Settings page holds the redacted
   * document, and `mutate` applies each op to the section as it stands when the
   * write reaches the front of the queue — so a caller never has to restate
   * fields it did not touch, and cannot delete a field it never saw.
   *
   * @param {ReadonlyArray<{op: 'set', path: readonly string[], value: unknown}|{op: 'unset', path: readonly string[]}>} ops - the edits.
   * @param {number} expectedRevision - the revision the caller read.
   * @returns {Promise<number>} the revision after the write.
   * @throws {import('./errors.js').RevisionConflictError} when the section moved.
   * @throws {import('./errors.js').MissingCapabilityError} when unregistered.
   */
  async write(ops, expectedRevision) {
    if (this.registrationError !== undefined) {
      throw this.registrationError;
    }
    if (typeof expectedRevision !== 'number') {
      // Never write unconditionally from this plugin. The only caller that
      // could not supply a revision is one that never read, and an unconditional
      // write is exactly the silent overwrite the plan forbids.
      throw new TypeError(
        'workspace-profile writes must carry the expectedRevision they read; an unconditional write would silently overwrite a concurrent edit',
      );
    }
    await this.provider.mutate(SETTINGS_NS, ops, expectedRevision);
    const next = this.revision();
    return next ?? expectedRevision + 1;
  }

  /**
   * Observe committed changes to this namespace.
   *
   * @param {(next: any, prev: any) => void} callback - invoked after each commit.
   * @returns {() => void} the disposer.
   */
  watch(callback) {
    return this.scope.watch((next, prev) => {
      callback(next, prev);
    });
  }

  /**
   * Persist a normalization result that changed meaning — a migration, or a
   * repair of an impossible stored pair.
   *
   * Only ever called by the activation path, and only when `read()` reported
   * `changed`, so a boot with a clean document performs no write at all.
   *
   * @param {any} document - the document to store.
   * @param {number} expectedRevision - the revision the read observed.
   * @returns {Promise<boolean>} whether the write was applied.
   */
  async persistNormalized(document, expectedRevision) {
    try {
      await this.provider.replace(SETTINGS_NS, document, expectedRevision);
      return true;
    } catch (error) {
      // A failed repair must not fail the boot: the in-memory document is
      // already correct, so the plugin works for this process and the next
      // boot retries. Reporting beats throwing here.
      this.logger?.warn?.(
        `workspace-profile: could not persist the normalized settings document (${errorOf(error).message}); continuing with the in-memory value`,
      );
      return false;
    }
  }
}

/**
 * Wrap a caught value as an `Error` without losing a non-Error throw.
 *
 * @param {unknown} value - the caught value.
 * @returns {Error} an Error carrying the original text.
 */
function errorOf(value) {
  return value instanceof Error ? value : new Error(String(value));
}

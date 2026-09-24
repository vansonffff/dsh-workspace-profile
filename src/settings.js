/**
 * The `workspace-profile` settings namespace and the store around it.
 *
 * ## Why the schema is permissive
 *
 * Since DSH 0.1.7 the document is a volatile field of this plugin's Profile
 * config. Settings projects that field into a form and writes through the
 * Profile's ConfigEditor. The schema remains permissive so an older or manually
 * edited document can still be displayed and repaired by policy normalization.
 *
 * This schema describes the document's shape for local callers; the active
 * plugin Config declares `document: Schema.any().volatile()`.
 * Validation lives in {@link module:dsh-workspace-profile/policy}, runs on every
 * read, and repairs toward safety rather than throwing. Writes are validated
 * before they are issued, so nothing invalid is ever stored by this plugin.
 *
 * The plugin registers its own Settings section and disables the generic form
 * for this entry with `settings.configure({ auto: false })`.
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
 * Reads and writes the plugin's `document` field through the Profile Settings
 * service. Revision checks remain owned by Settings, including concurrent edits
 * from another window.
 *
 * Every method is total: when the plugin entry is unavailable reads answer with
 * an empty document and writes reject with a named error rather than throwing a
 * property access.
 */
export class CompositionStore {
  /**
   * @param {object} deps - the provider and the owner scope.
   * @param {any} deps.provider - the `ctx.settings` provider.
   * @param {any} deps.ctx - the plugin context used to observe Settings changes.
   * @param {{ info: Function, warn: Function, error: Function }} [deps.logger] - diagnostics sink.
   * @param {() => string} [deps.now] - clock, injectable for tests.
   */
  constructor({ provider, ctx, logger, now }) {
    /** @private */ this.provider = provider;
    /** @private */ this.ctx = ctx;
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
      const descriptor = this.provider.describe().find((entry) => entry.ns === SETTINGS_NS);
      if (descriptor === undefined) throw new Error('workspace-profile is absent from Settings');
      raw = descriptor.value?.document;
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
   * The revision of the active plugin Config form.
   *
   * Read from `describe()` rather than tracked locally: the provider owns the
   * counter, including edits made in another window.
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
   * Path ops, not a wholesale replacement: `mutate` applies each op under the
   * plugin's `document` field when the write reaches the front of the queue,
   * so a caller never has to restate
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
    await this.provider.mutate(
      SETTINGS_NS,
      ops.map((op) => ({ ...op, path: ['document', ...op.path] })),
      expectedRevision,
    );
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
    return this.ctx.on('settings/document-updated', (namespace) => {
      if (namespace === SETTINGS_NS) callback();
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
    if (typeof expectedRevision !== 'number') return false;
    try {
      await this.provider.update(SETTINGS_NS, { document }, expectedRevision);
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

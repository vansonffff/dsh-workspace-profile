/**
 * Error vocabulary for the Workspace Composition plugin.
 *
 * Every failure this plugin raises is one of these, so a caller can branch on
 * `code` instead of matching prose. The model-facing tool turns them into text
 * that says what to do next; the Settings page turns them into a state; neither
 * parses a message string.
 *
 * @module dsh-workspace-profile/errors
 */

/**
 * Base class for every error this package raises.
 *
 * `code` is machine-readable and stable; `message` is written for the reader
 * who has to act on it. Sub-classing rather than tagging keeps `instanceof`
 * usable across module boundaries in tests.
 */
export class WorkspaceProfileError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - what went wrong and what to do about it.
   * @param {object} [details] - optional structured context (never secrets).
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'WorkspaceProfileError';
    /** @type {string} */
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** The stored document declares a `schemaVersion` this build cannot read or migrate. */
export class UnsupportedSchemaVersionError extends WorkspaceProfileError {
  /**
   * @param {unknown} found - the version found in the document.
   * @param {number} supported - the version this build writes.
   */
  constructor(found, supported) {
    super(
      'unsupported-schema-version',
      `the stored workspace-profile document declares schemaVersion ${JSON.stringify(found)}, but this build reads version ${supported} and has no migration from ${JSON.stringify(found)}. ` +
        'Refusing to write: a newer document was probably produced by a newer plugin version. Upgrade the plugin, or back up and remove the `workspace-profile` section from the settings document to start over.',
    );
    /** @type {unknown} */
    this.found = found;
    /** @type {number} */
    this.supported = supported;
  }
}

/** A requested Workspace has no registration in the official registry. */
export class UnknownWorkspaceError extends WorkspaceProfileError {
  /**
   * @param {string} workspaceId - the id that did not resolve.
   */
  constructor(workspaceId) {
    super(
      'unknown-workspace',
      `workspace "${workspaceId}" is not registered. Workspace Composition stores policy against the official Workspace id; a policy whose Workspace was deleted is kept (never auto-deleted) but is not addressable by this call.`,
      { workspaceId },
    );
  }
}

/** The calling Agent has no resolvable Workspace. */
export class NoWorkspaceContextError extends WorkspaceProfileError {
  /**
   * @param {string} reason - why resolution failed.
   */
  constructor(reason) {
    super(
      'no-workspace-context',
      `this session has no Workspace, so Workspace Subagents cannot run: ${reason}. Workspace Subagents are configured per Workspace; open a session inside one and configure it in Settings → Workspace Composition.`,
    );
  }
}

/** A requested Subagent definition is missing, or is disabled. */
export class UnknownSubagentError extends WorkspaceProfileError {
  /**
   * @param {string} reference - the key or name the caller asked for.
   * @param {string[]} available - enabled keys, for the diagnostic.
   */
  constructor(reference, available) {
    const list = available.length > 0 ? available.join(', ') : '(none)';
    super(
      'unknown-subagent',
      `no enabled Workspace Subagent matches "${reference}" in this Workspace. Available keys: ${list}. Call without an argument to list them, or add one in Settings → Workspace Composition.`,
      { reference, available },
    );
  }
}

/**
 * A Subagent asked for the Codex backend, and this deployment does not have one.
 *
 * This error exists to make one behaviour impossible to mistake for another: the
 * plugin **never** substitutes a different backend. It does not fall back to
 * `spawn`, it does not silently pick the parent's model, and it does not install
 * anything. A run that cannot happen on the transport the definition names does
 * not happen at all, and says so here.
 */
export class CodexBackendUnavailableError extends WorkspaceProfileError {
  /**
   * @param {string} reference - the Subagent's key.
   * @param {string[]} registered - the provider names this deployment does register.
   */
  constructor(reference, registered) {
    const list = registered.length > 0 ? registered.join(', ') : '(none)';
    super(
      'codex-backend-unavailable',
      `Workspace Subagent "${reference}" is configured to run on Codex, and no Codex subagent backend is registered in this deployment ` +
        `(registered providers: ${list}). Nothing was started and nothing was substituted: this plugin never falls back to the DSH \`spawn\` backend or ` +
        'to another model. Install and enable the official Codex backend package in this deployment, then restart the Host; or edit the Subagent in ' +
        'Settings → Workspace Configuration and choose the DSH subagent backend.',
      { reference, registered },
    );
  }
}

/**
 * More than one registered provider claims to be the Codex backend.
 *
 * Detected rather than guessed: if two providers both answer to a Codex name,
 * picking one would be a coin toss over where the user's work runs.
 */
export class AmbiguousCodexBackendError extends WorkspaceProfileError {
  /**
   * @param {string[]} candidates - the provider names that matched.
   */
  constructor(candidates) {
    super(
      'ambiguous-codex-backend',
      `more than one registered subagent provider claims to be the Codex backend (${candidates.join(', ')}), so this plugin cannot tell which one a Codex ` +
        'Subagent should run on. Nothing was started. Leave exactly one Codex provider enabled in the deployment composition, then restart the Host.',
      { candidates },
    );
  }
}

/** A Subagent definition is malformed, or collides with an existing one. */
export class InvalidSubagentError extends WorkspaceProfileError {
  /**
   * @param {string} message - field-level explanation.
   * @param {object} [details] - structured context.
   */
  constructor(message, details) {
    super('invalid-subagent', message, details);
  }
}

/** The selected model route cannot be resolved by the live LLM runtime. */
export class UnresolvableRouteError extends WorkspaceProfileError {
  /**
   * @param {string} message - which part of the route failed and how to fix it.
   * @param {object} [details] - `{ provider, model, reasoningEffort }`.
   */
  constructor(message, details) {
    super('unresolvable-route', message, details);
  }
}

/** A write was refused because the stored namespace moved past the caller's revision. */
export class RevisionConflictError extends WorkspaceProfileError {
  /**
   * @param {number} expected - the revision the caller held.
   * @param {number} actual - the revision actually stored.
   * @param {object} [draft] - the caller's unsaved edits, so a UI can offer "copy my edits".
   */
  constructor(expected, actual, draft) {
    super(
      'revision-conflict',
      `the workspace-profile configuration changed in another window (expected revision ${expected}, found ${actual}). Nothing was written. Reload to take the other change, or copy your edits before reloading.`,
      { expected, actual, draft },
    );
    /** @type {number} */
    this.expected = expected;
    /** @type {number} */
    this.actual = actual;
  }
}

/** The plugin is mounted but one of its required seams is missing. */
export class MissingCapabilityError extends WorkspaceProfileError {
  /**
   * @param {string} capability - the seam or service that is absent.
   * @param {string} consequence - what is therefore unavailable.
   */
  constructor(capability, consequence) {
    super(
      'missing-capability',
      `${capability} is not mounted in this deployment, so ${consequence}. This is a composition fact, not a bug: mount the matching package and restart the Host.`,
      { capability },
    );
  }
}

/** A dispatch ended with a stop reason other than `completed`. */
export class SubagentRunFailedError extends WorkspaceProfileError {
  /**
   * @param {string} stopReason - the terminal reason reported by the seam.
   * @param {string|undefined} diagnostic - provider-authored detail, when supplied.
   * @param {string} message - model-facing explanation.
   */
  constructor(stopReason, diagnostic, message) {
    super('subagent-run-failed', message, { stopReason, diagnostic });
    /** @type {string} */
    this.stopReason = stopReason;
    if (diagnostic !== undefined) {
      /** @type {string} */
      this.diagnostic = diagnostic;
    }
  }
}

/**
 * Explain a non-`completed` stop reason in the words the caller needs.
 *
 * One function, so the tool, the `/agent` command and the tests cannot drift
 * apart on what `aborted` means.
 *
 * @param {string} stopReason - one of the seam's stop reasons.
 * @param {string} [diagnostic] - provider-authored detail.
 * @returns {string} a sentence naming the cause and the next action.
 */
export function explainStopReason(stopReason, diagnostic) {
  const suffix = diagnostic !== undefined && diagnostic !== '' ? ` Provider detail: ${diagnostic}` : '';
  switch (stopReason) {
    case 'aborted':
      return `the Subagent run was cancelled before it finished. Its partial output, if any, follows.${suffix}`;
    case 'error':
      return `the Subagent run failed at the model or transport layer. Retrying is reasonable; if it repeats, check the configured model route in Settings → Workspace Composition.${suffix}`;
    case 'max-tokens':
      return `the Subagent hit its output-token ceiling before finishing, so its answer is truncated and must not be treated as complete. Narrow the task, or raise the model's maxTokens.${suffix}`;
    case 'refusal':
      return `the Subagent declined the task. The delegation needs rewording, or a different agent.${suffix}`;
    default:
      return `the Subagent run ended with stop reason "${stopReason}" rather than completing. Treat any output as partial.${suffix}`;
  }
}

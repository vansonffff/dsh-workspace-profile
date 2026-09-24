/**
 * The one table both Typert Remote faces are built from.
 *
 * A Remote has two artifacts — a Host manifest and a Client contribution — and
 * they must agree on every method name, parameter and alias. Deriving both from
 * this table makes disagreement impossible rather than merely unlikely. The
 * browser bundle has no bundler and so cannot import this file; it carries a copy
 * in `typert.remote-client.js`, and `test/remote-contract.test.js` asserts the
 * copy is deeply equal to this table. That test is the only reason the
 * duplication is acceptable.
 *
 * ## Why every method carries an `implementation` alias
 *
 * The Gateway reads a Remote member's **source text** and rejects any parameter
 * that is not a plain identifier — no destructuring, no defaults, no rest. The
 * service's methods are written for humans (`savePolicy({ workspaceId, patch })`)
 * and would be rejected outright, so each Remote member is a separate
 * `remoteX(args, signal)` whose body does the destructuring. The alias is the
 * name the browser calls.
 *
 * @module dsh-workspace-profile/remote/invocations
 */

/** The package name the Gateway keys descriptors by. */
export const WORKSPACE_PROFILE_PACKAGE = 'dsh-workspace-profile';

/** The Remote namespace, and therefore what the browser reads as `ctx.remote.workspaceProfile`. */
export const WORKSPACE_PROFILE_NAMESPACE = 'workspaceProfile';

/**
 * Every Remote method.
 *
 * `parameters` lists the *business* arguments in declaration order. The trailing
 * cancellation signal is not listed: the Gateway appends it, and declaring it
 * here would present it as something the browser has to pass.
 *
 * @type {ReadonlyArray<{ method: string, implementation: string, parameters: ReadonlyArray<{ name: string }>, cancellable?: boolean }>}
 */
export const REMOTE_INVOCATIONS = Object.freeze([
  /** Everything the Settings page needs in one round trip. */
  { method: 'snapshot', implementation: 'remoteSnapshot', parameters: [], cancellable: true },
  /** Skill catalog rows for one Workspace (lazy: only the selected one). */
  { method: 'skills', implementation: 'remoteSkills', parameters: [{ name: 'args' }], cancellable: true },
  /**
   * The literal text this Workspace contributes to the system prompt.
   *
   * Read-only, and composed by the same three functions the prompt sections use,
   * so "what the page shows" and "what the model is told" cannot drift. The page
   * shows a *stored* answer; the live prompt may differ by the session's
   * `/perspective` override, which is per session and deliberately not readable
   * from here.
   */
  { method: 'previewInjection', implementation: 'remotePreviewInjection', parameters: [{ name: 'args' }], cancellable: true },
  /**
   * Read the CaseBench Matter this Workspace's directory sits inside, and compare
   * it against the stored configuration. Read-only: nothing here writes a Profile,
   * a Perspective or a Matter.
   */
  { method: 'matter', implementation: 'remoteMatter', parameters: [{ name: 'args' }], cancellable: true },
  /** Provider / model / reasoning-effort catalog. */
  { method: 'models', implementation: 'remoteModels', parameters: [], cancellable: true },
  /** Non-throwing route verdict for one saved definition. */
  { method: 'validateRoute', implementation: 'remoteValidateRoute', parameters: [{ name: 'args' }], cancellable: true },
  /** Profile / Perspective / onboarding write for one Workspace. */
  { method: 'savePolicy', implementation: 'remoteSavePolicy', parameters: [{ name: 'args' }] },
  /** Create or replace one Subagent definition. */
  { method: 'putSubagent', implementation: 'remotePutSubagent', parameters: [{ name: 'args' }] },
  /** Duplicate a definition under a new key. */
  { method: 'duplicateSubagent', implementation: 'remoteDuplicateSubagent', parameters: [{ name: 'args' }] },
  /** Delete one Subagent definition. */
  { method: 'removeSubagent', implementation: 'remoteRemoveSubagent', parameters: [{ name: 'args' }] },
  /** Enable or disable one Skill for a Workspace. */
  { method: 'setSkillState', implementation: 'remoteSetSkillState', parameters: [{ name: 'args' }] },
  /** Drop the stored policy of a Workspace that no longer exists. */
  { method: 'pruneOrphan', implementation: 'remotePruneOrphan', parameters: [{ name: 'args' }] },
]);

/**
 * Build the descriptor list a Host manifest carries.
 *
 * The value schema is a free-form record on purpose: the service validates its
 * own result and produces far better diagnostics than a wire schema rejection
 * would, while the Gateway still gets a real codec for every value.
 *
 * @param {object} codecs - schema factories.
 * @param {(kind: string) => any} codecs.parameterSchema - schema for one parameter.
 * @param {(kind: string) => any} codecs.valueSchema - schema for a result.
 * @returns {any[]} the descriptors.
 */
export function buildRemoteDescriptors({ parameterSchema, valueSchema }) {
  const namespace = WORKSPACE_PROFILE_NAMESPACE;
  return REMOTE_INVOCATIONS.map((invocation) => ({
    id: `${WORKSPACE_PROFILE_PACKAGE}#${namespace}/${invocation.method}`,
    service: namespace,
    namespace,
    method: invocation.method,
    // The alias the strict dispatcher invokes. Always present: every Remote
    // member is a `remoteX` wrapper, because the public signatures are exactly
    // what the Gateway refuses.
    implementation: invocation.implementation,
    invocation: { kind: 'direct' },
    parameters: invocation.parameters.map((parameter) => ({
      name: parameter.name,
      wire: parameter.name,
      source: 'json',
      acceptsUndefined: false,
      codec: {
        mode: 'strict',
        typeSymbol: `${WORKSPACE_PROFILE_PACKAGE}#${namespace}/${invocation.method}:${parameter.name}`,
        create: () => parameterSchema('freeObject'),
      },
    })),
    ...(invocation.cancellable ? { cancellation: { parameter: 'signal' } } : {}),
    result: {
      mode: 'strict',
      typeSymbol: `${WORKSPACE_PROFILE_PACKAGE}#${namespace}/${invocation.method}:result`,
      create: () => valueSchema('freeObject'),
    },
  }));
}

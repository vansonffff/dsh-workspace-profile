/**
 * Client-face descriptor table for the browser bundle.
 *
 * `client.js` is a classic script with no bundler, so it cannot `import` the
 * shared table in `src/remote/invocations.js` — it carries this copy instead.
 * A copy that drifts is worse than no copy, so `test/remote-contract.test.js`
 * imports BOTH and asserts they are deeply equal; that test is the only reason
 * this duplication is acceptable.
 *
 * @module dsh-workspace-profile/remote/descriptors.client
 */

/** The package name the Gateway keys descriptors by. Mirrors `WORKSPACE_PROFILE_PACKAGE`. */
export const WORKSPACE_PROFILE_PACKAGE = 'dsh-workspace-profile';

/** The Remote namespace. Mirrors `WORKSPACE_PROFILE_NAMESPACE`. */
export const WORKSPACE_PROFILE_NAMESPACE = 'workspaceProfile';

/**
 * Build the client contribution's descriptor list.
 *
 * @param {(kind: string) => any} schema - the passthrough codec factory.
 * @returns {any[]} the descriptors.
 */
export function buildClientDescriptors(schema) {
  /** Mirrors `REMOTE_INVOCATIONS` exactly. */
  const invocations = [
    { method: 'snapshot', implementation: 'remoteSnapshot', parameters: [], cancellable: true },
    { method: 'skills', implementation: 'remoteSkills', parameters: [{ name: 'args' }], cancellable: true },
    { method: 'previewInjection', implementation: 'remotePreviewInjection', parameters: [{ name: 'args' }], cancellable: true },
    { method: 'models', implementation: 'remoteModels', parameters: [], cancellable: true },
    { method: 'validateRoute', implementation: 'remoteValidateRoute', parameters: [{ name: 'args' }], cancellable: true },
    { method: 'savePolicy', implementation: 'remoteSavePolicy', parameters: [{ name: 'args' }] },
    { method: 'putSubagent', implementation: 'remotePutSubagent', parameters: [{ name: 'args' }] },
    { method: 'duplicateSubagent', implementation: 'remoteDuplicateSubagent', parameters: [{ name: 'args' }] },
    { method: 'removeSubagent', implementation: 'remoteRemoveSubagent', parameters: [{ name: 'args' }] },
    { method: 'setSkillState', implementation: 'remoteSetSkillState', parameters: [{ name: 'args' }] },
    { method: 'pruneOrphan', implementation: 'remotePruneOrphan', parameters: [{ name: 'args' }] },
  ];

  const namespace = WORKSPACE_PROFILE_NAMESPACE;
  return invocations.map((invocation) => ({
    id: `${WORKSPACE_PROFILE_PACKAGE}#${namespace}/${invocation.method}`,
    service: namespace,
    namespace,
    method: invocation.method,
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
        schema: schema('freeObject'),
      },
    })),
    ...(invocation.cancellable ? { cancellation: { parameter: 'signal' } } : {}),
    result: {
      mode: 'strict',
      typeSymbol: `${WORKSPACE_PROFILE_PACKAGE}/${namespace}#${invocation.method}:result`,
      schema: schema('freeObject'),
    },
  }));
}

/**
 * The contribution a Client assembly mounts with `ctx.remote.$mount(...)`, which
 * is what makes `ctx.remote.workspaceProfile` exist.
 *
 * @type {any}
 */
export const TYPERT_REMOTE = {
  package: WORKSPACE_PROFILE_PACKAGE,
  descriptors: buildClientDescriptors(() => ({ mode: 'strict', parse: (value) => value })),
};

export default TYPERT_REMOTE;

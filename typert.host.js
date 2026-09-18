/**
 * Host face of the `workspaceProfile` Typert Remote.
 *
 * `@deepseek-ai/dsh-typert-loader` discovers this module because the package
 * declares `"./typert"` in its `exports`: when the loader entry mounts, the
 * loader imports this module, calls `ctx.typert.register(TYPERT)`, and withdraws
 * the registration on unmount. Nothing in DSH core needs to know this package
 * exists.
 *
 * Hand-written, not generated: `dsh-typert-generator` is a source-tree build step
 * and is not part of the installed distribution. It follows the generator's output
 * shape (see `dsh-host-plugin-inventory/lib/typert.host.js` in the DSH install)
 * while deriving every descriptor from {@link module:dsh-workspace-profile/remote/invocations}.
 *
 * @module dsh-workspace-profile/typert.host
 */

import { z } from 'zod';

import {
  REMOTE_INVOCATIONS,
  WORKSPACE_PROFILE_NAMESPACE,
  WORKSPACE_PROFILE_PACKAGE,
  buildRemoteDescriptors,
} from './src/remote/invocations.js';
import { hostSchema } from './src/remote/schemas.js';

/**
 * The manifest registered into `ctx.typert`.
 *
 * `model.services` stays empty: that array declares Cordis-service projections,
 * and a facade that exposes methods has none — an honest empty rather than a
 * fabricated surface.
 *
 * @type {any}
 */
export const TYPERT = {
  package: WORKSPACE_PROFILE_PACKAGE,
  face: 'host',
  schemas: [],
  invocations: buildRemoteDescriptors({
    parameterSchema: (kind) => hostSchema(z, kind),
    // The business value only. The Gateway adds the `{ ok, value }` envelope on
    // the wire; validating a second one here rejected every result the first time
    // this pattern was tried in this workspace.
    valueSchema: (kind) => hostSchema(z, kind),
  }),
  model: { services: [], events: [], objects: [] },
};

export { REMOTE_INVOCATIONS, WORKSPACE_PROFILE_NAMESPACE, WORKSPACE_PROFILE_PACKAGE };

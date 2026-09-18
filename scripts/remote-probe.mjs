/**
 * Call one `workspaceProfile` Remote operation on a real, fully booted tree.
 *
 * Split from `boot-probe.mjs` because the interesting failures are different:
 * that script answers "did the row activate", this one answers "does the
 * operation answer". A Remote method that never settles looks identical to a
 * slow one from the browser, and the browser has no stack to show.
 *
 * Usage: node scripts/remote-probe.mjs [method] [--args '<json>']
 */

import { resolve } from 'node:path';

import { boot, loadOptionalPatches, loadProfile, renderConfigDump } from '@deepseek-ai/dsh-app-boot';

import { requireIsolatedHome } from './isolated-home.mjs';

const INSTALL_ANCHOR = '/Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json';
const BIN_NAME = 'dsh';
const args = process.argv.slice(2);
const method = args[0] ?? 'snapshot';
const rawArgs = args.includes('--args') ? JSON.parse(args[args.indexOf('--args') + 1]) : undefined;
const home = requireIsolatedHome(args.includes('--home') ? args[args.indexOf('--home') + 1] : undefined);

const profile = loadProfile(BIN_NAME, 'web', INSTALL_ANCHOR, home, { userLayer: true });
const homePatches = loadOptionalPatches(BIN_NAME, `${home}/cordis.patch.yml`) ?? [];
const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
const allPatches = [...bundlePatches, ...profile.patches, ...homePatches, { id: 'dsh-pocket', disabled: true }];

const { provideCmdline } = await import('@deepseek-ai/dsh-cmdline');
const { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } = await import(
  '@deepseek-ai/dsh-launch-environment'
);

const ctx = await boot(BIN_NAME, `${profile.dir}/cordis.yml`, structuredClone(allPatches), (hostCtx) => {
  hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]));
  provideCmdline(hostCtx, {
    args: ['--port', '0', '--no-open'],
    exit: () => {},
    ready: { resolve: () => {}, promise: Promise.resolve(), settled: () => {} },
  });
});

const service = ctx.get('workspaceProfile');
process.stdout.write(`service: ${service === undefined ? 'MISSING' : 'present'}\n`);
if (service === undefined) process.exit(1);

// The gateway only answers an endpoint it CLAIMS. One it does not claim is not
// a 404: the interceptor declines and the HTTP request is simply never answered,
// which is why the browser sees a call that hangs forever with no error.
const typert = ctx.get('typert');
const gateway = ctx.get('typertGateway');
process.stdout.write(`local.get("workspaceProfile/snapshot"): ${JSON.stringify(typert?.local?.get?.('workspaceProfile/snapshot') !== undefined)}\n`);
process.stdout.write(`local.hasSeen("workspaceProfile/snapshot"): ${JSON.stringify(typert?.local?.hasSeen?.('workspaceProfile/snapshot'))}\n`);
process.stdout.write(`gateway.claimsEndpoint("workspaceProfile/snapshot"): ${JSON.stringify(gateway?.claimsEndpoint?.('workspaceProfile/snapshot'))}\n`);
process.stdout.write(`gateway.claimsEndpoint("settings/describe"): ${JSON.stringify(gateway?.claimsEndpoint?.('settings/describe'))}\n`);
try {
  const invoked = await gateway.invoke({ namespace: 'workspaceProfile', method: 'snapshot', args: new Map() });
  process.stdout.write(`gateway.invoke OK: ${JSON.stringify(invoked).slice(0, 200)}\n`);
} catch (error) {
  process.stdout.write(`gateway.invoke FAILED: ${error?.message}\n${error?.stack?.split('\n').slice(0, 6).join('\n')}\n`);
}

const call = service[method];
process.stdout.write(`method ${method}: ${typeof call}\n`);
try {
  const started = Date.now();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED OUT after 10s')), 10_000));
  const value = await Promise.race([Promise.resolve(call.call(service, rawArgs)), timeout]);
  const json = JSON.stringify(value);
  process.stdout.write(`resolved in ${Date.now() - started}ms, ${json.length} bytes\n`);
  process.stdout.write(`${json.slice(0, 3000)}\n`);
} catch (error) {
  process.stdout.write(`FAILED: ${error?.message}\n${error?.stack ?? ''}\n`);
}
await ctx.fiber.dispose();
process.exit(0);

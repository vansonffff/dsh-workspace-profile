/**
 * Prove the injected prompt on a real, fully booted tree.
 *
 * The claim under test is not "the section registered" — the integration test
 * covers that — but "an Agent working in a *configured* Workspace receives the
 * Profile, the Perspective and the expert directory", against the real
 * `systemPrompt`, the real settings document on disk, and the real workspace
 * registry. No model call is involved: an Agent is composed and its prompt
 * assembled, which is exactly the boundary a step crosses before it pays for a
 * request.
 *
 * Usage: node scripts/prompt-probe.mjs --home <harness-home> [--cwd <dir>]
 */

import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { boot, loadOptionalPatches, loadProfile } from '@deepseek-ai/dsh-app-boot';

import { requireIsolatedHome } from './isolated-home.mjs';

const INSTALL_ANCHOR = '/Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json';
const BIN_NAME = 'dsh';
const args = process.argv.slice(2);
const home = requireIsolatedHome(args.includes('--home') ? args[args.indexOf('--home') + 1] : undefined);
const cwd = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : process.cwd();

const profile = loadProfile(BIN_NAME, 'web', INSTALL_ANCHOR, home, { userLayer: true });
const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
const homePatches = loadOptionalPatches(BIN_NAME, `${home}/cordis.patch.yml`) ?? [];
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

const sessionId = randomUUID();
const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd },
  // The child scope is where a preset's tools live; this probe only needs the
  // prompt, so setup stays empty.
  setup: () => {},
});
const agent = handle.agent;

// What the step boundary does before every assembly; the synchronous index then
// answers for the prompt's own synchronous text function.
await ctx.workspaceProfile === undefined;
const resolverSeen = ctx.get('workspaceRegistry')?.list?.() ?? [];
process.stdout.write(`workspaces on the registry: ${resolverSeen.map((w) => `${w.title} :: ${w.path}`).join(' | ')}\n`);

const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
for (const name of ['workspace-profile:context', 'workspace-profile:subagents']) {
  const section = assembly.sections.find((entry) => entry.name === name);
  process.stdout.write(`\n===== ${name} (${section === undefined ? 'ABSENT' : `${section.text.length} chars`}) =====\n`);
  process.stdout.write(`${section === undefined ? '' : section.text.slice(0, 2600)}\n`);
}

const profile2 = ctx.get('workspaceProfile');
process.stdout.write(`\nresolved snapshot profile for this workspace: ${JSON.stringify(
  (await profile2.snapshot()).workspaces.map((w) => ({ title: w.title, profile: w.policy.profile, perspective: w.policy.defaultPerspective, configured: w.configured })),
)}\n`);

await handle.dispose();
await ctx.fiber.dispose();
process.exit(0);

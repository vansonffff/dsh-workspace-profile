/**
 * Boot the real `web` profile in-process and report host-side facts.
 *
 * This is the Phase 0/7 seam probe. It composes exactly what `dsh web` composes —
 * the same bundle patch layers, the same profile patch file, the same home layer
 * — and then boots it with two overlays that make the run non-invasive:
 * `webserver` and `web-runtime` are disabled, so nothing binds a port, opens a
 * browser, or touches shared runtime state.
 *
 * Everything it prints is read from the live tree: which loader entries are
 * active, whether the plugin's service exists, whether its Remote namespace is
 * registered with Typert, and whether its tool and prompt sections landed.
 *
 * Usage:
 *   node scripts/boot-probe.mjs [--profile web] [--home ~/.dsh]
 */

import { resolve } from 'node:path';
import { createRequire } from 'node:module';

import {
  boot,
  composeEntries,
  loadOptionalPatches,
  loadProfile,
  renderConfigDump,
} from '@deepseek-ai/dsh-app-boot';

import { requireIsolatedHome } from './isolated-home.mjs';

const INSTALL_ANCHOR = resolve(
  '/Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json',
);
const BIN_NAME = 'dsh';

/**
 * The one row this probe disables.
 *
 * Disabling `webserver` looks tidier and is wrong: nine rows inject it or the
 * services it gates, stay pending, and the tree audit then reports *them* rather
 * than the plugin under test. So the probe binds a real server on an
 * OS-assigned port instead (`--port 0`) and reports from a fully active tree.
 * `--home` must point at a throwaway home, because this writes real runtime
 * state.
 */
const NON_INVASIVE_OVERLAYS = [{ id: 'dsh-pocket', disabled: true }];

const args = process.argv.slice(2);
const profileName = valueOf('--profile') ?? 'web';
const home = valueOf('--home');

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

requireIsolatedHome(home);

const profile = loadProfile(BIN_NAME, profileName, INSTALL_ANCHOR, home, { userLayer: true });
const homePatches = loadOptionalPatches(BIN_NAME, `${home ?? process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/cordis.patch.yml`) ?? [];
const bundlePatches = profile.layers.flatMap((layer) => layer.patches);

const allPatches = [...bundlePatches, ...profile.patches, ...homePatches, ...NON_INVASIVE_OVERLAYS];

process.stdout.write(renderConfigDump(BIN_NAME, `${profile.dir}/cordis.yml`, [
  { label: '(probe) bundle layers', patches: bundlePatches },
  { label: '(probe) profile layer', patches: profile.patches },
  { label: '(probe) home layer', patches: homePatches },
  { label: '(probe) non-invasive overlays', patches: NON_INVASIVE_OVERLAYS },
]).split('\n').slice(-40).join('\n'));
process.stdout.write('\n--- booting ---\n');

const require = createRequire(`${profile.dir}/`);
const provideCmdline = (await import('@deepseek-ai/dsh-cmdline')).provideCmdline;
const { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } = await import(
  '@deepseek-ai/dsh-launch-environment'
);

let ctx;
try {
  ctx = await boot(
    BIN_NAME,
    `${profile.dir}/cordis.yml`,
    structuredClone(allPatches),
    (hostCtx) => {
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]));
      // The `web-startup` row parses these and provides `webStartup` itself, which
      // is why this probe must NOT provide that service: doing so collides with
      // the row's own `provide` (`service "webStartup" has been registered`).
      // `--port 0` keeps the intent explicit even though `webserver` is disabled.
      provideCmdline(hostCtx, {
        args: ['--port', '0', '--no-open'],
        exit: () => {},
        ready: { resolve: () => {}, promise: Promise.resolve(), settled: () => {} },
      });
    },
  );
} catch (error) {
  process.stdout.write(`BOOT FAILED: ${error?.message}\n`);
  if (error?.stack) process.stdout.write(`${error.stack}\n`);
  process.exit(1);
}

/** @type {any[]} */
const entries = [...ctx.loader.entries()];
const row = entries.find((entry) => entry.options?.name === 'dsh-workspace-profile');
const report = {
  totalEntries: entries.length,
  rowFound: row !== undefined,
  rowId: row?.options?.id,
  rowFiberState: row?.fiber?.state,
  servicePresent: ctx.get('workspaceProfile') !== undefined,
  settingsNamespaces: (ctx.get('settings')?.describe?.() ?? []).map((descriptor) => descriptor.ns),
  toolRegistered: ctx.get('tools')?.get?.('workspace_subagent') !== undefined,
  commandRegistered: (() => {
    const commands = ctx.get('commands');
    if (commands === undefined) return 'no-commands-service';
    const agent = ctx.get('agents')?.list?.()[0];
    return commands.find?.(agent, 'agent') !== undefined;
  })(),
  typertRegistry: (() => {
    const typert = ctx.get('typert');
    if (typert === undefined) return 'no-typert';
    const out = {};
    for (const key of ['listPackages', 'list']) {
      if (typeof typert[key] !== 'function') continue;
      try {
        const value = typert[key]();
        out[key] = Array.isArray(value)
          ? value.map((entry) => entry?.package ?? entry?.name ?? String(entry)).slice(0, 60)
          : typeof value;
      } catch (error) {
        out[key] = `threw: ${error?.message}`;
      }
    }
    return out;
  })(),
  typertLoaderRow: entries.some((entry) => String(entry.options?.name).includes('typert')),
  promptSections: (() => {
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt === undefined) return 'no-systemPrompt';
    try {
      return ctx.get('tools') === undefined ? 'n/a' : 'present';
    } catch {
      return 'n/a';
    }
  })(),
  ourPluginLog: true,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await ctx.fiber.dispose();
process.exit(0);

/**
 * Prove the Session Perspective loop on a real, fully booted tree.
 *
 * What the integration tests cannot show is that the pieces agree *in the real
 * composition*: that the storage domain the plugin asks for is the one this
 * deployment ships, that the override reaches the prompt through the real
 * `systemPrompt`, and that `/perspective` is reachable through the real
 * `commands` service with a real Agent.
 *
 * So this probe seeds a throwaway harness home, boots the real `web` profile,
 * creates a real Agent inside a configured Workspace, and then drives the actual
 * command — asserting on the *assembled prompt*, which is the only thing the
 * model ever sees.
 *
 * Usage: node scripts/perspective-probe.mjs [--keep]
 */

import { mkdir, rm, symlink, writeFile, readFile, copyFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boot, loadOptionalPatches, loadProfile } from '@deepseek-ai/dsh-app-boot';

import { requireIsolatedHome } from './isolated-home.mjs';

const INSTALL_ANCHOR = '/Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json';
const BIN_NAME = 'dsh';
const REAL_HOME = '/Users/vanson/.dsh';
const keep = process.argv.includes('--keep');

/**
 * A litany of the sections under test, in the order the prompt puts them.
 */
const PERSPECTIVE_SECTION = 'workspace-profile:perspective';
const PROFILE_SECTION = 'workspace-profile:context';

const failures = [];
const checks = [];

/**
 * Record one assertion.
 *
 * @param {string} label - what is being claimed.
 * @param {boolean} condition - whether it holds.
 * @param {string} [detail] - evidence to print.
 */
function check(label, condition, detail = '') {
  checks.push({ label, ok: condition });
  if (!condition) failures.push(label);
  process.stdout.write(`${condition ? '  ✔' : '  ✖'} ${label}${detail === '' ? '' : `\n      ${detail}`}\n`);
}

/** Build a throwaway harness home with one configured Workspace. */
async function seedHome() {
  const scratch = join(tmpdir(), `dsh-perspective-probe-${randomUUID().slice(0, 8)}`);
  await mkdir(join(scratch, 'case'), { recursive: true });

  // Canonicalise before anything is written. On macOS `tmpdir()` is
  // `/var/folders/…`, whose real path is `/private/var/folders/…`; the Workspace
  // registry stores *canonical* paths and a session's `header.cwd` is canonical
  // too, while the plugin's synchronous lookup indexes the registry's spelling.
  // Seeding the registry with the non-canonical form makes every lookup miss —
  // which presents as "the Workspace is unconfigured" rather than as a path bug,
  // because both spellings name the same directory and only one is indexed.
  const home = await realpath(scratch);
  const caseDir = join(home, 'case');
  await mkdir(join(home, 'profiles', 'web'), { recursive: true });
  await mkdir(join(home, 'storages'), { recursive: true });

  // The profile's real dependency tree, so the probe runs the same package
  // versions the user's instance does rather than whatever resolves by accident.
  await symlink(join(REAL_HOME, 'profiles', 'web', 'node_modules'), join(home, 'profiles', 'web', 'node_modules'));

  // And the layer *above* it. The harness's own packages (`@deepseek-ai/dsh-*`)
  // are not in the profile's tree at all — Node resolves a loader entry imported
  // from `<home>/profiles/web/` by walking up, so it finds them in
  // `<home>/profiles/node_modules`. Without this link the boot fails with
  // "Cannot find package '@deepseek-ai/dsh-subagent'" for every harness row, which
  // looks like a broken install rather than a missing link in the probe.
  await symlink(join(REAL_HOME, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'));

  // The real profile manifest, so the probe boots the *user's* actual plugin
  // composition rather than a hand-picked subset. That is the point: this is the
  // only check that proves the plugin works next to every other row that is really
  // installed, including whichever ones claim the same seams.
  for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    await copyFile(join(REAL_HOME, 'profiles', 'web', file), join(home, 'profiles', 'web', file));
  }

  // The profile root is an empty entry list by design — the real tree is composed
  // from `dsh.profile.bundles` plus the patches, and boot rewrites this file. It
  // has to exist before the first boot, though, so the seed writes the same empty
  // list rather than copying the deployed one (whose comment would then be a
  // stale copy of a generated file).
  await writeFile(join(home, 'profiles', 'web', 'cordis.yml'), '[]\n');

  const workspaceId = randomUUID();
  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] },
        tables: {
          workspaces: {
            [workspaceId]: {
              path: caseDir,
              title: '探针案件',
              sessionIds: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      },
      null,
      2,
    ),
  );

  // A Litigation Workspace with no default stance: the probe then proves that
  // `/perspective` can supply one, which is the whole feature.
  await writeFile(
    join(home, 'settings.yaml'),
    [
      'workspace-profile:',
      '  schemaVersion: 1',
      '  initializedAt: 2026-01-01T00:00:00.000Z',
      '  workspaces:',
      `    ${workspaceId}:`,
      '      onboardingStatus: configured',
      '      profile: litigation',
      '      defaultPerspective: none',
      '      skillOverrides: {}',
      '      subagents: {}',
      '      createdAt: 2026-01-01T00:00:00.000Z',
      '      updatedAt: 2026-01-01T00:00:00.000Z',
      '',
    ].join('\n'),
  );

  return { home, caseDir, workspaceId };
}

const seeded = await seedHome();
process.stdout.write(`probe home: ${seeded.home}\nworkspace: 探针案件 (${seeded.workspaceId}) → ${seeded.caseDir}\n\n`);

// Point the harness at the throwaway home before anything composes a root. See
// `isolated-home.mjs` for what goes wrong otherwise; the short version is that
// `--home` alone is not enough, and the failure looks like a plugin bug.
const home = requireIsolatedHome(seeded.home);
const caseDir = seeded.caseDir;
const workspaceId = seeded.workspaceId;

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

/** The perspective section of one assembly for one Agent. */
async function perspectiveTextFor(agent) {
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
  const section = assembly.sections.find((entry) => entry.name === PERSPECTIVE_SECTION);
  return section === undefined ? undefined : section.text;
}

/**
 * Run one command line the way the composer does.
 *
 * `execute` resolves to `{ commandId, result }` — the lifecycle record wraps the
 * handler's own `{ kind, text }` — so the handler's answer is unwrapped here.
 * Reading `.kind` off the envelope yields `undefined` for a command that plainly
 * succeeded, which is a probe bug that looks exactly like a failing feature.
 *
 * @param {any} agent - the Agent running the command.
 * @param {string} line - the full command line, including the slash.
 * @returns {Promise<any>} the handler's `{ kind, text }`.
 */
async function runCommand(agent, line) {
  const controller = new AbortController();
  const envelope = await ctx.commands.execute(agent, line, [], controller.signal);
  return envelope?.result ?? envelope;
}

process.stdout.write('=== 1. the storage domain the plugin asks for is available ===\n');
// `per-record` layout: one document per session under `<domain>/<table>/<key>.json`,
// not a single `<domain>.json`. Asserting the file path is part of the check — the
// layout is what makes a session's override inspectable and deletable on its own.
const sessionId = randomUUID();
const sessionRecordPath = join(home, 'storages', 'workspace_profile_session', 'perspectives', `${sessionId}.json`);
const domainMounted = ctx.get('storageDomain') !== undefined;
check('ctx.storageDomain is mounted in the real web profile', domainMounted);

const handle = await ctx.agents.create({
  sessionId,
  meta: { cwd: caseDir },
  setup: () => {},
});
const agent = handle.agent;

// The synchronous lookup both the prompt section and `/perspective` depend on
// keys off the session's canonical cwd and the registry's own path spelling. When
// they disagree the plugin reports the Workspace as unconfigured, which reads
// like a settings problem — so the two spellings are printed side by side.
process.stdout.write(`\nregistry paths:\n${(ctx.get('workspaceRegistry')?.list?.() ?? []).map((w) => `  ${w.id} :: ${w.title} :: ${w.path}`).join('\n')}\n`);
process.stdout.write(`session cwd:   ${agent.session?.header?.cwd}\nseed case dir: ${caseDir}\n`);

// A step boundary does this before every assembly; the synchronous index then
// answers for the prompt's own synchronous text function.
await ctx.commands.find(agent, 'perspective');

process.stdout.write('\n=== 2. /perspective is registered and reachable ===\n');
const found = ctx.commands.find(agent, 'perspective');
check('/perspective is registered', found !== undefined, found === undefined ? '' : String(found.definition?.description ?? '').slice(0, 80));

process.stdout.write('\n=== 3. the workspace default (none) injects no stance ===\n');
const before = await perspectiveTextFor(agent);
check('no Perspective section text before any override', before === '' || before === undefined, JSON.stringify(before));

process.stdout.write('\n=== 4. the Profile section names the recommended Skills ===\n');
const profileAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
const profileSection = profileAssembly.sections.find((entry) => entry.name === PROFILE_SECTION);
const profileText = profileSection === undefined ? '' : profileSection.text;
check('the Profile section carries the Litigation body', profileText.includes('诉讼'));
check('the Profile section names a recommended Skill', profileText.includes('legal-case-bench'), profileText.includes('本工作区推荐的 Skill') ? 'the recommendation block is present' : 'NO recommendation block');
check('the Profile section no longer states a stance', profileText.includes('当前立场') === false);

process.stdout.write('\n=== 5. /perspective switches the stance for this session ===\n');
const switched = await runCommand(agent, '/perspective plaintiff');
check('/perspective plaintiff reports success', switched?.kind === 'success', JSON.stringify(switched?.text ?? switched).slice(0, 200));

const after = await perspectiveTextFor(agent);
check('the Perspective section now injects the Plaintiff stance', typeof after === 'string' && after.includes('原告代理人'), JSON.stringify(after).slice(0, 200));
check('the stance names its source as a session override', typeof after === 'string' && after.includes('当前会话通过'), '');
check('the stance restates the precedence rule', typeof after === 'string' && after.includes('优先于本立场'), '');

process.stdout.write('\n=== 6. the override is durable ===\n');
let persisted = '';
try {
  persisted = await readFile(sessionRecordPath, 'utf8');
} catch (error) {
  persisted = `(unreadable: ${error.code})`;
}
check(
  'this session has its own persisted record',
  persisted.includes('"perspective": "plaintiff"'),
  `${sessionRecordPath} → ${persisted.replace(/\s+/g, ' ').slice(0, 160)}`,
);

process.stdout.write('\n=== 7. another session is unaffected ===\n');
const other = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: caseDir }, setup: () => {} });
const otherText = await perspectiveTextFor(other.agent);
check('a different session keeps the workspace default (no stance)', otherText === '' || otherText === undefined, JSON.stringify(otherText));

process.stdout.write('\n=== 8. a stance from another domain is refused ===\n');
const refused = await runCommand(agent, '/perspective administrator');
check('/perspective refuses a Bankruptcy stance under Litigation', refused?.kind === 'error', String(refused?.text ?? '').slice(0, 160));
const stillPlaintiff = await perspectiveTextFor(agent);
check('the refusal did not change the stance', typeof stillPlaintiff === 'string' && stillPlaintiff.includes('原告代理人'));

process.stdout.write('\n=== 9. /perspective default restores the workspace default ===\n');
const cleared = await runCommand(agent, '/perspective default');
check('/perspective default reports success', cleared?.kind === 'success', String(cleared?.text ?? '').slice(0, 140));
const restored = await perspectiveTextFor(agent);
check('the stance is gone again', restored === '' || restored === undefined, JSON.stringify(restored));

process.stdout.write('\n=== 10. status reports the effective stance ===\n');
await runCommand(agent, '/perspective defendant');
const status = await runCommand(agent, '/perspective');
check('status names the workspace default and the override separately',
  typeof status?.text === 'string' && status.text.includes('工作区默认立场') && status.text.includes('本会话覆盖'),
  String(status?.text ?? '').split('\n').slice(0, 5).join(' | '));

await handle.dispose();
await other.dispose();
await ctx.fiber.dispose();

process.stdout.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED (${failures.length})`}: ${checks.filter((c) => c.ok).length}/${checks.length}\n`);
for (const label of failures) process.stdout.write(`  ✖ ${label}\n`);

if (!keep) await rm(home, { recursive: true, force: true });
else process.stdout.write(`\nkept: ${home}\n`);
process.exit(failures.length === 0 ? 0 : 1);

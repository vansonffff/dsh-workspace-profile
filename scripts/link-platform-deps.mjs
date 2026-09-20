#!/usr/bin/env node
/**
 * Link the platform packages this package imports, so its tests can run.
 *
 * ## Why this is needed
 *
 * `src/` imports `@deepseek-ai/dsh-*` — the platform packages, which DSH provides
 * rather than this plugin depending on them. `node_modules/` is gitignored, so a
 * fresh clone has none of them and **seven test files fail immediately**, with
 * nothing in the README saying why.
 *
 * On the author's machine they are symlinks into the live DSH installation, and
 * that arrangement is deliberate: `npm` is unusable there (a broken `~/.npm`
 * ownership), so a missing dependency cannot be found by installing — only by
 * resolving it. This script creates the same links on any machine, from a DSH
 * installation you point it at.
 *
 * It links only what `src/` and the two typert entry points actually import, so it
 * cannot quietly paper over a dependency that was never declared.
 *
 * ## Usage
 *
 * ```bash
 * node scripts/link-platform-deps.mjs                     # ~/.dsh/profiles/node_modules
 * node scripts/link-platform-deps.mjs --from /path/to/dsh/node_modules
 * node scripts/link-platform-deps.mjs --check             # report, change nothing
 * ```
 *
 * Nothing is written outside this package's own `node_modules/`.
 */

import { readFile, readdir, symlink, mkdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Files whose bare imports define what must resolve.
 *
 * The tests are included on purpose: they import platform packages directly
 * (`@deepseek-ai/cordis`, `schemastery`), so scanning only `src/` leaves three
 * test *files* unable to load at all — which shows up as an unexplained file-level
 * failure rather than a missing-import message.
 */
const SOURCES = [
  'src/index.js', 'src/settings.js', 'src/policy.js', 'src/errors.js',
  'src/model-catalog.js', 'src/workspace-resolution.js', 'src/profile-runtime.js',
  'src/skill-policy.js', 'src/subagent-registry.js', 'src/subagent-dispatch.js',
  'src/tools.js', 'src/commands.js', 'src/service.js', 'src/instructions-probe.js',
  'src/matter-yaml.js', 'src/matter-resolution.js', 'src/matter-match.js',
  'src/remote/invocations.js', 'src/remote/operations.js', 'src/remote/schemas.js',
  'typert.host.js', 'typert.remote-client.js',
];

/**
 * Parse arguments.
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ from: string, check: boolean }} the options.
 */
function parseArgs(argv) {
  let from = process.env.DSH_NODE_MODULES ?? join(homedir(), '.dsh', 'profiles', 'node_modules');
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--from') {
      from = argv[index + 1] ?? '';
      index += 1;
    } else if (argv[index] === '--check') {
      check = true;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (from === '') throw new Error('--from needs a directory');
  return { from: resolve(from), check };
}

/**
 * Every bare import specifier the sources use, ignoring `node:` builtins.
 *
 * @returns {Promise<Set<string>>} the specifiers.
 */
async function bareImports() {
  const found = new Set();
  const tests = (await readdir(new URL('../test/', import.meta.url)))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => `test/${name}`);
  for (const file of [...SOURCES, ...tests]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      found.add(specifier);
    }
  }
  return found;
}

/**
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {Promise<number>} the exit code.
 */
async function main(argv) {
  const { from, check } = parseArgs(argv);
  const specifiers = [...(await bareImports())].sort();
  const modules = new URL('../node_modules/', import.meta.url);

  let present = 0;
  const missing = [];
  for (const specifier of specifiers) {
    const target = join(from, specifier);
    let available = true;
    try {
      await lstat(target);
    } catch {
      available = false;
    }
    if (!available) {
      missing.push(specifier);
      continue;
    }
    if (check) {
      try {
        await lstat(new URL(specifier, modules));
        present += 1;
      } catch {
        missing.push(specifier);
      }
      continue;
    }
    if (!check) {
      await mkdir(new URL('./', modules), { recursive: true });
      const link = new URL(specifier, modules);
      try {
        await lstat(link);
        present += 1;
        continue;
      } catch {
        // Not linked yet.
      }
      const parent = new URL('./', link);
      await mkdir(parent, { recursive: true });
      await symlink(target, link.pathname, 'dir');
      present += 1;
    }
  }

  for (const specifier of missing) {
    process.stdout.write(`cannot find ${specifier} under ${from}\n`);
  }
  if (missing.length > 0) {
    process.stdout.write(
      `\n${present}/${specifiers.length} resolvable. Point --from at a DSH installation's node_modules,\n`
      + 'or set DSH_NODE_MODULES.\n',
    );
    return 1;
  }
  process.stdout.write(
    `${check ? 'checked' : 'linked'} ${present}/${specifiers.length} platform dependencies from ${from}\n`,
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);

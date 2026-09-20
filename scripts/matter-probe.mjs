#!/usr/bin/env node
/**
 * Read every CaseBench Matter in a real workspace and report what was found.
 *
 * ## Why this exists
 *
 * The unit tests use fixtures this package controls. The claim they cannot make is
 * the one that matters most: that the reader agrees with CaseBench on the files
 * CaseBench actually writes. This probe runs against a real workspace so a
 * reviewer can see that for themselves — and `--json` emits the reader's answer in
 * a form that can be diffed against PyYAML's, which is the writer's own answer.
 *
 * It **requires an explicit `--workspace`**, for the same reason the other probes
 * require `--home`: a probe that defaults to somewhere real will one day run
 * against it by accident.
 *
 * ## Cross-checking against the writer
 *
 * ```bash
 * node scripts/matter-probe.mjs --workspace "$WS" --json > /tmp/js.json
 * python3 - "$WS" <<'PY' > /tmp/py.json
 * import json, pathlib, sys
 * import yaml  # the same library CaseBench dumps with
 * root = pathlib.Path(sys.argv[1])
 * out = {}
 * for case in sorted(p for p in root.iterdir() if p.is_dir()):
 *     f = case / "matter.yaml"
 *     if f.is_file():
 *         out[case.name] = yaml.safe_load(f.read_text(encoding="utf-8"))
 * print(json.dumps(out, ensure_ascii=False, sort_keys=True))
 * PY
 * diff <(jq -S . /tmp/js.json) <(jq -S . /tmp/py.json) && echo "identical"
 * ```
 *
 * Nothing here writes: no Matter is created, modified or migrated.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { findMatter } from '../src/matter-resolution.js';
import { parseMatterYaml } from '../src/matter-yaml.js';
import { matchMatter, perspectiveForMatter, profileForMatterType } from '../src/matter-match.js';

/**
 * Parse the arguments this probe accepts.
 *
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ workspace: string, json: boolean }} the parsed options.
 */
function parseArgs(argv) {
  let workspace = '';
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--workspace') {
      workspace = argv[index + 1] ?? '';
      index += 1;
    } else if (token === '--json') {
      json = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  if (workspace === '') {
    throw new Error('--workspace <dir> is required: this probe reads real case data and will not guess where it is');
  }
  return { workspace: resolve(workspace), json };
}

/**
 * Every immediate subdirectory that holds a `matter.yaml`.
 *
 * @param {string} workspace - the resolved workspace root.
 * @returns {Promise<string[]>} the case directory names, sorted.
 */
async function caseDirectories(workspace) {
  const entries = await readdir(workspace, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
  const found = [];
  for (const name of candidates) {
    try {
      await readFile(join(workspace, name, 'matter.yaml'), 'utf8');
      found.push(name);
    } catch {
      // An ordinary project directory. Not a finding.
    }
  }
  return found;
}

/**
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {Promise<number>} the exit code.
 */
async function main(argv) {
  const { workspace, json } = parseArgs(argv);
  const names = await caseDirectories(workspace);

  if (json) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const name of names) {
      out[name] = parseMatterYaml(await readFile(join(workspace, name, 'matter.yaml'), 'utf8'));
    }
    process.stdout.write(JSON.stringify(out));
    return names.length === 0 ? 1 : 0;
  }

  if (names.length === 0) {
    process.stdout.write(`no matter.yaml under ${workspace}\n`);
    return 1;
  }

  process.stdout.write(`workspace: ${workspace}\n\n`);
  const width = Math.min(30, Math.max(...names.map((name) => name.length)));
  let mapped = 0;
  for (const name of names) {
    const { facts, problem } = await findMatter(join(workspace, name));
    if (facts === null) {
      process.stdout.write(`${name.padEnd(width)}  UNREADABLE  ${problem ?? ''}\n`);
      continue;
    }
    const profile = profileForMatterType(facts.type);
    const perspective = perspectiveForMatter(facts);
    // Compared against the configuration the Matter itself implies, which is how a
    // Workspace *should* be set up. A mismatch here is this plugin disagreeing with
    // its own tables, not with a user.
    const selfConsistent = matchMatter({
      matter: { facts, problem: null },
      policy: { profile, defaultPerspective: perspective ?? 'none' },
    });
    const ok = selfConsistent.profile.verdict === 'match'
      && selfConsistent.perspective.verdict === 'match'
      && selfConsistent.problems.length === 0;
    if (ok) mapped += 1;
    const verdict = ok ? 'ok' : `PROBLEM: ${selfConsistent.problems.join('; ') || 'verdicts disagree'}`;
    process.stdout.write(
      `${name.padEnd(width)}  ${`${facts.type}/${facts.role}`.padEnd(38)}`
      + `-> ${`${profile}/${perspective ?? '(impossible pair)'}`.padEnd(40)}  ${verdict}\n`,
    );
    process.stdout.write(
      `${''.padEnd(width)}  id=${facts.id}  stage=${facts.stage}`
      + `${facts.modules.length > 0 ? `  modules=${facts.modules.join(',')}` : ''}\n`,
    );
  }
  process.stdout.write(`\n${mapped}/${names.length} mapped to a pair this plugin offers\n`);
  return mapped === names.length ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);

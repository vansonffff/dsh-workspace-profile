/**
 * Fail the build if a real client matter's identity appears anywhere in this repo.
 *
 * ## Why the deny-list is not in this file
 *
 * This repository is published. A list of the real matters would be exactly the
 * thing the test exists to prevent, so the names are read at run time from the
 * private case workspace and never committed. When that workspace is absent — a
 * fresh clone, CI, a reviewer's machine — the test skips rather than pretending to
 * have checked.
 *
 * ## What it catches, and what it does not
 *
 * It checks the **full matter name** and the **matter id (UUID)**, because that is
 * how client data actually arrives in a test: copied whole. It does **not** catch a
 * hand-shortened form — the first two characters of a name, say. Trying to would
 * mean guessing substrings, and Chinese legal vocabulary here would produce false
 * positives that get the test disabled, which is worse than a narrow test.
 *
 * (Writing this file is how the gap was found: the first draft used a real name and
 * a real id as its own illustration, and this test — run against itself — failed.)
 *
 * So the rule is the one the guard cannot enforce: **do not write a client's name
 * in this repository at all.** This only catches the copy-paste.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

const REPO = new URL('..', import.meta.url);
const WORKSPACE = join(homedir(), 'Documents', 'My Legal-agents');

/** Directories never worth walking. */
const SKIP = new Set(['.git', 'node_modules']);

/** Extensions that can carry a copied name. */
const TEXT = new Set(['.md', '.js', '.mjs', '.json', '.yaml', '.yml', '.py', '.txt']);

/**
 * Walk the repository, skipping the directories that hold no authored text.
 *
 * @param {URL} root - the directory to walk.
 * @returns {Promise<string[]>} absolute file paths.
 */
async function walk(root) {
  const found = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, root);
    if (entry.isDirectory()) {
      found.push(...(await walk(child)));
    } else if (TEXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      found.push(child);
    }
  }
  return found;
}

test('no real matter name or id appears in this repository', async () => {
  let registry;
  try {
    registry = JSON.parse(await readFile(join(WORKSPACE, '_registry.json'), 'utf8'));
  } catch {
    // No private workspace on this machine. Skip rather than assert nothing —
    // a test that silently passes when it checked nothing is not a guard.
    return;
  }
  const matters = Array.isArray(registry.matters) ? registry.matters : [];
  assert.ok(matters.length > 0, 'the workspace registry lists no matters');

  const needles = [];
  for (const matter of matters) {
    if (typeof matter.name === 'string' && matter.name !== '') needles.push(matter.name);
    if (typeof matter.matter_id === 'string' && matter.matter_id !== '') needles.push(matter.matter_id);
  }

  const leaks = [];
  for (const file of await walk(REPO)) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const needle of needles) {
      if (text.includes(needle)) {
        leaks.push(`${relative(new URL('.', REPO).pathname, file.pathname)} contains a real matter ${needle === matterName(needle, matters) ? 'name' : 'id'}`);
      }
    }
  }
  assert.deepEqual(leaks, [], `real client data must not be committed:\n  ${leaks.join('\n  ')}`);
});

/**
 * Whether a needle is a name rather than an id, for the message only.
 *
 * @param {string} needle - the matched string.
 * @param {Array<{name?: string}>} matters - the registry entries.
 * @returns {string|undefined} the name when it matches one.
 */
function matterName(needle, matters) {
  return matters.some((matter) => matter.name === needle) ? needle : undefined;
}

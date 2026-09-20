/**
 * Fail the build if a real client matter's identity appears anywhere in this repo.
 *
 * ## Why the deny-list is not in this file
 *
 * This repository is published. A list of the real matters would be exactly the
 * thing the test exists to prevent, so the names are read at run time from the
 * private case workspace and never committed.
 *
 * ## Absent data is a skip, and on a release it is a failure
 *
 * When the private workspace is not on this machine there is nothing to check
 * against. Returning quietly would report **pass** — a green tick on a check that
 * ran nothing — so the test skips, and the report says so. A skip is honest; a
 * silent pass is not.
 *
 * That still leaves the release path: publishing from a machine with no client
 * data would skip this check and ship unexamined. `RELEASE_CHECK=1` turns the skip
 * into a failure, so a release either checks or refuses.
 *
 * ```bash
 * node --test "test/*.test.js"                    # skips without the workspace
 * RELEASE_CHECK=1 node --test "test/*.test.js"    # fails without it
 * ```
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
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = join(homedir(), 'Documents', 'My Legal-agents');

/** Directories never worth walking. */
const SKIP = new Set(['.git', 'node_modules']);

/** Extensions that can carry a copied name. */
const TEXT = new Set(['.md', '.mjs', '.js', '.json', '.yaml', '.yml', '.py', '.txt']);

/**
 * Walk the repository, skipping the directories that hold no authored text.
 *
 * @param {string} root - the directory to walk.
 * @returns {Promise<string[]>} absolute file paths.
 */
async function walk(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const child = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(child)));
    } else if (TEXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      found.push(child);
    }
  }
  return found;
}

test('no real matter name or id appears in this repository', async (t) => {
  let registry;
  try {
    registry = JSON.parse(await readFile(join(WORKSPACE, '_registry.json'), 'utf8'));
  } catch {
    const why = `the private case workspace is not at ${WORKSPACE}, so there is no deny-list to check against`;
    if (process.env.RELEASE_CHECK === '1') {
      assert.fail(`${why} — and RELEASE_CHECK=1 means a release must check, not skip`);
    }
    t.skip(why);
    return;
  }

  const matters = Array.isArray(registry.matters) ? registry.matters : [];
  assert.ok(matters.length > 0, 'the workspace registry lists no matters');

  /** @type {Array<{ needle: string, kind: string }>} */
  const needles = [];
  for (const matter of matters) {
    if (typeof matter.name === 'string' && matter.name !== '') {
      needles.push({ needle: matter.name, kind: 'name' });
    }
    if (typeof matter.matter_id === 'string' && matter.matter_id !== '') {
      needles.push({ needle: matter.matter_id, kind: 'id' });
    }
  }

  const leaks = [];
  for (const file of await walk(REPO)) {
    const text = await readFile(file, 'utf8').catch(() => '');
    for (const { needle, kind } of needles) {
      if (text.includes(needle)) {
        const line = text.split('\n').findIndex((entry) => entry.includes(needle)) + 1;
        leaks.push(`${relative(REPO, file)}:${line} contains a real matter ${kind} — ${needle}`);
      }
    }
  }
  assert.deepEqual(leaks, [], `real client data must not be committed:\n  ${leaks.join('\n  ')}`);
});

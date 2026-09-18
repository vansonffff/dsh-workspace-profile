/**
 * Presence probe for the AGENTS instruction files a Workspace would load.
 *
 * ## Why this only *looks*
 *
 * The Settings page shows "Global AGENTS 已发现 / 未发现" and the same for the
 * project file. That is a statement about **presence**, and it must not be
 * confused with a second parser: `@deepseek-ai/dsh-agent-instructions` owns
 * discovery and rendering, and it is mounted per agent preset, not in this
 * plugin's plane. Re-implementing its byte budgets, dedup and truncation here
 * would give the page a second, subtly different answer to a question that
 * already has one.
 *
 * So this walks the same **default** roots the loader uses — `$DSH_HOME/AGENTS.md`
 * for the user-global file, and the `.git`-bounded ancestor chain from the
 * project root down to the Workspace for the project files, with the default
 * candidate names — and reports what exists. It says nothing about whether a file
 * was *loaded* (one over the byte cap is present and ignored), which is why every
 * row in the UI reads "已发现", never "已生效".
 *
 * @module dsh-workspace-profile/instructions-probe
 */

import { stat } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';

/** Default project-root marker, from `dsh-agent-instructions`. */
const PROJECT_ROOT_MARKERS = ['.git'];

/** Default base candidates, in load order. */
const INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];

/** Default local-overlay candidates, loaded after the base files. */
const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'];

/** Upper bound on the upward walk, so a pathological path cannot loop. */
const MAX_DEPTH = 64;

/**
 * Probe the instruction files that apply to one Workspace.
 *
 * @param {object} input - the probe inputs.
 * @param {string} input.workspacePath - the Workspace's canonical directory.
 * @param {string|undefined} input.dshHome - the harness home, for the user-global file.
 * @param {object} [options] - overrides, for tests.
 * @param {number} [options.maxDepth] - upward-walk bound.
 * @returns {Promise<{ global: { present: boolean, path: string }, project: { present: boolean, root: string, files: string[] } }>}
 *   the presence facts, as plain JSON.
 */
export async function probeInstructions({ workspacePath, dshHome }, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const globalPath = dshHome === undefined ? undefined : join(dshHome, 'AGENTS.md');
  const global = {
    present: globalPath !== undefined && (await isFile(globalPath)),
    path: globalPath ?? '',
  };

  const root = await findProjectRoot(workspacePath, maxDepth);
  const files = [];
  // `ancestorChain(root, cwd)` — broadest first, cwd last. Files *above* the
  // project root are not part of the baseline, and files below the Workspace
  // belong to nested projects the loader picks up when the agent touches them.
  for (const directory of ancestorChain(root, workspacePath)) {
    for (const name of [...INSTRUCTION_CANDIDATES, ...LOCAL_CANDIDATES]) {
      const candidate = join(directory, name);
      if (await isFile(candidate)) files.push(candidate);
    }
  }

  return { global, project: { present: files.length > 0, root, files } };
}

/**
 * Walk upward to the first directory carrying a project-root marker.
 *
 * Mirrors `findProjectRoot`'s documented contract: the discovered root, or the
 * starting directory itself when no marker exists anywhere above it.
 *
 * @param {string} start - the directory to begin at.
 * @param {number} maxDepth - how many levels to try.
 * @returns {Promise<string>} the project root, or the resolved start directory.
 */
export async function findProjectRoot(start, maxDepth = MAX_DEPTH) {
  const resolved = resolve(start);
  let directory = resolved;
  const stop = parse(directory).root;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const marker of PROJECT_ROOT_MARKERS) {
      if (await exists(join(directory, marker))) return directory;
    }
    if (directory === stop) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return resolved;
}

/**
 * The inclusive root-to-cwd directory chain, broadest first.
 *
 * @param {string} root - the project root expected to contain or equal `cwd`.
 * @param {string} cwd - the most specific directory.
 * @returns {string[]} the chain; `[cwd]` when `root` is not an ancestor.
 */
export function ancestorChain(root, cwd) {
  const target = resolve(cwd);
  const start = resolve(root);
  if (target !== start && !target.startsWith(start.endsWith(sep) ? start : `${start}${sep}`)) {
    return [target];
  }
  const chain = [];
  let directory = target;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    chain.push(directory);
    if (directory === start) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return chain.reverse();
}

/**
 * Whether a path exists at all (file or directory).
 *
 * @param {string} path - the path to probe.
 * @returns {Promise<boolean>} whether it exists.
 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a path is an existing regular file.
 *
 * @param {string} path - the path to probe.
 * @returns {Promise<boolean>} whether it is a file.
 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export { INSTRUCTION_CANDIDATES, LOCAL_CANDIDATES, PROJECT_ROOT_MARKERS };

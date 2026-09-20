/**
 * Resolve the CaseBench Matter a Session is working inside.
 *
 * ## The contract this mirrors
 *
 * CaseBench owns this rule (`common/references/matter-resolution.md`), and it is
 * deliberately not re-designed here:
 *
 * 1. start at the session's cwd and walk **up**;
 * 2. the nearest ancestor holding a `matter.yaml` is the Matter Root;
 * 3. that file must be a regular file, not a symlink;
 * 4. once a candidate is found, a `matter.yaml` that is present but **invalid is
 *    reported**, never skipped in favour of a higher directory — a broken Matter
 *    must not silently become a different Matter;
 * 5. **never infer identity from the directory name.** The name is a label. Only
 *    `matter.id` is identity, and only the file carries it.
 *
 * Rule 5 is the one worth stating twice: `/work/示例系列案件` is not evidence
 * that the directory is that matter, and a directory renamed by hand must not
 * change which Profile the session runs under.
 *
 * ## Why there is a synchronous half
 *
 * Prompt-section text functions are pure and synchronous, so the injection cannot
 * `await` a file read. The same shape `WorkspaceResolver` uses applies: the
 * asynchronous `resolveAgent` is awaited from `agent/created` and memoises into a
 * `WeakMap`, so by the time the first prompt assembles, `matterForAgent` is a
 * lookup. A miss is "no Matter", which the UI renders as such — never a guess.
 *
 * @module dsh-workspace-profile/matter-resolution
 */

import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, parse as parsePath, resolve, sep } from 'node:path';

import { MatterYamlError, parseMatterYaml } from './matter-yaml.js';
import { validateMatterDocument, validateMatterState } from './matter-contract.js';

/** The Contract file's name, fixed by CaseBench. */
export const MATTER_FILENAME = 'matter.yaml';

/** The case state that carries the matching `matter_id`, fixed by CaseBench. */
export const STATE_FILENAME = '_case_state.json';

/** Upper bound on the upward walk, so a pathological path cannot loop. */
const MAX_DEPTH = 64;

/**
 * A Matter as this plugin needs it: a plain projection, never the file's shape.
 *
 * @typedef {object} MatterFacts
 * @property {string} root - the Matter Root directory (absolute).
 * @property {string} path - the `matter.yaml` that was read.
 * @property {string} id - `matter.id`, the identity anchor.
 * @property {string} name - `matter.name`, a label that may change.
 * @property {string} type - `matter.type`, or `unclassified` when absent.
 * @property {string} role - `engagement.role`, or `unknown` when absent.
 * @property {string} stage - `procedure.stage`, or `unknown` when absent.
 * @property {string[]} modules - `modules[]`, or empty.
 * @property {string} status - `matter.status`, or `unknown` when absent.
 */

/**
 * Locate and read the Matter Root above a directory.
 *
 * @param {string} start - the directory to begin at.
 * @param {object} [options] - overrides, for tests.
 * @param {number} [options.maxDepth] - upward-walk bound.
 * @returns {Promise<{ facts: MatterFacts|null, problem: string|null }>} the facts,
 *   or the reason there are none. `problem` is a sentence for the UI; it is never
 *   thrown, because "this directory has no Matter" is an ordinary answer.
 */
export async function findMatter(start, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const found = await findMatterFile(start, maxDepth, options.workspaceRoot);
  if (found.problem !== null) return { facts: null, problem: found.problem };
  if (found.path === null) return { facts: null, problem: null };

  let text;
  try {
    text = await readFile(found.path, 'utf8');
  } catch (error) {
    return { facts: null, problem: `无法读取 ${found.path}：${messageOf(error)}` };
  }

  let document;
  try {
    document = parseMatterYaml(text);
  } catch (error) {
    // Present but unreadable. Reported, and deliberately *not* skipped in favour
    // of a higher directory: a broken Matter is a fact about this directory.
    const why = error instanceof MatterYamlError ? error.message : messageOf(error);
    return { facts: null, problem: `${MATTER_FILENAME} 无法解析：${why}` };
  }

  // Syntax was checked above; this is the Contract. A document that CaseBench
  // would have refused to write must not become a confident, ordinary-looking
  // answer here — `type: nonsense` falling back to `general` is exactly the
  // failure the strict reader exists to prevent, one level up.
  const problems = validateMatterDocument(document);
  if (problems.length > 0) {
    return { facts: null, problem: `${MATTER_FILENAME} 不符合 CaseBench Contract：${problems.join('；')}` };
  }

  const matter = document.matter;
  const id = matter.id;

  // `matter.yaml` alone is not the identity: CaseBench treats the pair as the
  // contract and hard-stops when they disagree, so telling a child "you are
  // working on Matter AAA" while the state says BBB would be a false statement
  // about a live matter.
  const statePath = join(dirname(found.path), STATE_FILENAME);
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      state = undefined;
    } else {
      return { facts: null, problem: `无法读取 ${STATE_FILENAME}：${messageOf(error)}` };
    }
  }
  const stateProblems = validateMatterState({ state, matterId: id });
  if (stateProblems.length > 0) {
    return { facts: null, problem: stateProblems.join('；') };
  }

  const engagement = isMapping(document.engagement) ? document.engagement : {};
  const procedure = isMapping(document.procedure) ? document.procedure : {};

  return {
    facts: {
      root: dirname(found.path),
      path: found.path,
      id,
      // Guaranteed valid by the Contract check above; nothing here is a fallback.
      name: matter.name,
      type: matter.type,
      role: engagement.role,
      stage: stringOr(procedure.stage, 'unknown'),
      modules: Array.isArray(document.modules)
        ? document.modules.filter((entry) => typeof entry === 'string')
        : [],
      status: stringOr(matter.status, 'unknown'),
    },
    problem: null,
  };
}

/**
 * Walk upward for the nearest `matter.yaml`, applying the symlink and
 * invalid-candidate rules without reading the file yet.
 *
 * @param {string} start - the directory to begin at.
 * @param {number} maxDepth - how many levels to try.
 * @returns {Promise<{ path: string|null, problem: string|null }>} the file, or why not.
 */
export async function findMatterFile(start, maxDepth = MAX_DEPTH, workspaceRoot = undefined) {
  const resolved = resolve(start);

  // The upward walk stops at the Workspace root, never above it. CaseBench's own
  // rule is "up to the workspace root, do not cross the boundary", and crossing it
  // is not a theoretical concern: a Workspace that is an ordinary project
  // directory sitting inside a directory that happens to hold a `matter.yaml`
  // would otherwise be adopted as that Matter, and every session in it would be
  // told it was working on someone else's case.
  const boundary = typeof workspaceRoot === 'string' && workspaceRoot !== ''
    ? resolve(workspaceRoot)
    : undefined;
  if (boundary !== undefined && !isWithin(boundary, resolved)) {
    // The session is not inside its own Workspace, which the Workspace resolver
    // should have prevented. Refuse rather than walk somewhere unbounded.
    return { path: null, problem: null };
  }

  let directory = resolved;
  const stop = boundary ?? parsePath(directory).root;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = join(directory, MATTER_FILENAME);
    let info = null;
    try {
      // `lstat`, not `stat`: the latter follows the link, so `isSymbolicLink()`
      // would always be false and a symlinked contract would be accepted. CaseBench
      // requires a real file here, and a link is how one Matter Root comes to
      // impersonate another.
      info = await lstat(candidate);
    } catch (error) {
      // "Not there" and "cannot tell" are different answers. Collapsing every
      // failure into absence would let a candidate that is unreadable — a
      // permission error, an I/O error — send the walk *upward*, where it may
      // find a different Matter and attribute this session to that one. An
      // unreadable candidate is a stop, not a step.
      if (!isMissing(error)) {
        return {
          path: null,
          problem: `无法检查 ${candidate}：${messageOf(error)}`,
        };
      }
      info = null;
    }
    if (info !== null) {
      if (info.isSymbolicLink()) {
        return { path: null, problem: `${candidate} 是符号链接；Matter Root 必须是真实文件` };
      }
      if (!info.isFile()) {
        return { path: null, problem: `${candidate} 不是普通文件` };
      }
      return { path: candidate, problem: null };
    }
    if (directory === stop) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { path: null, problem: null };
}

/**
 * Whether a filesystem error means "there is nothing at this path".
 *
 * Only these two. Anything else — `EACCES`, `EPERM`, `EIO`, a failed mount — is a
 * failure to determine the answer, and the caller must not read it as absence.
 *
 * @param {unknown} error - the caught value.
 * @returns {boolean} whether it means the path does not exist.
 */
export function isMissing(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Whether `path` is `root` itself or lies beneath it.
 *
 * A string-prefix test would be wrong at the boundary: `/work/matter-old` starts
 * with `/work/matter` but is a sibling, not a child. Comparing whole segments is
 * what makes the difference.
 *
 * @param {string} root - the resolved ancestor.
 * @param {string} path - the resolved candidate.
 * @returns {boolean} whether `path` is inside `root`.
 */
export function isWithin(root, path) {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Resolve Matters for Agents, with a synchronous read for prompt assembly.
 *
 * Mirrors `WorkspaceResolver`: one asynchronous resolution per Agent at creation,
 * memoised, so the synchronous half is a lookup during prompt assembly.
 */
export class MatterResolver {
  /**
   * @param {object} [deps] - dependencies.
   * @param {{ warn: Function }} [deps.logger] - diagnostics sink.
   * @param {(path: string, options?: object) => Promise<{facts: MatterFacts|null, problem: string|null}>} [deps.find]
   *   the discovery function, injectable for tests.
   */
  constructor({ logger, find, workspacePathFor } = {}) {
    /** @private */ this.logger = logger;
    /** @private */ this.find = find ?? findMatter;
    /** @private */
    // Resolves the Agent's Workspace directory, which bounds the upward walk.
    //
    // Every caller passes a boundary. An earlier version of this comment argued
    // that the Settings read could leave it out "because the Workspace path is its
    // own start" — that reasoning was wrong, and writing it down made the bug look
    // deliberate. Starting *at* the Workspace path does not stop the walk *at* it,
    // so Settings reported the enclosing Matter while the Agent reported none.
    // Passing the path as its own boundary is what makes the two reads agree.
    //
    // An Agent whose Workspace directory cannot be resolved is the only remaining
    // unbounded walk, and it is logged where that happens.
    this.workspacePathFor = workspacePathFor;
    /** @private @type {WeakMap<object, {facts: MatterFacts|null, problem: string|null}>} */
    this.agentIndex = new WeakMap();
    /** @private @type {Map<string, Promise<{facts: MatterFacts|null, problem: string|null}>>} keyed by path + boundary */
    this.pending = new Map();
  }

  /**
   * What is known about one Agent's Matter, without touching I/O.
   *
   * @param {any} agent - the Agent.
   * @returns {{facts: MatterFacts|null, problem: string|null}} the memoised answer,
   *   or "nothing known yet" — which is not the same as "no Matter exists".
   */
  matterForAgent(agent) {
    if (agent === null || typeof agent !== 'object') return { facts: null, problem: null };
    return this.agentIndex.get(agent) ?? { facts: null, problem: null };
  }

  /**
   * Resolve and memoise one Agent's Matter.
   *
   * Awaited by the `agent/created` observer. The cwd may not exist (a session can
   * outlive its directory), which is an ordinary "no Matter".
   *
   * @param {any} agent - the Agent to resolve.
   * @returns {Promise<{facts: MatterFacts|null, problem: string|null}>} the answer.
   */
  async resolveAgent(agent) {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd === '') {
      const answer = { facts: null, problem: null };
      if (agent !== null && typeof agent === 'object') this.agentIndex.set(agent, answer);
      return answer;
    }
    let boundary;
    try {
      boundary = this.workspacePathFor?.(agent);
    } catch (error) {
      this.logger?.warn?.(
        `workspace-profile: could not resolve the Workspace path bounding a Matter lookup (${messageOf(error)})`,
      );
    }
    const answer = await this.resolvePath(cwd, boundary);
    if (agent !== null && typeof agent === 'object') this.agentIndex.set(agent, answer);
    return answer;
  }

  /**
   * Resolve a directory, de-duplicating concurrent lookups for the same path.
   *
   * @param {string} path - an absolute directory to start at.
   * @param {string} [workspaceRoot] - the directory the walk must not go above.
   *   Omitting it walks to the filesystem root, which is correct only when the
   *   caller genuinely has no Workspace to bound by. A caller that *has* a
   *   Workspace and omits it will disagree with the Agent path — which is exactly
   *   how the Settings card came to report a Matter the session did not have.
   * @returns {Promise<{facts: MatterFacts|null, problem: string|null}>} the answer.
   */
  async resolvePath(path, workspaceRoot = undefined) {
    // The boundary is part of the question, so it is part of the key: the same
    // directory under two Workspaces is two different answers.
    const key = `${path}\u0000${workspaceRoot ?? ''}`;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;

    const work = (async () => {
      try {
        return await this.find(path, workspaceRoot === undefined ? {} : { workspaceRoot });
      } catch (error) {
        // A directory that is gone is not a fault worth a stack; it is a session
        // whose Matter cannot be determined.
        this.logger?.warn?.(`workspace-profile: could not probe a Matter at "${path}": ${messageOf(error)}`);
        return { facts: null, problem: null };
      }
    })();

    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }
}

/**
 * A string, or a fallback when the value is not a non-empty string.
 *
 * @param {unknown} value - the candidate.
 * @param {string} fallback - what to use otherwise.
 * @returns {string} the value or the fallback.
 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * Whether a parsed value is a mapping.
 *
 * @param {unknown} value - the value to test.
 * @returns {boolean} whether it is a non-null, non-array object.
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render an unknown thrown value as a message.
 *
 * @param {unknown} error - the caught value.
 * @returns {string} its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export { MAX_DEPTH };

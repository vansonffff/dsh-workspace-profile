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
import { dirname, join, parse as parsePath, resolve } from 'node:path';

import { MatterYamlError, parseMatterYaml } from './matter-yaml.js';

/** The Contract file's name, fixed by CaseBench. */
export const MATTER_FILENAME = 'matter.yaml';

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
  const found = await findMatterFile(start, maxDepth);
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

  const matter = isMapping(document.matter) ? document.matter : {};
  const id = typeof matter.id === 'string' ? matter.id.trim() : '';
  if (id === '') {
    return { facts: null, problem: `${MATTER_FILENAME} 缺少 matter.id` };
  }

  const engagement = isMapping(document.engagement) ? document.engagement : {};
  const procedure = isMapping(document.procedure) ? document.procedure : {};

  return {
    facts: {
      root: dirname(found.path),
      path: found.path,
      id,
      name: typeof matter.name === 'string' && matter.name !== '' ? matter.name : id,
      type: stringOr(matter.type, 'unclassified'),
      role: stringOr(engagement.role, 'unknown'),
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
export async function findMatterFile(start, maxDepth = MAX_DEPTH) {
  const resolved = resolve(start);
  let directory = resolved;
  const stop = parsePath(directory).root;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = join(directory, MATTER_FILENAME);
    let info = null;
    try {
      // `lstat`, not `stat`: the latter follows the link, so `isSymbolicLink()`
      // would always be false and a symlinked contract would be accepted. CaseBench
      // requires a real file here, and a link is how one Matter Root comes to
      // impersonate another.
      info = await lstat(candidate);
    } catch {
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
  constructor({ logger, find } = {}) {
    /** @private */ this.logger = logger;
    /** @private */ this.find = find ?? findMatter;
    /** @private @type {WeakMap<object, {facts: MatterFacts|null, problem: string|null}>} */
    this.agentIndex = new WeakMap();
    /** @private @type {Map<string, Promise<{facts: MatterFacts|null, problem: string|null}>>} */
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
    const answer = await this.resolvePath(cwd);
    if (agent !== null && typeof agent === 'object') this.agentIndex.set(agent, answer);
    return answer;
  }

  /**
   * Resolve a directory, de-duplicating concurrent lookups for the same path.
   *
   * @param {string} path - an absolute directory.
   * @returns {Promise<{facts: MatterFacts|null, problem: string|null}>} the answer.
   */
  async resolvePath(path) {
    const existing = this.pending.get(path);
    if (existing !== undefined) return existing;

    const work = (async () => {
      try {
        return await this.find(path);
      } catch (error) {
        // A directory that is gone is not a fault worth a stack; it is a session
        // whose Matter cannot be determined.
        this.logger?.warn?.(`workspace-profile: could not probe a Matter at "${path}": ${messageOf(error)}`);
        return { facts: null, problem: null };
      }
    })();

    this.pending.set(path, work);
    try {
      return await work;
    } finally {
      this.pending.delete(path);
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

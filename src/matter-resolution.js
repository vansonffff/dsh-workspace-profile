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
 *    `matter.id` is identity, and only the file carries it;
 * 6. a Workspace is **not necessarily one directory**. DSH's multi-root model
 *    lets a Workspace declare additional writable directories, and the Matter may
 *    live in any of them, so the search covers the whole declared set: the
 *    session's own chain first, then each declared directory as itself. If two of
 *    them hold different Matters, that is reported as an ambiguity rather than
 *    resolved by picking one.
 *
 * Rule 5 is the one worth stating twice: `/work/示例系列案件` is not evidence
 * that the directory is that matter, and a directory renamed by hand must not
 * change which Profile the session runs under.
 *
 * Rule 6 is the same rule seen from the other side. Reading a Matter out of an
 * *added* directory is not inference — the user declared that directory as part
 * of this Workspace — but it is still only the file that decides, and a set that
 * names two cases is a question for the user, not a coin to flip.
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
 * Locate and read the Matter Root reachable from a session.
 *
 * @param {string} start - the directory to begin at: a session's cwd, or the
 *   Workspace directory for the Settings read.
 * @param {object} [options] - the search.
 * @param {number} [options.maxDepth] - upward-walk bound.
 * @param {string[]} [options.roots] - the Workspace's declared directories. An
 *   empty or absent list means "no Workspace to bound by" and keeps the single
 *   unbounded walk from `start`; a non-empty list turns the search into the
 *   declared set (rule 6 above).
 * @returns {Promise<{ facts: MatterFacts|null, problem: string|null }>} the facts,
 *   or the reason there are none. `problem` is a sentence for the UI; it is never
 *   thrown, because "this directory has no Matter" is an ordinary answer.
 */
export async function findMatter(start, options = {}) {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const declared = normaliseRoots(options.roots);
  const origins = searchOrigins(start, declared);

  // The session's own chain first: it is the most specific answer available, and
  // it is the only one that existed before a Workspace could have several
  // directories. A problem here — a candidate that is present but unreadable, or
  // one outside the Contract — is the answer. It is never a reason to look
  // elsewhere, which would let a broken Matter become a different Matter.
  const [near, ...others] = origins;
  if (near !== undefined) {
    const candidate = await findMatterFile(near.start, maxDepth, near.boundary);
    if (candidate.problem !== null) return { facts: null, problem: candidate.problem };
    if (candidate.path !== null) return readMatterFile(candidate.path);
  }

  // Nothing in the session's own chain. A Workspace's other declared directories
  // are still part of the Workspace, so the Matter may be in one of those.
  const found = [];
  const problems = [];
  for (const origin of others) {
    const candidate = await findMatterFile(origin.start, maxDepth, origin.boundary);
    if (candidate.problem !== null) problems.push(candidate.problem);
    else if (candidate.path !== null) found.push(candidate.path);
  }
  if (problems.length > 0) return { facts: null, problem: problems.join('；') };
  if (found.length > 1) {
    // Two declared directories, two cases. Picking one would tell a session it
    // works on a matter that may not be its own, and the pick would be made by
    // directory order — a fact nobody stated.
    return {
      facts: null,
      problem:
        `工作区声明的多个目录各有一个 ${MATTER_FILENAME}：${found.join('、')}；` +
        '无法确定这个工作区属于哪一个案件，请只保留其中一个目录',
    };
  }
  if (found.length === 1) return readMatterFile(found[0]);
  return { facts: null, problem: null };
}

/**
 * Read one `matter.yaml`, and the case state beside it, into the facts this plugin uses.
 *
 * @param {string} path - the candidate file, already established as a regular file.
 * @returns {Promise<{ facts: MatterFacts|null, problem: string|null }>} the answer.
 */
async function readMatterFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { facts: null, problem: `无法读取 ${path}：${messageOf(error)}` };
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
  const statePath = join(dirname(path), STATE_FILENAME);
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
      root: dirname(path),
      path,
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
 * A directory list, resolved, de-duplicated, with unusable entries dropped.
 *
 * Order is preserved because it carries meaning: the first entry is the
 * Workspace's own directory and the rest are the ones added to it.
 *
 * @param {unknown} roots - the candidate list. A single string is accepted, so a
 *   caller holding one directory does not have to wrap it.
 * @returns {string[]} the resolved directories.
 */
export function normaliseRoots(roots) {
  const list = typeof roots === 'string' ? [roots] : roots;
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const resolved = [];
  for (const root of list) {
    if (typeof root !== 'string' || root === '') continue;
    const path = resolve(root);
    if (seen.has(path)) continue;
    seen.add(path);
    resolved.push(path);
  }
  return resolved;
}

/**
 * Where to look, and how far up each search may walk.
 *
 * This is the single-directory rule generalised to a set: **the walk from any
 * start stops at the topmost declared directory containing it**. With one
 * directory that is CaseBench's rule unchanged. With several, it is what keeps an
 * added directory from being searched *through* — the Matter above an added
 * directory stays reachable only if the user declared that higher directory too.
 *
 * Two refinements, each of which avoids answering a question nobody asked:
 *
 * - a start that **strictly contains** another start is dropped, because the walk
 *   from the deeper one already covers it;
 * - a session cwd **outside every declared directory** is not searched at all. A
 *   cwd outside its own Workspace is a resolution failure the Workspace resolver
 *   should have prevented, and reading a Matter out of it would attribute this
 *   session to whatever happens to sit there.
 *
 * @param {string} start - the session's cwd, or the Workspace directory.
 * @param {string[]} declared - the Workspace's directories, already normalised.
 * @returns {Array<{ start: string, boundary: string|undefined }>} the searches,
 *   most specific first.
 */
export function searchOrigins(start, declared) {
  const resolved = resolve(start);
  const inside = declared.some((root) => isWithin(root, resolved));
  /** @type {string[]} */
  const seeds = [];
  if (declared.length === 0 || inside) seeds.push(resolved);
  for (const root of declared) seeds.push(root);

  const unique = [...new Set(seeds)];
  const deepest = unique.filter((seed) => !unique.some((other) => other !== seed && isWithin(seed, other)));

  return deepest.map((seed) => {
    if (declared.length === 0) return { start: seed, boundary: undefined };
    // The declared directories containing this seed form a chain, so "topmost" is
    // simply the shortest spelling among them.
    let boundary = seed;
    for (const root of declared) {
      if (isWithin(root, seed) && root.length < boundary.length) boundary = root;
    }
    return { start: seed, boundary };
  });
}

/**
 * Walk upward for the nearest `matter.yaml`, applying the symlink and
 * invalid-candidate rules without reading the file yet.
 *
 * One search only. Which directories to search, and with which boundary, is
 * {@link searchOrigins}'s job — this function just walks.
 *
 * @param {string} start - the directory to begin at.
 * @param {number} maxDepth - how many levels to try.
 * @param {string} [boundary] - the directory the walk stops at, inclusive.
 *   Omitting it walks to the filesystem root, which is correct only when the
 *   caller genuinely has no Workspace to bound by.
 * @returns {Promise<{ path: string|null, problem: string|null }>} the file, or why not.
 */
export async function findMatterFile(start, maxDepth = MAX_DEPTH, boundary = undefined) {
  const resolved = resolve(start);

  // The upward walk stops at the Workspace root, never above it. CaseBench's own
  // rule is "up to the workspace root, do not cross the boundary", and crossing it
  // is not a theoretical concern: a Workspace that is an ordinary project
  // directory sitting inside a directory that happens to hold a `matter.yaml`
  // would otherwise be adopted as that Matter, and every session in it would be
  // told it was working on someone else's case.
  const stop = typeof boundary === 'string' && boundary !== '' ? resolve(boundary) : undefined;
  if (stop !== undefined && !isWithin(stop, resolved)) {
    // The session is not inside its own Workspace, which the Workspace resolver
    // should have prevented. Refuse rather than walk somewhere unbounded.
    return { path: null, problem: null };
  }

  let directory = resolved;
  const end = stop ?? parsePath(directory).root;

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
    if (directory === end) break;
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
   * @param {(agent: any) => string[]|undefined} [deps.workspaceRootsFor] - resolves
   *   the Agent's Workspace directories: its own path first, then the directories
   *   added to it. They bound the walk (a Matter above the Workspace is never
   *   adopted) and they are searched (a Matter may live in an added directory).
   */
  constructor({ logger, find, workspaceRootsFor } = {}) {
    /** @private */ this.logger = logger;
    /** @private */ this.find = find ?? findMatter;
    /** @private */
    // Resolves the Agent's Workspace directories. Every caller passes them: an
    // earlier version of this comment argued that the Settings read could leave
    // the boundary out "because the Workspace path is its own start" — that
    // reasoning was wrong, and writing it down made the bug look deliberate.
    // Starting *at* the Workspace path does not stop the walk *at* it, so Settings
    // reported the enclosing Matter while the Agent reported none. Passing the
    // path as its own boundary is what makes the two reads agree.
    //
    // An Agent whose Workspace cannot be resolved at all is the only remaining
    // unbounded walk, and it is logged where that happens.
    this.workspaceRootsFor = workspaceRootsFor;
    /** @private @type {WeakMap<object, {facts: MatterFacts|null, problem: string|null}>} */
    this.agentIndex = new WeakMap();
    /** @private @type {Map<string, Promise<{facts: MatterFacts|null, problem: string|null}>>} keyed by path + declared set */
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
    let roots;
    try {
      roots = this.workspaceRootsFor?.(agent);
    } catch (error) {
      this.logger?.warn?.(
        `workspace-profile: could not resolve the Workspace directories bounding a Matter lookup (${messageOf(error)})`,
      );
      // Fail closed rather than open. An empty set walks to the filesystem root and
      // could adopt an enclosing Matter — telling this session it works on a case
      // it has nothing to do with, which is the failure the boundary exists to
      // prevent.
      roots = [cwd];
    }
    const answer = await this.resolvePath(cwd, roots);
    if (agent !== null && typeof agent === 'object') this.agentIndex.set(agent, answer);
    return answer;
  }

  /**
   * Resolve a directory, de-duplicating concurrent lookups for the same question.
   *
   * @param {string} path - an absolute directory to start at.
   * @param {string[]|string} [roots] - the Workspace's declared directories: its
   *   own path, then the ones added to it. An empty list walks to the filesystem
   *   root, which is correct only when the caller genuinely has no Workspace to
   *   bound by. A caller that *has* a Workspace and omits it will disagree with
   *   the Agent path — which is exactly how the Settings card came to report a
   *   Matter the session did not have.
   * @returns {Promise<{facts: MatterFacts|null, problem: string|null}>} the answer.
   */
  async resolvePath(path, roots = []) {
    // The declared set is part of the question, so it is part of the key: the same
    // directory under two Workspaces is two different answers.
    const declared = normaliseRoots(roots);
    const key = `${path}\u0000${declared.join('\u0000')}`;
    const existing = this.pending.get(key);
    if (existing !== undefined) return existing;

    const work = (async () => {
      try {
        return await this.find(path, declared.length === 0 ? {} : { roots: declared });
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

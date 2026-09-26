/**
 * The directory set one Workspace covers, in the order it is searched.
 *
 * ## Why this is its own module
 *
 * It is six lines, and it is the six lines the reported defect lived on. The
 * Matter of every real Workspace sat in an *added* directory while the plugin
 * searched only the registry path, so the rule "the Workspace's own directory,
 * then everything added to it" is the rule that decides whether a case is
 * recognised at all.
 *
 * It is also the one answer two readers share: the Settings card and the Agent
 * path both resolve through here, and they disagreeing is a defect this plugin
 * has already had once (the card reported an enclosing Matter no session had).
 * Pure, therefore testable, therefore describable — `src/index.js` stays what it
 * says it is: a place that acquires seams and owns no logic.
 *
 * @module dsh-workspace-profile/workspace-roots
 */

/**
 * Compose the declared directory set.
 *
 * The Workspace's own path comes first because order is the search order: the
 * session's own chain is the most specific answer available, and the added
 * directories are only consulted when it has none. Duplicates are dropped — an
 * added directory equal to the Workspace itself would otherwise be searched
 * twice — and unusable entries are skipped rather than passed on, because a
 * caller below would resolve them into the filesystem root.
 *
 * @param {object} input - the inputs.
 * @param {unknown} input.path - the Workspace's own directory, from the registry.
 * @param {unknown} [input.extra] - the directories added to it, from
 *   `ctx.workspaceDirs` (`{ dirs }`), or `undefined` when no such service is
 *   mounted or the Workspace has no record.
 * @returns {string[]} the directories, the Workspace's own first.
 */
export function composeWorkspaceRoots({ path, extra } = {}) {
  const roots = [];
  const add = (candidate) => {
    if (typeof candidate !== 'string' || candidate === '') return;
    if (roots.includes(candidate)) return;
    roots.push(candidate);
  };
  add(path);
  const dirs = Array.isArray(extra) ? extra : [];
  for (const dir of dirs) add(dir);
  return roots;
}

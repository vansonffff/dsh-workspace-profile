/**
 * The declared directory set, unit-tested.
 *
 * These assertions exist because of where the reported defect lived. The Matter
 * of every real Workspace sat in an added directory while the plugin searched
 * only the registry path, so "the Workspace's own directory, then everything
 * added to it" is the rule that decides whether a case is recognised at all —
 * and until this file, no test could see it: the operation tests supply their
 * own `getWorkspaceRoots`, so dropping a directory inside the real composition
 * would have failed nothing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { composeWorkspaceRoots } from '../src/workspace-roots.js';

test('the workspace directory comes first, then the added ones', () => {
  assert.deepEqual(
    composeWorkspaceRoots({ path: '/team/case', extra: ['/product/case'] }),
    ['/team/case', '/product/case'],
  );
});

test('a workspace with no added directories is just itself', () => {
  assert.deepEqual(composeWorkspaceRoots({ path: '/team/case' }), ['/team/case']);
  assert.deepEqual(composeWorkspaceRoots({ path: '/team/case', extra: [] }), ['/team/case']);
});

test('the first entry stays the workspace directory even when the added ones come first', () => {
  // Order is the search order: the session's own chain is decisive, and added
  // directories are only consulted when it answers nothing. A composition that
  // put them first would let an added directory override the case the session is
  // standing in.
  const roots = composeWorkspaceRoots({ path: '/team/case', extra: ['/a', '/b'] });
  assert.equal(roots[0], '/team/case');
});

test('duplicates are dropped, including a directory added equal to the workspace', () => {
  assert.deepEqual(composeWorkspaceRoots({ path: '/w', extra: ['/a', '/a', '/w', '/b'] }), ['/w', '/a', '/b']);
});

test('unusable entries are skipped rather than passed on', () => {
  // An empty string would resolve to the current working directory and an
  // absolute walk from there is not what anyone asked for.
  assert.deepEqual(composeWorkspaceRoots({ path: '/w', extra: ['', null, 7, undefined, '/a'] }), ['/w', '/a']);
  assert.deepEqual(composeWorkspaceRoots({ extra: ['/a'] }), ['/a'], 'no path still yields the added ones');
  assert.deepEqual(composeWorkspaceRoots({}), []);
  assert.deepEqual(composeWorkspaceRoots(), []);
});

test('a non-array extra is ignored rather than iterated', () => {
  // `ctx.workspaceDirs` is another plugin's contract; a shape surprise must not
  // turn into a broken search.
  assert.deepEqual(composeWorkspaceRoots({ path: '/w', extra: '/a' }), ['/w']);
  assert.deepEqual(composeWorkspaceRoots({ path: '/w', extra: { dirs: ['/a'] } }), ['/w']);
});

/**
 * The Matter card's read, tested at the layer where it was wrong.
 *
 * Discovery itself was already correct and already covered: `findMatter` stops at
 * the Workspace boundary and has tests for it. What was broken sat one level up —
 * `operations.matter()` called `resolvePath(workspace.path)` without passing that
 * boundary, so the Settings card walked to the filesystem root while the Agent,
 * bounded, stopped at the Workspace. One Workspace, two answers:
 *
 *     /Parent/
 *         matter.yaml          ← Matter A
 *         /OrdinaryWorkspace/  ← the Workspace
 *             src/
 *
 *     Agent     → no Matter
 *     Settings  → Matter A
 *
 * So these tests drive `operations.matter()` rather than the discovery function.
 * Testing the function that was already right is what let the bug through.
 *
 * The last test is the one that generalises: it asserts the two readers of one
 * Workspace *agree*, which is the property that broke, rather than either answer
 * on its own.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MatterResolver } from '../src/matter-resolution.js';
import { createOperations } from '../src/remote/operations.js';
import { emptyDocument } from '../src/policy.js';

const NOW = '2026-09-14T00:00:00.000Z';
const MATTER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Render a fixture the way CaseBench's own writer does: PyYAML block style. */
function renderMatter({ id = MATTER_ID, name = '测试案件', type = 'bankruptcy', role = 'administrator' } = {}) {
  return [
    'schema_version: 1',
    'matter:',
    `  id: ${id}`,
    '  code: null',
    `  name: ${name}`,
    '  aliases: []',
    `  type: ${type}`,
    '  subtypes: []',
    '  status: active',
    'engagement:',
    `  role: ${role}`,
    '  represented_party: null',
    'procedure:',
    '  kind: unknown',
    '  stage: unknown',
    'modules: []',
  ].join('\n') + '\n';
}

/**
 * Write a Matter and its case state — the pair the Contract requires.
 *
 * @param {string} directory - where the Matter Root is.
 * @param {object} [options] - the Matter's contents.
 */
async function writeMatter(directory, options = {}) {
  const id = options.id ?? MATTER_ID;
  await writeFile(join(directory, 'matter.yaml'), renderMatter({ ...options, id }));
  await writeFile(
    join(directory, '_case_state.json'),
    JSON.stringify({ schema_version: 4, matter_id: id, facts: [], issues: [] }),
  );
}

/**
 * A temporary parent directory that outlives the test.
 *
 * @param {any} t - the test context.
 * @returns {Promise<string>} the directory.
 */
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'matter-op-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * Build the operation set over one Workspace, wired to a real MatterResolver.
 *
 * Neither the resolver nor the discovery is stubbed: the bug was in how a real
 * caller drove a real resolver, and a stub on either side would have hidden it.
 *
 * @param {object} options - the fixture.
 * @param {string} options.path - the Workspace directory.
 * @param {string} [options.profile] - the stored Profile for the Workspace.
 * @param {string} [options.defaultPerspective] - the stored Perspective.
 * @returns {{ operations: any, resolver: MatterResolver, workspace: any }} the wiring.
 */
function build({ path, profile = 'bankruptcy', defaultPerspective = 'administrator' }) {
  const workspace = { id: 'ws-1', title: '测试工作区', path, sessionIds: [] };
  const document = emptyDocument(NOW);
  document.workspaces[workspace.id] = {
    createdAt: NOW,
    updatedAt: NOW,
    profile,
    defaultPerspective,
    onboardingStatus: 'configured',
  };
  const store = { read: () => ({ document, revision: 3, error: undefined }), revision: () => 3 };
  const resolver = {
    list: () => [workspace],
    describe: (id) => (id === workspace.id ? workspace : undefined),
  };
  const matterResolver = new MatterResolver({
    logger: { warn() {}, info() {}, error() {} },
    // The Agent half of the agreement test. Real sessions resolve their Workspace
    // through the same describe() the Settings read uses.
    workspacePathFor: () => workspace.path,
  });

  const operations = createOperations({
    getStore: () => store,
    getResolver: () => resolver,
    getMatterResolver: () => matterResolver,
    getCatalog: () => undefined,
    getSkills: () => undefined,
    getAgents: () => [],
    getScopeParent: () => undefined,
    getDispatcher: () => undefined,
    getDshHome: () => undefined,
    getProfileTexts: () => ({ profiles: {}, perspectives: {} }),
    capabilities: () => ({}),
    now: () => NOW,
    logger: { warn() {}, info() {}, error() {} },
  });

  return { operations, resolver: matterResolver, workspace };
}

// ── the boundary ─────────────────────────────────────────────────────────────

test('a Workspace with no Matter of its own reports none, not the enclosing one', async (t) => {
  const parent = await scratch(t);
  // The trap: an ordinary project directory inside a directory that holds a
  // matter.yaml. Before the fix this answered `discovered: true` and named the
  // parent's Matter, while every session in the Workspace reported none.
  await writeMatter(parent, { name: '外层案件' });
  const path = join(parent, 'ordinary-workspace');
  await mkdir(join(path, 'src'), { recursive: true });

  const { operations, workspace } = build({ path });
  const result = await operations.matter({ workspaceId: workspace.id });

  assert.equal(result.available, true);
  assert.equal(result.discovered, false, 'the enclosing Matter must not be adopted');
  assert.equal(result.matter, null);
  assert.equal(result.problem, null, 'no Matter here is an ordinary answer, not a problem');
});

test('a Workspace holding a Matter reports it, with its identity and its match', async (t) => {
  const path = await scratch(t);
  await writeMatter(path, { name: '真实案件' });

  const { operations, workspace } = build({ path });
  const result = await operations.matter({ workspaceId: workspace.id });

  assert.equal(result.available, true);
  assert.equal(result.discovered, true);
  assert.equal(result.problem, null);
  assert.equal(result.matter.id, MATTER_ID, 'identity comes from matter.id, not the name');
  assert.equal(result.matter.name, '真实案件');
  assert.equal(result.matter.type, 'bankruptcy');
  assert.equal(result.matter.role, 'administrator');
  // The match is part of this read, so it is part of this test: a Workspace
  // configured for the Matter it actually holds must not be told to change.
  assert.equal(result.match.profile.verdict, 'match');
  assert.equal(result.match.profile.expected, 'bankruptcy');
  assert.equal(result.match.perspective.verdict, 'match');
  assert.equal(result.match.perspective.expected, 'administrator');
  assert.equal(result.match.perspective.effectiveAgrees, true);
  assert.deepEqual(result.match.problems, []);
});

// ── the property that broke: one Workspace, one answer ───────────────────────

test('the Settings read and the Agent read of one Workspace agree', async (t) => {
  const parent = await scratch(t);
  await writeMatter(parent, { name: '外层案件' });

  // Both shapes, in one test, so neither can drift without the other failing.
  for (const [label, subdirectory, expected] of [
    ['an ordinary project directory', 'ordinary-workspace', false],
    ['a Matter Root', 'case-workspace', true],
  ]) {
    const path = join(parent, subdirectory);
    await mkdir(path, { recursive: true });
    if (expected) await writeMatter(path, { name: '真实案件' });

    const { operations, resolver, workspace } = build({ path });

    const settings = await operations.matter({ workspaceId: workspace.id });
    const agent = await resolver.resolveAgent({ session: { header: { cwd: path }, id: 's1' } });

    assert.equal(
      settings.discovered,
      agent.facts !== null,
      `Settings and Agent disagreed about ${label}`,
    );
    assert.equal(settings.discovered, expected, label);
    assert.equal(settings.matter?.id ?? null, agent.facts?.id ?? null);
  }
});

test('the boundary is the Workspace itself, so a nested Matter is found', async (t) => {
  const path = await scratch(t);
  await writeMatter(path, { name: '本工作区案件' });
  // A subdirectory with its own Matter must win over the Workspace's own, because
  // "nearest ancestor" is the rule on both sides.
  await mkdir(join(path, 'sub'), { recursive: true });
  await writeMatter(join(path, 'sub'), { id: 'ffffffff-0000-1111-2222-333333333333', name: '子目录案件' });

  const { operations, resolver, workspace } = build({ path });

  const settings = await operations.matter({ workspaceId: workspace.id });
  assert.equal(settings.matter.name, '本工作区案件', 'the Workspace path itself is searched');

  const agent = await resolver.resolveAgent({ session: { header: { cwd: join(path, 'sub') }, id: 's2' } });
  assert.equal(agent.facts.name, '子目录案件');
});

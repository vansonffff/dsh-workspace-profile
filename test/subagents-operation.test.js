/**
 * The Subagent Remote operations: the write path the Settings page actually uses,
 * and the read path the `@` menu uses.
 *
 * ## Why this file exists
 *
 * `test/client-bundle.test.js` asserts what the browser **sends** — it records the
 * `putSubagent` payload and asserts it carries `id`, `enabled` and the rest. The
 * host-side unit tests asserted `updateDefinition` in isolation. Nothing drove the
 * browser's payload through the host's own function, and that gap hid a real
 * 0.5.0 bug: the immutability guard refused any patch that *mentioned* `id` or
 * `key`, and the client mentions them on every single write — so the
 * enable/disable switch and the editor both failed with `invalid-subagent`, and
 * the only evidence was a red notice in a page nobody had opened a browser for
 * during that milestone.
 *
 * That is the failure mode this file closes: **one payload, built the way the
 * browser builds it, sent through the operation the browser calls.** A double that
 * is more permissive than the runtime is not a test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperations, mentionCatalog, projectPolicy } from '../src/remote/operations.js';
import { defaultWorkspacePolicy, emptyDocument } from '../src/policy.js';

const NOW = '2026-10-01T00:00:00.000Z';

/**
 * Apply one path op to a document, in place.
 *
 * @param {any} document - the settings section.
 * @param {any} op - `{ op: 'set'|'unset', path, value? }`.
 * @returns {void}
 */
function applyOp(document, op) {
  const parents = [document];
  for (const key of op.path.slice(0, -1)) {
    const parent = parents[parents.length - 1];
    if (parent[key] === null || typeof parent[key] !== 'object') parent[key] = {};
    parents.push(parent[key]);
  }
  const target = parents[parents.length - 1];
  const last = op.path[op.path.length - 1];
  if (op.op === 'set') target[last] = op.value;
  else delete target[last];
}

/**
 * Build the operations over one document and one Workspace.
 *
 * @param {object} [options] - the fixture.
 * @param {object} [options.policy] - the stored Workspace policy (merged over a default).
 * @param {any[]} [options.agents] - live Agents, each `{ session: { id } }`.
 * @param {string[]} [options.registrySessions] - sessions the Workspace record claims.
 * @returns {{ operations: any, document: any, writes: any[] }} the wiring.
 */
function build({ policy = {}, agents = [], registrySessions = [] } = {}) {
  const workspace = { id: 'ws-1', title: '测试工作区', path: '/tmp/ws-1', sessionIds: registrySessions };
  const document = emptyDocument(NOW);
  document.workspaces[workspace.id] = {
    ...defaultWorkspacePolicy(NOW),
    onboardingStatus: 'configured',
    ...policy,
  };
  const writes = [];
  /** The revision the caller read, which this store fences against. */
  let revision = 1;
  const store = {
    read: () => ({ document, revision, error: undefined }),
    revision: () => revision,
    write: async (ops, expectedRevision) => {
      writes.push({ ops, expectedRevision });
      if (expectedRevision !== revision) throw new Error('revision conflict');
      for (const op of ops) applyOp(document, op);
      revision += 1;
      return revision;
    },
  };
  const operations = createOperations({
    getStore: () => store,
    getResolver: () => ({
      list: () => [workspace],
      describe: (id) => (id === workspace.id ? workspace : undefined),
      workspaceIdForAgent: (agent) => (agents.includes(agent) ? workspace.id : undefined),
    }),
    getMatterResolver: () => undefined,
    getCatalog: () => undefined,
    getSkills: () => undefined,
    getAgents: () => ({ list: () => agents }),
    getAgentPresets: () => undefined,
    getDispatcher: () => undefined,
    getDshHome: () => undefined,
    getProfileTexts: () => ({ profiles: {}, perspectives: {} }),
    capabilities: () => ({}),
    now: () => NOW,
    logger: { warn() {}, info() {}, error() {} },
  });
  return { operations, document, writes };
}

/**
 * The exact payload the enable/disable switch builds.
 *
 * Copied from `client.js` (`SubagentCard`'s `onToggle`): the whole projected
 * definition, with `enabled` inverted. Written out here rather than imported
 * because the bundle cannot be imported — and that is the point, since the bug
 * this guards against lived in the difference between the two shapes.
 *
 * @param {any} definition - a definition as the page holds it.
 * @param {boolean} enabled - the new state.
 * @returns {any} the `subagent` argument.
 */
function switchPayload(definition, enabled) {
  return Object.assign({}, definition, { id: definition.id, enabled });
}

/** One stored definition, as the projection hands it to the page. */
const STORED = {
  id: 'sub-1',
  key: 'coding',
  name: '码农',
  description: '阅读并分析代码仓库；定位、复现并修复 Bug',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
};

test('the browser toggle payload is accepted by the host write path', async () => {
  const { operations, document } = build({ policy: { subagents: { 'sub-1': STORED } } });
  const projected = { ...STORED, backend: 'spawn', routeLabel: 'deepseek-official/deepseek-flash · max' };

  const result = await operations.putSubagent({
    workspaceId: 'ws-1',
    expectedRevision: 1,
    subagent: switchPayload(projected, false),
  });

  assert.equal(result.saved, true, result.message);
  const stored = document.workspaces['ws-1'].subagents['sub-1'];
  assert.equal(stored.enabled, false, 'the toggle must actually land');
  assert.equal(stored.key, 'coding');
  assert.equal(stored.createdAt, NOW, 'the creation stamp is not rewritten by an echo-back');
  assert.equal('routeLabel' in stored, false, 'a display-only projection field must not be persisted');
  // The projection carries `backend`, so the toggle writes it — and that is not a
  // migration. It is the plan's rule read literally: an edit made *through the
  // 0.6.0 page* saves an explicit backend, and the value it saves (`spawn`) is the
  // transport the record was already running on. Nothing about where it runs
  // changes; the next test covers the caller that does not mention it at all.
  assert.equal(stored.backend, 'spawn');
});

test('a caller that does not mention backend leaves the record exactly as it was', async () => {
  // The 0.5.0 client, a script, or any tool that predates this field. This is the
  // zero-migration promise with a caller attached to it.
  const { operations, document } = build({ policy: { subagents: { 'sub-1': STORED } } });
  const result = await operations.putSubagent({
    workspaceId: 'ws-1',
    expectedRevision: 1,
    subagent: {
      id: 'sub-1', key: 'coding', name: '码农', description: STORED.description,
      provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max', enabled: false,
    },
  });
  assert.equal(result.saved, true, result.message);
  assert.equal('backend' in document.workspaces['ws-1'].subagents['sub-1'], false);
});

test('the editor payload is accepted too, and writes the explicit backend', async () => {
  const { operations, document } = build({ policy: { subagents: { 'sub-1': STORED } } });
  const result = await operations.putSubagent({
    workspaceId: 'ws-1',
    expectedRevision: 1,
    subagent: {
      id: 'sub-1',
      key: 'coding',
      name: '码农（改名）',
      description: STORED.description,
      backend: 'spawn',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      instructions: '',
      enabled: true,
    },
  });
  assert.equal(result.saved, true, result.message);
  const stored = document.workspaces['ws-1'].subagents['sub-1'];
  assert.equal(stored.name, '码农（改名）');
  assert.equal(stored.backend, 'spawn', 'an explicit save is when the field is written');
});

test('a real rename is still refused loudly', async () => {
  const { operations } = build({ policy: { subagents: { 'sub-1': STORED } } });
  const result = await operations.putSubagent({
    workspaceId: 'ws-1',
    expectedRevision: 1,
    subagent: switchPayload({ ...STORED, key: 'coder' }, true),
  });
  assert.equal(result.saved, false);
  assert.equal(result.code, 'invalid-subagent');
  assert.ok(result.message.includes('key cannot be changed'), result.message);
});

test('a Codex definition can be created without a route', async () => {
  const { operations, document } = build();
  const result = await operations.putSubagent({
    workspaceId: 'ws-1',
    expectedRevision: 1,
    subagent: {
      key: 'code-expert',
      name: '代码专家',
      description: '在真实代码仓库中完成工程任务',
      backend: 'codex',
      instructions: '',
      enabled: true,
    },
  });
  assert.equal(result.saved, true, result.message);
  const created = Object.values(document.workspaces['ws-1'].subagents)[0];
  assert.equal(created.backend, 'codex');
  assert.equal(created.provider, '', 'the field exists but is empty; nothing reads it for Codex');
});

// ── the `@` menu's read path ────────────────────────────────────────────────

test('subagentsForSession resolves a live Agent session to its Workspace', async () => {
  const agent = { session: { id: 's-live', header: { cwd: '/tmp/ws-1' } } };
  const { operations } = build({
    agents: [agent],
    policy: {
      subagents: {
        'sub-1': STORED,
        'sub-2': { ...STORED, id: 'sub-2', key: 'off', name: '停用的', enabled: false },
        'sub-3': { id: 'sub-3', key: 'code-expert', name: '代码专家', description: '真实仓库', backend: 'codex', enabled: true, createdAt: NOW, updatedAt: NOW },
      },
    },
  });
  const result = await operations.subagentsForSession({ sessionId: 's-live' });
  assert.equal(result.available, true);
  assert.equal(result.workspaceId, 'ws-1');
  // Enabled only, key-sorted, and exactly the five fields the composer needs.
  assert.deepEqual(JSON.parse(JSON.stringify(result.subagents)), [
    { key: 'code-expert', name: '代码专家', description: '真实仓库', backend: 'codex', routeLabel: 'Codex' },
    {
      key: 'coding',
      name: '码农',
      description: STORED.description,
      backend: 'spawn',
      routeLabel: 'deepseek-official/deepseek-flash · max',
    },
  ]);
  for (const row of result.subagents) {
    assert.deepEqual(Object.keys(row).sort(), ['backend', 'description', 'key', 'name', 'routeLabel']);
  }
});

test('subagentsForSession falls back to the registry for a session with no live Agent', async () => {
  const { operations } = build({ registrySessions: ['s-retained'], policy: { subagents: { 'sub-1': STORED } } });
  const result = await operations.subagentsForSession({ sessionId: 's-retained' });
  assert.equal(result.available, true);
  assert.equal(result.workspaceId, 'ws-1');
  assert.equal(result.subagents.length, 1);
});

test('a session outside every Workspace is reported as such, not as an empty list', async () => {
  const { operations } = build({ policy: { subagents: { 'sub-1': STORED } } });
  const result = await operations.subagentsForSession({ sessionId: 's-elsewhere' });
  assert.equal(result.available, false);
  assert.equal(result.workspaceId, null);
  assert.deepEqual(result.subagents, []);
  assert.ok(result.message.includes('registered Workspace'), result.message);
  // An empty list and "I cannot answer" are different, and only one of them is
  // the user's problem to fix — which is why `available` exists.
  assert.notEqual(result.message, undefined);
});

test('a request with no Session id is a caller fault, not a business outcome', async () => {
  const { operations } = build();
  await assert.rejects(() => operations.subagentsForSession({}), (error) => error.code === 'unknown-session');
});

test('the mention catalog lists enabled definitions only, and leaking nothing else', () => {
  const rows = mentionCatalog({
    subagents: {
      a: { ...STORED, enabled: true },
      b: { ...STORED, id: 'b', key: 'off', enabled: false },
    },
  });
  assert.deepEqual(rows.map((row) => row.key), ['coding']);
});

test('the policy projection carries the backend and the route label', () => {
  const projected = projectPolicy({
    ...defaultWorkspacePolicy(NOW),
    subagents: {
      a: { ...STORED, enabled: true },
      b: { id: 'b', key: 'code-expert', name: '代码专家', description: 'x', backend: 'codex', enabled: true, createdAt: NOW, updatedAt: NOW },
    },
  });
  const byKey = Object.fromEntries(projected.subagents.map((row) => [row.key, row]));
  assert.equal(byKey.coding.backend, 'spawn');
  assert.equal(byKey.coding.routeLabel, 'deepseek-official/deepseek-flash · max');
  assert.equal(byKey['code-expert'].backend, 'codex');
  assert.equal(byKey['code-expert'].routeLabel, 'Codex');
  // Disabled definitions still appear here — the Settings list must show them —
  // while the mention catalog does not.
  assert.deepEqual(projected.enabledSubagentKeys, ['code-expert', 'coding']);
});

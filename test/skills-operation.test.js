/**
 * The `skills` Remote operation's scope resolution.
 *
 * The bug these tests pin: on the desktop app the Settings page listed only
 * deployment-level Skills forever. Scope-parent bindings live in a
 * module-private WeakMap inside dsh-scope, and the desktop Host embeds its own
 * copy of the platform inside its asar — so this package's `scopeParentOf`
 * never saw a binding the platform recorded. The 0.1.7 `agentPresets`
 * registry keeps both ends of the scope key inside the platform's instance
 * and, unlike the live-Agent path, answers without any session running.
 *
 * @module dsh-workspace-profile/test/skills-operation
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperations } from '../src/remote/operations.js';
import { emptyDocument } from '../src/policy.js';

const NOW = '2026-09-24T00:00:00.000Z';

/** One minimal catalog row the way `skills.snapshot` summarizes it. */
function skill(name, source) {
  return {
    name,
    description: `${name} description`,
    source,
    provider: 'test',
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

/** The shared observation log one wiring writes into. */
function recorder() {
  return { snapshots: [], acquired: [], disposed: 0 };
}

/**
 * A fake 0.1.7 `agentPresets` registry: a standing scope per id,
 * `composedPreset` reading a marker off the Agent context.
 *
 * @param {object} seen - the recorder.
 * @param {object} [options] - the fixture.
 * @param {string[]} [options.broken] - preset ids whose acquisition throws.
 * @param {boolean} [options.leaseRefuses] - leases whose disposal throws.
 * @returns {{ registry: any, defaultKey: object }} the fake and its default key.
 */
function fakePresets(seen, { broken = [], leaseRefuses = false } = {}) {
  const defaultKey = { standing: 'default' };
  const keys = new Map([[undefined, defaultKey]]);
  return {
    defaultKey,
    registry: {
      composedPreset: (ctx) => ctx?.presetId,
      async acquireScope(id) {
        seen.acquired.push(id);
        if (broken.includes(id)) throw new Error(`preset ${id} is broken`);
        if (!keys.has(id)) keys.set(id, { standing: id });
        return {
          key: keys.get(id),
          async [Symbol.asyncDispose]() {
            seen.disposed += 1;
            if (leaseRefuses) throw new Error('refusing to release');
          },
        };
      },
    },
  };
}

/**
 * Build the operation set over one Workspace with fake `skills` / `agents` /
 * `agentPresets` services, recording what the operation actually asked for.
 *
 * @param {object} options - the fixture.
 * @param {object} options.seen - the recorder shared with the fake presets.
 * @param {any} [options.agentPresets] - the fake registry, or `undefined` (0.1.5).
 * @param {any[]} [options.agents] - live Agents, each `{ ctx }`.
 * @returns {{ operations: any }} the wiring.
 */
function build({ seen, agentPresets, agents = [] }) {
  const workspace = { id: 'ws-1', title: '测试工作区', path: '/tmp/ws-1', sessionIds: agents.map((_, i) => `s-${i}`) };
  const document = emptyDocument(NOW);
  document.workspaces[workspace.id] = { createdAt: NOW, updatedAt: NOW, onboardingStatus: 'configured' };
  const store = { read: () => ({ document, revision: 1, error: undefined }), revision: () => 1 };

  const skills = {
    async snapshot({ scope }) {
      seen.snapshots.push(scope);
      return {
        complete: true,
        skills: scope === undefined ? [skill('deployment-skill', 'deployment')] : [skill('user-skill', 'user')],
      };
    },
  };

  const operations = createOperations({
    getStore: () => store,
    getResolver: () => ({ list: () => [workspace], describe: (id) => (id === workspace.id ? workspace : undefined) }),
    getMatterResolver: () => undefined,
    getCatalog: () => undefined,
    getSkills: () => skills,
    getAgents: () => ({ list: () => agents }),
    getAgentPresets: () => agentPresets,
    getDispatcher: () => undefined,
    getDshHome: () => undefined,
    getProfileTexts: () => ({ profiles: {}, perspectives: {} }),
    capabilities: () => ({}),
    now: () => NOW,
    logger: { warn() {}, info() {}, error() {} },
  });

  return { operations };
}

// ── the desktop bug ──────────────────────────────────────────────────────────

test('with agentPresets and no live Agent the default preset standing scope is read — no note', async () => {
  // This is the desktop case: zero live sessions, and the old scopeParentOf
  // path could never answer there. On the pre-fix code this test fails twice:
  // `scoped` was false and the page carried the "no live session" note.
  const seen = recorder();
  const { registry, defaultKey } = fakePresets(seen);
  const { operations } = build({ seen, agentPresets: registry });

  const result = await operations.skills({ workspaceId: 'ws-1' });

  assert.equal(result.available, true);
  assert.equal(result.scoped, true, 'a standing preset scope counts as a layer');
  assert.equal(result.note, null, 'the "no live session" note is obsolete once a preset scope answers');
  assert.deepEqual(seen.acquired, [undefined], 'the default preset is acquired');
  assert.ok(
    seen.snapshots.includes(defaultKey),
    'the catalog is read through the standing scope, not only unscoped',
  );
  const names = result.rows.map((row) => row.name).sort();
  assert.deepEqual(names, ['deployment-skill', 'user-skill']);
  assert.equal(seen.disposed, 1, 'every lease is released after the read');
});

test('a live Agent on a non-default preset contributes its layer alongside the default', async () => {
  const seen = recorder();
  const { registry } = fakePresets(seen);
  const { operations } = build({ seen, agentPresets: registry, agents: [{ id: 'a-1', ctx: { presetId: 'legal-team' } }] });

  const result = await operations.skills({ workspaceId: 'ws-1' });

  assert.deepEqual(new Set(seen.acquired), new Set([undefined, 'legal-team']));
  assert.equal(seen.disposed, 2);
  assert.equal(result.layersRead, 3, 'global + default + live preset');
});

test('a broken preset is skipped and the surviving scopes still answer', async () => {
  const seen = recorder();
  const { registry } = fakePresets(seen, { broken: ['legal-team'] });
  const { operations } = build({ seen, agentPresets: registry, agents: [{ id: 'a-1', ctx: { presetId: 'legal-team' } }] });

  const result = await operations.skills({ workspaceId: 'ws-1' });

  assert.equal(result.scoped, true, 'the default preset still answers');
  assert.equal(result.note, null);
  assert.equal(seen.disposed, 1, 'only the acquired lease is disposed');
});

test('a lease that refuses disposal does not fail the read it served', async () => {
  const seen = recorder();
  const { registry } = fakePresets(seen, { leaseRefuses: true });
  const { operations } = build({ seen, agentPresets: registry });

  const result = await operations.skills({ workspaceId: 'ws-1' });

  assert.equal(result.available, true);
  assert.equal(seen.disposed, 1, 'disposal was attempted');
});

// ── the pre-0.1.7 fallback ───────────────────────────────────────────────────

test('without agentPresets and without a live Agent the note still explains the list', async () => {
  // The 0.1.5 shape: no registry, no session — only the deployment's own
  // Skills are visible, and the page must say so rather than let
  // "recommended but not installed" read as a fact.
  const seen = recorder();
  const { operations } = build({ seen, agentPresets: undefined, agents: [] });

  const result = await operations.skills({ workspaceId: 'ws-1' });

  assert.equal(result.scoped, false);
  assert.ok(typeof result.note === 'string' && result.note.length > 0);
  assert.deepEqual(seen.snapshots, [undefined], 'only the unscoped read happened');
});

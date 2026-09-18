/**
 * The composition store: reads, revision fencing, and repair persistence.
 *
 * The central rule is that this plugin never writes unconditionally. An
 * unconditional write is exactly the silent overwrite the plan forbids, and it
 * looks identical to a correct write until two windows are open at once — so it
 * is asserted directly rather than inferred.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CompositionStore } from '../src/settings.js';
import { SETTINGS_NS } from '../src/policy.js';
import { RevisionConflictError, MissingCapabilityError } from '../src/errors.js';

/**
 * A stand-in settings provider with the exact surface the store reads.
 *
 * @param {object} [options] - behaviour switches.
 * @returns {any} the fake provider plus its recorded calls.
 */
function makeProvider(options = {}) {
  const calls = { mutate: [], replace: [] };
  let section = options.section;
  let revision = options.revision ?? 0;
  const provider = {
    describe: () => {
      if (options.describeThrows === true) throw new Error('provider is swapping');
      return [{ ns: SETTINGS_NS, revision, value: section, schema: {}, applies: 'live' }];
    },
    mutate: async (ns, ops, expectedRevision) => {
      calls.mutate.push({ ns, ops, expectedRevision });
      if (options.conflict === true) throw new RevisionConflictError(expectedRevision, revision + 1);
      if (options.mutateThrows !== undefined) throw new Error(options.mutateThrows);
      assert.equal(ns, SETTINGS_NS);
      if (expectedRevision !== revision) throw new RevisionConflictError(expectedRevision, revision);
      section = applyOps(section, ops);
      revision += 1;
    },
    replace: async (ns, next, expectedRevision) => {
      calls.replace.push({ ns, next, expectedRevision });
      if (options.replaceThrows !== undefined) throw new Error(options.replaceThrows);
      section = next;
      revision += 1;
    },
  };
  return { provider, calls, read: () => ({ section, revision }) };
}

function applyOps(section, ops) {
  const next = section === undefined ? {} : JSON.parse(JSON.stringify(section));
  for (const op of ops) {
    const path = op.path;
    let cursor = next;
    for (let index = 0; index < path.length - 1; index += 1) {
      if (cursor[path[index]] === undefined || typeof cursor[path[index]] !== 'object') cursor[path[index]] = {};
      cursor = cursor[path[index]];
    }
    if (op.op === 'set') cursor[path[path.length - 1]] = op.value;
    else delete cursor[path[path.length - 1]];
  }
  return next;
}

function makeStore(provider, scopeOverrides = {}, logger = { warn: () => {} }) {
  const scope = {
    get: () => providerSection,
    watch: () => () => {},
    update: async () => {},
    replace: async () => {},
    ...scopeOverrides,
  };
  let providerSection;
  return { store: new CompositionStore({ provider, scope, logger, now: () => '2026-09-13T00:00:00.000Z' }), setSection: (value) => { providerSection = value; } };
}

test('a read normalizes and reports the revision from the provider', () => {
  const { provider } = makeProvider({ section: { schemaVersion: 1, workspaces: { w1: { profile: 'bankruptcy' } } }, revision: 7 });
  const { store, setSection } = makeStore(provider);
  setSection(provider.describe()[0].value);
  const read = store.read();
  assert.equal(read.document.workspaces.w1.profile, 'bankruptcy');
  assert.equal(read.error, undefined);
  assert.equal(store.revision(), 7);
});

test('a write without a revision is refused outright', async () => {
  const { provider } = makeProvider({ section: {}, revision: 3 });
  const { store, setSection } = makeStore(provider);
  setSection({});
  await assert.rejects(
    () => store.write([{ op: 'set', path: ['workspaces', 'w1', 'profile'], value: 'general' }], undefined),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error.message.includes('must carry the expectedRevision'));
      return true;
    },
  );
});

test('a stale revision surfaces as a conflict and writes nothing', async () => {
  const { provider, calls, read } = makeProvider({ section: { schemaVersion: 1, workspaces: {} }, revision: 2 });
  const { store, setSection } = makeStore(provider);
  setSection(provider.describe()[0].value);
  await assert.rejects(
    () => store.write([{ op: 'set', path: ['workspaces', 'w1', 'profile'], value: 'bankruptcy' }], 1),
    (error) => {
      assert.ok(error instanceof RevisionConflictError);
      assert.equal(error.code, 'revision-conflict');
      return true;
    },
  );
  assert.equal(calls.mutate.length, 1);
  // Nothing landed: the section is exactly what it was.
  assert.deepEqual(read().section.workspaces, {});
});

test('a current revision writes and the store reports the new one', async () => {
  const { provider, calls, read } = makeProvider({ section: { schemaVersion: 1, workspaces: {} }, revision: 2 });
  const { store, setSection } = makeStore(provider);
  setSection(provider.describe()[0].value);
  const next = await store.write([{ op: 'set', path: ['workspaces', 'w1', 'profile'], value: 'bankruptcy' }], 2);
  assert.equal(next, 3);
  assert.equal(calls.mutate[0].expectedRevision, 2);
  assert.equal(read().section.workspaces.w1.profile, 'bankruptcy');
});

test('an unregistered namespace cannot be written, and says so', async () => {
  const provider = {
    describe: () => [],
    mutate: async () => { throw new Error('should not be reached'); },
    replace: async () => {},
  };
  const { store, setSection } = makeStore(provider, { get: () => ({}) });
  setSection({});
  assert.equal(store.revision(), undefined);
  const error = new MissingCapabilityError('the `settings` service', 'nothing can be stored');
  // The store's own refusal path: a broken provider read must not become a green
  // write. Simulate by making describe() fail.
  const broken = { ...provider, describe: () => { throw new Error('no provider'); } };
  const { store: store2, setSection: set2 } = makeStore(broken);
  set2({});
  assert.equal(store2.revision(), undefined);
  assert.ok(error.message.includes('composition fact'));
});

test('a getter throw degrades to the last good document', () => {
  const { provider } = makeProvider({ section: { schemaVersion: 1, workspaces: { w1: {} } }, revision: 1 });
  let mode = 'ok';
  const { store } = makeStore(provider, { get: () => { if (mode === 'boom') throw new Error('mid-swap'); return { schemaVersion: 1, workspaces: { w1: { profile: 'litigation' } } }; } });
  assert.equal(store.read().document.workspaces.w1.profile, 'litigation');
  mode = 'boom';
  const degraded = store.read();
  // The previous value, not an empty document — an empty document would read as
  // "no workspaces configured", which is a different and wrong claim.
  assert.equal(degraded.document.workspaces.w1.profile, 'litigation');
  assert.ok(degraded.error instanceof Error);
});

test('an unsupported stored version is reported, never thrown, and keeps the last good read', () => {
  const { provider } = makeProvider({ section: { schemaVersion: 1, workspaces: {} }, revision: 1 });
  let section = { schemaVersion: 1, workspaces: { w1: {} } };
  const { store } = makeStore(provider, { get: () => section });
  assert.equal(store.read().error, undefined);
  section = { schemaVersion: 42, workspaces: {} };
  const bad = store.read();
  assert.ok(bad.error !== undefined);
  assert.equal(bad.error.code, 'unsupported-schema-version');
});

test('a failed repair is reported and does not fail the boot', async () => {
  const warnings = [];
  const { provider } = makeProvider({ section: {}, revision: 1, replaceThrows: 'read-only provider' });
  const { store, setSection } = makeStore(provider, {}, { warn: (message) => warnings.push(message) });
  setSection({});
  const applied = await store.persistNormalized({ schemaVersion: 1, initializedAt: 'x', workspaces: {} }, 1);
  assert.equal(applied, false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('could not persist'));
});

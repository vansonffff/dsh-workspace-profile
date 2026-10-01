/**
 * The `backend` field's write path: who may set it, who may not, and what an
 * absent value means.
 *
 * The dispatcher tests cover where a definition *runs*; this file covers what
 * gets **stored**. The two are separate failures — a definition that is read
 * correctly but written with a lost field runs somewhere the user did not choose
 * on the next call, and nothing on screen would say so.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InvalidSubagentError } from '../src/errors.js';
import { subagentBackend } from '../src/policy.js';
import { createDefinition, updateDefinition } from '../src/subagent-registry.js';

const NOW = '2026-10-01T00:00:00.000Z';

const INPUT = {
  name: '代码专家',
  key: 'code-expert',
  description: '在真实代码仓库中完成工程任务',
};

test('a create writes an explicit backend, defaulting to spawn', () => {
  // The plan's rule: an explicit value is written when the user creates or edits,
  // so a fresh record never depends on the compatibility reading.
  const dspawn = createDefinition(
    { ...INPUT, key: 'coding', name: '码农', provider: 'deepseek-official', model: 'deepseek-flash' },
    {},
    NOW,
  );
  assert.equal(dspawn.backend, 'spawn');
  const codex = createDefinition({ ...INPUT, backend: 'codex' }, {}, NOW);
  assert.equal(codex.backend, 'codex');
});

test('a create for Codex needs no route, and a create for spawn still does', () => {
  const codex = createDefinition({ ...INPUT, backend: 'codex' }, {}, NOW);
  assert.equal('provider' in codex, true, 'the field is present but empty, as the form sends it');
  assert.equal(codex.provider, '');
  assert.equal(codex.model, '');
  assert.equal(subagentBackend(codex), 'codex');

  assert.throws(
    () => createDefinition(INPUT, {}, NOW),
    (error) => {
      assert.ok(error instanceof InvalidSubagentError);
      assert.ok(error.message.includes('provider is required for a DSH-subagent backend'));
      return true;
    },
  );
});

test('an unrecognised backend is refused rather than rewritten to spawn', () => {
  // Coercing `acp` to `spawn` would be the silent transport substitution this
  // whole field exists to prevent.
  assert.throws(
    () => createDefinition({ ...INPUT, backend: 'acp', provider: 'p', model: 'm' }, {}, NOW),
    (error) => {
      assert.ok(error instanceof InvalidSubagentError);
      assert.ok(error.message.includes('backend, when present, must be one of spawn, codex'));
      return true;
    },
  );
});

test('editing an old definition leaves it without a backend field', () => {
  // The zero-regression case. A caller that knows nothing about `backend` — the
  // 0.5.0 client, a script, a test — must be able to toggle `enabled` and get the
  // same record back, not one that has quietly acquired a field.
  const legacy = {
    id: 'a', key: 'coding', name: '码农', description: '阅读并分析代码仓库',
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
    enabled: true, createdAt: NOW, updatedAt: NOW,
  };
  const toggled = updateDefinition(legacy, { enabled: false }, { a: legacy }, NOW);
  assert.equal('backend' in toggled, false);
  assert.equal(subagentBackend(toggled), 'spawn');
  assert.equal(toggled.enabled, false);

  // An explicit `undefined` is the same statement as an absent key: "this write
  // does not mention the backend".
  const ignored = updateDefinition(legacy, { backend: undefined, name: '码农' }, { a: legacy }, NOW);
  assert.equal('backend' in ignored, false);

  // And an explicit value is honoured, including a switch to Codex.
  const switched = updateDefinition(legacy, { backend: 'codex' }, { a: legacy }, NOW);
  assert.equal(switched.backend, 'codex');
  // The stale route is *not* erased by this function: the client clears it when
  // the backend changes, and erasing it here would silently drop data a caller
  // might still be using. What matters is that nothing *reads* it.
  assert.equal(subagentBackend(switched), 'codex');
});

test('an edit cannot introduce an unknown backend either', () => {
  const legacy = {
    id: 'a', key: 'coding', name: '码农', description: 'x',
    provider: 'deepseek-official', model: 'deepseek-flash',
    enabled: true, createdAt: NOW, updatedAt: NOW,
  };
  assert.throws(
    () => updateDefinition(legacy, { backend: 'fork' }, { a: legacy }, NOW),
    (error) => {
      assert.ok(error instanceof InvalidSubagentError);
      assert.ok(error.message.includes('spawn, codex'));
      return true;
    },
  );
});

test('a Codex definition survives a round trip through the projection', () => {
  // The Settings card reads a projected definition and writes it back on toggle.
  // The projection adds `backend` and `routeLabel`; `routeLabel` is display-only
  // and must not be persisted, or every save would grow the stored record.
  const stored = {
    id: 'a', key: 'code-expert', name: '代码专家', description: 'x', backend: 'codex',
    enabled: true, createdAt: NOW, updatedAt: NOW,
  };
  const projected = { ...stored, routeLabel: 'Codex' };
  const written = updateDefinition(stored, { ...projected, enabled: false }, { a: stored }, NOW);
  assert.equal(written.backend, 'codex');
  assert.equal('routeLabel' in written, false, 'a display field must never be stored');
  assert.equal('provider' in written, false, 'and neither may a route a Codex definition does not have');
});

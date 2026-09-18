/**
 * Data-model tests.
 *
 * Every assertion that guards a *rule* is paired with a negative control: an
 * input the rule must reject. A validator that accepts everything passes a
 * happy-path test, so only the rejection proves the check exists.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PERSPECTIVES_BY_PROFILE,
  PERSPECTIVE_LABELS,
  PROFILE_IDS,
  SCHEMA_VERSION,
  defaultKeyFor,
  defaultWorkspacePolicy,
  disabledSkills,
  emptyDocument,
  enabledSubagents,
  findDuplicateKey,
  findSubagent,
  isSkillEnabled,
  isValidSubagentKey,
  normalizeDocument,
  normalizeWorkspacePolicy,
  perspectivesFor,
  recommendedSkills,
  resolveWorkspacePolicy,
  validateProfilePerspective,
  validateSubagentDefinition,
  validateSubagentEdit,
} from '../src/policy.js';
import { UnsupportedSchemaVersionError } from '../src/errors.js';

const NOW = '2026-09-13T00:00:00.000Z';

test('an absent document resolves to an empty v1 document', () => {
  const { document, migratedFrom, changed } = normalizeDocument(undefined, NOW);
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.equal(document.initializedAt, NOW);
  assert.deepEqual(document.workspaces, {});
  assert.equal(migratedFrom, null);
  // Nothing to persist: a fresh install must not write anything on boot.
  assert.equal(changed, false);
});

test('a version-less stored section is read as v1 and not rewritten', () => {
  const { document, migratedFrom, changed } = normalizeDocument({ workspaces: { w1: { profile: 'litigation' } } }, NOW);
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.equal(document.workspaces.w1.profile, 'litigation');
  // Negative control for the auto-write: guessing that a hand-written section
  // needs rewriting would be a write nobody asked for.
  assert.equal(migratedFrom, null);
  assert.equal(changed, false);
});

test('an unknown declared version is refused, naming the version', () => {
  assert.throws(
    () => normalizeDocument({ schemaVersion: 99, workspaces: {} }, NOW),
    (error) => {
      assert.ok(error instanceof UnsupportedSchemaVersionError, 'expected UnsupportedSchemaVersionError');
      assert.equal(error.code, 'unsupported-schema-version');
      assert.equal(error.found, 99);
      assert.equal(error.supported, SCHEMA_VERSION);
      return true;
    },
  );
});

test('a declared older version runs the migration chain and reports it', () => {
  // No released version precedes 1, so the runner is exercised through an
  // injected table: a mechanism that has never run is a mechanism nobody can
  // claim works.
  const seen = [];
  const migrations = {
    0: (doc) => {
      seen.push(0);
      return { ...doc, schemaVersion: 1, workspaces: { w1: { profile: 'bankruptcy' } } };
    },
  };
  const result = normalizeDocument({ schemaVersion: 0, workspaces: {} }, NOW, migrations);
  assert.deepEqual(seen, [0]);
  assert.equal(result.migratedFrom, 0);
  assert.equal(result.changed, true, 'a real migration must be worth persisting');
  assert.equal(result.document.workspaces.w1.profile, 'bankruptcy');

  // Negative control: a gap in the chain stops rather than silently skipping.
  assert.throws(
    () => normalizeDocument({ schemaVersion: 0, workspaces: {} }, NOW, {}),
    UnsupportedSchemaVersionError,
  );
});

test('unknown fields survive normalization', () => {
  const { document } = normalizeDocument(
    { schemaVersion: 1, workspaces: { w1: { profile: 'bankruptcy', futureField: { a: 1 } } } },
    NOW,
  );
  assert.deepEqual(document.workspaces.w1.futureField, { a: 1 });
});

test('timestamps fall back to initializedAt, never to the clock', () => {
  const first = normalizeWorkspacePolicy({ profile: 'general' }, NOW);
  const second = normalizeWorkspacePolicy({ profile: 'general' }, '2030-01-01T00:00:00.000Z');
  // A clock-derived fallback would make a record look newly created on every
  // read; the same stored value must normalize identically whatever the clock is.
  assert.equal(first.createdAt, NOW);
  const withDoc = normalizeDocument({ schemaVersion: 1, initializedAt: NOW, workspaces: { w1: {} } }, '2030-01-01T00:00:00.000Z');
  assert.equal(withDoc.document.workspaces.w1.createdAt, NOW);
  assert.notEqual(second.createdAt, undefined);
});

test('an impossible Profile/Perspective pair is repaired toward safety', () => {
  const repaired = normalizeWorkspacePolicy({ profile: 'general', defaultPerspective: 'administrator' }, NOW);
  assert.equal(repaired.profile, 'general');
  assert.equal(repaired.defaultPerspective, 'none');

  const unknownProfile = normalizeWorkspacePolicy({ profile: 'nope', defaultPerspective: 'debtor' }, NOW);
  assert.equal(unknownProfile.profile, 'general');
  assert.equal(unknownProfile.defaultPerspective, 'none');
});

test('Profile/Perspective validation accepts exactly the legal combinations', () => {
  assert.equal(validateProfilePerspective('general', 'none'), null);
  assert.equal(validateProfilePerspective('bankruptcy', 'administrator'), null);
  assert.equal(validateProfilePerspective('litigation', 'plaintiff'), null);
  assert.equal(validateProfilePerspective('litigation', 'defendant'), null);

  // The property that matters is cross-domain refusal, not "which Profiles have
  // stances": every Profile accepts its own vocabulary and refuses every *other*
  // Profile's. A validator that only checked "is this a real Perspective id"
  // would let a Bankruptcy Administrator be stored under a Litigation Workspace,
  // where the prompt composer would then inject an insolvency stance into a
  // lawsuit.
  for (const profile of PROFILE_IDS) {
    const own = PERSPECTIVES_BY_PROFILE[profile];
    for (const perspective of own) {
      assert.equal(
        validateProfilePerspective(profile, perspective),
        null,
        `${profile} + ${perspective} must be accepted`,
      );
    }
    for (const other of PROFILE_IDS) {
      if (other === profile) continue;
      for (const perspective of PERSPECTIVES_BY_PROFILE[other]) {
        if (perspective === 'none') continue;
        assert.notEqual(
          validateProfilePerspective(profile, perspective),
          null,
          `${profile} + ${perspective} (a ${other} stance) must be refused`,
        );
      }
    }
  }

  assert.notEqual(validateProfilePerspective('general', 'nope'), null);
  assert.notEqual(validateProfilePerspective('nope', 'none'), null);
  assert.deepEqual(perspectivesFor('general'), ['none']);
  assert.equal(perspectivesFor('bankruptcy').length, PERSPECTIVES_BY_PROFILE.bankruptcy.length);
  assert.equal(perspectivesFor('litigation').length, PERSPECTIVES_BY_PROFILE.litigation.length);
  // An unknown Profile must not be a way to obtain a stance.
  assert.deepEqual(perspectivesFor('nope'), ['none']);
});

test('the Perspective vocabulary is internally consistent', () => {
  const seen = new Map();
  for (const profile of PROFILE_IDS) {
    const vocabulary = PERSPECTIVES_BY_PROFILE[profile];
    assert.ok(Array.isArray(vocabulary), `${profile} must declare a vocabulary`);
    // `none` is always available: "no stance" is a real answer in every domain.
    assert.equal(vocabulary[0], 'none', `${profile}'s vocabulary must start with none`);
    assert.equal(new Set(vocabulary).size, vocabulary.length, `${profile} has a duplicate id`);

    for (const id of vocabulary) {
      assert.equal(typeof PERSPECTIVE_LABELS[id], 'string', `${profile}/${id} has no label`);
      // `none` is the shared "no stance" sentinel and appears in every vocabulary
      // by design. Every *other* id is domain-specific and must be globally
      // unique: the Settings page and `/perspective` resolve a label from an id
      // alone, so a collision would silently relabel a stance.
      if (id === 'none') continue;
      assert.equal(seen.has(id), false, `Perspective id "${id}" is used by both ${seen.get(id)} and ${profile}`);
      seen.set(id, profile);
    }
  }
  // A label for an id no vocabulary offers is dead weight that will drift.
  for (const id of Object.keys(PERSPECTIVE_LABELS)) {
    if (id === 'none') continue;
    assert.equal(seen.has(id), true, `label "${id}" belongs to no Profile vocabulary`);
  }
});

test('an unconfigured workspace resolves to general/none but stays unconfigured', () => {
  const document = emptyDocument(NOW);
  const { policy, configured } = resolveWorkspacePolicy(document, 'missing', NOW);
  assert.equal(policy.profile, 'general');
  assert.equal(policy.defaultPerspective, 'none');
  assert.deepEqual(policy.skillOverrides, {});
  // The distinction the Settings page depends on: resolving like General is not
  // the same as the user having chosen General.
  assert.equal(configured, false);
});

test('a stored policy reports configured only when the status says so', () => {
  const document = normalizeDocument(
    { schemaVersion: 1, initializedAt: NOW, workspaces: { w1: { onboardingStatus: 'configured' } } },
    NOW,
  ).document;
  assert.equal(resolveWorkspacePolicy(document, 'w1', NOW).configured, true);
});

test('Subagent keys obey one grammar, and the default key always satisfies it', () => {
  for (const good of ['a', 'case-researcher', 'agent-0', 'x1']) {
    assert.equal(isValidSubagentKey(good), true, `${good} should be valid`);
  }
  for (const bad of ['', 'Case-Research', 'case_researcher', '-lead', 'a b', 'A', null, 42, 'x'.repeat(65)]) {
    assert.equal(isValidSubagentKey(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
  for (const id of ['3f9a2c1b-0000-4000-8000-000000000000', 'ZZZ', '']) {
    assert.equal(isValidSubagentKey(defaultKeyFor(id)), true, `derived key for ${id} must be valid`);
  }
});

test('definition validation names every problem at once', () => {
  const problems = validateSubagentDefinition({
    id: '',
    key: 'Bad Key',
    name: '  ',
    description: '',
    provider: '',
    model: '',
    enabled: 'yes',
  });
  assert.ok(problems.length >= 6, `expected several problems, got ${JSON.stringify(problems)}`);
  assert.equal(validateSubagentDefinition(makeDefinition()).length, 0);
});

test('id is immutable and key freezes at creation', () => {
  const previous = makeDefinition();
  assert.deepEqual(validateSubagentEdit(previous, { ...previous, name: '新名字' }), []);
  const changedId = validateSubagentEdit(previous, { ...previous, id: 'other' });
  assert.ok(changedId.some((problem) => problem.includes('id cannot be changed')));
  const changedKey = validateSubagentEdit(previous, { ...previous, key: 'other-key' });
  assert.ok(changedKey.some((problem) => problem.includes('key cannot be changed')));
});

test('duplicate keys are found within a workspace and only there', () => {
  assert.equal(
    findDuplicateKey({ a: makeDefinition({ id: 'a' }), b: makeDefinition({ id: 'b' }) }),
    'case-researcher',
  );
  assert.equal(findDuplicateKey({ a: makeDefinition({ id: 'a', key: 'x' }), b: makeDefinition({ id: 'b', key: 'y' }) }), null);
  assert.equal(findDuplicateKey({ a: makeDefinition({ id: 'a' }) }), null);
});

test('Skill overrides default to enabled, and only "disabled" disables', () => {
  const policy = defaultWorkspacePolicy(NOW);
  assert.equal(isSkillEnabled(policy, 'anything'), true);
  policy.skillOverrides = { 'legal-case-bench': 'disabled', other: 'enabled' };
  assert.equal(isSkillEnabled(policy, 'legal-case-bench'), false);
  assert.equal(isSkillEnabled(policy, 'other'), true);
  assert.deepEqual(disabledSkills(policy), ['legal-case-bench']);
  // `recommended` is a hint, not a gate: a recommended Skill must remain usable,
  // which is what makes it a third state rather than a form of disabling.
  policy.skillOverrides = { flagged: 'recommended' };
  assert.equal(isSkillEnabled(policy, 'flagged'), true);
});

test('recommendations merge the Profile and the Workspace, and disabled wins', () => {
  const policy = defaultWorkspacePolicy(NOW);
  policy.profile = 'litigation';
  policy.skillOverrides = {};

  // Baseline: the Profile's own list, which every Litigation Workspace gets.
  const fromProfile = recommendedSkills(policy);
  assert.ok(fromProfile.length > 0);
  assert.equal(fromProfile.every((entry) => entry.source === 'profile'), true);
  assert.deepEqual(fromProfile.map((entry) => entry.name), [...fromProfile.map((e) => e.name)].sort());

  // A Workspace can add its own, and the source distinguishes them.
  policy.skillOverrides = { 'contract-review': 'recommended' };
  const withWorkspace = recommendedSkills(policy);
  assert.deepEqual(
    withWorkspace.filter((entry) => entry.source === 'workspace').map((entry) => entry.name),
    ['contract-review'],
  );
  assert.equal(withWorkspace.length, fromProfile.length + 1);

  // A name both sources want is reported once, as the Profile's — the broader
  // source is the one worth showing, and one Skill must not look like two rows.
  const shared = fromProfile[0].name;
  policy.skillOverrides = { [shared]: 'recommended' };
  const merged = recommendedSkills(policy);
  assert.equal(merged.filter((entry) => entry.name === shared).length, 1);
  assert.equal(merged.find((entry) => entry.name === shared).source, 'profile');

  // Disabling beats both: recommending a Skill the user turned off would tell the
  // model to use something it cannot load.
  policy.skillOverrides = { [shared]: 'disabled', 'contract-review': 'recommended' };
  const afterDisable = recommendedSkills(policy);
  assert.equal(afterDisable.some((entry) => entry.name === shared), false);

  // `enabled` is not a recommendation; it is the absence of one.
  policy.skillOverrides = { plain: 'enabled' };
  assert.equal(recommendedSkills(policy).some((entry) => entry.name === 'plain'), false);

  // General recommends nothing of its own, so only explicit Workspace choices show.
  policy.profile = 'general';
  policy.skillOverrides = {};
  assert.deepEqual(recommendedSkills(policy), []);
});

test('enabled Subagents are key-sorted and disabled ones are absent entirely', () => {
  const policy = defaultWorkspacePolicy(NOW);
  policy.subagents = {
    b: makeDefinition({ id: 'b', key: 'zebra' }),
    a: makeDefinition({ id: 'a', key: 'alpha' }),
    c: makeDefinition({ id: 'c', key: 'beta', enabled: false }),
  };
  assert.deepEqual(enabledSubagents(policy).map((entry) => entry.key), ['alpha', 'zebra']);
});

test('lookup prefers the key and falls back to the exact name only', () => {
  const policy = defaultWorkspacePolicy(NOW);
  policy.subagents = {
    a: makeDefinition({ id: 'a', key: 'case-researcher', name: '案例检索员' }),
    b: makeDefinition({ id: 'b', key: 'renamed', name: 'case-researcher' }),
  };
  assert.equal(findSubagent(policy, 'case-researcher').id, 'a');
  assert.equal(findSubagent(policy, '案例检索员').id, 'a');
  // No fuzzy matching: a typo must fail loudly rather than run another expert.
  assert.equal(findSubagent(policy, '案例检索'), undefined);
  assert.equal(findSubagent(policy, '  '), undefined);
  assert.equal(findSubagent(policy, undefined), undefined);
  assert.equal(findSubagent(policy, ''), undefined);
});

test('a disabled definition is invisible to lookup, not merely refused', () => {
  const policy = defaultWorkspacePolicy(NOW);
  policy.subagents = { a: makeDefinition({ id: 'a', enabled: false }) };
  assert.equal(findSubagent(policy, 'case-researcher'), undefined);
});

function makeDefinition(overrides = {}) {
  return {
    id: 'a',
    key: 'case-researcher',
    name: '案例检索员',
    description: '检索并核验与当前任务相关的法律规则和案例',
    provider: 'kimi-coding',
    model: 'k3',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

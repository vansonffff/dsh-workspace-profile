import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findMatter, isMissing, normaliseRoots, searchOrigins } from '../src/matter-resolution.js';
import {
  ROLE_TO_PERSPECTIVE,
  matchMatter,
  perspectiveForMatter,
  profileForMatterType,
} from '../src/matter-match.js';
import { CASEBENCH_ROLES, CASEBENCH_TYPES } from '../src/matter-contract.js';
import { validateProfilePerspective } from '../src/policy.js';

/** Render a fixture document the way CaseBench's writer would: PyYAML block style. */
const renderMatter = (document) => {
  const matter = document.matter;
  const engagement = document.engagement;
  const procedure = document.procedure;
  return [
    'schema_version: 1',
    'matter:',
    `  id: ${matter.id}`,
    '  code: null',
    `  name: ${matter.name}`,
    '  aliases: []',
    `  type: ${matter.type}`,
    '  subtypes: []',
    `  status: ${matter.status}`,
    'engagement:',
    `  role: ${engagement.role}`,
    '  represented_party: null',
    'procedure:',
    `  kind: ${procedure.kind}`,
    `  stage: ${procedure.stage}`,
    'modules: []',
  ].join('\n') + '\n';
};

const MATTER_DOCUMENT = (overrides = {}) => ({
  schema_version: 1,
  matter: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: '测试案件', type: 'bankruptcy', status: 'active', ...overrides.matter },
  engagement: { role: 'administrator', ...overrides.engagement },
  procedure: { kind: 'unknown', stage: 'unknown', ...overrides.procedure },
});

/**
 * Write a Matter **and its case state**.
 *
 * The Contract requires the pair: `matter.yaml` carries the identity and
 * `_case_state.json` carries the same `matter_id`, and CaseBench hard-stops when
 * they disagree. A fixture with only the first half is not a Matter this plugin
 * will accept, which is the point of the test below that writes one deliberately.
 */
async function writeMatter(directory, overrides = {}, state = undefined) {
  const document = MATTER_DOCUMENT(overrides);
  await writeFile(join(directory, 'matter.yaml'), renderMatter(document));
  if (state === null) return document;
  await writeFile(
    join(directory, '_case_state.json'),
    JSON.stringify(state ?? { schema_version: 4, matter_id: document.matter.id, facts: [], issues: [] }),
  );
  return document;
}

const MATTER = (overrides = {}) => renderMatter(MATTER_DOCUMENT(overrides));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'matter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// ── discovery ────────────────────────────────────────────────────────────────

test('the nearest ancestor with a matter.yaml is the Matter Root', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'outer', 'inner'), { recursive: true });
  await writeMatter(root, { matter: { name: '外层' } });
  await writeMatter(join(root, 'outer'), { matter: { name: '中层' } });
  const { facts } = await findMatter(join(root, 'outer', 'inner'));
  assert.equal(facts.name, '中层');
});

test('identity comes from the file, never from the directory name', async (t) => {
  const root = await workspace(t);
  // A directory named after one matter holding another matter's contract. The id
  // in the file wins; a plugin that read the name would report the wrong Matter.
  const dir = join(root, '看起来像示例系列案件');
  await mkdir(dir);
  await writeMatter(dir, { matter: { id: '99999999-8888-7777-6666-555555555555' } });
  const { facts } = await findMatter(dir);
  assert.equal(facts.id, '99999999-8888-7777-6666-555555555555');
});

test('no matter.yaml anywhere is an ordinary answer, not a problem', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'plain'), { recursive: true });
  const { facts, problem } = await findMatter(join(root, 'plain'));
  assert.equal(facts, null);
  assert.equal(problem, null);
});

test('a present but unparsable matter.yaml is reported, not skipped upward', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'inner'), { recursive: true });
  await writeMatter(root, { matter: { name: '外层' } });
  // Anchor syntax: outside the supported subset.
  await writeFile(join(root, 'inner', 'matter.yaml'), 'schema_version: 1\nmatter: &m\n  id: x\n');
  const { facts, problem } = await findMatter(join(root, 'inner'));
  assert.equal(facts, null, 'must not fall through to the outer Matter');
  assert.match(problem, /无法解析/);
});

test('a matter.yaml without an id is reported', async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, 'matter.yaml'), 'schema_version: 1\nmatter:\n  name: 无身份\n');
  const { facts, problem } = await findMatter(root);
  assert.equal(facts, null);
  assert.match(problem, /不符合 CaseBench Contract/);
  assert.match(problem, /matter\.id/);
});

test('a symlinked matter.yaml is refused', async (t) => {
  const root = await workspace(t);
  const real = join(root, 'real.yaml');
  await writeMatter(root, {}, null);
  await writeFile(real, MATTER());
  await unlink(join(root, 'matter.yaml'));
  await symlink(real, join(root, 'matter.yaml'));
  const { facts, problem } = await findMatter(root);
  assert.equal(facts, null);
  assert.match(problem, /符号链接/);
});

test('the projection carries the fields the header needs', async (t) => {
  const root = await workspace(t);
  await writeMatter(root, { matter: { type: 'non-litigation' }, engagement: { role: 'debtor' }, procedure: { stage: 'negotiation' } });
  const { facts } = await findMatter(root);
  assert.equal(facts.type, 'non-litigation');
  assert.equal(facts.role, 'debtor');
  assert.equal(facts.stage, 'negotiation');
  assert.deepEqual(facts.modules, []);
  assert.equal(facts.path, join(root, 'matter.yaml'));
});

// ── mapping ──────────────────────────────────────────────────────────────────

test('a known type maps to its Profile; an unknown domain maps to general', () => {
  assert.equal(profileForMatterType('litigation'), 'litigation');
  assert.equal(profileForMatterType('bankruptcy'), 'bankruptcy');
  assert.equal(profileForMatterType('non-litigation'), 'non-litigation');
  // "The domain is unknown" is not a domain. `general` claims nothing and offers
  // no stance, which is the honest answer.
  assert.equal(profileForMatterType('other'), 'general');
  assert.equal(profileForMatterType('unclassified'), 'general');
  assert.equal(profileForMatterType(undefined), 'general');
});

test('every valid CaseBench pair maps to a pair this plugin offers', () => {
  // CaseBench's own vocabulary, type by type — the combinations that can legally
  // appear in a matter.yaml. Asserting the mapping against the live Profile
  // vocabulary is the point: a mapping producing an id no Profile offers would
  // inject nothing and say nothing about why.
  const VALID = {
    litigation: ['plaintiff', 'defendant', 'third-party', 'appellant', 'respondent', 'applicant', 'respondent-to-application'],
    bankruptcy: ['administrator', 'debtor', 'creditor', 'investor', 'restructuring-advisor'],
    'non-litigation': ['debtor', 'creditor', 'investor', 'restructuring-advisor'],
  };
  for (const [type, roles] of Object.entries(VALID)) {
    const profile = profileForMatterType(type);
    for (const role of [...roles, 'unknown', 'other']) {
      const perspective = perspectiveForMatter({ type, role });
      assert.notEqual(perspective, null, `${type}/${role} must map`);
      assert.equal(
        validateProfilePerspective(profile, perspective),
        null,
        `${type}/${role} → ${profile}/${perspective} must be an offered pair`,
      );
    }
  }
  // "The domain is unknown" still yields an offered pair — `general` + `none`.
  for (const type of ['other', 'unclassified']) {
    for (const role of ['unknown', 'other']) {
      assert.equal(perspectiveForMatter({ type, role }), 'none');
    }
  }
});

test('an impossible pair yields null, not an id from another domain', () => {
  // `litigation + administrator` is a combination CaseBench refuses; if it reaches
  // this plugin through a hand-edited file, the mapping must not hand back
  // `administrator` — that id belongs to the Bankruptcy Profile, and a careless
  // caller could store it.
  assert.equal(perspectiveForMatter({ type: 'litigation', role: 'administrator' }), null);
  assert.equal(perspectiveForMatter({ type: 'non-litigation', role: 'plaintiff' }), null);
  // And the comparison reports it rather than translating it.
  const result = matchMatter({
    matter: matterWith(FACTS({ type: 'litigation', role: 'administrator' })),
    policy: { profile: 'litigation', defaultPerspective: 'plaintiff' },
  });
  assert.equal(result.perspective.expected, 'none');
  assert.equal(result.perspective.verdict, 'unknown');
  assert.match(result.problems[0], /无法映射/);
});

test('non-litigation roles map to their distinct ids', () => {
  assert.equal(perspectiveForMatter({ type: 'non-litigation', role: 'debtor' }), 'debtor-oc');
  assert.equal(perspectiveForMatter({ type: 'non-litigation', role: 'creditor' }), 'creditor-oc');
  assert.equal(perspectiveForMatter({ type: 'non-litigation', role: 'investor' }), 'investor-oc');
  assert.equal(perspectiveForMatter({ type: 'non-litigation', role: 'restructuring-advisor' }), 'advisor-oc');
});

test('litigation and bankruptcy map by identity, and that is recorded not assumed', () => {
  assert.equal(perspectiveForMatter({ type: 'bankruptcy', role: 'administrator' }), 'administrator');
  assert.equal(perspectiveForMatter({ type: 'litigation', role: 'plaintiff' }), 'plaintiff');
  assert.equal(perspectiveForMatter({ type: 'litigation', role: 'respondent-to-application' }), 'respondent-to-application');
});

test('every type has an explicit row covering exactly the Contract’s roles', () => {
  // This is what makes "recorded, not assumed" true rather than a comment. With a
  // fallback of "no table means the names coincide", a rename on either side would
  // drift silently; with this assertion it turns red here instead.
  for (const type of CASEBENCH_TYPES) {
    const table = ROLE_TO_PERSPECTIVE[type];
    assert.ok(table !== undefined, `${type} must have an explicit row, not a fallback`);
    assert.deepEqual(
      Object.keys(table).sort(),
      [...CASEBENCH_ROLES[type]].sort(),
      `${type}'s row must list exactly the roles CaseBench 3.2.8 defines for it`,
    );
  }
});

test('an unknown type maps to nothing rather than to itself', () => {
  // The fallback this replaced would have returned `plaintiff` unchanged here.
  assert.equal(perspectiveForMatter({ type: 'a-type-we-never-heard-of', role: 'plaintiff' }), null);
});

test('unknown and other roles mean no stance, in every domain', () => {
  for (const type of ['litigation', 'bankruptcy', 'non-litigation']) {
    for (const role of ['unknown', 'other']) {
      assert.equal(perspectiveForMatter({ type, role }), 'none');
    }
  }
});

// ── comparison ───────────────────────────────────────────────────────────────

const matterWith = (facts, problem = null) => ({ facts, problem });
const FACTS = (over = {}) => ({
  root: '/x', path: '/x/matter.yaml', id: 'id-1', name: '案', type: 'bankruptcy',
  role: 'administrator', stage: 'unknown', modules: [], status: 'active', ...over,
});

test('agreement is a match', () => {
  const result = matchMatter({
    matter: matterWith(FACTS()),
    policy: { profile: 'bankruptcy', defaultPerspective: 'administrator' },
  });
  assert.equal(result.profile.verdict, 'match');
  assert.equal(result.perspective.verdict, 'match');
  assert.deepEqual(result.problems, []);
});

test('a Workspace configured otherwise is a mismatch', () => {
  const result = matchMatter({
    matter: matterWith(FACTS()),
    policy: { profile: 'litigation', defaultPerspective: 'plaintiff' },
  });
  assert.equal(result.profile.verdict, 'mismatch');
  assert.equal(result.perspective.verdict, 'mismatch');
  assert.equal(result.profile.expected, 'bankruptcy');
  assert.equal(result.perspective.expected, 'administrator');
});

test('a session override outranks the default and is reported as such', () => {
  const result = matchMatter({
    matter: matterWith(FACTS()),
    policy: { profile: 'bankruptcy', defaultPerspective: 'none' },
    sessionOverride: 'creditor',
  });
  assert.equal(result.perspective.verdict, 'override');
  assert.equal(result.perspective.effective, 'creditor');
  assert.equal(result.perspective.workspaceDefault, 'none');
  // An override that agrees is still an override — the session chose it.
  assert.equal(result.perspective.effectiveAgrees, false);
});

test('an override that agrees says so without becoming a match', () => {
  const result = matchMatter({
    matter: matterWith(FACTS()),
    policy: { profile: 'bankruptcy', defaultPerspective: 'none' },
    sessionOverride: 'administrator',
  });
  assert.equal(result.perspective.verdict, 'override');
  assert.equal(result.perspective.effectiveAgrees, true);
});

test('no Matter is "unknown", never a mismatch', () => {
  const result = matchMatter({
    matter: { facts: null, problem: null },
    policy: { profile: 'bankruptcy', defaultPerspective: 'administrator' },
  });
  assert.equal(result.matter, null);
  assert.equal(result.profile.verdict, 'unknown');
  assert.equal(result.perspective.verdict, 'unknown');
  assert.deepEqual(result.problems, []);
});

test('an unreadable Matter carries its reason through', () => {
  const result = matchMatter({
    matter: { facts: null, problem: 'matter.yaml 无法解析：line 2: ...' },
    policy: { profile: 'general', defaultPerspective: 'none' },
  });
  assert.equal(result.profile.verdict, 'unknown');
  assert.equal(result.problems.length, 1);
});

test('a Matter whose own type/role pair does not validate is reported, not translated', () => {
  // CaseBench enforces this pairing, so reaching here means a hand-edited file.
  const result = matchMatter({
    matter: matterWith(FACTS({ type: 'litigation', role: 'administrator' })),
    policy: { profile: 'litigation', defaultPerspective: 'plaintiff' },
  });
  assert.equal(result.perspective.verdict, 'unknown');
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /无法映射/);
});

test('the comparison never writes to the policy it is given', () => {
  const policy = { profile: 'general', defaultPerspective: 'none' };
  const before = JSON.stringify(policy);
  matchMatter({ matter: matterWith(FACTS()), policy, sessionOverride: 'creditor' });
  assert.equal(JSON.stringify(policy), before);
});

// ── the Workspace boundary ───────────────────────────────────────────────────
//
// CaseBench's rule is "walk up to the workspace root, never across it". Without
// the boundary a Workspace that is an ordinary project directory inside a
// directory that happens to hold a matter.yaml would be adopted as that Matter,
// and every session in it would be told it was working on someone else's case.

test('a Matter above the Workspace root is not adopted', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'workspace-B', 'src'), { recursive: true });
  // A matter belonging to the parent — a different case, or another project.
  await writeMatter(root, { matter: { name: '外层的案件' } });

  const cwd = join(root, 'workspace-B', 'src');
  const unbounded = await findMatter(cwd);
  assert.equal(unbounded.facts?.name, '外层的案件', 'without a boundary the walk does reach it');

  const bounded = await findMatter(cwd, { roots: [join(root, 'workspace-B')] });
  assert.equal(bounded.facts, null, 'with the boundary it must not');
  assert.equal(bounded.problem, null, 'and that is an ordinary "no Matter", not a failure');
});

test('a Matter at or inside the Workspace root is still found', async (t) => {
  const root = await workspace(t);
  // A decoy above both Workspaces below, so a run that silently lost its boundary
  // would answer with *this* Matter rather than passing by accident.
  await writeMatter(root, { matter: { name: '外层干扰案' } });

  // At the root.
  const at = join(root, 'at-root');
  await mkdir(join(at, 'sub'), { recursive: true });
  await writeMatter(at, { matter: { name: '根本案' } });
  const atRoot = await findMatter(join(at, 'sub'), { roots: [at] });
  assert.equal(atRoot.facts?.name, '根本案');

  // Below the root, above the cwd.
  const nested = join(root, 'nested');
  await mkdir(join(nested, 'case', 'deep', 'deeper'), { recursive: true });
  await writeMatter(join(nested, 'case'), { matter: { name: '嵌套案' } });
  const found = await findMatter(join(nested, 'case', 'deep', 'deeper'), { roots: [nested] });
  assert.equal(found.facts?.name, '嵌套案');
});

test('a cwd outside its own Workspace resolves to no Matter, not to a guess', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'elsewhere'), { recursive: true });
  await writeMatter(root);
  const result = await findMatter(join(root, 'elsewhere'), { roots: [join(root, 'other-root')] });
  assert.equal(result.facts, null);
  assert.equal(result.problem, null);
});

test('a sibling with a shared prefix is not inside the Workspace', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'matter-old'), { recursive: true });
  await writeMatter(root, { matter: { name: '外层' } });
  // `/…/matter-old` starts with `/…/matter` as a string but is not a child of it.
  const result = await findMatter(join(root, 'matter-old'), { roots: [join(root, 'matter')] });
  assert.equal(result.facts, null);
});

// ── the Workspace's declared set ─────────────────────────────────────────────
//
// A Workspace is not necessarily one directory. DSH's multi-root model lets it
// declare additional writable directories, and a CaseBench Matter may live in one
// of them — the shape this plugin reported as "no matter.yaml" for every real
// Workspace on the machine it was written on (`My Legal-agents/<案件>/matter.yaml`
// beside a team drive holding the case files).
//
// The rules being pinned here: the set is searched; the session's own chain wins;
// a directory is not searched *through*; and a set naming two cases is reported
// rather than resolved by directory order.

test('a Matter in a directory added to the Workspace is found', async (t) => {
  const root = await workspace(t);
  const caseDir = join(root, 'team-drive', '案件_1');
  const productDir = join(root, 'My Legal-agents', '案件');
  await mkdir(caseDir, { recursive: true });
  await mkdir(productDir, { recursive: true });
  await writeMatter(productDir, { matter: { name: '真实案件' } });

  // The bug: the case directory holds the work and the product directory holds the
  // Matter, so a search that stops at the Workspace's own directory answers "none".
  const before = await findMatter(caseDir, { roots: [caseDir] });
  assert.equal(before.facts, null, 'the primary directory alone has no Matter — that was the report');

  const after = await findMatter(caseDir, { roots: [caseDir, productDir] });
  assert.equal(after.facts?.name, '真实案件');
  assert.equal(after.problem, null);
  assert.equal(after.facts.root, productDir, 'the facts name where it was actually read from');
});

test("the session's own chain wins over an added directory", async (t) => {
  const root = await workspace(t);
  const caseDir = join(root, 'case');
  const added = join(root, 'added');
  await mkdir(caseDir, { recursive: true });
  await mkdir(added, { recursive: true });
  // Both hold a Matter. The nearest-ancestor rule decides the session's own chain,
  // so an added directory never overrides the case the session is standing in —
  // and this is the ambiguity the *next* test shows when the chain is silent.
  await writeMatter(caseDir, { matter: { name: '本目录案件' } });
  await writeMatter(added, { matter: { id: 'ffffffff-0000-1111-2222-333333333333', name: '附加目录案件' } });

  const result = await findMatter(caseDir, { roots: [caseDir, added] });
  assert.equal(result.facts?.name, '本目录案件');
  assert.equal(result.problem, null);
});

test('two declared directories holding two Matters are reported, not resolved', async (t) => {
  const root = await workspace(t);
  const caseDir = join(root, 'case');
  const addedA = join(root, 'added-a');
  const addedB = join(root, 'added-b');
  for (const dir of [caseDir, addedA, addedB]) await mkdir(dir, { recursive: true });
  await writeMatter(addedA, { matter: { name: '案件甲' } });
  await writeMatter(addedB, { matter: { id: 'ffffffff-0000-1111-2222-333333333333', name: '案件乙' } });

  const result = await findMatter(caseDir, { roots: [caseDir, addedA, addedB] });
  assert.equal(result.facts, null, 'picking one would be a statement nobody made');
  assert.match(result.problem, /多个目录各有一个 matter\.yaml/);
  assert.match(result.problem, /案件甲|added-a/);
  assert.match(result.problem, /added-b/);
});

test('an added directory is not searched through to the directory above it', async (t) => {
  const root = await workspace(t);
  const caseDir = join(root, 'case');
  const productRoot = join(root, 'My Legal-agents');
  const caseSub = join(productRoot, '案件', '子案件');
  await mkdir(caseDir, { recursive: true });
  await mkdir(caseSub, { recursive: true });
  await writeMatter(join(productRoot, '案件'), { matter: { name: '案件' } });

  // The added directory is a *subdirectory* of the Matter Root. Declaring only the
  // subdirectory must not reach the Matter above it: the walk stops at the topmost
  // declared directory, exactly as it stops at the Workspace root.
  const narrow = await findMatter(caseDir, { roots: [caseDir, caseSub] });
  assert.equal(narrow.facts, null, 'the Matter above an added directory is not adopted');
  assert.equal(narrow.problem, null);

  // Declaring the Matter Root as well makes it reachable — the user stated it.
  const wide = await findMatter(caseDir, { roots: [caseDir, caseSub, join(productRoot, '案件')] });
  assert.equal(wide.facts?.name, '案件');
});

test('a session whose cwd sits in an added directory is searched from there', async (t) => {
  const root = await workspace(t);
  const caseDir = join(root, 'case');
  const added = join(root, 'added');
  await mkdir(join(added, 'sub'), { recursive: true });
  await mkdir(caseDir, { recursive: true });
  await writeMatter(added, { matter: { name: '附加目录案件' } });

  const result = await findMatter(join(added, 'sub'), { roots: [caseDir, added] });
  assert.equal(result.facts?.name, '附加目录案件');
});

test('the declared set is resolved and de-duplicated, and unusable entries are dropped', () => {
  assert.deepEqual(normaliseRoots(['/a', '/a', '/b/']), ['/a', '/b']);
  assert.deepEqual(normaliseRoots('/a'), ['/a'], 'one directory does not need wrapping');
  assert.deepEqual(normaliseRoots(['', null, 7, '/a']), ['/a']);
  assert.deepEqual(normaliseRoots(undefined), []);
  assert.deepEqual(normaliseRoots([]), []);
});

test('searchOrigins: the walk stops at the topmost declared directory containing the start', () => {
  // One directory: the rule CaseBench states, unchanged.
  assert.deepEqual(searchOrigins('/w/sub', ['/w']), [{ start: '/w/sub', boundary: '/w' }]);
  // A start that contains another start is dropped: the deeper walk covers it.
  assert.deepEqual(searchOrigins('/w', ['/w', '/w/added']), [{ start: '/w/added', boundary: '/w' }]);
  // Unrelated directories are searched as themselves.
  assert.deepEqual(searchOrigins('/team/case', ['/team/case', '/product/case']), [
    { start: '/team/case', boundary: '/team/case' },
    { start: '/product/case', boundary: '/product/case' },
  ]);
  // A cwd outside every declared directory is not searched at all.
  assert.deepEqual(searchOrigins('/elsewhere', ['/w']), [{ start: '/w', boundary: '/w' }]);
  // No declared set keeps the single unbounded walk.
  assert.deepEqual(searchOrigins('/w/sub', []), [{ start: '/w/sub', boundary: undefined }]);
});

// ── the Contract, not just the syntax ────────────────────────────────────────
//
// The YAML reader is strict about *syntax*. These are about *semantics*: a
// document CaseBench would have refused to write must not become a confident,
// ordinary-looking answer here. Before this check, `type: nonsense` fell back to
// the `general` Profile and `schema_version: 999` was not noticed at all.

test('a document outside the CaseBench Contract is refused, not coerced', async (t) => {
  const cases = [
    ['a wrong schema_version', 'schema_version: 999\nmatter:\n  id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n  name: x\n  type: bankruptcy\nengagement:\n  role: administrator\n', /schema_version/],
    ['an id that is not a UUID', 'schema_version: 1\nmatter:\n  id: not-a-uuid\n  name: x\n  type: bankruptcy\nengagement:\n  role: administrator\n', /matter\.id/],
    ['an empty name', 'schema_version: 1\nmatter:\n  id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n  name: ""\n  type: bankruptcy\nengagement:\n  role: administrator\n', /matter\.name/],
    ['a type outside the vocabulary', 'schema_version: 1\nmatter:\n  id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n  name: x\n  type: nonsense\nengagement:\n  role: administrator\n', /matter\.type/],
    ['a role the type does not allow', 'schema_version: 1\nmatter:\n  id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n  name: x\n  type: litigation\nengagement:\n  role: administrator\n', /engagement\.role/],
    ['a missing role', 'schema_version: 1\nmatter:\n  id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n  name: x\n  type: bankruptcy\nengagement:\n  represented_party: null\n', /engagement\.role/],
  ];
  for (const [what, text, pattern] of cases) {
    const root = await workspace(t);
    await writeFile(join(root, 'matter.yaml'), text);
    await writeFile(join(root, '_case_state.json'), JSON.stringify({ schema_version: 4, matter_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    const { facts, problem } = await findMatter(root);
    assert.equal(facts, null, `${what} must not produce facts`);
    assert.match(problem ?? '', /不符合 CaseBench Contract/, what);
    assert.match(problem ?? '', pattern, what);
  }
});

test('the escape hatches stay legal beside every type', async (t) => {
  for (const type of ['litigation', 'bankruptcy', 'non-litigation', 'other', 'unclassified']) {
    for (const role of ['unknown', 'other']) {
      const root = await workspace(t);
      const document = await writeMatter(root, { matter: { type }, engagement: { role } });
      assert.equal(document.matter.type, type);
      const { facts, problem } = await findMatter(root);
      assert.equal(problem, null, `${type} + ${role} must be readable`);
      assert.equal(facts?.role, role);
    }
  }
});

test('a Matter whose case state does not exist is refused', async (t) => {
  // CaseBench treats the pair as the contract, and hard-stops when state is
  // missing. A consumer that read only matter.yaml could tell a child "you are
  // working on Matter AAA" about a case that has no state at all.
  const root = await workspace(t);
  await writeMatter(root, {}, null);
  const { facts, problem } = await findMatter(root);
  assert.equal(facts, null);
  assert.match(problem, /_case_state\.json/);
});

test('a Matter whose state carries a different identity is refused', async (t) => {
  const root = await workspace(t);
  await writeMatter(root, {}, { schema_version: 4, matter_id: '99999999-8888-7777-6666-555555555555' });
  const { facts, problem } = await findMatter(root);
  assert.equal(facts, null, 'two identities must not be resolved by picking one');
  assert.match(problem, /身份不一致/);
});

test('a Matter whose state is not v4 is refused', async (t) => {
  const root = await workspace(t);
  await writeMatter(root, {}, { schema_version: 3, matter_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  const { facts, problem } = await findMatter(root);
  assert.equal(facts, null);
  assert.match(problem, /schema_version 必须是 4/);
});

test('an unreadable candidate stops the walk instead of sending it upward', async (t) => {
  // The failure this guards against is not "the file could not be read" — it is
  // that the walk *continues past it* and adopts a Matter from further up, which
  // attributes this session to a case it has nothing to do with.
  const root = await workspace(t);
  await mkdir(join(root, 'inner'), { recursive: true });
  await writeMatter(root, { matter: { name: '外层' } });
  // A directory where the contract should be: `lstat` succeeds, and the entry is
  // not a regular file. That path is already a stop; this asserts it stays one.
  await mkdir(join(root, 'inner', 'matter.yaml'));
  const { facts, problem } = await findMatter(join(root, 'inner'));
  assert.equal(facts, null, 'must not fall through to the outer Matter');
  assert.match(problem, /不是普通文件/);
});

test('only ENOENT and ENOTDIR count as "nothing here"', () => {
  assert.equal(isMissing(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
  assert.equal(isMissing(Object.assign(new Error('x'), { code: 'ENOTDIR' })), true);
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENAMETOOLONG']) {
    assert.equal(isMissing(Object.assign(new Error('x'), { code })), false, code);
  }
  assert.equal(isMissing(new Error('no code')), false);
  assert.equal(isMissing(undefined), false);
});

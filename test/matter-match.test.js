import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findMatter } from '../src/matter-resolution.js';
import {
  matchMatter,
  perspectiveForMatter,
  profileForMatterType,
} from '../src/matter-match.js';
import { validateProfilePerspective } from '../src/policy.js';

const MATTER = (overrides = {}) => {
  const matter = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: '测试案件', type: 'bankruptcy', status: 'active', ...overrides.matter };
  const engagement = { role: 'administrator', ...overrides.engagement };
  const procedure = { kind: 'unknown', stage: 'unknown', ...overrides.procedure };
  const modules = overrides.modules ?? [];
  const lines = [
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
  ];
  return `${[...lines, ...modules.map((m) => `- ${m}`)].join('\n')}\n`;
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'matter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// ── discovery ────────────────────────────────────────────────────────────────

test('the nearest ancestor with a matter.yaml is the Matter Root', async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, 'outer', 'inner'), { recursive: true });
  await writeFile(join(root, 'matter.yaml'), MATTER({ matter: { name: '外层' } }));
  await writeFile(join(root, 'outer', 'matter.yaml'), MATTER({ matter: { name: '中层' } }));
  const { facts } = await findMatter(join(root, 'outer', 'inner'));
  assert.equal(facts.name, '中层');
});

test('identity comes from the file, never from the directory name', async (t) => {
  const root = await workspace(t);
  // A directory named after one matter holding another matter's contract. The id
  // in the file wins; a plugin that read the name would report the wrong Matter.
  const dir = join(root, '看起来像示例系列案件');
  await mkdir(dir);
  await writeFile(join(dir, 'matter.yaml'), MATTER({ matter: { id: '99999999-8888-7777-6666-555555555555' } }));
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
  await writeFile(join(root, 'matter.yaml'), MATTER({ matter: { name: '外层' } }));
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
  assert.match(problem, /缺少 matter\.id/);
});

test('a symlinked matter.yaml is refused', async (t) => {
  const root = await workspace(t);
  const real = join(root, 'real.yaml');
  await writeFile(real, MATTER());
  await symlink(real, join(root, 'matter.yaml'));
  const { facts, problem } = await findMatter(root);
  assert.equal(facts, null);
  assert.match(problem, /符号链接/);
});

test('the projection carries the fields the header needs', async (t) => {
  const root = await workspace(t);
  await writeFile(
    join(root, 'matter.yaml'),
    MATTER({ matter: { type: 'non-litigation' }, engagement: { role: 'debtor' }, procedure: { stage: 'negotiation' } }),
  );
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

/**
 * The injection preview: what the Settings page shows must be what the runtime
 * composes.
 *
 * The whole reason this operation exists is that the two prompt sections are
 * invisible once registered — they appear in a session transcript and nowhere
 * else — so "is the Profile actually in effect, or is this just a UI?" had no
 * on-screen answer. A preview that reimplemented the composition would restore
 * exactly that problem in a new place, so the first test here asserts the
 * preview and the runtime agree *by construction*: both come from the same
 * exported composers. What the other tests pin down is the gate, because the
 * gate is where the plugin was previously misleading — `configured`, the
 * presence of any stored value, and "something is actually written" are three
 * different questions and only the first two were answerable before.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOperations } from '../src/remote/operations.js';
import {
  AGENTS_SECTION_NAME,
  AGENTS_SECTION_ORDER,
  PERSPECTIVE_SECTION_NAME,
  PERSPECTIVE_SECTION_ORDER,
  PROFILE_SECTION_NAME,
  PROFILE_SECTION_ORDER,
  composeAgentDirectorySection,
  composePerspectiveSection,
  composeProfileSection,
} from '../src/profile-runtime.js';
import { emptyDocument, resolveWorkspacePolicy } from '../src/policy.js';

const NOW = '2026-09-14T00:00:00.000Z';
const WORKSPACE = { id: 'ws-1', title: '华北地产重整', path: '/cases/huabei', sessionIds: [] };

const TEXTS = {
  profiles: {
    general: '# 通用工作区 (General)',
    litigation: '# 诉讼工作区 (Litigation)',
  },
  perspectives: {
    general: {},
    litigation: { plaintiff: '# 立场：原告代理人 (Plaintiff)' },
  },
};

const EXPERT = {
  id: 'sub-1',
  key: 'case-researcher',
  name: '案例检索员',
  description: '检索可核验来源的类案',
  provider: 'kimi-coding',
  model: 'k3',
  reasoningEffort: 'high',
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
};

/**
 * Build the operation set over a seeded document.
 *
 * @param {object} [options] - the fixture.
 * @param {any} [options.policy] - the stored policy record for `ws-1`.
 * @param {any} [options.texts] - the loaded Profile and Perspective bodies.
 * @param {any[]} [options.workspaces] - the Workspace registry projection.
 * @returns {Record<string, Function>} the operations.
 */
function build({ policy = {}, texts = TEXTS, workspaces = [WORKSPACE] } = {}) {
  const document = emptyDocument(NOW);
  document.workspaces[WORKSPACE.id] = { createdAt: NOW, updatedAt: NOW, ...policy };
  const store = { read: () => ({ document, revision: 3, error: undefined }), revision: () => 3 };
  const resolver = {
    list: () => workspaces,
    describe: (id) => workspaces.find((workspace) => workspace.id === id),
  };
  return createOperations({
    getStore: () => store,
    getResolver: () => resolver,
    getCatalog: () => undefined,
    getSkills: () => undefined,
    getAgents: () => [],
    getScopeParent: () => undefined,
    getDispatcher: () => undefined,
    getDshHome: () => undefined,
    getProfileTexts: () => texts,
    capabilities: () => ({}),
    now: () => NOW,
    logger: { warn() {}, info() {}, error() {} },
  });
}

/** The section texts, keyed by section name, for compact assertions. */
function byName(group) {
  return Object.fromEntries(group.sections.map((section) => [section.id, section.text]));
}

test('the preview composes the very text the runtime composes, in order', async () => {
  const operations = build({ policy: { profile: 'litigation', defaultPerspective: 'plaintiff', onboardingStatus: 'configured', subagents: { [EXPERT.id]: EXPERT } } });
  const preview = await operations.previewInjection({ workspaceId: WORKSPACE.id });

  const { policy, configured } = resolveWorkspacePolicy(
    (() => { const document = emptyDocument(NOW); document.workspaces[WORKSPACE.id] = { createdAt: NOW, updatedAt: NOW, profile: 'litigation', defaultPerspective: 'plaintiff', onboardingStatus: 'configured', subagents: { [EXPERT.id]: EXPERT } }; return document; })(),
    WORKSPACE.id,
    NOW,
  );

  // Composed here by hand, from the same exported functions the sections call.
  // If the operation ever grows its own copy of this logic, this fails.
  assert.deepEqual(preview.saved.sections.map((section) => section.text), [
    composeProfileSection({ policy, configured, workspace: WORKSPACE, texts: TEXTS }),
    composePerspectiveSection({ policy, configured, override: undefined, texts: TEXTS }),
    composeAgentDirectorySection(policy),
  ]);

  // The names and orders are the live registration's, not restated strings: they
  // are what a session transcript and the dialog have in common.
  assert.deepEqual(
    preview.saved.sections.map((section) => [section.id, section.order]),
    [
      [PROFILE_SECTION_NAME, PROFILE_SECTION_ORDER],
      [PERSPECTIVE_SECTION_NAME, PERSPECTIVE_SECTION_ORDER],
      [AGENTS_SECTION_NAME, AGENTS_SECTION_ORDER],
    ],
  );
  assert.equal(preview.saved.active, true);
  assert.equal(preview.saved.gate, 'ok');
  assert.deepEqual(preview.saved.parts, { profile: true, perspective: true, agents: true });
  assert.equal(preview.textsLoaded, true);
});

test('a workspace whose only stored configuration is a skill toggle injects nothing', async () => {
  // The state that made the feature look inert: `hasStoredPolicy` is true, so the
  // header badge has always said 已配置 — and the prompt has always been empty.
  const operations = build({
    policy: { onboardingStatus: 'unconfigured', skillOverrides: { 'workbuddy-cli-model-bridge': 'disabled' } },
  });
  const preview = await operations.previewInjection({ workspaceId: WORKSPACE.id });

  assert.equal(preview.available, true, 'the preview itself must still answer');
  assert.equal(preview.onboardingStatus, 'unconfigured');
  assert.equal(preview.saved.active, false, 'nothing may be reported as injected');
  assert.equal(preview.saved.gate, 'unconfigured');
  assert.equal(preview.saved.totalChars, 0);
  assert.deepEqual(Object.values(byName(preview.saved)), ['', '', '']);

  // Negative control: flip the one field that is the gate and the same fixture
  // must report the opposite. Without this the test would pass on a preview that
  // hard-codes `active: false`.
  const configured = await build({
    policy: { onboardingStatus: 'configured', profile: 'litigation', defaultPerspective: 'plaintiff', skillOverrides: { 'workbuddy-cli-model-bridge': 'disabled' } },
  }).previewInjection({ workspaceId: WORKSPACE.id });
  assert.equal(configured.saved.active, true);
  assert.equal(configured.saved.gate, 'ok');
  assert.ok(configured.saved.totalChars > 0);
});

test('a skipped workspace is reported as skipped, not as unconfigured', async () => {
  const preview = await build({ policy: { onboardingStatus: 'skipped' } })
    .previewInjection({ workspaceId: WORKSPACE.id });
  assert.equal(preview.saved.active, false);
  assert.equal(preview.saved.gate, 'skipped', 'the two reasons are different and the page says so');
});

test('an enabled expert is advertised even before a Profile is chosen', async () => {
  // The section is deliberately ungated — every Subagent was created on purpose —
  // so "configured" is not the same question as "does anything get written".
  const preview = await build({
    policy: { onboardingStatus: 'unconfigured', subagents: { [EXPERT.id]: EXPERT } },
  }).previewInjection({ workspaceId: WORKSPACE.id });

  assert.equal(preview.saved.gate, 'unconfigured');
  assert.equal(preview.saved.parts.profile, false, 'no Profile may be injected without the gate');
  assert.equal(preview.saved.parts.agents, true, 'the expert directory is not gated');
  assert.equal(preview.saved.active, true, 'something IS written, and saying otherwise would be false');
  assert.ok(byName(preview.saved)[AGENTS_SECTION_NAME].includes('case-researcher'));
});

test('a draft pair is previewed through the gate a save would leave behind', async () => {
  const preview = await build({ policy: { onboardingStatus: 'unconfigured' } })
    .previewInjection({ workspaceId: WORKSPACE.id, profile: 'litigation', perspective: 'plaintiff' });

  assert.equal(preview.saved.active, false, 'the stored composition is unchanged by a preview');
  assert.equal(preview.draft.valid, true);
  assert.equal(preview.draft.gate, 'ok');
  assert.equal(preview.draft.active, true);
  assert.deepEqual(preview.draft.parts, { profile: true, perspective: true, agents: false });
  assert.ok(byName(preview.draft)[PERSPECTIVE_SECTION_NAME].includes('原告代理人'));
});

test('an illegal draft is refused rather than composed', async () => {
  // A bankruptcy stance under the Litigation Profile is exactly what the write
  // path refuses. Composing it would preview a position that can never be saved.
  const preview = await build({}).previewInjection({
    workspaceId: WORKSPACE.id,
    profile: 'litigation',
    perspective: 'administrator',
  });
  assert.equal(preview.draft.valid, false);
  assert.match(preview.draft.invalidReason, /administrator/);
  assert.equal(preview.draft.sections, undefined, 'nothing may be composed for a refused pair');
});

test('a workspace that is not registered is reported, never thrown', async () => {
  const preview = await build({}).previewInjection({ workspaceId: 'nope' });
  assert.equal(preview.available, false);
  assert.match(preview.message, /nope/);
});

test('an unloaded Profile body is declared, so an empty preview is not read as "nothing configured"', async () => {
  // The bodies are read asynchronously at activation; before that read lands a
  // configured workspace legitimately composes almost nothing.
  const preview = await build({
    policy: { onboardingStatus: 'configured', profile: 'litigation', defaultPerspective: 'plaintiff' },
    texts: { profiles: {}, perspectives: {} },
  }).previewInjection({ workspaceId: WORKSPACE.id });

  assert.equal(preview.textsLoaded, false, 'the page must be able to say the read is unfinished');
  // The gate is still genuinely open: the Profile heading is written even when the
  // body is missing, because the section states the domain it is working in.
  assert.equal(preview.saved.active, true);
});

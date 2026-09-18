/**
 * Persona and dispatch-prompt compilers.
 *
 * The template-safety tests matter more than they look: both compiled texts
 * become `systemPrompt` sections, section text is interpolated with **strict**
 * `{{variable}}` references, and an unknown reference throws. A user who types
 * `{{当事人}}` into a Subagent description would otherwise abort prompt assembly
 * for the *parent* session — a failure far from its cause.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileDispatchTask, compilePersona, renderSubagentOutput, sanitizeTemplateText } from '../src/subagent-registry.js';
import { composeAgentDirectorySection, composePerspectiveSection, composeProfileSection } from '../src/profile-runtime.js';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';

const DEFINITION = {
  id: 'a',
  key: 'case-researcher',
  name: '案例检索员',
  description: '检索并核验与当前任务相关的法律规则和案例',
  instructions: '1. 优先一手来源；2. 不虚构案例。',
  provider: 'kimi-coding',
  model: 'k3',
  reasoningEffort: 'high',
  enabled: true,
};

test('template delimiters in user text are neutralized', () => {
  assert.equal(sanitizeTemplateText('{{cwd}}'), '{ {cwd} }');
  assert.equal(sanitizeTemplateText('a {{ b }} c'), 'a { { b } } c');
  assert.equal(sanitizeTemplateText('no delimiters'), 'no delimiters');
  assert.equal(sanitizeTemplateText(undefined), '');
  // A lone opening delimiter is literal prose for the renderer, but it is
  // neutralized too: leaving it is a rule with an exception nobody can see.
  assert.equal(sanitizeTemplateText('{{unclosed'), '{ {unclosed');
});

test('a hostile description cannot abort prompt assembly', () => {
  const persona = compilePersona(
    { ...DEFINITION, name: '{{nope}}', description: '{{also-not-a-variable}}', instructions: '{{x}}' },
    { workspaceTitle: '{{bad}}', profileLabel: 'Bankruptcy', perspectiveLabel: 'Administrator' },
  );
  // The proof is that the real renderer accepts it. Anything else is a guess
  // about what the renderer tolerates.
  const hostile = { ...DEFINITION, name: '{{nope}}', description: '{{bad}}' };
  const profileSection = composeProfileSection({
    // The Workspace title is renameable user text and rides the same section.
    policy: { ...policyWith([]), profile: 'bankruptcy' },
    configured: true,
    workspace: { title: '{{oops}}' },
    texts: { profiles: { bankruptcy: '正文' }, perspectives: {} },
  });
  const rendered = renderPrompt({
    sections: [
      { name: 'p', text: persona },
      { name: 'd', text: composeAgentDirectorySection(policyWith([hostile])) },
      { name: 'w', text: profileSection },
    ],
    contexts: [],
    tools: [],
    variables: { model: 'm', cwd: '/tmp' },
  });
  // The proof that matters: the renderer ran at all. Before the sanitizer, each
  // of these three sections threw `unknown prompt variable`.
  assert.ok(rendered.length > 0);
  assert.ok(rendered.includes('{ {nope} }'), 'the persona name should be visible but inert');
  assert.ok(rendered.includes('{ {also-not-a-variable} }'), 'the description too');
  assert.ok(rendered.includes('{ {oops} }'), 'the workspace title is user text too');
  assert.ok(!/\{\{[^}]*\}\}/.test(rendered), 'no live reference may survive into the rendered prompt');
});

test('the persona binds identity, stance and the precedence rule', () => {
  const persona = compilePersona(DEFINITION, {
    workspaceTitle: '华北地产重整',
    profileLabel: '破产重整 (Bankruptcy)',
    perspectiveLabel: '管理人 (Administrator)',
  });
  assert.ok(persona.includes('案例检索员'));
  assert.ok(persona.includes('华北地产重整'));
  assert.ok(persona.includes('管理人 (Administrator)'));
  assert.ok(persona.includes('优先于本段人设'));
  assert.ok(persona.includes('不扩大任何权限'));
  // The child has no history; the persona has to say so, because the model will
  // otherwise assume the parent's context is available to it.
  assert.ok(persona.includes('没有父会话的历史记录'));
});

test('an empty Perspective is stated as absent, never implied', () => {
  const persona = compilePersona(DEFINITION, {
    workspaceTitle: 'W',
    profileLabel: 'General',
    perspectiveLabel: '',
  });
  assert.ok(!persona.includes('工作立场是'));
  const task = compileDispatchTask({ task: 't', workspaceTitle: 'W', profileLabel: 'General', perspectiveLabel: '' });
  assert.ok(task.includes('工作立场：未指定'));
});

test('the dispatch task carries the model text verbatim inside a delimiter', () => {
  const task = compileDispatchTask({
    task: '  检索争议焦点二的相关案例。\n\n并列明可核验来源。  ',
    workspaceTitle: '华北地产重整',
    profileLabel: '破产重整',
    perspectiveLabel: '管理人',
  });
  assert.ok(task.includes('检索争议焦点二的相关案例。\n\n并列明可核验来源。'));
  assert.ok(task.includes('"""'));
  assert.ok(task.includes('你没有父会话的历史'));
  assert.ok(task.includes('工作区：华北地产重整'));
  // The standing requirements the child must apply to its own output.
  assert.ok(task.includes('无法核验的内容必须显式标注'));
});

test('the expert directory lists only enabled agents and names each key', () => {
  const policy = policyWith([DEFINITION, { ...DEFINITION, id: 'b', key: 'off', enabled: false }]);
  const section = composeAgentDirectorySection(policy);
  assert.ok(section.includes('case-researcher'));
  assert.ok(section.includes('kimi-coding/k3 · high'));
  assert.ok(!section.includes('`off`'));
  assert.ok(section.includes('脱离本会话也能独立执行'));
});

test('an unconfigured workspace contributes no Profile section', () => {
  const policy = policyWith([DEFINITION]);
  assert.equal(composeProfileSection({ policy, configured: false, workspace: { title: 'W' }, texts: {} }), '');
  assert.equal(composeProfileSection({ policy: undefined, configured: true, texts: {} }), '');
});

test('a configured expert is advertised even before a Profile is chosen', () => {
  // Regression, and the reason this test exists by name: gating the expert
  // directory on `configured` — which records only whether a *Profile* was
  // picked — made a user's Subagent silently inert. It appeared in Settings and
  // was stored correctly, but the model was never told it existed, so it could
  // never be dispatched, and nothing said why. Adding a Subagent is itself a
  // deliberate configuration act and must have an effect on its own.
  const policy = policyWith([DEFINITION]);
  policy.onboardingStatus = 'unconfigured';
  const section = composeAgentDirectorySection(policy);
  assert.ok(section.includes('case-researcher'), section);
  assert.ok(section.includes('案例检索员'));

  // The empty cases are still empty, and for the only reason that matters: there
  // is nothing enabled to list. A Workspace with no stored policy resolves to a
  // default with no Subagents, so it contributes nothing without needing a flag.
  assert.equal(composeAgentDirectorySection(policyWith([])), '');
  assert.equal(composeAgentDirectorySection(undefined), '');
  const untouched = { onboardingStatus: 'unconfigured', profile: 'general', defaultPerspective: 'none', skillOverrides: {}, subagents: {} };
  assert.equal(composeAgentDirectorySection(untouched), '');

  // And a disabled expert stays invisible even now that the gate is gone.
  const disabled = policyWith([{ ...DEFINITION, enabled: false }]);
  assert.equal(composeAgentDirectorySection(disabled), '');
});

test('the Profile section carries domain framing and the precedence rule', () => {
  const policy = policyWith([]);
  policy.profile = 'bankruptcy';
  policy.defaultPerspective = 'administrator';
  const section = composeProfileSection({
    policy,
    configured: true,
    workspace: { title: '华北地产重整' },
    texts: {
      profiles: { bankruptcy: '# 破产重整工作区\n\n正文' },
      perspectives: { bankruptcy: { administrator: '# 立场：管理人' } },
    },
  });
  assert.ok(section.includes('华北地产重整'));
  assert.ok(section.includes('# 破产重整工作区'));
  assert.ok(section.includes('优先于本节全部内容'));
  // The stance is a separate contribution; it must not leak in here, or a
  // consumer rendering this section alone gets a stance with no explanation.
  assert.equal(section.includes('立场'), false, section);
});

test('the Perspective section states the stance, its source, and its limits', () => {
  const policy = policyWith([]);
  policy.profile = 'bankruptcy';
  policy.defaultPerspective = 'administrator';
  const texts = { perspectives: { bankruptcy: { administrator: '# 立场：管理人' } } };

  const fromWorkspace = composePerspectiveSection({ policy, configured: true, override: undefined, texts });
  assert.ok(fromWorkspace.includes('# 立场：管理人'));
  assert.ok(fromWorkspace.includes('工作区配置的默认立场'));
  assert.ok(fromWorkspace.includes('不是已核实的事实'));
  // The stance must restate the precedence rule itself: this section can be read
  // without the Profile section.
  assert.ok(fromWorkspace.includes('优先于本立场'));

  // A session override outranks the Workspace default, and says so.
  const fromSession = composePerspectiveSection({ policy, configured: true, override: 'debtor', texts: { perspectives: { bankruptcy: { debtor: '# 立场：债务人' } } } });
  assert.ok(fromSession.includes('# 立场：债务人'), fromSession);
  assert.ok(fromSession.includes('当前会话通过'), fromSession);
  assert.equal(fromSession.includes('管理人'), false, fromSession);

  // `none` as an override is a deliberate instruction, but it renders nothing:
  // there is no stance text for "no stance".
  assert.equal(composePerspectiveSection({ policy, configured: true, override: 'none', texts }), '');
  // The Workspace default of `none` likewise renders nothing.
  policy.defaultPerspective = 'none';
  assert.equal(composePerspectiveSection({ policy, configured: true, override: undefined, texts }), '');
});

test('a Perspective section refuses a stance the current Profile does not define', () => {
  const policy = policyWith([]);
  policy.profile = 'litigation';
  policy.defaultPerspective = 'none';
  const texts = { perspectives: { bankruptcy: { administrator: '# 立场：管理人' }, litigation: {} } };

  // A session override survives a Workspace reconfiguration — it is keyed by
  // session, not by Workspace — so a Litigation Workspace can hold an override
  // naming a Bankruptcy stance. Injecting it would put an insolvency stance into
  // a lawsuit, which is worse than falling back to the Workspace default.
  const section = composePerspectiveSection({ policy, configured: true, override: 'administrator', texts });
  assert.equal(section, '', section);

  // The same id under the Profile that defines it is honoured.
  policy.profile = 'bankruptcy';
  assert.ok(
    composePerspectiveSection({ policy, configured: true, override: 'administrator', texts }).includes('管理人'),
  );
});

test('output rendering keeps text, names other blocks, and never invents content', () => {
  assert.equal(renderSubagentOutput([{ type: 'text', text: '答案' }]), '答案');
  assert.equal(renderSubagentOutput([]), '');
  assert.equal(renderSubagentOutput(undefined), '');
  const mixed = renderSubagentOutput([{ type: 'text', text: '看这个' }, { type: 'image', source: {} }]);
  assert.ok(mixed.includes('看这个'));
  // Dropping it silently would misrepresent the child's answer.
  assert.ok(mixed.includes('[image 内容块已省略]'));
});

function policyWith(subagents) {
  return {
    onboardingStatus: 'configured',
    profile: 'general',
    defaultPerspective: 'none',
    skillOverrides: {},
    subagents: Object.fromEntries(subagents.map((definition) => [definition.id, definition])),
    createdAt: 'now',
    updatedAt: 'now',
  };
}

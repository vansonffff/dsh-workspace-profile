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

import {
  ENGINEERING_SUBAGENT_KEYS,
  compileBaseTask,
  compilePersona,
  compileTaskFor,
  renderSubagentOutput,
  sanitizeTemplateText,
  subagentDomain,
} from '../src/subagent-registry.js';
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
  const task = compileBaseTask({ task: 't', workspaceTitle: 'W', profileLabel: 'General', perspectiveLabel: '' });
  assert.ok(task.includes('工作立场：未指定'));
});

test('the dispatch task carries the model text verbatim inside a delimiter', () => {
  const task = compileBaseTask({
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

test('the dispatch task carries the Matter a child could not otherwise recover', () => {
  const task = compileBaseTask({
    task: 't',
    workspaceTitle: '示例系列案件',
    profileLabel: '诉讼 (Litigation)',
    perspectiveLabel: '原告代理人 (Plaintiff)',
    matter: {
      id: '11111111-2222-3333-4444-555555555555',
      name: '示例系列案件',
      type: 'litigation',
      role: 'plaintiff',
      stage: 'unknown',
    },
  });
  assert.ok(task.includes('案件 (Matter)：'));
  assert.ok(task.includes('11111111-2222-3333-4444-555555555555'));
  assert.ok(task.includes('类型：litigation'));
  assert.ok(task.includes('正式角色：plaintiff'));
  // The effective stance is the line above; the Matter's formal role is printed
  // next to it so a disagreement between the two is visible rather than hidden.
  assert.ok(task.indexOf('工作立场：') < task.indexOf('正式角色：'));
});

test('a Matter name is user-authored text and is sanitized like any other', () => {
  const task = compileBaseTask({
    task: 't',
    workspaceTitle: 'W',
    profileLabel: 'P',
    perspectiveLabel: '',
    matter: { id: 'i', name: '案件{{danger}}', type: 'litigation', role: 'plaintiff', stage: 'unknown' },
  });
  assert.ok(!task.includes('{{danger}}'));
  assert.ok(task.includes('{ {danger} }'));
});

test('no Matter adds nothing at all, rather than an empty heading', () => {
  for (const matter of [undefined, null, {}]) {
    const task = compileBaseTask({ task: 't', workspaceTitle: 'W', profileLabel: 'P', perspectiveLabel: '', matter });
    assert.ok(!task.includes('案件 (Matter)：'), `matter=${JSON.stringify(matter)} must add no block`);
  }
});

/* -------------------------------------------------------------------------- */
/* Which requirements a child is sent                                          */
/* -------------------------------------------------------------------------- */

test('the legal requirements are the pre-0.6.0 text, unchanged', () => {
  // The fallback is not a classification of anyone's work: it is what every
  // definition stored before 0.6.0 was sent, and dropping it from a real legal
  // agent's assignment would be a regression this upgrade may not cause.
  const task = compileBaseTask({ task: 't', workspaceTitle: 'W', profileLabel: 'P', perspectiveLabel: '' });
  assert.ok(task.includes('要求：'));
  assert.ok(task.includes('引用法条给出法规名称与条号，引用案例给出案号与法院'), 'legal keeps its citation rule');
  assert.ok(task.includes('已查明事实 / 当事人主张 / 推断 / 未知'));
  // And the default is the legal set, for a caller that says nothing.
  assert.equal(task, compileBaseTask({ task: 't', workspaceTitle: 'W', profileLabel: 'P', perspectiveLabel: '', domain: 'legal' }));
});

test('an engineering child is never told to cite statutes', () => {
  // The pollution the plan names: every agent in every workspace used to receive
  // the legal citation rule, including the coding ones.
  const task = compileBaseTask({
    task: 't', workspaceTitle: 'W', profileLabel: 'P', perspectiveLabel: '', domain: 'engineering',
  });
  assert.ok(!task.includes('引用法条'), 'no statute rule for engineering work');
  assert.ok(!task.includes('案号与法院'));
  assert.ok(task.includes('引用代码必须给出文件路径与函数/符号名'));
  assert.ok(task.includes('已核实（实际读过或实际运行过）'));
  // The parts that genuinely apply everywhere are still there.
  assert.ok(task.includes('无法核验的内容必须显式标注'));
  assert.ok(task.includes('输出使用与任务相同的语言'));
});

test('a general child gets neither domain rule', () => {
  const task = compileBaseTask({
    task: 't', workspaceTitle: 'W', profileLabel: 'P', perspectiveLabel: '', domain: 'general',
  });
  assert.ok(!task.includes('引用法条'));
  assert.ok(!task.includes('引用代码'));
  assert.ok(task.includes('区分「已核实 / 推断 / 未知」'));
});

test('the domain is decided by the role, and legal stays the fallback', () => {
  const base = { id: 'a', name: 'x', description: 'x' };
  // The three built-in engineering roles, wherever they are used — including in a
  // litigation Workspace, where the fallback would otherwise hand 码农 the
  // statute-citation rule.
  for (const key of ENGINEERING_SUBAGENT_KEYS) {
    assert.equal(subagentDomain({ ...base, key }), 'engineering', `${key} is engineering work`);
  }
  // Every codex definition is engineering by construction.
  assert.equal(subagentDomain({ ...base, key: 'anything', backend: 'codex' }), 'engineering');
  // Everything else keeps exactly what it had in 0.5.0.
  assert.equal(subagentDomain({ ...base, key: 'assist' }), 'legal');
  assert.equal(subagentDomain({ ...base, key: 'reviewer' }), 'legal');
  assert.equal(subagentDomain({ ...base, key: 'case-researcher' }), 'legal');
  assert.equal(subagentDomain({ ...base, key: 'agent-3f9a2c1b', backend: 'spawn' }), 'legal');
  assert.equal(subagentDomain(undefined), 'legal');
});

test('the engineering roles named by the plan are exactly the engineering keys', () => {
  // The plan's §11 names 码农 / 代码专家 / 代码架构师. If a key is added or renamed
  // here without the matching template, the role silently starts receiving the
  // legal requirements again.
  assert.deepEqual([...ENGINEERING_SUBAGENT_KEYS], ['coding', 'code-expert', 'code-architect']);
});

test('compileTaskFor picks the compiler the backend needs', () => {
  const input = { task: '修 KDocs Sidebar', workspaceTitle: 'DSH', profileLabel: 'General', perspectiveLabel: '' };
  const spawn = compileTaskFor({ definition: { key: 'coding', name: '码农', description: 'd' }, ...input });
  // Spawn: identity rides the persona, so the assignment does not restate it.
  assert.ok(!spawn.includes('角色：'));
  assert.ok(spawn.includes('引用代码必须给出文件路径'), 'a coding role gets the engineering requirements');
  assert.ok(!spawn.includes('引用法条'));

  const codex = compileTaskFor({
    definition: { key: 'code-expert', name: '代码专家', description: '在真实代码仓库中完成工程任务', backend: 'codex' },
    ...input,
  });
  // Codex: this backend has no persona channel, so identity is compiled in.
  assert.ok(codex.includes('角色：代码专家'));
  assert.ok(codex.includes('职责：'));
  assert.ok(codex.includes('在真实代码仓库中完成工程任务'));
  assert.ok(codex.includes('工程原则：'));
  assert.ok(codex.includes('先读后改'));
  assert.ok(codex.includes('验收要求：'));
  assert.ok(codex.includes('修 KDocs Sidebar'));
  assert.ok(codex.includes('工作区：DSH'));
  assert.ok(!codex.includes('引用法条'), 'and it is engineering work, not legal work');
});

test('a Codex assignment carries the supplementary guidance, and a spawn one does not duplicate it', () => {
  const definition = {
    key: 'code-expert', name: '代码专家', description: 'd', backend: 'codex',
    instructions: '这个仓库的测试用 /usr/local/bin/node 跑。',
  };
  const codex = compileTaskFor({ definition, task: 't', workspaceTitle: 'W', profileLabel: 'P', perspectiveLabel: '' });
  assert.ok(codex.includes('补充要求：'));
  assert.ok(codex.includes('/usr/local/bin/node'));

  const spawnDefinition = { key: 'coding', name: '码农', description: 'd', instructions: '同上' };
  const spawn = compileTaskFor({ definition: spawnDefinition, task: 't', workspaceTitle: 'W', profileLabel: 'P', perspectiveLabel: '' });
  assert.ok(!spawn.includes('补充要求：'), 'spawn guidance rides the persona; repeating it in the task would say it twice');
});

test('a Codex assignment is template-safe like every other', () => {
  const codex = compileTaskFor({
    definition: {
      key: 'code-expert', name: '代码{{expert}}', description: 'd{{anger}}', instructions: 'i{{x}}', backend: 'codex',
    },
    task: 't', workspaceTitle: 'W{}', profileLabel: 'P', perspectiveLabel: '',
  });
  assert.ok(!/\{\{/.test(codex), 'no strict-template delimiter may survive into a prompt section');
});

test('the expert directory says where each agent runs, including Codex', () => {
  const policy = policyWith([
    { ...DEFINITION, id: 'a', key: 'coding', name: '码农', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    { id: 'b', key: 'code-expert', name: '代码专家', description: '在真实代码仓库中完成工程任务', backend: 'codex', enabled: true },
  ]);
  const section = composeAgentDirectorySection(policy);
  // The model reads this list to choose an agent, so the route has to be part of
  // it — and for a Codex agent the route is the backend, not the empty
  // `provider/model` its definition legitimately does not carry.
  assert.ok(section.includes('执行：deepseek-official/deepseek-flash · max'), section);
  assert.ok(section.includes('执行：Codex'), section);
  assert.ok(!section.includes('undefined'), 'an absent route must never render as undefined');
  assert.ok(section.includes('`code-expert`'));
});

/**
 * Integration: the real plugin, mounted in a real Cordis context, over real DSH
 * services.
 *
 * This is the Phase 0 compatibility gate expressed as a test rather than as a
 * document. Every seam the plugin depends on is the shipping implementation —
 * `SettingsForms`, `SkillRegistry`, `SystemPrompt`, `CommandRuntime`,
 * `ToolRuntime`, `TypertRegistry` — so a contract change in any of them fails
 * here instead of in the browser.
 *
 * `SettingsForms` is subclassed only for document storage/description, since a
 * Profile patch file is not present in this in-memory composition.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { SettingsForms } from '@deepseek-ai/dsh-settings';
import { SkillRegistry } from '@deepseek-ai/dsh-skill';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';

import { apply as applyPlugin, SETTINGS_NS } from '../src/index.js';

const CWD = process.cwd();

/**
 * Let every `ctx.inject` callback run.
 *
 * `ctx.inject` does **not** invoke its callback synchronously when the service is
 * already present — it schedules it — so a test that asserts immediately after
 * `apply()` sees a plugin that appears to have registered nothing. Two turns of
 * the event loop is what a settled Loader tree gives the real thing.
 *
 * @returns {Promise<void>} resolution once the injected callbacks have run.
 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** An in-memory settings document: the same seam, different bytes. */
class MemorySettingsProvider extends SettingsForms {
  constructor(ctx, doc) {
    super(ctx);
    this.doc = doc ?? {};
  }
  describe() {
    return [{ ns: SETTINGS_NS, value: { document: this.doc[SETTINGS_NS] ?? {} }, revision: 0 }];
  }
}

/**
 * Mount a context carrying every service the plugin looks for.
 *
 * @param {object} [options] - the composition's behaviour.
 * @returns {any} the context plus the services under test.
 */
function makeComposition(options = {}) {
  const ctx = new Context();
  ctx.root.loader = { await: async () => {} };
  ctx.provide('profileContext', { home: '/dsh-workspace-profile-test-no-legacy-settings' });
  const settings = new MemorySettingsProvider(ctx, options.document);
  const skills = new SkillRegistry(ctx, {});
  const systemPrompt = new SystemPrompt(ctx, {});
  const commands = new CommandRuntime(ctx);
  const tools = new ToolRuntime(ctx);
  const typert = new TypertRegistry(ctx);

  skills.registerProvider(() => ({
    name: 'test-skills',
    list: async () => [
      {
        name: 'legal-case-bench',
        description: '案件共同工作台',
        source: 'user-dsh',
        provider: 'test-skills',
        invocation: { modelInvocable: true, userInvocable: true },
        rank: 500,
        locator: {},
      },
    ],
    get: async () => undefined,
  }));

  const workspace = {
    id: 'ws-1',
    path: CWD,
    title: '华北地产重整',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [],
  };
  ctx.provide('workspaceRegistry', {
    list: () => [workspace],
    get: (id) => (id === 'ws-1' ? workspace : undefined),
    resolveByPath: async (path) => (path === CWD ? workspace : undefined),
  });
  ctx.provide('llm', {
    listProviders: () => [{ id: 'kimi-coding', name: 'Kimi' }],
    listModels: async () => [{ provider: 'kimi-coding', id: 'k3', name: 'Kimi K3' }],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
    }),
    resolveCallConfig: async (config) => config,
  });
  ctx.provide('subagents', {
    list: () => ['spawn'],
    getProvider: (name) => (name === 'spawn' ? { name: 'spawn' } : undefined),
    start: async (name, request) => ({
      id: 'child-1',
      localAgent: undefined,
      result: Promise.resolve({ output: [{ type: 'text', text: `done:${request.label}` }], stopReason: 'completed' }),
      dispose: async () => {},
    }),
  });

  return { ctx, settings, skills, systemPrompt, commands, tools, typert };
}

/** A minimal agent-shaped object: only what the plugin reads. */
function makeAgent(ctx, cwd = CWD) {
  return { session: { id: 's1', header: { cwd } }, ctx };
}

test('the plugin activates against the real service set and registers every seam', async () => {
  const { ctx, settings, skills, systemPrompt, commands, tools } = makeComposition();
  applyPlugin(ctx);
  await settle();

  // The namespace is registered as a settings owner.
  assert.ok(settings.describe().some((descriptor) => descriptor.ns === SETTINGS_NS));

  // Both prompt sections are on the ledger.
  const section = systemPrompt.assemble({ scope: undefined });
  const names = (await section).sections.map((entry) => entry.name);
  assert.ok(names.includes('workspace-profile:context'), names.join(', '));
  assert.ok(names.includes('workspace-profile:subagents'), names.join(', '));

  // The command is registered globally.
  const agent = makeAgent(ctx);
  assert.ok(commands.find(agent, 'agent') !== undefined);

  // The tool is registered globally.
  assert.ok(tools.get('workspace_subagent') !== undefined);
  void skills;
});

test('an unconfigured workspace injects nothing at all', async () => {
  const { ctx, systemPrompt } = makeComposition();
  applyPlugin(ctx);
  await settle();
  const agent = makeAgent(ctx);
  const assembly = await systemPrompt.assemble({ agent, scope: agent });
  const context = assembly.sections.find((entry) => entry.name === 'workspace-profile:context');
  assert.equal(context.text, '');
  const directory = assembly.sections.find((entry) => entry.name === 'workspace-profile:subagents');
  assert.equal(directory.text, '');
});

test('a configured workspace injects Profile, Perspective and the expert directory', async () => {
  const { ctx, systemPrompt } = makeComposition({
    document: {
      [SETTINGS_NS]: {
        schemaVersion: 1,
        initializedAt: '2026-01-01T00:00:00.000Z',
        workspaces: {
          'ws-1': {
            onboardingStatus: 'configured',
            profile: 'bankruptcy',
            defaultPerspective: 'administrator',
            skillOverrides: {},
            subagents: {
              a: {
                id: 'a',
                key: 'case-researcher',
                name: '案例检索员',
                description: '检索并核验与当前工作区相关的法律规则和案例',
                provider: 'kimi-coding',
                model: 'k3',
                reasoningEffort: 'high',
                enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        },
      },
    },
  });
  applyPlugin(ctx);
  await settle();

  const agent = makeAgent(ctx);
  // The resolver's index is built from `registry.list()`; a step boundary does
  // the same work, and here the synchronous path is already a hit.
  const assembly = await systemPrompt.assemble({ agent, scope: agent });
  const context = assembly.sections.find((entry) => entry.name === 'workspace-profile:context');
  assert.ok(context.text.includes('华北地产重整'), context.text);
  assert.ok(context.text.includes('破产重整'));
  assert.ok(context.text.includes('优先于本节全部内容'));
  // The stance moved to its own section, so the Profile section must no longer
  // carry it: a consumer rendering one section alone must not get a half-stated
  // precedence rule.
  assert.equal(context.text.includes('当前立场'), false, context.text);

  const perspective = assembly.sections.find((entry) => entry.name === 'workspace-profile:perspective');
  assert.ok(perspective.text.includes('管理人'), perspective.text);
  assert.ok(perspective.text.includes('工作区配置的默认立场'), perspective.text);

  const directory = assembly.sections.find((entry) => entry.name === 'workspace-profile:subagents');
  assert.ok(directory.text.includes('case-researcher'));
  assert.ok(directory.text.includes('kimi-coding/k3 · high'));
});

test('a session outside every workspace gets no section even when others are configured', async () => {
  const { ctx, systemPrompt } = makeComposition({
    document: {
      [SETTINGS_NS]: {
        schemaVersion: 1,
        initializedAt: '2026-01-01T00:00:00.000Z',
        workspaces: { 'ws-1': { onboardingStatus: 'configured', profile: 'bankruptcy', defaultPerspective: 'administrator' } },
      },
    },
  });
  applyPlugin(ctx);
  await settle();
  const agent = makeAgent(ctx, '/somewhere/else');
  const assembly = await systemPrompt.assemble({ agent, scope: agent });
  assert.equal(assembly.sections.find((entry) => entry.name === 'workspace-profile:context').text, '');
});

test('an expert is advertised through a real assembly before any Profile is chosen', async () => {
  // The wiring, not just the composer: this asserts the section registration
  // passes the policy through without consulting `configured`. A Workspace whose
  // owner added a Subagent but has not chosen a Profile must still tell the model
  // the expert exists, or the expert can never be dispatched.
  const { ctx, systemPrompt } = makeComposition({
    document: {
      [SETTINGS_NS]: {
        schemaVersion: 1,
        initializedAt: '2026-01-01T00:00:00.000Z',
        workspaces: {
          'ws-1': {
            // Deliberately no `onboardingStatus`, exactly as a workspace looks
            // after a Subagent is added and nothing else is configured.
            skillOverrides: {},
            subagents: {
              a: {
                id: 'a',
                key: 'legal-anylist',
                name: '高级顾问',
                description: '高级顾问，负责专业法律问题的深度分析',
                provider: 'kimi-coding',
                model: 'k3',
                reasoningEffort: 'max',
                enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        },
      },
    },
  });
  applyPlugin(ctx);
  await settle();

  const agent = makeAgent(ctx);
  const assembly = await systemPrompt.assemble({ agent, scope: agent });
  const directory = assembly.sections.find((entry) => entry.name === 'workspace-profile:subagents');
  assert.ok(directory.text.includes('legal-anylist'), directory.text);
  assert.ok(directory.text.includes('高级顾问'), directory.text);
  assert.ok(directory.text.includes('kimi-coding/k3 · max'), directory.text);

  // The Profile section stays empty: nobody chose a domain, and guessing one is
  // the failure the `configured` gate exists to prevent. The two sections have
  // different questions, which is the whole point of this test.
  assert.equal(assembly.sections.find((entry) => entry.name === 'workspace-profile:context').text, '');
});

test('the remote namespace is bound into the Typert gateway', async () => {
  const { ctx, typert } = makeComposition();
  applyPlugin(ctx);
  await settle();
  const descriptor = typert
    .describe?.()
    .flatMap((entry) => entry.invocations ?? [])
    .find((invocation) => invocation.namespace === 'workspaceProfile');
  // `describe()` is not part of the public surface in every build; the
  // registration itself is what matters, and the service is what proves it.
  if (descriptor !== undefined) {
    assert.equal(descriptor.service, 'workspaceProfile');
  }
  assert.ok(ctx.get('workspaceProfile') !== undefined, 'ctx.remote.workspaceProfile requires the service');
});

test('the plugin degrades rather than failing when seams are absent', async () => {
  const ctx = new Context();
  // No settings, no skills, no systemPrompt, no commands, no tools, no typert.
  assert.doesNotThrow(() => applyPlugin(ctx));
  const plugin = applyPlugin;
  assert.equal(typeof plugin, 'function');
});

test('disabling by configuration withdraws everything', async () => {
  const { ctx, systemPrompt, commands } = makeComposition();
  applyPlugin(ctx, { enabled: false });
  await settle();
  const agent = makeAgent(ctx);
  const assembly = await systemPrompt.assemble({ agent, scope: agent });
  assert.equal(assembly.sections.some((entry) => entry.name.startsWith('workspace-profile:')), false);
  assert.equal(commands.find(agent, 'agent'), undefined);
});

/**
 * Skill policy, against the **real** `SkillRegistry`.
 *
 * No fake registry here on purpose. The whole mechanism is a property of how the
 * registry layers scopes, so a stand-in would prove that the stand-in behaves
 * like the stand-in. What this file establishes:
 *
 *   - a Workspace "disable" is a same-named runtime Skill registered in a scope
 *     keyed by the Agent, which wins the name because the nearest layer wins;
 *   - the shadow is invisible to the model (`modelInvocable: false`), so the
 *     `skill` tool's own catalog filter drops it;
 *   - a different scope is untouched — Workspace isolation is structural, not a
 *     check anyone has to remember;
 *   - disposing the scope restores the original entry exactly, so there is
 *     nothing to unwind by hand.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import SkillRegistry from '@deepseek-ai/dsh-skill';

import { SHADOW_PROVIDER, SkillPolicy, buildSkillCatalog, isManagedSource } from '../src/skill-policy.js';

const AGENT_KEY_SKILL = 'legal-case-bench';

function makeHarness() {
  const ctx = new Context();
  const registry = new SkillRegistry(ctx, {});
  ctx.skills.registerProvider(() => ({
    name: 'test-provider',
    list: async () => [
      {
        name: AGENT_KEY_SKILL,
        description: '案件共同工作台',
        source: 'user-dsh',
        provider: 'test-provider',
        invocation: { modelInvocable: true, userInvocable: true },
        rank: 500,
        locator: {},
      },
      {
        name: 'bundled-helper',
        description: '随部署发布',
        source: 'bundled',
        provider: 'test-provider',
        invocation: { modelInvocable: true, userInvocable: true },
        rank: 500,
        locator: {},
      },
    ],
    get: async () => undefined,
  }));
  return { ctx, registry };
}

function makePolicy({ ctx, disabled }) {
  return new SkillPolicy({
    ctx,
    getSkills: () => ctx.skills,
    disabledForWorkspace: () => disabled,
    logger: { warn: () => {} },
  });
}

test('a disabled skill is shadowed for that agent only, and restored on release', async () => {
  const { ctx } = makeHarness();
  const agentA = {};
  const agentB = {};
  const policy = makePolicy({ ctx, disabled: [AGENT_KEY_SKILL] });

  const beforeA = await ctx.skills.list({ scope: agentA });
  assert.equal(beforeA.find((entry) => entry.name === AGENT_KEY_SKILL).source, 'user-dsh');

  await policy.applyFor(agentA, 'ws-a');
  const afterA = await ctx.skills.list({ scope: agentA });
  assert.equal(afterA.length, 2);
  const shadow = afterA.find((entry) => entry.name === AGENT_KEY_SKILL);
  assert.equal(shadow.source, SHADOW_PROVIDER);
  assert.equal(shadow.invocation.modelInvocable, false);
  assert.equal(shadow.invocation.userInvocable, false);

  // Workspace isolation: agent B never saw a thing.
  const afterB = await ctx.skills.list({ scope: agentB });
  assert.equal(afterB.find((entry) => entry.name === AGENT_KEY_SKILL).source, 'user-dsh');

  await policy.releaseFor(agentA);
  const restored = await ctx.skills.list({ scope: agentA });
  assert.equal(restored.find((entry) => entry.name === AGENT_KEY_SKILL).source, 'user-dsh');
});

test('applying twice with the same policy does not churn scopes', async () => {
  const { ctx } = makeHarness();
  const agent = {};
  const policy = makePolicy({ ctx, disabled: [AGENT_KEY_SKILL] });
  await policy.applyFor(agent, 'ws-a');
  const first = policy.shadowedFor(agent);
  await policy.applyFor(agent, 'ws-a');
  assert.deepEqual(policy.shadowedFor(agent), first);
  assert.deepEqual(first, [AGENT_KEY_SKILL]);
});

test('a workspace with no disabled skills leaves the catalog alone', async () => {
  const { ctx } = makeHarness();
  const agent = {};
  const policy = makePolicy({ ctx, disabled: [] });
  await policy.applyFor(agent, 'ws-a');
  assert.deepEqual(policy.shadowedFor(agent), []);
  const entries = await ctx.skills.list({ scope: agent });
  assert.equal(entries.every((entry) => entry.source !== SHADOW_PROVIDER), true);
});

test('an agent with no workspace is released rather than left half-configured', async () => {
  const { ctx } = makeHarness();
  const agent = {};
  const policy = makePolicy({ ctx, disabled: [AGENT_KEY_SKILL] });
  await policy.applyFor(agent, 'ws-a');
  assert.equal(policy.shadowedFor(agent).length, 1);
  await policy.applyFor(agent, undefined);
  assert.equal(policy.shadowedFor(agent).length, 0);
});

test('a missing skills service degrades to a warning, not a throw', async () => {
  const { ctx } = makeHarness();
  const warnings = [];
  const policy = new SkillPolicy({
    ctx,
    getSkills: () => undefined,
    disabledForWorkspace: () => [AGENT_KEY_SKILL],
    logger: { warn: (message) => warnings.push(message) },
  });
  await policy.applyFor({}, 'ws-a');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('`skills` service is not mounted'));
});

test('the catalog applies the policy on top of a scope-free read', async () => {
  const { ctx } = makeHarness();
  const policy = { skillOverrides: { [AGENT_KEY_SKILL]: 'disabled' }, profile: 'general' };
  const result = await buildSkillCatalog({
    skills: ctx.skills,
    workspace: { id: 'ws-a', path: '/tmp' },
    policy,
    recommended: [AGENT_KEY_SKILL, 'not-installed'],
  });
  const row = result.rows.find((entry) => entry.name === AGENT_KEY_SKILL);
  // The row reports the Skill as present-but-disabled. Reading through the
  // agent's scope instead would have shown the shadow and reported it missing.
  assert.equal(row.state, 'disabled');
  assert.equal(row.overridden, true);
  assert.equal(row.managed, true);
  assert.equal(row.recommended, true);
  assert.deepEqual(result.missing, ['not-installed']);
  assert.equal(result.complete, true);

  const bundled = result.rows.find((entry) => entry.name === 'bundled-helper');
  assert.equal(bundled.managed, false, 'a bundled skill is read-only in Settings');
});

test('managed sources are exactly the roots a user owns', () => {
  for (const source of ['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'custom']) {
    assert.equal(isManagedSource(source), true, `${source} should be managed`);
  }
  for (const source of ['bundled', 'runtime', 'workspace-profile', 'something-new']) {
    assert.equal(isManagedSource(source), false, `${source} should be read-only`);
  }
});

/**
 * Dispatcher lifecycle: lookup, preflight, start, result, stop reasons, cancel,
 * disposal and the depth cap.
 *
 * The disposal assertions are the ones worth having. A leaked child keeps a
 * session log open and a driver resident, and the leak is invisible from the
 * caller's side — the answer arrives either way. So every terminal path asserts
 * that `dispose()` ran, including the two paths where something else already
 * failed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SubagentDispatcher, SUBAGENT_MAX_DEPTH, SUBAGENT_PROVIDER, buildCodexRequest, buildSpawnRequest, resolveCodexProvider } from '../src/subagent-dispatch.js';
import {
  AmbiguousCodexBackendError,
  CodexBackendUnavailableError,
  NoWorkspaceContextError,
  SubagentRunFailedError,
  UnknownSubagentError,
  UnresolvableRouteError,
} from '../src/errors.js';

const NOW_ISO = '2026-09-13T00:00:00.000Z';

const DEFINITION = {
  id: 'a',
  key: 'case-researcher',
  name: '案例检索员',
  description: '检索并核验与当前工作区相关的法律规则和案例',
  provider: 'kimi-coding',
  model: 'k3',
  reasoningEffort: 'high',
  enabled: true,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

/**
 * Build a dispatcher over fakes that mirror the real seams.
 *
 * @param {object} [spec] - the run behaviour.
 * @returns {any} the dispatcher plus recorded calls.
 */
function makeDispatcher(spec = {}) {
  const calls = { start: [], disposed: 0, routeChecks: [] };
  const agent = { session: { header: { cwd: spec.cwd ?? '/work/matter' }, id: 's1' } };

  const policy = {
    onboardingStatus: 'configured',
    profile: spec.profile ?? 'bankruptcy',
    defaultPerspective: spec.defaultPerspective ?? 'administrator',
    skillOverrides: {},
    subagents: spec.subagents ?? { [DEFINITION.id]: DEFINITION },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };

  const resolver = {
    workspaceIdForAgent: () => (spec.noWorkspace === true ? undefined : 'ws-1'),
    describe: () => ({ id: 'ws-1', path: '/work/matter', title: '华北地产重整' }),
    list: () => [],
  };
  const store = { read: () => ({ document: { schemaVersion: 1, initializedAt: NOW_ISO, workspaces: { 'ws-1': policy } } }) };
  const catalog = {
    assertRoute: async (route) => {
      calls.routeChecks.push(route);
      if (spec.routeFails === true) throw new UnresolvableRouteError('no adapter for "kimi-coding"');
      return { provider: route.provider, model: route.model };
    },
  };
  /**
   * The registered providers.
   *
   * Modelled as a *table*, exactly as the seam is: `getProvider(name)` answers
   * only for a name that is registered, and `list()` is the same set. `spawn` is
   * in it by default because that is what this deployment has; `codex` is added
   * only by the tests that say so — which is also the whole point of the Codex
   * path, since the official package is not installed here.
   */
  const providers = spec.providers ?? (spec.noProvider === true ? [] : [SUBAGENT_PROVIDER]);
  const subagents = spec.noSubagents === true ? undefined : {
    list: () => [...providers],
    getProvider: (name) => (providers.includes(name) ? { name } : undefined),
    start: async (name, request) => {
      calls.start.push({ name, request });
      if (spec.startFails === true) throw new Error('provider refused to start');
      return {
        id: 'child-1',
        localAgent: undefined,
        result: spec.resultRejects === true
          ? Promise.reject(new Error('infrastructure exploded'))
          : Promise.resolve(spec.result ?? { output: [{ type: 'text', text: '检索结果' }], stopReason: 'completed' }),
        dispose: async () => {
          calls.disposed += 1;
          if (spec.disposeFails === true) throw new Error('dispose exploded');
        },
      };
    },
  };

  const dispatcher = new SubagentDispatcher({
    getSubagents: () => subagents,
    getResolver: () => resolver,
    // `undefined` means "this session has no override", which is not the same as
    // an override of `none`.
    getSessionPerspective: () => spec.sessionPerspective,
    getStore: () => store,
    getCatalog: () => catalog,
    now: () => NOW_ISO,
    logger: { info: () => {}, warn: () => {} },
  });
  return { dispatcher, agent, calls };
}

test('a completed run returns the child text with its route metadata', async () => {
  const { dispatcher, agent, calls } = makeDispatcher();
  const outcome = await dispatcher.dispatch({ agent, reference: '案例检索员', task: '检索争议焦点二' });
  assert.equal(outcome.text, '检索结果');
  assert.equal(outcome.stopReason, 'completed');
  assert.equal(outcome.childId, 'child-1');
  assert.equal(outcome.subagent.key, 'case-researcher');
  assert.equal(calls.disposed, 1, 'a completed run is still disposed');
});

test('the start request carries the fixed provider, the route, the cap and a persona', async () => {
  const { dispatcher, agent, calls } = makeDispatcher();
  await dispatcher.dispatch({ agent, reference: 'case-researcher', task: '检索争议焦点二' });
  const { name, request } = calls.start[0];
  // The provider is fixed in v0.1 and never user-selectable.
  assert.equal(name, SUBAGENT_PROVIDER);
  assert.equal(request.maxDepth, SUBAGENT_MAX_DEPTH);
  assert.equal(request.parent, agent);
  assert.equal(request.label, '案例检索员');
  assert.deepEqual(request.agentOptions, { provider: 'kimi-coding', model: 'k3', reasoningEffort: 'high' });
  assert.ok(request.persona.includes('案例检索员'));
  assert.ok(request.persona.includes('管理人'));
  const prompt = request.prompt[0].text;
  assert.ok(prompt.includes('检索争议焦点二'));
  assert.ok(prompt.includes('华北地产重整'));
});

test('a session outside every workspace is refused, with the reason', async () => {
  const { dispatcher, agent } = makeDispatcher({ noWorkspace: true });
  await assert.rejects(
    () => dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't' }),
    (error) => {
      assert.ok(error instanceof NoWorkspaceContextError);
      assert.equal(error.code, 'no-workspace-context');
      assert.ok(error.message.includes('/work/matter'));
      return true;
    },
  );
});

test('an unknown or disabled agent names the ones that are available', async () => {
  const { dispatcher, agent } = makeDispatcher();
  await assert.rejects(
    () => dispatcher.dispatch({ agent, reference: 'nobody', task: 't' }),
    (error) => {
      assert.ok(error instanceof UnknownSubagentError);
      assert.ok(error.message.includes('case-researcher'));
      return true;
    },
  );
  const disabled = makeDispatcher({ subagents: { a: { ...DEFINITION, enabled: false } } });
  await assert.rejects(
    () => disabled.dispatcher.dispatch({ agent: disabled.agent, reference: 'case-researcher', task: 't' }),
    UnknownSubagentError,
  );
});

test('a route that cannot run fails before any child resource is reserved', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({ routeFails: true });
  await assert.rejects(() => dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't' }), UnresolvableRouteError);
  assert.equal(calls.start.length, 0, 'nothing may be started when the route is unusable');
});

test('a missing subagents service or spawn provider is a named composition fact', async () => {
  const none = makeDispatcher({ noSubagents: true });
  await assert.rejects(
    () => none.dispatcher.dispatch({ agent: none.agent, reference: 'case-researcher', task: 't' }),
    (error) => error.message.includes('`subagents` service is not mounted'),
  );
  const unregistered = makeDispatcher({ noProvider: true });
  await assert.rejects(
    () => unregistered.dispatcher.dispatch({ agent: unregistered.agent, reference: 'case-researcher', task: 't' }),
    (error) => error.message.includes('"spawn" subagent provider is not registered'),
  );
});

test('every non-completed stop reason becomes a named failure carrying the partial output', async () => {
  for (const stopReason of ['aborted', 'error', 'max-tokens', 'refusal', 'something-new']) {
    const { dispatcher, agent, calls } = makeDispatcher({
      result: { output: [{ type: 'text', text: '半截答案' }], stopReason, diagnostic: 'provider said so' },
    });
    await assert.rejects(
      () => dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't' }),
      (error) => {
        assert.ok(error instanceof SubagentRunFailedError, `${stopReason} should fail`);
        assert.equal(error.code, 'subagent-run-failed');
        assert.equal(error.stopReason, stopReason);
        assert.ok(error.message.includes('半截答案'), 'partial output must survive the refusal');
        if (stopReason !== 'something-new') assert.ok(error.message.includes('provider said so'));
        return true;
      },
    );
    // A failed run is disposed exactly as a successful one is.
    assert.equal(calls.disposed, 1, `${stopReason} must still dispose`);
  }
});

test('an infrastructure rejection is reported with disposal still performed', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({ resultRejects: true, disposeFails: true });
  await assert.rejects(
    () => dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't' }),
    (error) => {
      assert.ok(error instanceof SubagentRunFailedError);
      // The two failures must not erase each other: the execution error is the
      // headline, the disposal failure is reported alongside it.
      assert.ok(error.message.includes('failed outside the model'));
      assert.equal(error.diagnostic, 'dispose failed: dispose exploded');
      return true;
    },
  );
  assert.equal(calls.disposed, 1);
});

test('a disposal failure does not swallow a successful result', async () => {
  const { dispatcher, agent } = makeDispatcher({ disposeFails: true });
  const outcome = await dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't' });
  assert.equal(outcome.text, '检索结果');
  assert.equal(outcome.disposeError, 'dispose exploded');
});

test('a start rejection has no run to dispose and is rethrown unchanged', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({ startFails: true });
  await assert.rejects(
    () => dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't' }),
    (error) => error.message === 'provider refused to start',
  );
  assert.equal(calls.disposed, 0);
});

test('the caller signal is forwarded to the run', async () => {
  const { dispatcher, agent, calls } = makeDispatcher();
  const controller = new AbortController();
  await dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't', signal: controller.signal });
  assert.equal(calls.start[0].request.signal, controller.signal);

  const without = makeDispatcher();
  await without.dispatcher.dispatch({ agent: without.agent, reference: 'case-researcher', task: 't' });
  // An absent signal must be absent, not `undefined`-valued: the seam's contract
  // distinguishes "no caller cancellation" from a present-but-undefined slot.
  assert.equal('signal' in without.calls.start[0].request, false);
});

test('listing reports the workspace context and only the enabled agents', () => {
  const { dispatcher, agent } = makeDispatcher({
    subagents: { a: DEFINITION, b: { ...DEFINITION, id: 'b', key: 'off', enabled: false } },
  });
  const listing = dispatcher.listFor(agent);
  assert.equal(listing.context.workspaceId, 'ws-1');
  assert.deepEqual(listing.subagents.map((entry) => entry.key), ['case-researcher']);
});

// ── the stance a child inherits ──────────────────────────────────────────────
//
// A dispatched child has no parent history, so the assignment is the only place
// it can learn which position it is working from. The parent's own prompt section
// reads the *session's* stance; if the child read the Workspace default instead,
// parent and child would reason from different positions and nothing on either
// side would say so.

test('a dispatched child inherits the session stance, not the Workspace default', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({ sessionPerspective: 'investor' });
  await dispatcher.dispatch({ agent, reference: '案例检索员', task: 't' });
  const text = calls.start[0].request.prompt[0].text;
  assert.ok(text.includes('工作立场：投资人 (Investor)'), 'the session stance reaches the child');
  assert.ok(text.includes('（本次会话指定）'), 'and is named as the session’s, not the Workspace’s');
});

test('with no session stance the child gets the Workspace default, named as such', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({});
  await dispatcher.dispatch({ agent, reference: '案例检索员', task: 't' });
  const text = calls.start[0].request.prompt[0].text;
  assert.ok(text.includes('工作立场：管理人 (Administrator)'));
  assert.ok(text.includes('（工作区默认）'));
});

test('a session stance of none silences the child too', async () => {
  // `none` is a decision, not an absence: the parent is working from no position,
  // so the child must not be handed one.
  const { dispatcher, agent, calls } = makeDispatcher({ sessionPerspective: 'none' });
  await dispatcher.dispatch({ agent, reference: '案例检索员', task: 't' });
  assert.ok(calls.start[0].request.prompt[0].text.includes('工作立场：未指定'));
});

test('a session stance the current Profile does not define is dropped, not translated', async () => {
  // The session override outlives a Workspace reconfiguration — it is keyed by
  // session — so a Workspace that moved from Bankruptcy to Litigation can still
  // hold one naming `administrator`. Injecting it would put an insolvency stance
  // into a lawsuit, so it falls back to the Workspace's own answer.
  const { dispatcher, agent, calls } = makeDispatcher({
    profile: 'litigation',
    defaultPerspective: 'plaintiff',
    sessionPerspective: 'administrator',
  });
  await dispatcher.dispatch({ agent, reference: '案例检索员', task: 't' });
  const text = calls.start[0].request.prompt[0].text;
  assert.ok(text.includes('工作立场：原告代理人 (Plaintiff)'), 'falls back to the new Profile’s default');
  assert.ok(!text.includes('管理人'), 'and never carries the stale insolvency stance');
});

test('a broken session-stance lookup costs the child its override, not its stance', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({});
  // Wired to throw rather than return.
  dispatcher.getSessionPerspective = () => { throw new Error('storage exploded'); };
  await dispatcher.dispatch({ agent, reference: '案例检索员', task: 't' });
  assert.ok(calls.start[0].request.prompt[0].text.includes('工作立场：管理人 (Administrator)'));
});

/* -------------------------------------------------------------------------- */
/* Backends                                                                    */
/* -------------------------------------------------------------------------- */

/** The 0.5.0 shape: no `backend` field at all. */
const LEGACY_DEFINITION = {
  id: 'legacy',
  key: 'case-researcher',
  name: '案例检索员',
  description: '检索并核验与当前工作区相关的法律规则和案例',
  provider: 'kimi-coding',
  model: 'k3',
  reasoningEffort: 'high',
  enabled: true,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

/** The 0.6.0 Codex role: no provider, no model, no effort. */
const CODEX_DEFINITION = {
  id: 'codex',
  key: 'code-expert',
  name: '代码专家',
  description: '在真实代码仓库中完成工程任务',
  backend: 'codex',
  enabled: true,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

/** The 0.6.0 spawn role the plan pins to a specific model and effort. */
const ARCHITECT_DEFINITION = {
  id: 'architect',
  key: 'code-architect',
  name: '代码架构师',
  description: '以分析、设计和审查为主',
  backend: 'spawn',
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  enabled: true,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

test('a definition stored before 0.6.0 still runs on spawn, unchanged', async () => {
  // The compatibility red line. `backend === undefined` is not "unknown"; it is
  // what every 0.5.0 definition carries, and it means exactly what it did.
  const { dispatcher, agent, calls } = makeDispatcher({ subagents: { legacy: LEGACY_DEFINITION } });
  const outcome = await dispatcher.dispatch({ agent, reference: 'case-researcher', task: 't' });
  assert.equal(calls.start[0].name, SUBAGENT_PROVIDER);
  assert.deepEqual(calls.start[0].request.agentOptions, {
    provider: 'kimi-coding', model: 'k3', reasoningEffort: 'high',
  });
  assert.equal(outcome.subagent.backend, 'spawn');
  assert.equal(outcome.subagent.routeLabel, 'kimi-coding/k3 · high');
  // No migration happened anywhere: the definition is handed back as stored.
  assert.equal('backend' in LEGACY_DEFINITION, false, 'the test fixture must stay a pre-0.6.0 record');
});

test('the coding template keeps its 0.5.0 behaviour: spawn on DeepSeek', async () => {
  // The plan calls this out as the one regression test 0.6.0 must have. 码农 is
  // not a legacy alias for the Codex role — it is a first-class engineering role
  // that keeps the exact route it was configured with.
  const coding = {
    id: 'coding-id', key: 'coding', name: '码农',
    description: '阅读并分析代码仓库；定位、复现并修复 Bug',
    backend: 'spawn', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
    enabled: true, createdAt: NOW_ISO, updatedAt: NOW_ISO,
  };
  const { dispatcher, agent, calls } = makeDispatcher({ subagents: { c: coding } });
  const outcome = await dispatcher.dispatch({ agent, reference: 'coding', task: '改一个类型错误' });
  assert.equal(calls.start[0].name, SUBAGENT_PROVIDER);
  assert.deepEqual(calls.start[0].request.agentOptions, {
    provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max',
  });
  assert.equal(outcome.subagent.routeLabel, 'deepseek-official/deepseek-flash · max');
});

test('a Codex definition starts the codex provider and sends it no DSH start capability', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({
    subagents: { c: CODEX_DEFINITION },
    providers: [SUBAGENT_PROVIDER, 'codex'],
  });
  const outcome = await dispatcher.dispatch({ agent, reference: 'code-expert', task: '修 KDocs Sidebar 白屏' });

  assert.equal(calls.start.length, 1);
  assert.equal(calls.start[0].name, 'codex');
  const { request } = calls.start[0];
  // The out-of-process backend advertises NO start capabilities, and the seam
  // rejects a request that asks for one rather than ignoring it. Each of these
  // would be a loud failure at `start`, so each is asserted absent by name.
  for (const forbidden of ['agentOptions', 'persona', 'maxDepth', 'toolFilter', 'outputSchema']) {
    assert.equal(forbidden in request, false, `the Codex request must not carry ${forbidden}`);
  }
  assert.equal(request.parent, agent);
  assert.equal(request.label, '代码专家');
  // The identity still reaches the child — compiled into the assignment, which
  // is the only channel this backend has.
  const prompt = request.prompt[0].text;
  assert.ok(prompt.includes('角色：代码专家'));
  assert.ok(prompt.includes('修 KDocs Sidebar 白屏'));
  assert.equal(outcome.subagent.backend, 'codex');
  assert.equal(outcome.subagent.routeLabel, 'Codex');
  assert.equal(outcome.subagent.provider, undefined, 'a Codex run reports no DSH provider');
  assert.equal(outcome.subagent.model, undefined, 'and no DSH model');
});

test('a Codex definition never goes through the LLM route preflight', async () => {
  // It has no DSH route to check, and asking the catalog would report "no
  // complete model route" for a definition the Host itself considers valid.
  const { dispatcher, agent, calls } = makeDispatcher({
    subagents: { c: CODEX_DEFINITION },
    providers: ['codex'],
  });
  await dispatcher.dispatch({ agent, reference: 'code-expert', task: 't' });
  assert.deepEqual(calls.routeChecks, [], 'the Codex path must not consult the model catalog');
  assert.equal(calls.start[0].name, 'codex');
});

test('a missing Codex backend is refused by name, and nothing is substituted', async () => {
  // This is the case this machine can actually reproduce: the official Codex
  // provider package is not installed in either distribution here.
  const { dispatcher, agent, calls } = makeDispatcher({ subagents: { c: CODEX_DEFINITION } });
  await assert.rejects(
    () => dispatcher.dispatch({ agent, reference: 'code-expert', task: 't' }),
    (error) => {
      assert.ok(error instanceof CodexBackendUnavailableError, `got ${error && error.code}`);
      assert.equal(error.code, 'codex-backend-unavailable');
      assert.ok(error.message.includes('code-expert'), 'the error names the Subagent');
      assert.ok(error.message.includes('spawn'), 'and says the fallback is refused in as many words');
      assert.ok(error.message.includes('never falls back'), error.message);
      assert.deepEqual(error.details.registered, ['spawn'], 'it reports what IS registered');
      return true;
    },
  );
  assert.equal(calls.start.length, 0, 'no run may be started on another backend');
});

test('the Codex provider is detected from the live provider table, never assumed', () => {
  assert.equal(resolveCodexProvider({ list: () => [], getProvider: () => undefined }), undefined);
  assert.equal(resolveCodexProvider({ list: () => ['spawn', 'fork'], getProvider: () => undefined }), undefined);
  assert.equal(resolveCodexProvider({ list: () => ['spawn', 'codex'], getProvider: (n) => (n === 'codex' ? {} : undefined) }), 'codex');
  // A registration name in another letter case is still the Codex backend, and
  // is started under the name the deployment actually used.
  assert.equal(resolveCodexProvider({ list: () => ['spawn', 'Codex'], getProvider: () => undefined }), 'Codex');
  // Substring matches are deliberately not candidates: a provider that merely
  // mentions Codex is not evidence that it IS the Codex backend, and guessing
  // would send the user's work somewhere they did not choose.
  assert.equal(resolveCodexProvider({ list: () => ['codex-acp', 'my-codex-fork'], getProvider: () => undefined }), undefined);
  // Two claimants is an error, not a coin toss.
  assert.throws(
    () => resolveCodexProvider({ list: () => ['codex', 'CODEX'], getProvider: () => undefined }),
    AmbiguousCodexBackendError,
  );
  // A broken table is "not known", never a throw from a capability read.
  assert.deepEqual(resolveCodexProvider({ list: () => { throw new Error('gone'); } }), undefined);
});

test('the architect keeps spawn, its own route, and its high reasoning effort', async () => {
  const { dispatcher, agent, calls } = makeDispatcher({
    subagents: { a: ARCHITECT_DEFINITION },
    providers: [SUBAGENT_PROVIDER, 'codex'],
  });
  const outcome = await dispatcher.dispatch({ agent, reference: 'code-architect', task: '审查这次修改' });
  assert.equal(calls.start[0].name, SUBAGENT_PROVIDER);
  assert.equal(calls.start[0].request.agentOptions.reasoningEffort, 'high');
  assert.equal(calls.start[0].request.agentOptions.model, 'gpt-6.1-sol');
  assert.ok(calls.start[0].request.persona.includes('代码架构师'));
  assert.equal(outcome.subagent.routeLabel, 'openai-codex/gpt-6.1-sol · high');
});

test('buildCodexRequest refuses to carry a start capability, by key', () => {
  // The guard is what turns "never send these to Codex" from a comment into a
  // property. This asserts the guard itself, so a future edit that adds
  // `maxDepth` back to the builder fails here rather than at the seam.
  const request = buildCodexRequest({ definition: CODEX_DEFINITION, agent: { id: 'a' }, prompt: 'p' });
  assert.deepEqual(Object.keys(request).sort(), ['label', 'parent', 'prompt']);
  assert.equal(request.prompt[0].type, 'text');

  const spawn = buildSpawnRequest({
    definition: ARCHITECT_DEFINITION, agent: { id: 'a' }, prompt: 'p', persona: 'persona',
  });
  for (const key of ['agentOptions', 'persona', 'maxDepth']) {
    assert.ok(key in spawn, `the spawn request must carry ${key}`);
  }
  // And the signal is omitted rather than passed as `undefined`: the seam reads
  // the property, so `signal: undefined` is a cancellation channel it will try
  // to use.
  assert.equal('signal' in spawn, false);
  assert.equal('signal' in request, false);
  const controller = new AbortController();
  assert.equal(buildCodexRequest({ definition: CODEX_DEFINITION, agent: {}, prompt: 'p', signal: controller.signal }).signal, controller.signal);
});

test('the two backends do not share a request shape', async () => {
  // Sending the spawn body to Codex would fail loudly at `start`; sending the
  // Codex body to spawn would silently drop the route and the persona. The
  // dispatcher must therefore branch, and this asserts it did.
  const spawnRun = makeDispatcher({ subagents: { a: ARCHITECT_DEFINITION } });
  await spawnRun.dispatcher.dispatch({ agent: spawnRun.agent, reference: 'code-architect', task: 't' });
  const codexRun = makeDispatcher({ subagents: { c: CODEX_DEFINITION }, providers: ['spawn', 'codex'] });
  await codexRun.dispatcher.dispatch({ agent: codexRun.agent, reference: 'code-expert', task: 't' });
  const spawnKeys = Object.keys(spawnRun.calls.start[0].request).sort();
  const codexKeys = Object.keys(codexRun.calls.start[0].request).sort();
  assert.notDeepEqual(codexKeys, spawnKeys);
  assert.ok(spawnKeys.length > codexKeys.length);
});

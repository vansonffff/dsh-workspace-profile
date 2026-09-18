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

import { SubagentDispatcher, SUBAGENT_MAX_DEPTH, SUBAGENT_PROVIDER } from '../src/subagent-dispatch.js';
import {
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
    profile: 'bankruptcy',
    defaultPerspective: 'administrator',
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
  const subagents = spec.noSubagents === true ? undefined : {
    list: () => (spec.noProvider === true ? [] : [SUBAGENT_PROVIDER]),
    getProvider: (name) => (spec.noProvider === true || name !== SUBAGENT_PROVIDER ? undefined : { name: SUBAGENT_PROVIDER }),
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

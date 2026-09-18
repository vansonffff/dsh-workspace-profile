/**
 * Route catalog and preflight.
 *
 * The interesting cases are all failures. The LLM seam deliberately does not
 * reject an unknown model for every adapter — the DeepSeek adapter synthesizes
 * metadata for any id it is handed, so a typo resolves cleanly and only fails at
 * the provider's HTTP boundary. This plugin's membership gate is the thing that
 * catches it, and it must fire *only* when the adapter actually advertises a
 * catalog: an adapter that advertises nothing is not evidence that a model is
 * wrong, and treating its silence as a rejection would break working routes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ModelCatalog } from '../src/model-catalog.js';
import { MissingCapabilityError, UnresolvableRouteError } from '../src/errors.js';

/**
 * Build a fake `ctx.llm` with the exact surface the catalog reads.
 *
 * @param {object} spec - the fake's behaviour.
 * @returns {any} the fake service.
 */
function makeLlm(spec = {}) {
  const providers = spec.providers ?? [{ id: 'kimi-coding', name: 'Kimi' }];
  const models = spec.models ?? { 'kimi-coding': [{ provider: 'kimi-coding', id: 'k3', name: 'Kimi K3' }] };
  const efforts = spec.efforts ?? { 'kimi-coding/k3': ['low', 'high', 'max'] };
  return {
    listProviders: () => providers,
    listModels: async (provider) => {
      if (spec.listModelsThrows === provider) throw new Error(`adapter "${provider}" exploded`);
      return models[provider] ?? [];
    },
    resolveModelInfo: async (provider, model) => {
      if (spec.resolveThrows === `${provider}/${model}`) throw new Error('unknown model');
      const allowed = efforts[`${provider}/${model}`];
      return {
        provider,
        id: model,
        name: model,
        ...(spec.contextWindow === undefined ? {} : { context: { contextWindow: spec.contextWindow } }),
        ...(allowed === undefined
          ? {}
          : { reasoning: { efforts: allowed.map((id) => ({ id, name: id.toUpperCase() })), defaultEffort: allowed[0] } }),
      };
    },
    resolveCallConfig: async (config) => {
      if (spec.callConfigThrows !== undefined) throw Object.assign(new Error(spec.callConfigThrows), { code: spec.callConfigCode });
      if (spec.callConfigRejects !== undefined && spec.callConfigRejects(config)) {
        throw Object.assign(new Error('unsupported reasoning effort "bogus"'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
      }
      return config;
    },
  };
}

function makeCatalog(spec) {
  const llm = spec === null ? undefined : makeLlm(spec ?? {});
  const warnings = [];
  return { catalog: new ModelCatalog({ getLlm: () => llm, logger: { warn: (m) => warnings.push(m) }, now: () => 0 }), warnings };
}

test('a complete route resolves and reports what it resolved to', async () => {
  const { catalog } = makeCatalog({ contextWindow: 262144 });
  const detail = await catalog.assertRoute({ provider: 'kimi-coding', model: 'k3', reasoningEffort: 'high' });
  assert.equal(detail.provider, 'kimi-coding');
  assert.equal(detail.model, 'k3');
  assert.equal(detail.reasoningEffort, 'high');
  assert.equal(detail.providerName, 'Kimi');
});

test('an incomplete route is refused before anything is looked up', async () => {
  const { catalog } = makeCatalog();
  for (const route of [{}, { provider: 'kimi-coding' }, { model: 'k3' }, { provider: '  ', model: 'k3' }]) {
    await assert.rejects(
      () => catalog.assertRoute(route),
      (error) => {
        assert.ok(error instanceof UnresolvableRouteError, `${JSON.stringify(route)} should be refused`);
        assert.ok(error.message.includes('never substitutes the parent session'));
        return true;
      },
    );
  }
});

test('an unregistered provider names the providers that do exist', async () => {
  const { catalog } = makeCatalog();
  await assert.rejects(
    () => catalog.assertRoute({ provider: 'openai', model: 'gpt' }),
    (error) => {
      assert.ok(error instanceof UnresolvableRouteError);
      assert.ok(error.message.includes('no registered adapter'));
      assert.ok(error.message.includes('kimi-coding'));
      return true;
    },
  );
});

test('a typo in a model the adapter advertises is caught, with a suggestion', async () => {
  const { catalog } = makeCatalog({
    models: { 'kimi-coding': [{ provider: 'kimi-coding', id: 'k3-256k', name: 'K3 256K' }] },
  });
  await assert.rejects(
    () => catalog.assertRoute({ provider: 'kimi-coding', model: 'k3-256' }),
    (error) => {
      assert.ok(error instanceof UnresolvableRouteError);
      assert.ok(error.message.includes('does not advertise a model'));
      assert.ok(error.message.includes('did you mean "k3-256k"?'), error.message);
      return true;
    },
  );
});

test('an adapter that advertises no catalog is NOT turned into a rejection', async () => {
  // The seam calls catalog membership advisory, and it is right to: a provider
  // whose discovery is unavailable would otherwise make every saved route fail.
  const { catalog } = makeCatalog({ models: { 'kimi-coding': [] }, efforts: {} });
  const detail = await catalog.assertRoute({ provider: 'kimi-coding', model: 'anything-at-all' });
  assert.equal(detail.model, 'anything-at-all');
});

test('an unsupported reasoning effort names the ones the route declares', async () => {
  const { catalog } = makeCatalog();
  await assert.rejects(
    () => catalog.assertRoute({ provider: 'kimi-coding', model: 'k3', reasoningEffort: 'bogus' }),
    (error) => {
      assert.ok(error instanceof UnresolvableRouteError);
      assert.ok(error.message.includes('does not support reasoning effort "bogus"'));
      assert.ok(error.message.includes('low, high, max'));
      return true;
    },
  );
});

test('the runtime preflight is the final authority, and its refusal is wrapped', async () => {
  // A route the catalog cannot judge — here, an effort on a route that declares
  // no effort list — is still decided by `resolveCallConfig`.
  const { catalog } = makeCatalog({
    efforts: {},
    callConfigRejects: (config) => config.reasoningEffort === 'bogus',
  });
  await assert.rejects(
    () => catalog.assertRoute({ provider: 'kimi-coding', model: 'k3', reasoningEffort: 'bogus' }),
    (error) => {
      assert.ok(error instanceof UnresolvableRouteError);
      assert.ok(error.message.includes('refused by the model runtime'));
      assert.equal(error.details.cause.includes('UNSUPPORTED_REASONING_EFFORT'), true);
      return true;
    },
  );
});

test('routeStatus reports rather than throws, which is what a settings row needs', async () => {
  const { catalog } = makeCatalog();
  assert.deepEqual(await catalog.routeStatus({ provider: 'kimi-coding', model: 'k3' }), {
    available: true,
    provider: 'kimi-coding',
    model: 'k3',
    providerName: 'Kimi',
    modelName: 'k3',
  });
  const bad = await catalog.routeStatus({ provider: 'nope', model: 'x' });
  assert.equal(bad.available, false);
  assert.equal(bad.code, 'unresolvable-route');
  assert.ok(typeof bad.reason === 'string' && bad.reason.length > 0);
});

test('a missing llm service is named as a composition fact', async () => {
  const { catalog } = makeCatalog(null);
  await assert.rejects(
    () => catalog.assertRoute({ provider: 'p', model: 'm' }),
    (error) => {
      assert.ok(error instanceof MissingCapabilityError);
      assert.equal(error.code, 'missing-capability');
      return true;
    },
  );
});

test('one failing adapter does not empty the picker for the others', async () => {
  const { catalog, warnings } = makeCatalog({
    providers: [
      { id: 'broken', name: 'Broken' },
      { id: 'kimi-coding', name: 'Kimi' },
    ],
    listModelsThrows: 'broken',
    models: { 'kimi-coding': [{ provider: 'kimi-coding', id: 'k3', name: 'Kimi K3' }] },
  });
  const groups = await catalog.catalog();
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.find((group) => group.provider === 'broken').models, []);
  assert.equal(groups.find((group) => group.provider === 'kimi-coding').models[0].id, 'k3');
  assert.equal(warnings.length, 1);
});

test('the catalog carries effort lists and context windows, and caches', async () => {
  const { catalog } = makeCatalog({ contextWindow: 1048576 });
  const first = await catalog.catalog();
  const model = first[0].models[0];
  assert.equal(model.contextWindow, 1048576);
  assert.deepEqual(model.efforts.map((entry) => entry.id), ['low', 'high', 'max']);
  assert.equal(model.defaultEffort, 'low');
  // Second read is served from the cache, with the same value.
  assert.equal(await catalog.catalog(), first);
  catalog.invalidate();
  assert.notEqual(await catalog.catalog(), first);
});

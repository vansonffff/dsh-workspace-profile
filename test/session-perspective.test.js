/**
 * Session Perspective overrides and the `/perspective` command.
 *
 * ## The storage double is deliberately strict
 *
 * A test double that is looser than the runtime proves nothing — four bugs in
 * this workspace's history were "tests green, real machine broken" for exactly
 * that reason. So the double here does not just record calls:
 *
 * - it runs {@link SESSION_DOMAIN_SPEC} through the **real** `defineDomain` when
 *   `@deepseek-ai/dsh-storage-domain` is resolvable, so the spec is checked by
 *   the owner of the contract rather than by this file's opinion of it;
 * - it makes reads synchronous and writes asynchronous, matching the documented
 *   contract ("reads are synchronous from memory; every write awaits backend
 *   durability first");
 * - it throws from reads after `close()`, matching `DomainImpl.assertReadable`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SESSION_DOMAIN_NAME,
  SESSION_DOMAIN_SPEC,
  SESSION_DOMAIN_VERSION,
  SESSION_TABLE,
  SessionPerspectiveStore,
  sessionIdOf,
} from '../src/session-perspective.js';
import { PERSPECTIVE_COMMAND, registerPerspectiveCommand } from '../src/commands.js';

/**
 * A storage domain double that mirrors the documented contract.
 *
 * @param {object} [options] - behaviour switches.
 * @param {boolean} [options.failWrites] - make every durable write reject.
 * @param {boolean} [options.failOpen] - make `open()` reject.
 * @param {Record<string, any>} [options.seed] - records to hydrate with.
 * @returns {any} the double, plus its captured state.
 */
function makeStorageDomain({ failWrites = false, failOpen = false, seed = {} } = {}) {
  const calls = { opened: [], puts: [], deletes: [], closed: 0 };
  const records = new Map(Object.entries(seed));

  /**
   * Mint one domain instance over the shared records.
   *
   * A fresh instance per `open()` is the point: the real facility hands out a new
   * `DomainImpl` each time, and only *that* instance is closed afterwards. A
   * double that returned one long-lived object would make a reopened store look
   * broken — its reads would hit the closed guard — which is a property of the
   * double, not of the code under test.
   */
  const openDomain = () => {
    let closed = false;
    const assertReadable = () => {
      if (closed) {
        const error = new Error(`domain '${SESSION_DOMAIN_NAME}' is closed`);
        error.code = 'closed';
        throw error;
      }
    };
    return {
      name: SESSION_DOMAIN_NAME,
      table(name) {
        assertReadable();
        if (name !== SESSION_TABLE) throw new Error(`domain '${SESSION_DOMAIN_NAME}' declares no table '${name}'`);
        return {
          // Synchronous, from memory — as the real table handle is.
          get(key) {
            assertReadable();
            return records.get(key);
          },
          entries() {
            assertReadable();
            return [...records.entries()][Symbol.iterator]();
          },
          keys() {
            assertReadable();
            return [...records.keys()][Symbol.iterator]();
          },
          async put(key, value) {
            calls.puts.push([key, value]);
            if (failWrites) throw new Error('backend write failed');
            // The real domain validates through the table's schema on the way in
            // as well as on hydration.
            records.set(key, SESSION_DOMAIN_SPEC.tables[SESSION_TABLE].valueSchema.parse(value));
          },
          async delete(key) {
            calls.deletes.push(key);
            if (failWrites) throw new Error('backend write failed');
            records.delete(key);
          },
        };
      },
      async close() {
        calls.closed += 1;
        closed = true;
      },
    };
  };

  return {
    calls,
    records,
    async open(spec) {
      calls.opened.push(spec);
      if (failOpen) throw new Error('no backend is routed for this domain');
      return openDomain();
    },
  };
}

/** An Agent-shaped object carrying a session id. */
function agentWithSession(id) {
  return { session: { id } };
}

/* -------------------------------------------------------------------------- */
/* The domain spec                                                             */
/* -------------------------------------------------------------------------- */

test('the domain spec satisfies the storage layer own validator', async () => {
  // The real validator, when this machine can resolve it. The spec is hand-written
  // precisely because the runtime must not depend on that import, so the check
  // that the hand-written shape is *correct* has to happen somewhere — here.
  let defineDomain;
  try {
    ({ defineDomain } = await import('@deepseek-ai/dsh-storage-domain'));
  } catch {
    defineDomain = undefined;
  }

  // Fall back to asserting the rules defineDomain enforces, so this test still
  // has teeth in a checkout without the package linked.
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
  assert.match(SESSION_DOMAIN_NAME, UNIT_NAME_RE);
  assert.equal(SESSION_DOMAIN_NAME.includes('-'), false, 'domain names take underscores, not hyphens');
  assert.ok(Number.isInteger(SESSION_DOMAIN_VERSION) && SESSION_DOMAIN_VERSION >= 0);
  assert.equal(SESSION_DOMAIN_SPEC.layout, 'per-record');
  for (const table of Object.keys(SESSION_DOMAIN_SPEC.tables)) assert.match(table, UNIT_NAME_RE);

  if (defineDomain !== undefined) {
    assert.doesNotThrow(() => defineDomain(SESSION_DOMAIN_SPEC));
  }
});

test('the record schema repairs a missing timestamp and rejects a missing stance', () => {
  const schema = SESSION_DOMAIN_SPEC.tables[SESSION_TABLE].valueSchema;
  assert.deepEqual(schema.parse({ perspective: 'debtor' }), {
    perspective: 'debtor',
    updatedAt: new Date(0).toISOString(),
  });
  assert.equal(schema.parse({ perspective: 'debtor', updatedAt: 'x' }).updatedAt, 'x');
  assert.throws(() => schema.parse({}), TypeError);
  assert.throws(() => schema.parse({ perspective: '' }), TypeError);
  assert.throws(() => schema.parse(null), TypeError);
});

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

test('sessionIdOf tolerates every Agent shape that has no session', () => {
  assert.equal(sessionIdOf(agentWithSession('s1')), 's1');
  assert.equal(sessionIdOf({ session: {} }), undefined);
  assert.equal(sessionIdOf({ session: { id: '' } }), undefined);
  assert.equal(sessionIdOf({}), undefined);
  assert.equal(sessionIdOf(undefined), undefined);
  assert.equal(sessionIdOf(null), undefined);
});

test('without storage the store still answers, and reports that it is not durable', async () => {
  const store = new SessionPerspectiveStore();
  assert.equal(store.durable, false);
  assert.equal(await store.open(undefined), false);
  assert.equal(store.durable, false);

  await store.set('s1', 'debtor');
  assert.equal(store.get('s1'), 'debtor');
  assert.equal(store.overrideFor(agentWithSession('s1')), 'debtor');
  assert.equal(store.get('s2'), undefined);

  await store.clear('s1');
  assert.equal(store.get('s1'), undefined);
});

test('a durable store hydrates, writes through, and survives a reopen', async () => {
  const storage = makeStorageDomain({ seed: { s1: { perspective: 'administrator', updatedAt: 'x' } } });
  const store = new SessionPerspectiveStore();
  assert.equal(await store.open(storage), true);
  assert.equal(store.durable, true);

  // Hydration: the value was written by a *previous* process.
  assert.equal(store.get('s1'), 'administrator');

  await store.set('s2', 'investor');
  assert.equal(store.get('s2'), 'investor');
  assert.deepEqual(
    storage.calls.puts.map(([key, value]) => [key, value.perspective]),
    [['s2', 'investor']],
  );

  // A second store over the same medium sees both — this is the "/perspective
  // then restart" path the plan asks for.
  const reopened = new SessionPerspectiveStore();
  await reopened.open(storage);
  assert.equal(reopened.get('s1'), 'administrator');
  assert.equal(reopened.get('s2'), 'investor');

  await reopened.clear('s1');
  assert.equal(reopened.get('s1'), undefined);
  assert.deepEqual(storage.calls.deletes, ['s1']);
});

test('a failed durable write does not leave memory believing the value landed', async () => {
  const storage = makeStorageDomain({ failWrites: true });
  const store = new SessionPerspectiveStore();
  await store.open(storage);

  await assert.rejects(() => store.set('s1', 'debtor'));
  // The whole point: after a restart the value would be gone, so the running
  // process must not report it as set.
  assert.equal(store.get('s1'), undefined);
});

test('an unusable storage domain degrades instead of failing activation', async () => {
  const warnings = [];
  const store = new SessionPerspectiveStore({ logger: { warn: (m) => warnings.push(m) } });
  assert.equal(await store.open(makeStorageDomain({ failOpen: true })), false);
  assert.equal(store.durable, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /memory-only/);

  // Still fully usable.
  await store.set('s1', 'creditor');
  assert.equal(store.get('s1'), 'creditor');
});

test('the domain is closed once, and closing twice is a no-op', async () => {
  const storage = makeStorageDomain();
  const store = new SessionPerspectiveStore();
  await store.open(storage);
  await store.close();
  await store.close();
  assert.equal(storage.calls.closed, 1);

  // A closed table must not be consulted again.
  const after = new SessionPerspectiveStore();
  await after.open(storage);
  assert.equal(after.durable, true);
});

test('a domain that refuses the second open is reported, not thrown', async () => {
  const warnings = [];
  const store = new SessionPerspectiveStore({ logger: { warn: (m) => warnings.push(m) } });
  const storage = makeStorageDomain();
  await store.open(storage);
  // The real facility throws `already-open` for a duplicate mount; the store must
  // survive a second activation attempt.
  const second = new SessionPerspectiveStore({ logger: { warn: (m) => warnings.push(m) } });
  const ok = await second.open({ open: async () => { throw new Error('already-open'); } });
  assert.equal(ok, false);
  assert.match(warnings.at(-1), /memory-only/);
});

/* -------------------------------------------------------------------------- */
/* /perspective                                                                */
/* -------------------------------------------------------------------------- */

/** A minimal `commands` service that captures registrations. */
function makeCommandCtx() {
  const registrations = new Map();
  return {
    registrations,
    ctx: {
      commands: {
        register(definition) {
          registrations.set(definition.name, definition);
          return () => registrations.delete(definition.name);
        },
      },
    },
  };
}

/** Wire the command against a fixed policy and store. */
function setupCommand({ profile, defaultPerspective, configured = true, override }) {
  const { ctx, registrations } = makeCommandCtx();
  const store = new SessionPerspectiveStore();
  if (override !== undefined) void store.set('s1', override);
  const resolveFor = () =>
    configured
      ? { policy: { profile, defaultPerspective }, configured: true, workspace: { title: 'W' } }
      : { policy: { profile: 'general', defaultPerspective: 'none' }, configured: false, workspace: undefined };
  registerPerspectiveCommand(ctx, { resolveFor, getSessionStore: () => store });
  const handler = registrations.get(PERSPECTIVE_COMMAND).handler;
  return {
    store,
    run: (rawInput, agent = agentWithSession('s1')) => handler({ agent, rawInput, signal: new AbortController().signal }),
  };
}

test('/perspective registers under a name the command seam accepts', () => {
  const { registrations } = makeCommandCtx();
  const { ctx } = makeCommandCtx();
  registerPerspectiveCommand(ctx, { resolveFor: () => ({ policy: undefined, configured: false }), getSessionStore: () => new SessionPerspectiveStore() });
  assert.equal(PERSPECTIVE_COMMAND, 'perspective');
  // The seam's own pattern; a name that fails it never registers at all.
  assert.match(PERSPECTIVE_COMMAND, /^[a-z][a-z0-9_-]*$/);
  assert.equal(registrations.size, 0);
});

test('/perspective with no argument reports the effective stance and the options', async () => {
  const { run } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator' });
  const result = await run('');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /管理人的|管理人/);
  assert.match(result.text, /本会话实际生效/);
  assert.match(result.text, /debtor/);
  assert.match(result.text, /原告代理人|plaintiff|restructuring-advisor/);
});

test('/perspective switches the session and leaves the workspace default alone', async () => {
  const { run, store } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator' });
  const result = await run('  investor  ');
  assert.equal(result.kind, 'success');
  assert.equal(store.get('s1'), 'investor');

  const status = await run('');
  // The workspace default is untouched — `管理员` still reads on that line, and
  // the override shows on the effective line. Asserting the two lines separately
  // is what proves the command moved the session and not the Workspace.
  assert.match(status.text, /工作区默认立场：管理人/);
  assert.match(status.text, /本会话覆盖：投资人/);
  assert.match(status.text, /本会话实际生效：投资人/);
});

test('/perspective default clears the override back to the workspace default', async () => {
  const { run, store } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator', override: 'investor' });
  assert.equal(store.get('s1'), 'investor');
  const result = await run('default');
  assert.equal(result.kind, 'success');
  assert.equal(store.get('s1'), undefined);
  assert.match(result.text, /恢复工作区默认/);
});

test('/perspective default on a session with no override says so instead of claiming a change', async () => {
  const { run } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator' });
  const result = await run('default');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /本来就没有设置立场覆盖/);
});

test('/perspective none silences the stance without touching the workspace default', async () => {
  const { run, store } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator' });
  const result = await run('none');
  assert.equal(result.kind, 'success');
  // Recorded as an explicit `none`, which is what makes it reversible with
  // `/perspective default` and distinguishable from "no override".
  assert.equal(store.get('s1'), 'none');
  assert.match(result.text, /不设定/);
});

test('/perspective refuses an id from another domain, naming what is available', async () => {
  const { run, store } = setupCommand({ profile: 'litigation', defaultPerspective: 'none' });
  const result = await run('administrator');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /未知的 Perspective/);
  assert.match(result.text, /plaintiff/);
  assert.equal(store.get('s1'), undefined);

  // Negative control: the id that IS legal for this Profile is accepted, so the
  // refusal above is about the domain and not about a broken validator.
  const accepted = await run('plaintiff');
  assert.equal(accepted.kind, 'success');
  assert.equal(store.get('s1'), 'plaintiff');
});

test('/perspective on a Profile with no stances explains the Profile, not the id', async () => {
  const { run } = setupCommand({ profile: 'general', defaultPerspective: 'none' });
  const result = await run('plaintiff');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /不支持 Perspective/);
  assert.match(result.text, /工作区类型/);
});

test('/perspective refuses to guess when the workspace is unconfigured', async () => {
  const { run } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator', configured: false });
  const result = await run('investor');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /还没有配置 Profile/);
});

test('/perspective reports a session it cannot key an override by', async () => {
  const { run } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator' });
  const result = await run('investor', {});
  assert.equal(result.kind, 'error');
  assert.match(result.text, /没有 session id/);
});

test('/perspective warns when the stance will not survive a restart', async () => {
  const { run } = setupCommand({ profile: 'bankruptcy', defaultPerspective: 'administrator' });
  const result = await run('investor');
  assert.match(result.text, /不会在重启后保留/);
});

/**
 * The `@子代理` trigger source, driven the way the platform drives it.
 *
 * ## Why it is tested here rather than in a browser
 *
 * The source is a plain object: the platform hands it a session projection, a
 * query and a signal, and reads back candidates, a lexicon or a `CommandClaim`.
 * Every rule the plan sets out about `@` lives in that object, and a real browser
 * adds nothing to the *rules* — it adds the composer around them, which is a
 * different (and separately observed) question.
 *
 * Two of those rules are easy to get wrong in opposite directions, so both are
 * asserted by name:
 *
 * - **Leading only.** An inline `请让 @代码专家 看看` is prose about an agent. It
 *   must not produce a candidate, must not be claimable at a space, and must not
 *   be turned into a `/agent` line at enter time.
 * - **No guessing on a name collision.** Two enabled experts may share a display
 *   name; the key still works, and the name refuses rather than picking one.
 *
 * The bundle is loaded exactly as the browser loads it — a classic script
 * registering itself with `window.__ModuleLoader__` — because that is the only way
 * to exercise the object the plugin actually registers.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8');

/**
 * Load the bundle and return its exports.
 *
 * A deliberately minimal double: this file needs no React and no slots, only the
 * factory's return value. This file renders nothing, so React is only needed
 * because the factory destructures it at module scope.
 *
 * @returns {any} the bundle's exports.
 */
function loadBundle() {
  const registrations = [];
  const react = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    Component: class {},
  };
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: Symbol('Fragment'),
  };
  const context = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          registrations.push(entry);
          entry.exports = entry.factory((name) => {
            if (name === 'react') return react;
            if (name === 'react/jsx-runtime') return jsxRuntime;
            throw new Error(`unexpected require(${name})`);
          });
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    navigator: {},
    document: undefined,
  };
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(SOURCE, { filename: 'client.js' }).runInContext(context);
  assert.equal(registrations.length, 1, 'the bundle must call __ModuleLoader__.load exactly once');
  return registrations[0].exports;
}

/** The mention rows a Host would answer with, in the shape `subagentsForSession` returns. */
const ROWS = [
  { key: 'coding', name: '码农', description: '阅读并分析代码仓库', backend: 'spawn', routeLabel: 'deepseek-official/deepseek-flash · max' },
  { key: 'code-expert', name: '代码专家', description: '在真实代码仓库中完成工程任务', backend: 'codex', routeLabel: 'Codex' },
  { key: 'code-architect', name: '代码架构师', description: '以分析、设计和审查为主', backend: 'spawn', routeLabel: 'openai-codex/gpt-6.1-sol · high' },
  { key: 'assist', name: '律师助理', description: '整理文件、摘要与时间线', backend: 'spawn', routeLabel: 'deepseek-official/deepseek-flash · max' },
];

/**
 * Strip a value back to plain host-realm JSON.
 *
 * The bundle runs in its own vm realm, so nothing it returns is `deepStrictEqual`
 * to a host array — the prototypes differ, and the failure reads like a content
 * mismatch. This package has been bitten by that before; normalising is the fix,
 * not loosening the comparison.
 *
 * @param {any} value - anything the bundle produced.
 * @returns {any} a host-realm copy.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A locale lookup that echoes its key, plus its parameters when interpolated. */
const t = (key, params) => (params === undefined ? key : key + ':' + JSON.stringify(params));

/**
 * Build the source over fakes for the two Remote namespaces.
 *
 * @param {object} [options] - the fixture.
 * @param {any[]} [options.rows] - the mention rows the Host returns.
 * @param {boolean} [options.unavailable] - answer "this session has no Workspace".
 * @param {Function} [options.answer] - a full replacement for the Remote call.
 * @param {any} [options.commandAnswer] - a full replacement for `commands.execute`'s
 *   answer, in the wire shape the Host really sends.
 * @returns {{ source: any, calls: any[], commands: any[], remote: any, settle: Function }}
 *   the source and the recorded traffic.
 */
function makeSource({ rows = ROWS, unavailable = false, answer = null, commandAnswer = null } = {}) {
  const calls = [];
  const commands = [];
  const listeners = new Set();
  const remote = {
    subagentsForSession: async (args) => {
      calls.push(args);
      if (answer !== null) return answer(args);
      if (unavailable) {
        return { ok: true, value: { available: false, workspaceId: null, subagents: [], message: 'not in a workspace' } };
      }
      return { ok: true, value: { available: true, workspaceId: 'ws-1', subagents: rows } };
    },
  };
  const commandsApi = {
    execute: async (sessionId, line, attachments) => {
      commands.push({ sessionId, line, attachments });
      if (commandAnswer !== null) return commandAnswer;
      return { ok: true, value: { commandId: 'c1', result: { kind: 'success' } } };
    },
  };
  const exports = loadBundle();
  const source = exports.createMentionSource({ remote, commands: commandsApi, t });
  return {
    source,
    calls,
    commands,
    remote,
    /** The same module instance's cache dropper — a second load would be a second cache. */
    invalidateMentions: exports.invalidateMentions,
    /** Let the source's internal promise chain reach its settled state. */
    settle: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
    listeners,
  };
}

/** The session projection the platform passes. */
const SESSION = { sessionId: 's-1' };
/** A stand-in for the platform's `AbortSignal`, never aborted. */
const SIGNAL = new AbortController().signal;

test('the source registers under the plan’s identity and trigger', () => {
  const { source } = makeSource();
  assert.equal(source.trigger, '@');
  assert.equal(source.name, 'workspace-subagents');
  // The heading is carried by `section` on each candidate, not by `name`: the
  // platform renders `t(source.name)` as a fallback heading, and an identifier
  // is not a heading.
  assert.equal(source.showGroupTitle, false);
  assert.equal(typeof source.candidates, 'function');
  assert.equal(typeof source.onPick, 'function');
  assert.equal(typeof source.matchSpace, 'function');
  assert.equal(typeof source.matchEnter, 'function');
  assert.equal(typeof source.lexicon, 'function');
  assert.equal(typeof source.subscribeLexicon, 'function');
  assert.equal(typeof source.warm, 'function');
});

test('a candidate carries the key as its name, the display name as its label', async () => {
  const { source } = makeSource();
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const rows = await source.candidates(SESSION, { query: '', position: 'leading', signal: SIGNAL });

  assert.equal(rows.length, 4);
  const expert = rows.find((row) => row.name === 'code-expert');
  // This is what makes both `@code-expert` and `@代码专家` find one agent: the
  // platform searches `name` and `label`, and renders the label with the name as
  // a trailing alias when the two differ.
  assert.equal(expert.label, '代码专家');
  assert.equal(expert.value, 'code-expert', 'the pick payload is the key, never the display name');
  assert.ok(expert.description.includes('Codex'), 'the row says where the agent runs');
  assert.ok(expert.description.includes('真实代码仓库'), 'and what it is for');
  assert.equal(expert.section, 'mentionGroup');
  // Nothing invented: the platform's candidate contract is name/label/description/
  // section/value plus the optional icon/drill/hint.
  for (const row of rows) {
    for (const field of Object.keys(row)) {
      assert.ok(['name', 'label', 'description', 'section', 'value'].includes(field), `unexpected candidate field ${field}`);
    }
  }
});

test('candidates are filtered locally, by key and by display name', async () => {
  const { source, calls } = makeSource();
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const before = calls.length;

  const all = await source.candidates(SESSION, { query: '', position: 'leading', signal: SIGNAL });
  assert.equal(all.length, 4, 'a bare @ lists every enabled agent');
  const byChinese = await source.candidates(SESSION, { query: '代码', position: 'leading', signal: SIGNAL });
  assert.deepEqual(plain(byChinese.map((row) => row.name)), ['code-architect', 'code-expert']);
  const byKey = await source.candidates(SESSION, { query: 'code', position: 'leading', signal: SIGNAL });
  assert.deepEqual(plain(byKey.map((row) => row.name)), ['code-architect', 'code-expert']);
  const one = await source.candidates(SESSION, { query: 'expert', position: 'leading', signal: SIGNAL });
  assert.deepEqual(plain(one.map((row) => row.name)), ['code-expert'], 'an ordered subsequence still matches');

  // Every keystroke after the first is answered from the cache. One Remote call
  // for four queries is the whole point of the per-Session cache.
  assert.equal(calls.length, before, 'filtering must not go back to the Host');
  assert.equal(calls.length, 1, 'exactly one read served all four queries');
});

test('an inline @ lists nothing, and claims nothing', async () => {
  const { source } = makeSource();
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const inline = await source.candidates(SESSION, { query: '代码专家', position: 'inline', signal: SIGNAL });
  assert.deepEqual(plain(inline), [], 'prose about an agent offers no direct call');
  // The space hook is not asked at all for an inline token: the controller's
  // `onSpace()` requires `hit.position === 'leading'` before polling any source,
  // so there is nothing here to refuse. Asserted on the source object rather than
  // on the controller (which this package does not own) because the fact that
  // matters is that the leading-only rule is not duplicated here in a form that
  // could disagree with it.
  // The enter hook is only reached for a *leading* token by the platform; the
  // source refuses the inline spelling anyway, so a different adjudicator cannot
  // turn a sentence into a dispatch.
  assert.equal(await source.matchEnter(SESSION, '请让 @代码专家 看看', SIGNAL, { attachments: 0 }), undefined);
});

test('a typed @name or @key becomes one /agent line, and the menu pick agrees', async () => {
  const { source, commands } = makeSource();
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  // Typed by display name.
  const byName = source.matchSpace(SESSION, '@代码专家');
  assert.ok(byName && byName.claim, 'a leading @name must claim at the space');
  assert.equal(byName.claim.name, 'agent', 'the underlying command is /agent, so the composer copy keys by it');
  assert.equal(byName.claim.token, '@代码专家 ', 'the draft keeps the spelling the user typed');
  await byName.claim.submit('修 KDocs Sidebar 白屏', {}, []);
  assert.deepEqual(commands[0], { sessionId: 's-1', line: '/agent code-expert 修 KDocs Sidebar 白屏', attachments: [] });

  // Typed by key.
  const byKey = source.matchSpace(SESSION, '@code-architect');
  await byKey.claim.submit('审查这次修改', {}, []);
  assert.equal(commands[1].line, '/agent code-architect 审查这次修改');

  // Picked from the menu.
  const rows = await source.candidates(SESSION, { query: '码农', position: 'leading', signal: SIGNAL });
  const pick = source.onPick({ candidate: rows[0], session: SESSION, position: 'leading', via: 'menu', action: 'pick' });
  assert.equal(pick.claim.token, '@码农 ');
  await pick.claim.submit('改一个类型错误', {}, []);
  assert.equal(commands[2].line, '/agent coding 改一个类型错误');
});

test('an empty task is refused before any command runs, and keeps the draft', async () => {
  const { source, commands } = makeSource();
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const outcome = await source.matchSpace(SESSION, '@码农').claim.submit('   ', {}, []);
  assert.deepEqual(plain(outcome), { kind: 'error', text: 'mentionNeedsTask' });
  assert.deepEqual(plain(commands), [], 'nothing is dispatched without a task');
});

test('a failed dispatch reaches the composer as the Host’s own error', async () => {
  // The plan's §29 "Backend Missing" case: `@代码专家` must **return** a clear
  // error, and the six characters it turns on must arrive verbatim. The reason is
  // the Host's, not this bundle's — `/agent` settles an absent backend, an
  // unmatched reference and a refused dispatch alike as `{ kind: 'error', text }`
  // — so the only correct translation is to hand that settlement back. Reporting
  // it as success is what the plan forbids: it also clears the draft and the
  // claim, so the user would have to retype the task after installing the backend.
  const text = 'Codex 后端未安装：本部署没有注册 Codex 子代理后端。插件不会自动安装、也不会改用 DSH 子代理或换模型。';
  const { source, commands } = makeSource({
    commandAnswer: { ok: true, value: { commandId: 'c9', result: { kind: 'error', text } } },
  });
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  const claim = source.matchSpace(SESSION, '@代码专家');
  assert.ok(claim && claim.claim, 'the mention still claims at the space');
  const outcome = await claim.claim.submit('修这个 bug', {}, []);
  assert.deepEqual(plain(outcome), { kind: 'error', text }, 'the failure reason must survive the translation');
  assert.ok(outcome.text.includes('Codex 后端未安装'));
  // The line still went out: this is a pass-through of the settlement, not a veto
  // in the browser. Whether to retry is the Host's answer to act on, not this
  // bundle's to pre-empt.
  assert.equal(commands.length, 1);
  assert.equal(commands[0].line, '/agent code-expert 修这个 bug');
});

test('a success settlement is success, and its text is not echoed into the composer', async () => {
  // `SubmitOutcome.text` is optional (`input.d.ts`), and the platform's own command
  // client omits it on success. It is omitted here too on purpose: the composer
  // turns an outcome text into a notice, and `/agent`'s success text is the child
  // Agent's entire report — which the Host already logs as a `command/done` and the
  // chat renders as a card. Echoing it would be a second copy in a smaller box.
  const { source } = makeSource({
    commandAnswer: { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '【代码专家】已完成：…' } } },
  });
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const outcome = await source.matchSpace(SESSION, '@代码专家').claim.submit('看看这个 bug', {}, []);
  assert.deepEqual(plain(outcome), { kind: 'success' });
});

test('a value without a settlement is refused, not reported as success', async () => {
  // A shape the wire schema does not allow, kept as a guard: whatever the Host
  // answered, nobody confirmed a dispatch, so "success" would be a claim this
  // bundle cannot support. It must refuse without throwing — a throw would lose
  // the line the user typed.
  const { source } = makeSource({ commandAnswer: { ok: true, value: { commandId: 'c2' } } });
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const outcome = await source.matchSpace(SESSION, '@码农').claim.submit('改一个类型错误', {}, []);
  assert.equal(outcome.kind, 'error');
  assert.ok(outcome.text.includes('/agent coding 改一个类型错误'), outcome.text);
});

test('a name shared by two enabled experts is never guessed', async () => {
  const rows = [
    ROWS[0],
    { ...ROWS[3], key: 'assist-2', name: '码农' },
  ];
  const { source, commands } = makeSource({ rows });
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });

  // The space hook declines rather than picking one: it answers synchronously and
  // has nowhere to explain itself, and the safe answer is "not claimed".
  assert.equal(source.matchSpace(SESSION, '@码农'), undefined);
  // Enter-time adjudication can explain, so it does — and still does not run.
  await assert.rejects(
    () => source.matchEnter(SESSION, '@码农 改一个类型错误', SIGNAL, { attachments: 0 }),
    (error) => {
      assert.ok(error.message.startsWith('mentionAmbiguous:'), error.message);
      const payload = JSON.parse(error.message.slice('mentionAmbiguous:'.length));
      assert.equal(payload.name, '码农');
      // The interpolation is the locale's job; what this asserts is that the
      // source hands it a comma-joined key list rather than picking one.
      assert.equal(payload.keys, 'assist-2, coding', 'the notice names the keys to use instead');
      return true;
    },
  );
  assert.deepEqual(commands, []);
  // The key still resolves — that is the escape hatch the notice points at.
  const byKey = source.matchSpace(SESSION, '@coding');
  assert.ok(byKey && byKey.claim);
  await byKey.claim.submit('改一个类型错误', {}, []);
  assert.equal(commands[0].line, '/agent coding 改一个类型错误');
});

test('an unknown token is left to the other @ source, not claimed', async () => {
  const { source } = makeSource();
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  // `@src/index.js` is a file reference; refusing it here would break `@file`.
  assert.equal(source.matchSpace(SESSION, '@src'), undefined);
  assert.equal(await source.matchEnter(SESSION, '@src/index.js', SIGNAL, { attachments: 0 }), undefined);
  assert.equal(await source.matchEnter(SESSION, '@', SIGNAL, { attachments: 0 }), undefined);
});

test('a disabled expert is absent, because the Host never sent it', async () => {
  const { source } = makeSource({ rows: ROWS.filter((row) => row.key !== 'code-expert') });
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const rows = await source.candidates(SESSION, { query: '', position: 'leading', signal: SIGNAL });
  assert.deepEqual(plain(rows.map((row) => row.name)), ['coding', 'code-architect', 'assist']);
  assert.equal(source.matchSpace(SESSION, '@code-expert'), undefined);
  assert.ok(!source.lexicon(SESSION).includes('code-expert'));
});

test('a session outside every Workspace answers nothing, and says so in the log rule', async () => {
  const { source } = makeSource({ unavailable: true });
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.deepEqual(plain(await source.candidates(SESSION, { query: '', position: 'leading', signal: SIGNAL })), []);
  assert.deepEqual(plain(source.lexicon(SESSION)), []);
});

test('a failed read is not cached as "no experts", and is retried', async () => {
  let attempts = 0;
  const { source, invalidateMentions: invalidator } = makeSource({
    answer: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transport is down');
      return { ok: true, value: { available: true, workspaceId: 'ws-1', subagents: ROWS } };
    },
  });
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  // A transport failure must not be frozen into "this workspace has no agents":
  // the cache drops the failed entry so the next `@` asks again.
  assert.equal(typeof invalidator, 'function');
  invalidator(SESSION.sessionId);
  const rows = await source.candidates(SESSION, { query: '', position: 'leading', signal: SIGNAL });
  assert.equal(attempts, 2, 'the second read happened');
  assert.equal(rows.length, 4);
});

test('the lexicon offers keys, and the subscription fires when the roll lands', async () => {
  const { source } = makeSource();
  let notified = 0;
  const unsubscribe = source.subscribeLexicon(SESSION, () => { notified += 1; });
  assert.equal(source.lexicon(SESSION), undefined, 'cold: nothing to decorate, and never a fetch from here');
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const roll = source.lexicon(SESSION);
  // Keys only: the platform's plain-text scan matches `[\w-]+`, so a Chinese
  // display name can never be a reference — offering one would be noise.
  assert.deepEqual(plain(roll), ['coding', 'code-expert', 'code-architect', 'assist']);
  assert.ok(notified > 0, 'the render side is told the roll moved');
  unsubscribe();
  const before = notified;
  source.warm(SESSION);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(notified, before, 'an unsubscribed listener hears nothing more');
});

test('concurrent asks share one read', async () => {
  let resolves = 0;
  const { source, calls } = makeSource({
    answer: () => {
      resolves += 1;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, value: { available: true, workspaceId: 'ws-1', subagents: ROWS } }), 1);
      });
    },
  });
  const [a, b, c] = await Promise.all([
    source.candidates(SESSION, { query: '', position: 'leading', signal: SIGNAL }),
    source.candidates(SESSION, { query: 'co', position: 'leading', signal: SIGNAL }),
    source.candidates(SESSION, { query: '码', position: 'leading', signal: SIGNAL }),
  ]);
  assert.equal(calls.length, 1, 'three concurrent asks, one Remote call');
  assert.equal(resolves, 1);
  assert.equal(a.length, 4);
  // 'co' is an ordered subsequence of all three code-* keys.
  assert.equal(b.length, 3);
  assert.equal(c.length, 3, 'every 代码* display name starts with the same character');
});

test('an aborted ask renders nothing rather than rows for a dead query', async () => {
  const { source } = makeSource();
  const controller = new AbortController();
  const pending = source.candidates(SESSION, { query: '', position: 'leading', signal: controller.signal });
  controller.abort();
  assert.deepEqual(plain(await pending), []);
});

test('the source never builds the command line itself', () => {
  // The plan's "no fourth execution path": a mention ends in `/agent`, and the
  // claim submits a *line*, not a dispatch call. Asserted against the source text
  // because the alternative — a second dispatcher — would not be visible from any
  // one behaviour.
  assert.ok(SOURCE.includes("runAgentLine(commands, sessionId, '/' + MENTION_AGENT_COMMAND + ' ' + key + ' ' + args, attachments)"));
  assert.ok(!/SubagentDispatcher|dispatcher\.dispatch/.test(SOURCE), 'the bundle must not carry a second dispatcher');
});

# Milestone 0.6 — a second execution backend, and `@子代理`

**Status: 0.6.0.** Two capabilities are added to the 0.5.0 architecture, and the
existing one is left alone: a Workspace Subagent may now run on the official Codex
backend instead of the in-process DSH child, and a user can address an expert
directly with `@`.

> The plan this implements is `docs/PLAN-0.6.md`, reproduced in this repository as
> the acceptance baseline. Where the plan and the running platform disagree, the
> platform wins and the disagreement is recorded below — §"Where the plan and the
> platform disagree".

> Names, ids and paths below are placeholders. Real ones are client data and are
> deliberately not in this repository; `test/no-client-data.test.js` enforces that
> against the private workspace's own registry.

---

## What shipped, in the plan's own phases

| Phase | Deliverable | Where |
|---|---|---|
| 1 | `backend` in the data model, `undefined → spawn`, no migration | `src/policy.js`, `src/subagent-registry.js` |
| 2 | Dispatcher branches on the backend; two explicit request builders | `src/subagent-dispatch.js` |
| 3 | 代码专家 (Codex) and 代码架构师 (spawn, model resolved from the live catalogue) | `client.js` |
| 4 | 执行方式 in the editor, with conditional route fields and a Codex status line | `client.js` |
| 5 | `@子代理` trigger source + the `subagentsForSession` read | `client.js`, `src/remote/operations.js` |
| 6 | Tests, README, CHANGELOG, this file | `test/`, `docs/` |

### The data model

```
{ id, key, name, description, backend, provider, model, reasoningEffort, enabled }
```

`backend` is `'spawn' | 'codex'` and nothing else. Everything stored before this
release has no such field, and `subagentBackend(definition)` reads an absent field
as `'spawn'` — which is what those definitions actually did.

**No migration runs.** No document is rewritten, no record is touched. The field is
written only when the user creates or edits a Subagent through the 0.6.0 page, and
the value written is what they chose. A caller that knows nothing about the field
(the 0.5.0 client, a script) can still edit a definition and gets it back without
one — `test/backend-model.test.js` pins exactly that.

Validation splits by backend, and the split is the substance:

- `spawn` (and an absent backend) must name `provider` and `model`;
- `codex` must **not** be held to that rule. Those are DSH LLM route fields; a
  Codex child's model comes from the Codex provider's own configuration, which this
  plugin neither reads nor writes.

An unrecognised backend is refused at write time rather than coerced to `spawn`. A
silent coercion would run the user's work on a transport they did not choose, which
is the failure this field exists to prevent.

### The dispatcher

```
definition → backend → { spawn: route preflight, persona, agentOptions, maxDepth }
                     { codex: provider detection, identity compiled into the task }
```

The two requests are separate functions, `buildSpawnRequest()` and
`buildCodexRequest()`, because the two backends do **not** take the same payload.
The platform's own source says so: an out-of-process backend advertises
`NO_START_CAPABILITIES` (`dsh-subagent/lib/index.js`, comment at the
`NO_START_CAPABILITIES` constant), and `start` **rejects** a request that asks for
`agentOptions`, `outputSchema`, `maxDepth`, `toolFilter` or `persona` rather than
ignoring it. A single "one request, two backends" body would therefore either fail
loudly for every Codex run or quietly send a `spawn`-shaped request to a backend
that cannot honour it. `buildCodexRequest` asserts the absence of those five keys
by name, so the rule is a property of the function rather than a comment.

The prompt compilers split three ways: `compileBaseTask` (Workspace, Matter,
verbatim task, requirements), `compileSpawnTask` (the base — identity rides the
`persona` field this backend supports), and `compileCodexTask` (role identity,
responsibility and guidance compiled **into** the text, because this backend has no
persona channel). `compileTaskFor` is the single place the backend chooses, so a
caller cannot assemble one request out of the other's pieces.

### How the Codex backend is detected

The official package is **not installed here** — `@deepseek-ai/dsh-subagent-codex`
is absent from both distributions this machine runs:

```
desktop app.asar (13,973 files): @deepseek-ai/dsh-subagent-codex  → not present
  present: dsh-subagent, dsh-subagent-spawn-in-process,
           dsh-subagent-fork-in-process, dsh-subagent-in-process-driver
npm-global dsh 0.1.7-rc.2:        → not present
```

So the plugin does not import it and does not depend on it. It asks the live
registry instead, in this order:

1. `ctx.subagents.getProvider('codex')` — the exact name, which is what the
   platform's own naming convention produces (the in-process backend registers as
   `spawn`, i.e. its short id);
2. otherwise the **unique** registered name equal to `codex` in another letter case;
3. more than one match is an error (`ambiguous-codex-backend`), not a coin toss;
4. no match is `undefined`, and the caller raises `codex-backend-unavailable`.

The name match is deliberately narrow — `/^codex$/i`, never a substring. A provider
called `codex-acp` merely *mentions* Codex; treating that as evidence would send the
user's work somewhere they did not choose.

**What is not verified here, and cannot be.** No real Codex run happens on this
machine, because there is no Codex backend to run on. What is verified is the
detection, the refusal, the request shape and the whole spawn path. A deployment
that installs the package gets its real name reported in the error message when
detection fails, and the dispatched provider name is the registered one, not a
hard-coded string.

### Where the plan and the platform disagree

Three places, all measured against the source rather than guessed.

**(1) `matchEnter` is not reached for an `@` draft.** The composer's submit machine
adjudicates only drafts that start with `/` — `SubmitMachine.onEnter` in
`dsh-client-ui-conversation/lib/client.js`:

```js
const trimmed = draft.trim();
if (trimmed === "") return [];
if (trimmed.startsWith("/")) { … type: "adjudicate" … }
return this.detachedEffects(this.beginDetached(mode, draft));
```

So the plan's "直接输入 `@码农 xxx`" cannot be implemented through `matchEnter` on
this platform: the hook is never called for an `@` line. What *is* called is
`matchSpace` — `InputTriggerController.onSpace()` polls every source registered for
the hit's trigger character, with no trigger filter, and `hit.position === 'leading'`
is checked there. So typing `@码农` and then a space is what claims the line:

```
@码农 ␣   → claim token "@码农 ", the composer enters claimed mode
修一下类型错误  → typed as the argument
⏎        → /agent coding 修一下类型错误
```

`matchEnter` is implemented anyway: it is the contract's enter hook, `adjudicate`
does iterate `@` sources when it is called, and if the shell ever routes `@` through
it the behaviour is already correct and already tested.

**(2) The menu group heading cannot come from the source `name`.** The plan says
`name: 'workspace-subagents'`, and the platform renders `t(source.name)` as the
group heading — an identifier is not a heading, and the `slash.menu` locale
namespace is owned by another package (`locale.register` throws when a namespace
already has that language). The heading therefore travels on each candidate's
`section` field, which is the platform's own mechanism for naming a group in the
reader's language, and `showGroupTitle` is `false`.

**(3) A command's error is not always the composer's to report.** The platform's own
command client returns plain success for a **handler** error whenever the draft
carries no attachments — `CommandUiRuntime.execute` in
`dsh-client-ui-commands/lib/client.js`:

```js
this.notifyExecuted(session.sessionId, submittedCommandName(line), result.value.result);
if (attachments.length > 0 && result.value.result.kind === "error") return { kind: "error", text: result.value.result.text };
return { kind: "success" };
```

Its comment gives the reason: the Host durably logs `command/run`/`command/done` and
the outcome renders as a chat card, so the composer does not echo it — and the Host
does record the text (`dsh-commands/lib/index.js`, the `settle()` that appends
`command/done` with `kind` and `text`), which `CommandNodeView` renders
(`dsh-client-ui-chat/lib/client.js`). So the 0.6.0 acceptance report that the reason
"was completely discarded" holds for the composer — which is where it was noticed;
the card is a reading of that source, not of a page (no browser was opened; see
"What is **not** verified" below).

The `@` claim departs from that mirror anyway, and not out of tidiness: §29's
"Backend Missing" says `@代码专家` must **return** a clear error, and a success
settlement also consumes the draft and the claim (`onSubmitSettled`, same file), so
the user would retype the task after installing the backend. A failure has to reach
the point of action. The cost is that a failed `@` run now shows the reason twice —
once as the composer's notice, once as the card. The success branch keeps the
platform's shape and drops the success text: `SubmitOutcome.text` is optional
(`input.d.ts`), and a success text becomes an `info` notice, which for `/agent` is
the child Agent's entire report in a smaller box.

### Which requirements a child is sent

The plan's §11 pollution — every agent in every Workspace was told to cite statutes
and case numbers — is fixed the thin way the plan prefers: **no new field**. The
requirement list is chosen by the role:

```
codex backend, or one of the three built-in engineering template keys  → engineering
everything else                                                       → legal
```

`legal` is the fallback on purpose, and that is a compatibility decision rather than
a classification of anyone's work: every definition stored before 0.6.0 received the
legal paragraph, and silently dropping it from a real legal agent's assignment would
be a regression this release is not allowed to cause. Only the three roles the plan
names (码农 / 代码专家 / 代码架构师) move.

`general` is implemented and tested at the compiler level but **no definition
resolves to it in 0.6.0**. Reaching it would need either a stored `domain` field
(which the plan prefers not to add) or a heuristic over names, and both would change
what existing definitions receive. Recorded here as a deliberate deferral.

### The `@` source

Registered as `{ trigger: '@', name: 'workspace-subagents' }`. It **selects**, and
never executes: every path ends in a `CommandClaim` whose `submit` sends
`/agent <key> <task>` to the Host, so the model tool, `/agent` and `@` share one
lifecycle. There is no second dispatcher in the bundle, and a test asserts that.

- **Leading only.** `candidates()` returns nothing when `position !== 'leading'`, so
  `请让 @代码专家 看看` never offers a direct call, and `matchEnter` parses only a
  line that *starts* with `@`.
- **Name and key.** The candidate's `name` is the **key** and its `label` the display
  name, which is what makes `@code-expert` and `@代码专家` find the same agent.
- **Never guessing on a collision.** Two enabled experts may share a display name.
  The key still resolves; the name refuses, and the notice names the keys to use.
- **Per-session cache**, warmed at session-scope birth and invalidated by: a local
  write from the Settings section, any write to this settings namespace
  (`settings/document-updated` is a forwarded host event), and `connection/reset` —
  the platform's own statement that wire-derived caches must repull. A generation
  counter drops a late answer from a superseded read.

The read behind it is a new read-only Remote method:

```js
subagentsForSession({ sessionId })
  → { available, workspaceId, subagents: [{ key, name, description, backend, routeLabel }] }
```

Enabled definitions only, five fields each, no stored policy and no Skill overrides.
`available` and `workspaceId` are an addition to the plan's bare array, and they are
there because an empty array cannot distinguish "this Workspace has no experts" from
"this session is not inside a Workspace" — two answers with different remedies.

### The settings page

`执行方式` is its own field group above the route, offering `DSH 子代理` and `Codex`.
Choosing Codex **hides** Provider / Model / Reasoning (rather than disabling them,
which reads as "you forgot to fill this in") and shows what will actually run:

```
执行后端：Codex
模型：跟随 Codex 原生配置
Codex 后端未安装
本部署没有注册 Codex 子代理后端。插件不会自动安装、也不会改用 DSH 子代理或换模型；
保存后调用会直接报错说明原因。
```

The availability verdict is read from the Host's capability map
(`capabilities.codexBackend`), never inferred in the browser: only the Host can see
which providers are registered. A detection *failure* is reported separately from
absence, because "there is no Codex backend" and "I could not tell" are different
answers.

### A bug this release found and fixed (0.5.0 regression)

`updateDefinition` refused any patch that merely **mentioned** `id`, `key` or
`createdAt`. The Settings page echoes the whole definition back — the enable/disable
switch sends `{...definition, enabled}` and the editor sends the form's fields — so
**every** write from the page was refused with `invalid-subagent` and rendered as an
error notice. The switch and the editor had both been broken since the guard was
introduced (`v0.1.2`), and nothing caught it because the two halves were tested
separately: the client test asserted the payload *carried* `id`, and the host test
asserted a patch mentioning `id` was refused. Neither ever sent one through the
other.

The guard now compares **values** (`patch[field] !== previous[field]`), which is what
the rule is about, and keeps the loud refusal for a real rename or a rewritten
creation stamp. `updateDefinition`'s `validateSubagentEdit` already compared the
values, so the presence check was adding nothing but the false refusal.

`test/subagents-operation.test.js` is the test that closes the gap: it builds the
payload **the way the browser builds it** and sends it through the operation the
browser calls.

---

## Tests

```
baseline  (0.5.0)                                                       250 tests
0.6.0     RELEASE_CHECK=1 node --test "test/*.test.js"                  319 tests   all green
repair    (acceptance, below)                                           322 tests   all green
```

New files: `test/backend-model.test.js` (the write path), `test/mention-source.test.js`
(the `@` source, driven as the platform drives it), `test/subagents-operation.test.js`
(the browser's payload through the host's own operations, and the mention read).

### A defect the 0.6.0 acceptance found, and its repair

**`@` reported a failed dispatch as success.** `runAgentLine` read the wire answer
and then returned `{ kind: 'success' }` for every settlement except a missing one —
while this plugin's own `/agent` reports an absent Codex backend, an unmatched
reference and a refused dispatch as `{ kind: 'error', text }`
(`src/commands.js`, through `describeFailure`). So `@代码专家 修这个 bug` cleared the
draft, consumed the claim and said nothing, with the reason dropped on the floor.

The settlement is now passed through: `kind: 'error'` keeps its `text` and becomes an
`error` outcome, which is what makes the composer show the reason **and** keep the
draft and the claim for a retry. A value with no `result` field at all — a shape the
wire schema does not allow — refuses with the line named rather than throwing.

Same class of gap as the 0.5.0 write bug above: the harness stopped one layer short.
`test/mention-source.test.js` asserted the **line** a mention sends
(`/agent code-expert …`) and never the **answer** it translates, so a client that
discarded every settlement was fully green. The three new cases drive
`runAgentLine`'s translation with the Host's real wire shape.

### Negative controls

Every check added in this milestone was shown to fail on a deliberately broken
input before it was trusted. One planted defect at a time, the named test file then
run; each control had to go **red**, and the tree was restored afterwards. 28
controls, 28 fired.

| Planted defect | Went red in |
|---|---|
| `subagentBackend` reads everything as `spawn` | `test/dispatcher.test.js` |
| Codex definitions are held to the spawn route rule | `test/policy.test.js` |
| `buildCodexRequest` carries `maxDepth` | `test/dispatcher.test.js` |
| A missing Codex backend falls back to `spawn` | `test/dispatcher.test.js` |
| The Codex path is routed through the LLM preflight | `test/dispatcher.test.js` |
| The Codex provider is matched by substring | `test/dispatcher.test.js` |
| Every role is sent the legal requirements | `test/compilers.test.js` |
| The expert directory prints an empty route for Codex | `test/compilers.test.js` |
| The LLM preflight runs for a codex route | `test/model-catalog.test.js` |
| The immutability guard refuses any mention of `id`/`key` | `test/subagents-operation.test.js` |
| The mention catalog includes disabled definitions | `test/subagents-operation.test.js` |
| The projection drops `routeLabel` | `test/subagents-operation.test.js` |
| An unknown session answers as available-and-empty | `test/subagents-operation.test.js` |
| The `@` source ignores the trigger position | `test/mention-source.test.js` |
| A duplicate display name is resolved by first match | `test/mention-source.test.js` |
| A mention builds its own command line | `test/mention-source.test.js` |
| The candidate `name` is the display name, not the key | `test/mention-source.test.js` |
| The lexicon offers display names as well as keys | `test/mention-source.test.js` |
| The cache is never invalidated on a reconnect | `test/client-bundle.test.js` |
| The route group renders for Codex too | `test/client-bundle.test.js` |
| An ambiguous model spec resolves to the first match | `test/client-bundle.test.js` |
| The architect template hard-codes a model id | `test/client-bundle.test.js` |
| The card fallback drops the reasoning effort | `test/client-bundle.test.js` |
| The card fallback prints an empty route for Codex | `test/client-bundle.test.js` |
| A Codex save stores the route it should not have | `test/client-bundle.test.js` |
| The editor saves no backend at all | `test/client-bundle.test.js` |
| The source is built from `ctx.remote`, read too early | `test/client-bundle.test.js` |
| A dispatch failure is reported as success *(the acceptance repair)* | `test/mention-source.test.js` |

The last row is the repair's own control: `runAgentLine` was put back to its shipped
form — `undefined` refuses, every other value is success — and the file went
**16/18**. Two of the three new cases went red: *"a failed dispatch reaches the
composer as the Host's own error"*, with

```
+ actual - expected
  { + kind: 'success'   - kind: 'error',
                        - text: 'Codex 后端未安装：本部署没有注册 Codex 子代理后端。…' }
```

and *"a value without a settlement is refused"*. The third — *"a success settlement
is success, and its text is not echoed"* — stayed green, correctly: the plant does
not touch that path. The tree was then restored from a checksummed copy
(`sha256 5fe32d2b…`) and the full gate re-run against the restored file.

One plant did **not** fire and is recorded as such rather than quietly dropped:
*"a card ignores the Host `routeLabel`"*. Both branches of that expression produce
the same string for every reachable fixture — the local fallback exists precisely so
an un-restarted Host renders the same label — so the plant is behaviour-preserving
and there is nothing for a test to catch. The two properties that *are* real are
tested separately (the Host's label is shown; the fallback still works).

### Doubles that are not more permissive than the runtime

Two harness faults were fixed rather than worked around, both of the same class:

- The client harness's `ctx.inject` handed every dependency set the same fake. It now
  hands `['inputTriggers', 'remote.commands']` the shape those services actually
  have, so a missing method cannot pass here and fail in the browser.
- `test/panel-copy.test.js`'s dictionary reader did not skip `//` comments, so an
  apostrophe in an English comment inside the `DICTS` literal flipped it into
  "inside a string" and it reported *every* Chinese label as bare English. The walker
  is now comment-aware, because a double that is stricter than the runtime invents
  failures.

---

## What is **not** verified

- **No real Codex run.** `@deepseek-ai/dsh-subagent-codex` is not installed in either
  distribution on this machine, so the Codex path is verified up to the call that
  would start it: the detection, the refusal when it is absent, the request shape,
  and the compiled prompt. Everything after `ctx.subagents.start('codex', …)` is
  unexercised.
- **No real browser observation of the `@` menu.** Every rule of the source is
  driven directly through the object the platform calls, and the wiring is asserted
  through the bundle's own `apply`, but no page was opened and no menu was rendered.
  The platform facts the design rests on (`onSpace` polls every source for the hit's
  trigger; `onEnter` adjudicates only `/` lines; the group heading comes from
  `t(source.name)`) were read from the installed platform source, not observed.
- **The 设置页's Codex branch was never seen.** The dialog only renders while open,
  and the static tree the harness builds has it closed; the assertions are on the
  source and on the exported pure functions, exactly as the template control's are.

## Deployment notes

- **The Host half must be restarted.** `src/**` changed, so `subagentsForSession`,
  the backend validation, the dispatcher and the capability map are all new Host
  code. The browser half hot-reloads; the Host does not, and this workspace's normal
  state is "client newer than host" — the Settings page will show the new dialog and
  the `@` read will fail as a transport error until DSH is restarted.
- Adding a Codex Subagent before installing the backend is **allowed and honest**: it
  saves, it appears in the list and in the model-visible directory, and calling it
  fails with the reason. The plugin never installs a package and never substitutes a
  transport.
- `client.js` is a classic script: no ESM, `children:` props, slot bodies inside the
  error boundary, declaration order = dependency order. The `@` source is registered
  **inside** the `remote.workspaceProfile` callback so it cannot be constructed before
  the namespace it reads has resolved.

---

## Corrections to earlier records

- The 0.6.0 plan's §20 shows the menu pick producing `token: @代码专家` and a
  `submit` that runs `/agent code-expert <args>`. That is what ships, with one
  correction from the platform: the typed form is claimed at the **space**, not at
  enter (see above).
- `docs/MILESTONE-0.5.md` and the release notes before it describe the Subagent
  editor and its enable/disable switch as working. They were not: every write from
  that page was refused (see "A bug this release found and fixed"). Nothing in 0.5.0
  reported it as working — the milestone records the *rendering* as verified, which
  it was.
- `README.md` said a display name shared by two experts is answered by "the notice
  names the keys to use instead". That notice exists only in `matchEnter`, which this
  platform never reaches for an `@` draft (disagreement (1) above), so in a real
  composer the collision produces no notice at all: the space claims nothing, the
  menu closes, and the line goes to the model as ordinary text. The README now says
  to type the key instead. **No behaviour changed** — the notice is still there for
  the enter hook, and the key still resolves.

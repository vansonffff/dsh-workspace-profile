# Compatibility baseline — DSH `0.1.5-rc.1`

> Status: **Phase 0 complete.** Every seam below was measured against the
> installed distribution, not read from a README or inferred from an older
> version of DSH. Where a claim rests on runtime behaviour rather than a
> declaration, the observation is recorded with the probe that produced it.
>
> Baseline frozen: `@deepseek-ai/dsh` **0.1.5-rc.1** at
> `/Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/`.
> Package: `dsh-workspace-profile` (directory `dsh-workspace-profile/`).

## 0. What this document is for

The plan's exit condition for Phase 0 is: *any key seam that does not hold stops
further development; update the architecture rather than monkey-patching DSH
Core.* This document is the evidence that each seam holds, and it names the one
seam that required a change of mechanism.

Two rules were applied throughout:

- **The installed distribution is the first authority.** Third-party projects
  were only to be consulted for interaction patterns; none was consulted,
  because every question was answerable from the shipped code. See §10.
- **A probe that has not failed on a known-bad input has not been shown to
  work.** Each seam's probe has a negative control, listed with it.

## 1. Seam summary

| # | Seam | Verdict | Mechanism used |
|---|---|---|---|
| 1 | External Host plugin mounts | ✅ | one loader row, `cordis.patch.yml` |
| 2 | `client.js` id == loader row `name` | ✅ | package name in all three places |
| 3 | Settings namespace registration | ✅ | `ctx.settings.register('workspace-profile', …)` |
| 4 | Revision-aware write + conflict | ✅ | `settings.mutate(ns, ops, expectedRevision)` |
| 5 | Workspace baseline and increments | ⚠️ **baseline only** | `workspaceRegistry.list()`; no change event exists |
| 6 | `WorkspaceId` from cwd | ✅ | `registry.resolveByPath` + a synchronous index |
| 7 | Dynamic system-prompt section | ✅ | `systemPrompt.section({ text: (ctx) => … })` |
| 8 | Skill policy / invalidation | ✅ **changed mechanism** | per-Agent scope shadow, not a filter hook |
| 9 | `spawn` provider present | ✅ | `ctx.subagents.getProvider('spawn')` |
| 10 | Foreground child start/result/dispose | ✅ | `ctx.subagents.start('spawn', …)` |
| 11 | Model route preflight | ✅ **with one added gate** | `llm.resolveCallConfig` + our `listModels` membership gate |
| 12 | `/agent` command registration | ✅ | `ctx.commands.register({ … })` |
| 13 | Browser Settings section | ✅ | `settings.section` slot + `remote.$mount` |

Legend: ✅ holds as assumed · ⚠️ holds with a documented limit · **changed
mechanism** means the plan's assumed API does not exist and the design moved.

## 2. Host plugin mounting

`cordis.patch.yml` declares exactly one row:

```yaml
- insert:
    - id: workspace-profile
      name: dsh-workspace-profile
```

**One row, not two.** `dsh-client-modules` discovers a package's browser bundle
by keying each *active* Loader entry by `baseUrl + loaderName`; a package reached
by two active rows is rejected with `resolves from multiple active Loader sources`
and the rejection is a `logger.warn` — the package simply gets no bundle, and the
only symptom is a section that never appears.

**Verified.** `dsh web --dump-config` prints the row (`# == dsh-workspace-profile`).
On a full in-process boot of the real `web` composition,
`scripts/boot-probe.mjs` reports `rowFiberState: 2` (active),
`servicePresent: true`, `toolRegistered: true`, `commandRegistered: true`, and
`workspace-profile` among the registered settings namespaces.

## 3. `client.js` registration identity

Three names must agree or the failure is misleading:

| Place | Value |
|---|---|
| `package.json` `name` | `dsh-workspace-profile` |
| loader row `name` | `dsh-workspace-profile` |
| `window.__ModuleLoader__.load({ id })` | `dsh-workspace-profile` |

A mismatch reports `bundle <url> loaded without registering "<id>"` with no hint
about which of the three is wrong. `test/manifest.test.js` asserts all three from
separate files.

`exports["./client"]` is mandatory; without it the package mounts and has no
browser half at all.

## 4. Settings namespace

`ctx.settings.register(ns, schema, options)` — `ns` must match
`/^[a-z][a-z0-9-]*$/` or it throws, and a throw inside a `ctx.inject` callback is
**contained by Cordis**: the plugin still activates and the namespace is simply
never registered. `workspace-profile` is a legal namespace, and
`test/integration-plugin.test.js` asserts it appears in `describe()`.

### The stored schema is deliberately permissive

`register` validates the *stored* section and **rejects the registration itself**
when it fails. A strict schema therefore has a failure mode worse than the
corruption it guards: a user hand-edits `settings.yaml`, registration throws, the
namespace never exists, and the Settings page that would have let them fix it has
nothing to write to. Every leaf in `CompositionDocumentSchema` is
`Schema.any()`; validation lives in `src/policy.js`, runs on every read, and
**repairs toward safety** rather than throwing. Unknown fields survive.

A declared `schemaVersion` that is not this build's is refused with
`UnsupportedSchemaVersionError` and never written. An *absent* version is read as
version 1 and **not** rewritten — guessing that a hand-written section needs
rewriting would be a write nobody asked for. Recorded in
`test/policy.test.js` with a synthetic migration table, because the runner must
be exercised before the first real migration exists.

## 5. Revision-aware writes

`SettingsScope` (the owner handle from `register`) has `get/watch/update/replace`
and **no revision argument**. Revision fencing lives on the provider:
`settings.mutate(ns, ops, expectedRevision)`.

Path-addressed ops, not wholesale replacement: `mutate` applies each op to the
section **as it stands when the write reaches the front of the queue**, so a
caller never restates a field it did not touch and cannot delete one it never
saw. On a stale revision the provider throws `SettingsConflictError`
(`code: 'SETTINGS_CONFLICT'`).

`src/settings.js` refuses a write with **no** `expectedRevision` outright
(`TypeError`). An unconditional write is exactly the silent overwrite the plan
forbids, and it looks identical to a correct write until two windows are open —
so `test/settings-store.test.js` asserts the refusal directly.

The wire error code is a closed set (`gateway/*`) this plugin cannot extend, so
a conflict cannot ride as a code. Write operations therefore answer
`{ saved: false, code, message, revision }` — deliberately **not** `ok`, because
the client API already wraps each call in `{ ok, value }` and a nested `ok`
inside `value` reads as though the call itself failed.

## 6. Workspace resolution — the one seam with a real limit

`ctx.workspaceRegistry` is a plain `Service` (not a Typert remote) with:

- `list(): Workspace[]` — **synchronous**, no persistence reads;
- `resolveByPath(path): Promise<Workspace|undefined>` — runs `fs.realpath`; a
  **missing path rejects** rather than returning `undefined`;
- `get(id)`, `create(path, title?)`, `delete(id)`, `insertBefore(...)`.

`WorkspaceId` is a branded uuid, never a path. `Workspace.path` is
`fs.realpath`-canonical; uniqueness is string equality of canonical paths.

**Prefix matching was rejected.** "The workspace whose path prefixes the session
cwd" maps `/work/matter` and `/work/matter-old` to one Workspace and disagrees
with the registry's own canon for a symlinked or trailing-slash spelling. Identity
therefore comes from the registry, via a **synchronous index** built from
`list()` (already canonical) with `resolveByPath` as the authoritative backstop.

**The limit.** `dsh-workspace` declares **no Cordis events** — there is no
change notification for a created, renamed, or deleted Workspace. The plugin
therefore observes:

- a **baseline** at activation, from `list()`;
- **increments** on `agent/created`, `agent/pre-step` and every Remote read;
- the Settings page re-reads on open and after every write.

For v0.1 this is sufficient: the page always reads live. It is **not** sufficient
for v0.2's post-create wizard, which needs a durable `pending` marker and a
watcher; that work must add polling or a session-derived trigger, and is recorded
here as a known prerequisite rather than discovered later.

`test/workspace`-level assertions live in `test/integration-plugin.test.js`,
including the negative control that a session whose cwd matches no Workspace gets
**no** section even when other Workspaces are configured.

## 7. Dynamic system-prompt sections

```ts
section(section: { name, order, text: string | ((context: AssembleContext) => string), complete? }): () => void
```

Registration lands in the **calling context's scope**; an unscoped context
registers globally. `AssembleContext` is merge-extended by `dsh-agent` with
`agent?: Agent`, and the agent loop builds it as
`{ agent, scope: agent, signal? }` (`assembleContextFor`). So one global section
whose `text` is a function of `context.agent` is enough, and it is re-evaluated at
every assembly — which is what makes *"a configuration change takes effect from
the next Agent step"* true by construction rather than by invalidation.

**Measured order anchors** (`SECTION_ORDERS`, from the distribution — the plan
required these be measured rather than assumed):

| Name | Order |
|---|---|
| `DEPLOYMENT_PERSONA_PREFIX` | 0 |
| `PLAN_POLICY` | 500 |
| `TEAM_POLICY` | 600 |
| `TOOL_BASH` … `TOOL_SUBAGENT` | 1000 … 2800 |
| `DELIVERABLE_FILE_REFERENCES` | 9000 |
| `DEPLOYMENT_PERSONA_SUFFIX` | 10200 |

This plugin uses **400** for the Workspace context (after the persona identity,
before plan/team/tool guidance) and **2800** for the expert directory (beside
`TOOL_SUBAGENT`, which is where delegation is decided). Neither claims a reserved
name; `getSectionOrder(name)` exists so a plugin does not have to invent a
colliding one.

### `text` is synchronous — and that is load-bearing

`text` may not return a promise, so the policy lookup inside it may not await
anything. That is why the Workspace resolver keeps a synchronous index, and why
`agent/pre-step` (a **waterfall**, awaited before each step) calls the async
resolution *before* the step can assemble. Without that, the first step of a new
Agent could race the lookup.

### Template safety — a defect this seam caused, and the fix

Section text is interpolated with **strict** `{{variable}}` references: an
unknown reference **throws** and aborts assembly for the whole session. Subagent
names, descriptions, the Workspace title and Subagent instructions are all
user-authored, so a stray `{{…}}` in any of them would take down the *parent's*
next step — a failure a long way from its cause.

`test/compilers.test.js` caught this by rendering the composed sections through
the real `renderPrompt`. `sanitizeTemplateText` now neutralizes `{{` and `}}` in
every user-authored fragment before it enters a section, and the test asserts the
real renderer accepts the hostile input **and** that no live reference survives.

## 8. Skill policy — the mechanism that changed

The plan assumed "disable via the Skill registry's shadowing/policy mechanism".
There is no filter hook: `SkillRegistry` exposes `registerProvider`, `register`,
`list`, `snapshot`, `get`, and the only event is `skills/change` (unfiltered, no
waterfall). Providers can only *add*.

What does exist is **layering**:

- a registration files into the layer of its **calling context's scope**
  (`scopeOf(this.ctx)`, where the Cordis service tracker rebinds `this.ctx` to
  the caller — verified in `cordis/lib/index.js`'s `createTraceable`);
- a read merges the global layer with the viewing scope's chain, **farthest
  ancestor first, so the nearest layer wins a duplicate name outright**
  (`ScopedLayers.merge` / `SkillRegistry.collectFresh`);
- the viewing scope for a Skill read is the **Agent object itself**, because
  `dsh-agent-loop` mints each Agent as `createScope(loopCtx, agent)` and
  `dsh-tool-skill` passes `scope: agent`.

So a Workspace "disable" is: mint a scope keyed by that Agent, and register a
same-named runtime Skill there whose invocation policy refuses both the model and
the user. The shadow wins the name; `isModelInvocable` drops it from the
model-facing catalog and the `skill` tool refuses to load it.

Three properties fall out rather than needing to be arranged:

- **Workspace isolation** — the shadow lives in one Agent's layer.
- **Parent/child consistency** — a `spawn` child is its own Agent with its own
  scope, so the same code path applies the same rule.
- **Invalidation** — `ScopedLayers` calls the registry's change callback on every
  layer effect, so registering or disposing a shadow invalidates the catalog
  cache. There is no manual invalidation to forget.

**Verified** by `test/skill-policy.test.js` against the **real** `SkillRegistry`:
after applying, the scope sees source `workspace-profile` with
`modelInvocable: false`; a different scope still sees the original `user-dsh`
entry; and after `releaseFor` the original entry is restored exactly. Negative
control: an Agent with no Workspace is released rather than left half-configured,
and a missing `skills` service warns instead of throwing.

`scope.dispose()` settles **asynchronously**, so `releaseFor` is awaited — a
re-apply that did not wait would race its own teardown and leave the previous
policy in force. This was found by the restore assertion in that test.

### Which layers the Settings catalog reads

In a Web deployment the base `skill-filesystem` row is **disabled** and each
agent preset mounts its own. An unscoped read therefore returns only the
deployment's contributions, and the page would report every project- and
user-root Skill as "not installed" while the agent sees them all.

The catalog therefore reads the global layer **plus each live Agent's preset
layer**, taken from `scopeParentOf(agent)` — the preset layer and not the Agent's
own, because the Agent's layer is where the shadows live and a shadow wins the
name (reading there would make a *disabled* Skill vanish from the very list that
should show it as disabled). With no live Agent in the Workspace the Host reports
`scoped: false` and a sentence saying so, rather than letting "recommended but not
installed" read as a fact.

## 9. Subagents

### `spawn` capabilities (measured)

```
agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true
inheritsParentContext: false
```

`inheritsParentContext: false` is the whole reason the dispatch-prompt compiler
exists: the child sees **zero** parent context, so an assignment that only makes
sense with the conversation in view produces a confident answer to the wrong
question.

### The lifecycle, and why disposal is asserted everywhere

`ctx.subagents.start(name, request)` resolves **after publication**; ownership
transfers at fulfillment. `run.result` does **not** reject on a child failure — a
model or transport failure resolves with `stopReason: 'error'` — but it *does*
reject on an infrastructure fault the seam cannot express as a stop reason.
`run.dispose()` is idempotent.

`test/dispatcher.test.js` asserts, for **every** terminal path including the two
where something else already failed:

- a completed run is still disposed;
- each non-`completed` stop reason (`aborted`, `error`, `max-tokens`, `refusal`,
  and an unknown variant) becomes a named failure that **carries the partial
  output**;
- an infrastructure rejection is reported *and* still disposed, with the disposal
  failure preserved alongside rather than replacing it;
- a disposal failure does not swallow a successful result;
- a start rejection has no run to dispose and is rethrown unchanged;
- an absent caller signal is `absent`, not `undefined`-valued.

`maxDepth` is a fixed 3 (the cap is on the *child's* depth, so a top-level
session's children sit at depth 1).

### Persona

`request.persona` shadows `deployment:persona-prefix` for that child alone, with
the same strict `{{…}}` interpolation — which is why the persona text goes through
the same sanitizer as everything else. See §7.

## 10. Model routes — the silent-acceptance trap

`ctx.llm` is the catalog service. There is no `ctx.models`.

```
ctx.llm.listProviders(): LlmProviderInfo[]                     // { id, name }
await ctx.llm.listModels(provider): LlmModelInfo[]              // { provider, id, name, … }
await ctx.llm.resolveModelInfo(provider, model, signal?)        // + context.contextWindow, reasoning.efforts[]
await ctx.llm.resolveCallConfig(config, signal?)                // THE preflight
```

`ReasoningEffortId` is a branded **free string** with no validation, so the only
legitimate source of valid values is
`resolveModelInfo(...).reasoning.efforts[].id`, and the picker must never
hardcode a set.

**The trap.** `resolveCallConfig` is the seam's own preflight, but it does not
reject an unknown model for every adapter: the DeepSeek adapter *synthesizes*
model metadata for any id it is handed, so a typo resolves cleanly and only fails
at the provider's HTTP boundary. "Never silently fall back" therefore cannot be
delegated to the seam.

This plugin adds **one** membership gate of its own, applied **only when the
adapter actually advertises a non-empty catalog** — because an adapter that
advertises nothing is not evidence that a model is wrong, and turning its silence
into a rejection would break working routes. `resolveCallConfig` remains the
final authority. `test/model-catalog.test.js` covers, with negative controls:
unknown provider (naming the registered ones), a typo against a non-empty catalog
(with a did-you-mean suggestion), an **empty** catalog *not* producing a
rejection, an unsupported effort (naming the declared ones), a runtime refusal,
the non-throwing `routeStatus`, a missing `llm` service, and one failing adapter
not emptying the picker for the others.

That test found a real bug: the suggestion list was built by passing the catalog
*array* to a helper that reads `.catalog` off its argument, so the list was always
empty and the hint never appeared.

## 11. Commands

`ctx.commands.register({ name, description, input?, recordInput?, handler })`.
`name` must match `/^[a-z][a-z0-9_-]*$/`. `input` is **only**
`{ hint, attachments? }` — there is no argument-spec or completion type anywhere,
so every command parses its own `rawInput`. There is no `defineCommand` helper.

The handler receives one object: `{ commandId, agent, rawInput, attachments,
signal }`. The current session is **not** a field — it is `invocation.agent.session`.

`CommandResult` is `{ kind: 'success', text?, sourceEventSeq? } | { kind: 'error',
text }`, returned as a durable flow node. A host handler cannot return UI.

**Browser push is closed.** The Host→browser forwarded-event allowlist is a frozen
19-entry constant in the shipped distribution, and `registerRemoteEvents` throws
if called twice. An external plugin **cannot** push its own custom event. This
plugin needs none: the Settings page is pull-based and re-reads after each write.

## 12. The browser surface — and the defect this seam caused

`settings.section` is a `list` slot at `scope: 'root'`. The shell passes exactly
one prop, `{ close }`; the registration's `inject` factory return value is merged
on top. `id` is the nav key **and** the `only` filter, `order` the nav position,
`label` the text, and the third argument of `register` is a React **component**.

Shipped orders: `general` 0, `models` 10, `plugins` 15, `agent-presets` 20,
`kdocs` 35. This plugin uses **20** — see §12.2 for the tie.

### 12.1 A Remote namespace does not exist until the client mounts it

`dsh-api-remotes`' client half mounts a **hard-coded list of 15 generated
contributions**. It discovers nothing. A third-party namespace exists in the
browser only because the plugin's own bundle calls
`ctx.remote.$mount(TYPERT_REMOTE)`.

This was found the hard way. The Host half was correct — `ctx.typert.listPackages()`
listed `dsh-workspace-profile`, `gateway.claimsEndpoint('workspaceProfile/snapshot')`
returned `true`, and the service answered in 2 ms — and the Settings section still
never appeared, because `ctx.inject(['remote.workspaceProfile'], …)` was waiting
for a namespace nobody mounted. **A pending `ctx.inject` reports nothing at all**;
it is not an error, not a warning, and not a log line.

`test/client-bundle.test.js` now loads the real bundle in a `vm` sandbox with a
stand-in `window.__ModuleLoader__`, calls the factory, and asserts that `apply`
mounts exactly one contribution whose methods match the Host manifest.

### 12.2 A Remote call passes business arguments only

A Remote method takes its **business** arguments, positionally, and nothing else;
the carrier appends the cancellation signal. A method declaring zero business
parameters therefore takes **no** argument — `snapshot()`, never
`snapshot(undefined)`. Both working third-party plugins on this machine call a
zero-argument method as `remote.status()` / `remote.authorization()`.

A trailing `undefined` builds the call with one argument too many and the
endpoint then never answers: `POST /api/workspaceProfile/snapshot` stayed at
`status: None, completed: False` forever, the panel sat on 正在读取配置, and the
browser's per-origin connection pool filled with stuck requests until even
official endpoints queued behind them. `test/client-bundle.test.js` now asserts no
Remote call passes `undefined`.

### 12.3 The client descriptor table is a copy, and is checked

The bundle cannot `import` (classic script, no bundler), so it carries its own
descriptor table. `test/client-bundle.test.js` loads the bundle and compares that
table against the Host manifest; that assertion is the only reason the duplication
is acceptable. `test/remote-contract.test.js` separately asserts the Host manifest
against `typert.remote-client.js`, and that each `remoteX` implementation exists
with an **arity matching its descriptor** — the Gateway checks parameter counts
and reads the method source, so a destructured or defaulted parameter is rejected
outright.

### 12.4 No schema-driven form exists to reuse

Three negative checks (no `settingsForm`/`SchemaForm` id in any client bundle, not
in the platform seed, not in the 55 graph rows). Every shipped settings page
hand-renders from `ctx.settingsScope` + `ctx.settingsSchema`. This plugin builds
its own controls and reads `value`, never the serialized schema — which also
sidesteps `schema.toJSON()` returning a `{uid, refs}` table with numeric ids and
no field names.

### 12.5 Slots swallow render exceptions

Every slot body is wrapped in an error boundary. Without one, any mistake is a
blank panel and nothing else. **This paid for itself immediately**: the boundary
rendered `TypeError: Cannot read properties of undefined (reading 'bind')` when
the section body destructured `locale` while the `inject` factory never supplied
it. That is now asserted: every prop the body reads must come from the factory.

## 13. Reference projects

The plan named three projects as interaction references and required their owner,
commit, licence, and compatibility result be fixed during Phase 0.

**None was consulted, and no line of any of them was copied.** Every question
Phase 0 asked was answerable from the installed distribution — which §4.1 of the
plan makes the first authority anyway — and the two working third-party plugins
already on this machine (`kdocs-settings`, `dsh-apple-calendar`) were used as
*behavioural* references for the client contract, because they are proven against
this exact DSH build.

| Project | Owner | Consulted | Licence obligation |
|---|---|---|---|
| `dsh-client-ui-settings-skills` | `dsh-mixxed` (plan) | no | none — nothing copied |
| `dsh-specify-subagent-suite` | `Cho-Geer` (plan) | no | none — nothing copied |
| [`dsh-settings-ui`](https://github.com/KaramachiA217/dsh-settings-ui) | `KaramachiA217` | no | none — nothing copied |

`dsh-settings-ui` is the only one whose repository URL resolves; it is recorded
here for traceability. Its `ctx.settingsUi` service was **not** added as a runtime
dependency: v0.1 uses the platform seed (`react`, `react/jsx-runtime`) and nothing
else, which is asserted by `test/manifest.test.js`.

`THIRD_PARTY_NOTICES.md` therefore records no copied code and no inherited
licence. If any of these projects is consulted in a later phase, its commit and
licence must be added there before the first line is copied.

## 14. Probes in this repository

| Probe | What it answers | Invocation |
|---|---|---|
| `scripts/boot-probe.mjs` | does the row activate in the real web composition, and what did it contribute | `DSH_HOME=<home> node scripts/boot-probe.mjs --home <home>` |
| `scripts/remote-probe.mjs` | does one Remote operation answer, and does the gateway claim its endpoint | `node scripts/remote-probe.mjs snapshot --home <home>` |
| `scripts/prompt-probe.mjs` | what exactly does an Agent in a configured Workspace receive | `node scripts/prompt-probe.mjs --home <home> --cwd <dir>` |
| `node --test "test/*.test.js"` | the unit, contract and integration suites | 92 tests |

`boot-probe.mjs` disables only the `dsh-pocket` row. Disabling `webserver` looks
tidier and is wrong: nine rows inject it or the services it gates, stay pending,
and the tree audit then reports *them* instead of the plugin under test. The probe
binds a real server on an OS-assigned port (`--port 0`) and reports from a fully
active tree, which is why it needs a throwaway `--home`.

## 15. Environment facts that shaped the work

- `dsh plugin --profile web add <path>` works and reconciles
  `dsh.profile.bundles` itself; it reported `Packages: -2` while removing
  nothing, and every previously linked plugin was confirmed still present
  afterwards.
- Any `dsh` subcommand rewrites `<profile>/cordis.yml` during profile boot, so it
  needs write access to `~/.dsh` even for `--dump-config`.
- The browser page keeps loaded client modules in memory across a Host restart.
  Verifying a client change requires a page reload, not just a Host restart.

## 16. Plugin-owned session state — `ctx.storageDomain`

Verified against `0.1.5-rc.1`. Use this when a plugin needs durable state that is
keyed by something *other* than a Workspace — a session, a run, a job.

- The service is `ctx.storageDomain`, provided by the `dsh-storage-domain` row,
  which the shipped `web` profile mounts. The medium is `dsh-storage-json`,
  rooted at `dshHomePath('storages')`.
- `open(spec)` is **async** and returns a domain with `.table(name)`. The spec is
  plain data: `{ name, version, tables, global?, layout?, compatibleVersions?,
  invalidRecords? }`. A table is `{ valueSchema }`, and `valueSchema` only has to
  expose `parse` — it is duck-typed, not required to be a real zod schema.
- **Reads are synchronous, from memory; writes are asynchronous and durable-first.**
  This is the property that makes the domain usable from a `systemPrompt` section's
  synchronous `text` function: `table.get(key)` and `table.entries()` do not await.
- `layout: 'per-record'` writes one document per key under
  `<domain>/<table>/<key>.json`, each shaped `{ version, record }`. This is what
  makes one session's record inspectable and deletable on its own.
- **The domain name regex is `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` — underscores,
  not hyphens.** This is a *different* rule from the Settings namespace
  (`/^[a-z][a-z0-9-]*$/`), which takes hyphens and rejects underscores. Copying one
  identifier's spelling into the other's slot fails.
- `close()` is idempotent and drains the write chain, so a queued write is not lost
  by unloading the plugin. Close the **domain**, not the table — the table's `host`
  field happens to be the domain, but relying on that is relying on an internal.
- Do not import `defineDomain` / `domainTable` at runtime if the plugin must load
  without that package linked. They are developer-facing assertions; `open()` reads
  the fields itself. Feed the hand-written spec through the real `defineDomain` in a
  test instead, so the shape is still checked by the owner of the contract.

## 17. `systemPrompt.section()` vs `systemPrompt.context()` — the same function, two channels

Both accept `text: string | ((context: AssembleContext) => string)` and evaluate it
identically (`typeof section.text === "function" ? section.text(context) : …`).
The difference is **where the text lands**, and it decides which one a standing
instruction should use:

| | `section()` | `context()` |
|---|---|---|
| Lands in | the system prompt, `\n\n`-joined in `order` | the runtime-context snapshot |
| Framing | none | prefixed `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` |
| Suppressible | no | **yes** |

`context()` is suppressed wholesale by `dsh-persona` when
`includeRuntimeContext: false` is configured, and any scoped plugin can call
`systemPrompt.suppressRuntimeContext()`. The runtime-context channel is also where
volatile per-turn state (cwd, date) lives.

A plugin injecting a *standing* rule — a stance, a domain framing, a precedence
statement — should therefore use `section()`: losing it silently because some other
row suppressed runtime context is a far worse failure than a system prompt that
changes when the rule changes. Use `context()` for state that genuinely supersedes
itself turn to turn.

Both `section()` and `context()` take an `order` that must be finite, and the two
order tables are **separate**: `getSectionOrder()` reads `SECTION_ORDERS`,
`getContextOrder()` reads `CONTEXT_ORDERS`. Neither contains a name for
workspace/profile/perspective, so a plugin supplies its own number.

`AssembleContext.agent` is set on every per-agent assembly, so a text function can
reach `context.agent.session.id` — which is how a per-session override is resolved
without any invalidation step.

## 18. Probes must set `DSH_HOME`, not just pass `--home`

The single most expensive mistake recorded in this repository. `loadProfile(bin,
name, anchor, home)` takes the harness home explicitly, but every composed row that
*persists* something resolves its root through `dshHomePath()` — which reads the
`DSH_HOME` environment variable and otherwise falls back to the real `~/.dsh`. It
never consults the `--home` argument.

So a probe that passes a throwaway `--home` while leaving `DSH_HOME` unset boots a
throwaway profile against the **real** harness home:

- the Workspace registry lists the user's own Workspaces, so seeded fixtures are
  invisible and every policy lookup misses — which presents as "the Workspace is
  unconfigured", i.e. as a plugin bug;
- session logs are written into the user's real `~/.dsh/sessions/`.

`scripts/isolated-home.mjs` is the fix: require an explicit `--home`, refuse it when
it canonicalises to the real `~/.dsh` (realpath, so a non-canonical spelling is
caught too), and set `DSH_HOME` before anything composes a root.

Related, and separate: on macOS `tmpdir()` is `/var/folders/…` while its real path
is `/private/var/folders/…`. The Workspace registry stores **canonical** paths and a
session's `header.cwd` is canonical, so a fixture seeded with the non-canonical
spelling is indexed under one string and looked up under another. Seed with the
realpath.

# Phase 0 recon — the human-command seam and the client Settings-section seam

Target: the **installed** DSH distribution `0.1.5-rc.1` at
`/Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/` (referred to below as `$DIST`).
Internal packages live at `$DIST/node_modules/@deepseek-ai/*`.

Method: **read-only static inspection** of `lib/types/*.d.ts` (authoritative contract),
`lib/*.js` (real behavior), `README.md`, `package.json`, plus the two proven-working
external plugins on this machine (`kdocs-settings`, `dsh-apple-calendar`, `dsh-office-preview`,
`dsh-markdown-editor`). Nothing was executed and nothing outside this notes file was
modified. Every claim below cites a file + line, or quotes a `.d.ts` line.

Legend: **[V]** = verified by reading shipped code/types. **[U]** = UNVERIFIED.

---

## Part A — the human command seam (`ctx.commands`)

### A0. Correction to the brief: `dsh-cmdline` is **not** the slash-command seam

`dsh-cmdline` is about **process argv**, not slash commands. Its own module doc says:

> `$DIST/node_modules/@deepseek-ai/dsh-cmdline/lib/types/index.d.ts:2-3`
> ```
>  * @deepseek-ai/dsh-cmdline — the command line a dsh launcher hands to the app
>  * it boots.
> ```

It provides `cmdlineArgs?: CmdlineArgs`, `appExit?`, `appReady?` on the Cordis `Context`
(`dsh-cmdline/lib/types/index.d.ts:41-51`) and `parseCmdline(ctx, program)` over `commander`.
It has **no** relation to `ctx.commands`. **[V]**

Also confirmed: the whole distribution contains **no** helper named `defineCommand`
(`grep -rn "defineCommand" $DIST/node_modules/@deepseek-ai --include=*.js --include=*.d.ts`
→ 0 hits). Registration is always the `ctx.commands.register(...)` method. **[V]**

### A1. Service name, registration method, and full parameter contract

Service name: **`commands`** (`Context.commands: CommandRuntime`).

> `$DIST/.../dsh-commands/lib/types/index.d.ts:14`
> ```ts
> export declare const name = "commands";
> ```
> `$DIST/.../dsh-commands/lib/types/index.d.ts:60-64`
> ```ts
> declare module '@deepseek-ai/cordis' {
>     interface Context {
>         commands: CommandRuntime;
>     }
> }
> ```

Registration is a **method on the service** — `ctx.commands.register(definition)` — not a
`defineCommand` helper. There is no `defineCommand` anywhere in the distribution. **[V]**

> `$DIST/.../dsh-commands/lib/types/index.d.ts:86-91`
> ```ts
>     /**
>      * Register a global or calling-agent-scoped command.
>      * @param definition - discovery metadata and direct UI handler.
>      * @returns the exact effect disposer that unregisters this definition.
>      */
>     register(definition: CommandDefinition): () => void;
> ```

Full definition shape:

> `$DIST/.../dsh-commands/lib/types/index.d.ts:36-52`
> ```ts
> /** Plugin-owned command registration. */
> export interface CommandDefinition {
>     /** Lowercase command name without the leading slash. */
>     readonly name: string;
>     /** Human-readable summary used in discovery UI. */
>     readonly description: string;
>     /** Optional free-form input hint advertised to capable clients. */
>     readonly input?: CommandInputDescriptor;
>     /**
>      * Whether `command/run` records `rawInput`. Defaults to true. A command
>      * whose domain event owns the payload sets this false to avoid duplicating
>      * that payload in the session log.
>      */
>     readonly recordInput?: boolean;
>     /** Execute against the receiving agent without sending the command to the model. */
>     readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
> }
> ```

Argument-spec / completion types — **there are none**.

> `$DIST/.../dsh-commands/lib/types/types.d.ts:19-31`
> ```ts
> /** Immutable metadata for a command's optional unstructured input. */
> export interface CommandInputDescriptor {
>     /** Placeholder shown before the user supplies free-form input. */
>     readonly hint: string;
>     /**
>      * Whether composer attachments may accompany an invocation. Absent or
>      * false = the executor rejects an invocation carrying attachments and capable
>      * composers refuse the submission before dispatch. A declaring command's
>      * handler receives the admitted durable blocks and owns every further
>      * grammar decision, including rejecting sub-commands that cannot use them.
>      */
>     readonly attachments?: boolean;
> }
> ```

> `$DIST/.../dsh-commands/README.md:139`
> ```
> - **Only unstructured text input** — forms, completion schemas, and typed arguments remain command-owned parsing concerns.
> ```

So an argument-spec/completion type **does not exist**; `input` is `{ hint, attachments? }` only. **[V]**

Validation performed at registration (runtime, authoritative for what will throw):

> `$DIST/.../dsh-commands/lib/index.js:71` — `const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;`
> `$DIST/.../dsh-commands/lib/index.js:142-152` — `normalizeDefinition()` throws
> `TypeError` for a bad name, a non-string/blank `description`, a non-function `handler`,
> a missing/non-string/blank `input.hint`, and a non-boolean `input.attachments`.

Name grammar at parse time is the same (with the leading slash):

> `$DIST/.../dsh-commands/lib/index.js:95-104`
> ```js
> function parseCommand(line) {
> 	const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line);
> ```

Duplicate name in one layer throws:

> `$DIST/.../dsh-commands/lib/index.js:75-83`
> ```
> this.commands = new NamedEntries((name) => new Error(scope === void 0
>   ? `command "${name}" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's \`agent.ctx\`)`
>   : `command "${name}" is already registered in this scope`));
> ```

### A2. How a handler obtains the invocation Agent and the current session

The handler is called with **one** argument, `CommandInvocation`:

> `$DIST/.../dsh-commands/lib/types/index.d.ts:17-35`
> ```ts
> /** Invocation passed to one registered command handler. */
> export interface CommandInvocation {
>     /** Pairing id already written to this invocation's `command/run` event. */
>     readonly commandId: CommandId;
>     /** Exact agent whose UI received the command. */
>     readonly agent: Agent;
>     /** Exact text following the registered command name, including separator whitespace. */
>     readonly rawInput: string;
>     readonly attachments: readonly (ImageBlock | FileBlock)[];
>     /** Cancellation signal owned by the dispatching UI request. */
>     readonly signal: AbortSignal;
> }
> ```

**Exact field names: `invocation.agent`, `invocation.rawInput`, `invocation.attachments`,
`invocation.signal`, `invocation.commandId`.** The README example destructures
`handler: ({ agent, rawInput }) => …` (`dsh-commands/README.md:39`, `:44`). **[V]**

The **current session is not a field on the invocation**. It is reached through the agent:

> `$DIST/.../dsh-agent/lib/types/runtime-types.d.ts:138-143`
> ```ts
> declare module './types.ts' {
>     interface Agent {
>         /** The provider route and model this agent's requests use. */
>         readonly options: AgentOptions;
>         /** The live session this agent drives; its log is the durable source of truth. */
>         readonly session: Session;
> ```

> `$DIST/.../dsh-session/lib/types/index.d.ts:120-121`
> ```ts
>     /** The session identity, derived from its durable header's single copy. */
>     get id(): SessionId;
> ```

So: **`invocation.agent.session` = the live `Session`; `invocation.agent.session.id` = `SessionId`;
`invocation.agent.id` is also a `SessionId`** (`dsh-agent/lib/types/types.d.ts:11-14` —
`export interface Agent { readonly id: SessionId; }`). **[V]**

Real consumers confirm both the injection style and the field names:

> `$DIST/.../dsh-command-goal/lib/index.js` — `const inject = ["commands", "goals"];` and
> `apply(ctx) { ctx.commands.register({ name: "goal", …, handler: (invocation) => executeGoalCommand(ctx, invocation) }) }`;
> the body reads `invocation.agent`, `invocation.rawInput`, `invocation.attachments` (e.g. `ctx.goals.get(invocation.agent)`).
> `$DIST/.../dsh-command-compact/lib/index.js` — `const inject = ["commands", "compaction"];`,
> `ctx.commands.register({ name: "compact", description: "Compact older conversation history", handler })`,
> handler reads `invocation.rawInput`, `invocation.signal`, `invocation.commandId`.
> `$DIST/.../dsh-plan-mode/lib/index.js:179-186` — `ctx.inject(["commands"], (commandCtx) => { commandCtx.commands.register({ … handler: ({ agent, rawInput, attachments }) => … }) })`.
> `$DIST/.../dsh-permission-presets/lib/index.js:156-165` — same shape, reads `agent.session`.

Two injection idioms exist and both are shipped: a **static** `inject: ["commands", …]` export
(`dsh-command-goal`, `dsh-command-compact`, `dsh-command-feedback`), and
`ctx.inject(["commands"], cb)` when `commands` is not a hard dependency
(`dsh-plan-mode`, `dsh-permission-presets`). **[V]**

### A3. Return values and how results render

The handler must return a `CommandResult` (sync or promised):

> `$DIST/.../dsh-commands/lib/types/types.d.ts:32-41`
> ```ts
> /** Expected command outcome rendered directly by the dispatching UI. */
> export type CommandResult = {
>     readonly kind: 'success';
>     readonly text?: string;
>     /** Earlier authoritative domain event that owns a richer presentation. */
>     readonly sourceEventSeq?: SessionSeq;
> } | {
>     readonly kind: 'error';
>     readonly text: string;
> };
> ```

Rendering: the result is **not** a model message and **not** free-form UI.

> `$DIST/.../dsh-commands/README.md:12`
> ```
> `dsh-commands` lets users run `/command [input]` actions in interactive Harness UIs without turning the command or its result into a model message.
> ```
> `$DIST/.../dsh-commands/lib/types/index.d.ts:111-122` (doc on `execute`) — the lifecycle is logged:
> `command/run` appended before the handler, `command/done` after settlement; a thrown or
> aborted handler settles as `kind: 'error'`.

Return-value validation is strict and happens at the registry boundary:

> `$DIST/.../dsh-commands/lib/index.js:175-198` — `normalizeResult()` throws
> `command "<n>" handler must return a CommandResult`; for `success`, `text` must be a string
> when supplied and `sourceEventSeq` a non-negative safe integer; for `error`, `text` must be
> a **non-empty** string; any other `kind` throws.

The UI contract (composer does not echo the text; the durable flow node renders it):

> `$DIST/.../dsh-client-ui-commands/lib/types/client/service.d.ts` (doc on `execute`)
> ```
>  * An unmatched line reports an error outcome (the composer's immediate admission
>  * feedback); an admitted command reports plain success regardless of its handler
>  * outcome, because the host executor durably logged the lifecycle
>  * (`command/run`/`command/done`) and the outcome renders as a persistent flow node —
>  * the composer never echoes it.
> ```

For a rich, client-computed presentation, `sourceEventSeq` is the only hook: it names an
earlier domain event the browser can render instead of the text
(`dsh-commands/lib/types/types.d.ts:36-37`, `:105-116`). **[V]** There is **no** API to return
a React element or arbitrary UI from a host command handler. **[U]** for any undocumented path.

### A4. Scoping — global vs agent-scoped

> `$DIST/.../dsh-commands/lib/types/index.d.ts:72-76`
> ```ts
> /**
>  * Human-command registry. Plain-context definitions are global; definitions
>  * registered through a command-injected child of an agent context shadow
>  * globals for that agent.
>  */
> export declare class CommandRuntime extends TypertRemoteService {
> ```

> `$DIST/.../dsh-commands/README.md:54`
> ```
> A plain registration is global. A command-producing plugin mounted beneath an agent's own context declares its `commands` injection and registers an exact agent-scoped command, which shadows the global definition of the same name for that agent only.
> ```

Mechanism (all verified):

1. `register()` attaches the insertion to the **calling context's** scope:
   `$DIST/.../dsh-commands/lib/index.js:257-260`
   ```js
   register(definition) {
       const registered = normalizeDefinition(definition);
       return this.layers.effect(this.ctx, (layer) => layer.commands.insert(registered.definition.name, registered), { label: "commands.register()" });
   }
   ```
   Note `this.ctx` — a Cordis service reads `ctx` as its **caller's** fiber, so the scope comes
   from the *registrant*, not from the service.
2. The layer is chosen by the context's scope key:
   `$DIST/.../dsh-scope/lib/index.js:189-216` — `const scope = scopeOf(ctx); … if (scope === void 0) layer = this.global; else { …this.scoped.get(scope)… }`.
3. `scopeOf` reads the context tag: `$DIST/.../dsh-scope/lib/index.js:312-314`
   ```js
   function scopeOf(ctx) {
       return ctx[kScope];
   }
   ```
4. The **Agent object is the scope key** of its own context:
   `$DIST/.../dsh-agent-loop/lib/index.js:761-762`
   ```js
   this.scope = createScope(loopCtx, this);
   this.ctx = this.scope.ctx;
   ```
   (`this` is the live Agent.) And `dsh-agent/lib/index.js:198` builds the routing carrier with
   `scopeTarget(agent, agent)`.
5. Resolution merges **globals first, then the scope chain farthest-ancestor-first, nearest last**:
   `$DIST/.../dsh-scope/lib/index.js:177-181`
   ```js
   merge(scope, pick) {
       const merged = new Map(pick(this.global).entries());
       for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value);
       return merged;
   }
   ```
   and `CommandRuntime.view(agent)` is `this.layers.merge(agent, (layer) => layer.commands)`
   (`dsh-commands/lib/index.js:414-416`), used by both `list(agent)` and `find(agent, name)`.

**Answer:**

* A **plain (unscoped) registration from a root-plane context is global and visible to every
  session** — `merge()` seeds the map from `this.global` for every viewing scope. This is exactly
  what `dsh-command-goal` / `dsh-command-compact` / `dsh-command-feedback` do. **[V]**
* A **scoped registration is possible**, and the nearest scope wins. Two concrete scopes matter:
  * an **agent-exact** scope: mount a command-producing row under `agent.ctx`; it shadows the
    global of the same name for that agent only (README:54, plus the duplicate-name error text at
    `dsh-commands/lib/index.js:80-81`). **[V]**
  * a **preset standing scope** (an *ancestor*): an agent preset row registering a command lands
    in the preset's standing scope layer, which is an ancestor of each joined agent's key, so it
    is visible to every session naming that preset (and beats a global, but loses to an
    agent-exact registration). Evidence: `$DIST/.../dsh-agent-presets/lib/index.js:1085-1097`
    ("mounted ONCE per preset under a standing scope and joined by every agent that names it …
    An agent joins by having its scope key parented to the mount's (`bindScopeParent`), which
    makes the mount's registrations visible to that agent's views") and the actual bind at
    `dsh-agent-presets/lib/index.js:1504`, `:1538`, `:1702`
    (`this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))`);
    preset scope minted at `dsh-agent-presets/lib/index.js:1779` (`createScope(this.selfCtx, key)`). **[V]**
* No shipped preset registers a command today: `grep -rn "command" $DIST/.../dsh-agent-presets/presets/*/agent.cordis.yml` → **0 hits**. **[V]**

Discovery is per-agent: `list(agent): readonly CommandDescriptor[]` and
`find(agent, name): CommandDefinition | undefined`
(`dsh-commands/lib/types/index.d.ts:98-110`); the descriptor is handler-free:

> `$DIST/.../dsh-commands/lib/types/types.d.ts:54-62`
> ```ts
> /** Handler-free immutable command view returned to UI adapters. */
> export interface CommandDescriptor {
>     readonly name: string;
>     readonly description: string;
>     readonly input?: CommandInputDescriptor;
> }
> ```

### A5. Dynamic registration after startup, and push vs poll on the client

**Yes, commands can be registered at any time**; `register()` returns the disposer and is
effect-owned, and the registry announces both registration and removal. **[V]**

* Notification is emitted at insert **and** at dispose:
  `$DIST/.../dsh-scope/lib/index.js:216` — `if (notify) this.onChange();` (after the action, i.e.
  on registration) and `:214` — `if (notify) this.onChange();` inside the disposer.
  `notify` defaults to `true`: `:191` — `const notify = options.notify ?? true;`.
  `CommandRuntime` wires `onChange` to `notifyChange`:
  `$DIST/.../dsh-commands/lib/index.js:240-241`
  ```js
  layers = (…, new ScopedLayers((scope) => new CommandLayer(scope), () => {
      this.notifyChange();
  }));
  ```
* The event is part of the public contract:

  > `$DIST/.../dsh-commands/lib/types/types.d.ts:76-85`
  > ```ts
  > declare module '@deepseek-ai/cordis' {
  >     interface Events {
  >         /**
  >          * A command was registered or unregistered. This is an unfiltered registry
  >          * notification because a global or scoped change may affect any UI view.
  >          * Observer failures are contained and cannot veto the registry mutation.
  >          * @mode emit
  >          */
  >         'commands/change'(): void;
  >     }
  > }
  > ```

**The client discovers them automatically, by push-then-pull** (not polling). **[V]**

* `commands/change` is on the Host→browser forward allowlist:
  `$DIST/.../dsh-api-remotes/lib/index.js:46-49`
  ```js
  {
      event: "commands/change",
      mode: "emit"
  },
  ```
  The allowlist is described as *"The one home of this application's forwarded-Host-event
  allowlist"* (`dsh-api-remotes/lib/index.js:7-9`) and is installed once:
  `dsh-api-remotes/lib/index.js:101-103` — `ctx.effect(() => ctx.typertGateway.registerRemoteEvents(remoteEventSource(ctx), …))`.
* The browser subscribes and re-pulls the directory:
  `$DIST/.../dsh-client-ui-commands/lib/client.js:537-539`
  ```js
  ctx.remote.$on("commands/change", () => {
      this.directory.invalidateAll();
  });
  ```
  `invalidateAll()` → `refresh(sessionId)` → `fetchCommands` → `ctx.remote.commands.list(sessionId)`
  (`dsh-client-ui-commands/lib/client.js:48-51`, `:90-95`, `:518-523`). The comment on
  `invalidateAll` is explicit: *"Soft invalidation (commands-changed): background repull on every
  touched key; ready snapshots keep serving."* (`:47`)
* Two further invalidation paths: `agent-preset/selected` → `directory.resetSession(sessionId)`
  (`:540-542`) and `connection/reset` → `directory.resetConnected()` (`:543-545`).

**Hard constraint found while verifying this (important for a new external plugin):** the
forwarded-event allowlist is a **frozen const compiled into the shipped distribution** — 19
events, `dsh-api-remotes/lib/index.js:17-94` — and the gateway accepts **one** source only:
`$DIST/.../dsh-api-gateway/lib/index.js:485-487`
```js
registerRemoteEvents(source, host) {
    if (this.remoteEvents !== void 0) throw new Error("typert gateway: forwarded Remote event source is already registered");
```
So an external plugin **cannot** push a custom Cordis event of its own to the browser via
`ctx.remote.$on`; it must either use an allowlisted event, have the browser call a Remote method,
or have the browser poll. **[V]**

### A6. Client-side command contributions (separate seam, for completeness)

The browser has its own registry, `ctx.commandUi` (`CommandUiRuntime`), which can register
**client-only** contributions and decorations onto host commands:

> `$DIST/.../dsh-client-ui-commands/lib/types/client/service.d.ts`
> ```ts
>     register(contribution: CommandContribution): () => void;
>     decorate(decoration: CommandDecoration): () => void;
> ```
> `$DIST/.../dsh-client-ui-commands/lib/types/client/service.d.ts` (module doc)
> ```
>  * CommandUiRuntime (`ctx.commandUi`): the '/' command source over the
>  * session-keyed directory, the client-contribution registry, and the
>  * per-session popupSelect controllers. Candidate synthesis merges the host
>  * catalog with contributions by availability, then position filtering and
>  * the `/` menu's shared name ranking (ui-primitives `rankByName`); a
>  * host/contribution name collision fails loud.
> ```

This is the seam to use if a command needs a client popup/argument picker; a host command's
`handler` is still the only place the Agent is available. **[V]** for the API; **[U]** for how a
third-party plugin would render its own popup (no shipped third-party example was inspected).

---

## Part B — the client Settings section seam

### B1. The exact slot, and the props it passes

A third-party plugin registers a Settings **page** into the list slot **`settings.section`**.

> `$DIST/.../dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:56-71`
> ```ts
>         /**
>          * One settings page per list entry. Registrant options carry the nav
>          * identity: `id` (section key, drives `only` filtering), `order` (nav
>          * position), `label` (registrant-localized display text — the registrant
>          * re-registers with fresh text on locale change, so the shell never
>          * subscribes locale state; the ledger bump doubles as the shell's
>          * re-render trigger). Sections render inside the panel content column.
>          * (`settings.general.item`, declared by ui-settings-general's General
>          * entry, is typed in the locale package — the common dependency of every
>          * item registrant; the shell neither declares nor renders it.)
>          */
>         'settings.section': {
>             kind: 'list';
>             scope: 'root';
>             owner: SettingsSectionOwnerProps;
>         };
> ```

Props the slot passes — **exactly one field, `close`**:

> `$DIST/.../dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:141-151`
> ```ts
> /**
>  * Owner share of a settings section entry. The shell owns modal visibility
>  * and navigation; a section's data arrives through its own inject faces and
>  * stores. `close` is the one shell affordance a section receives, for flows
>  * that leave settings altogether (starting a session from a section) — the
>  * onboarding coordinator's `openSection`/`complete` precedent, inverted.
>  */
> export interface SettingsSectionOwnerProps {
>     /** Close the settings panel (the shell owns the open state). */
>     close: () => void;
> }
> ```

Confirmed at the render site:

> `$DIST/.../dsh-client-ui-settings-general/lib/client.js:165-168`
> ```js
> 						}), (0, react_jsx_runtime.jsx)("div", {
> 							className: SettingsRoot_module_css_default.options,
> 							children: active !== void 0 && renderSlot("settings.section", { close: onClose }, { only: active })
> 						})]
> ```

Additional props arrive from the registrant's **own** `inject` factory (not from the shell) —
see the working example in B3.

Register options actually used by shipped registrants (the `registerOptions` contract as the
runtime advertises it):

| option | required | type | source |
|---|---|---|---|
| `name` | yes | the slot name | every shipped `ctx.slots.register({ name: … })` |
| `id` | yes (list/keyed) | `string` | embedded slot directory, `dsh-cordis-client-runner/lib/client.js` (`settings.section` entry, `name: "id", requirement: "required"`) |
| `order` | optional | `number` | same (`name: "order", requirement: "optional", type: "number"`) |
| `label` | optional | `string \| (() => string)` | same (`a thunk is re-read on every projection`) |
| `locale` | optional (shipped) | namespace string | `dsh-client-ui-settings-general/lib/client.js:651-658` |
| `inject` | optional (shipped) | `() => object` merged into props | same, plus `dsh-client-ui-settings-plugins/lib/client.js:1761-1770` |
| `children` | optional (shipped) | child-slot declarations | `dsh-client-ui-settings-general/lib/client.js:601-630`, `dsh-client-ui-settings-plugins/lib/client.js:1768-1782` |

The embedded runtime slot directory is a **static snapshot** compiled into
`$DIST/.../dsh-cordis-client-runner/lib/client.js` (search for `key: "settings.section"`); it
also states `declaredBy: "an entry in 'sidebar.settings' (client-ui-settings-general), so it
exists while that entry is mounted"`. Treat it as strong secondary evidence — the primary
evidence is the `.d.ts` quoted above and the shipped registrations. **[V]**

### B2. How the official pages are structured: nav item ⇄ section are the same entry

* `sidebar.settings` (single, `scope: 'root'`) is the **shell/modal**, occupied by
  `ui-settings-general`'s `SettingsRoot`, which **declares** the six child slots
  (`settings.trigger`, `settings.header`, `settings.action`, `settings.close`,
  `settings.section`, `settings.onboarding`):
  `$DIST/.../dsh-client-ui-settings-general/lib/client.js:601-631`.
* Each `settings.section` **list entry is both one nav row and its page**. The shell builds the
  nav from the ledger:

  > `$DIST/.../dsh-client-ui-settings-general/lib/client.js:559-573`
  > ```js
  > 					sections: {
  > 						getSnapshot: () => {
  > 							const version = ctx.slots.getVersion("settings.section");
  > 							const revision = ctx.locale.getSnapshot().revision;
  > 							if (version !== rowsVersion || revision !== rowsRevision) {
  > 								rowsVersion = version;
  > 								rows = ctx.slots.entries("settings.section").map((e) => ({
  > 									id: e.options.id ?? "",
  > 									order: e.options.order ?? 0,
  > 									label: resolveSlotLabel(e.options.label) ?? ""
  > 								})).sort((a, b) => a.order - b.order);
  > 							}
  > 							return rows;
  > 						},
  ```

  and renders the active one with `{ only: active }` (`:167`). So **`id` is the nav key, `order`
  is the nav position, `label` is the nav text, and the component you pass is the page body.**
* Shipped sections and their nav order: `general` (`order: 0`,
  `dsh-client-ui-settings-general/lib/client.js:651-657`), `plugins` (`order: 15`,
  `dsh-client-ui-settings-plugins/lib/client.js:1761-1767`), models (`order: 10`,
  `dsh-client-ui-settings-models/lib/client.js:2936-2941`), plus the proven third-party `kdocs`
  (`order: 35`, `kdocs-settings/dist/client.js:424-430`).
* Sub-seats inside a page (all `scope: 'root'`, declared by the page owner, not by the shell):
  * `settings.general.item` — `kind: 'list'`; a preference row inside General.
    `slots.d.ts:100-118`; *"the owner passes no props at all — copy, current value, and the
    write path are all yours, through your own inject face and `host.call`"*; owner props are
    an intentionally empty marker (`slots.d.ts:121-125`).
  * `settings.plugins.tab` — `kind: 'list'`; one tab inside the Plugins page (`slots.d.ts:72-84`).
  * `settings.plugin.item` — `kind: 'keyed'`; one plugin card inside the Plugins *configurable*
    tab, registered with `key` (`dsh-client-ui-settings-plugins/lib/client.js:1773-1811`;
    embedded slot directory entry `key: "settings.plugin.item"`, `kind: "keyed"`,
    `keyDomain: "open: any string the owner dispatches (no compile-time key set)"`).
    **Not declared in the shipped `slots.d.ts`** — it is declared at runtime by
    `ui-settings-plugins`. **[V]**
  * `settings.models.provider-card` (`kind: 'keyed'`, keyed by `settingsNs`) and
    `settings.models.footer` (`kind: 'list'`) — declared by `ui-settings-models`:
    `$DIST/.../dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts:19-45`.
  * `settings.onboarding` — `kind: 'list'` (`slots.d.ts:85-99`).
* Trigger/header/action/close seats (`slots.d.ts:21-55`) are chrome; a third-party page does not
  need them.

### B3. The proven-working third-party registration (kdocs-settings)

`/Users/vanson/Documents/DSH/kdocs-settings/dist/client.js:420-441`:

```js
		function apply(ctx) {
			…
			ctx.inject(["remote.kdocs"], (scoped) => {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "kdocs",
					order: 35,
					label: DISPLAY_NAME,
					inject: () => ({ remote: scoped.remote.kdocs }),
				}, () => jsx(SectionBoundary, { children: jsx(KdocsSettingsSection, { remote: scoped.remote.kdocs }) })));
			});
		}

		exports.apply = apply;
		exports.inject = ["slots", "remote"];
```

Notes distilled from it (all **[V]** by reading the file):

* `ctx.slots.inject(slotName, registerThunk)` is the required idiom: the slot is declared by
  another plugin whose activation order is not constrained.
* The third argument to `ctx.slots.register` is a **React component function**, not an element.
  Shipped code passes an ordinary component (`GeneralSection`,
  `dsh-client-ui-settings-general/lib/client.js:661` — `}, GeneralSection));`); kdocs-settings passes a zero-prop
  component that closes over the namespace service instead of reading props. Both are the same
  thing to the renderer. Third-party proof of the component form:
  `dsh-office-preview/lib/client.js:12362-12370` — `ctx.slots.register({ name: "sidebar.right.tab.document", key: DOCX_ID, locale: "officePreview", inject: () => ({ moduleRequire, onRenderEvent }) }, guarded(DocxBody))`.
* The registrant's `inject` factory's **return value is merged into the component props**
  (here `{ remote }`), on top of the shell's `{ close }`.
* The module also registers itself as `window.__ModuleLoader__.load({ id: "kdocs-settings", factory })`
  with the **same id as the loader row `name`** (`kdocs-settings/dist/client.js:24-26`;
  `cordis.patch.yml` `- id: kdocs-settings / name: kdocs-settings`).
* Static `exports.inject = ["slots", "remote"]` names **Cordis services**, not module ids.
* Its `package.json` `dsh.client.inject` is `[]` — it requires no other plugin's module.

### B4. The namespace-driven settings form: `describe()` → schema → form

**Read path (host → browser).**

> `$DIST/.../dsh-api-settings-controller/lib/types/index.d.ts:54-59`
> ```ts
>     /**
>      * Describe every registered namespace for a configuration page: redacted
>      * layered values plus the serialized schema the page renders its form from.
>      * @returns provider writability, local-document presence, and one view per namespace.
>      * @throws RemoteError when no settings provider is mounted.
>      */
>     describe(): SettingsDescribeValue;
> ```

> `$DIST/.../dsh-settings/lib/types/types.d.ts:27-49`
> ```ts
> export interface SettingsNamespaceView {
>     /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
>     ns: string;
>     /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
>     schema: JsonValue;
>     /** Redacted resolved value (schema defaults → composition base → user layer). */
>     value: JsonValue;
>     /** Redacted composition base layer, when the registrant declared one. */
>     base?: JsonValue;
>     /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
>     user?: JsonValue;
>     /** When the owner applies changes. */
>     applies: 'live' | 'restart';
>     /** Every schema-declared secret slot with its configured state. */
>     secrets: SettingsSecretView[];
>     /**
>      * Monotonic revision of the raw user section this view was read at. Send it
>      * back as `expectedRevision` on a write so a stale editor is refused rather
>      * than silently overwriting a concurrent change.
>      */
>     revision: number;
> }
> ```

`SettingsDescribeValue` is `{ writable, hasDocument, namespaces: SettingsNamespaceView[] }`
(`dsh-settings/lib/types/types.d.ts:63-71`).

The browser's **one** reader of that call is the mirror in `ui-settings`:

> `$DIST/.../dsh-client-ui-settings/lib/client.js:1299`
> ```js
> 							const response = await this.ctx.remote.settings.describe();
> ```
> `$DIST/.../dsh-client-ui-settings/lib/client.js:1333`
> ```js
> 		const inject = ["remote", "remote.settings"];
> ```
> and the invalidation subscriptions it owns (`:1347-1356`):
> ```js
> 			ctx.effect(() => {
> 				const disposers = [ctx.remote.$on("settings/document-updated", () => {
> 					mirror.load();
> 				}), ctx.on("connection/reset", () => {
> 					mirror.load();
> 				})];
> 				mirror.ensure();
> ```

`settings/document-updated` is likewise a hard-coded allowlisted forwarded event
(`dsh-api-remotes/lib/index.js:86-89`). **[V]**

**Services a third-party client plugin consumes (both provided by `dsh-client-ui-settings`):**

* `ctx.settingsScope` (`SettingsScopeBinder`) — `dsh-client-ui-settings/lib/client.js:1143`
  (`super(ctx, "settingsScope")`); declared in `dsh-client-ui-settings/lib/types/client/settings-scope.d.ts:88-92`.
  * `bind<T>(spec: { namespace: string; decode?: (section: unknown) => T | undefined }): SettingsScope<T>`
    (`settings-scope.d.ts:129-139`) — the scope's disposer rides the **caller's** fiber.
  * `describe(): SettingsDescribeFace` (`:121-128`) — the shared mirror face:
    `getSnapshot() / subscribe() / ensure() / acceptView()`
    (`settings-mirror.d.ts:40-61`); the namespace rows are at
    `getSnapshot().view.namespaces` (`settings-mirror.d.ts:23-34`, `:110-114`).
  * `SettingsScope<T>` write face (`settings-contract.d.ts:50-85`):
    `set(field, value)`, `unset(field)`, `mutate(ops, expectedRevision?)`.
  * Snapshot shape (`settings-contract.d.ts:6-32`): `{ status, value, base, user, revision, writable, mode }`.
* `ctx.settingsSchema` (`SettingsSchemaService`) — `dsh-client-ui-settings/lib/client.js:831`
  (`super(ctx, "settingsSchema")`); contract in
  `dsh-client-ui-settings/lib/types/client/schema.d.ts:11-71`:
  `rehydrate(serialized)`, `validate(schema, draft)`, `nodeAtPath(root, path)`,
  `getPath(value, path)`, `hasPath`, `setPath`, `deletePath`.
  Its doc is explicit about why it is a service: *"Dynamic client plugins receive this Cordis
  entity instead of importing executable helpers from one another."* (`schema.d.ts:7-10`).

**Write path.** `mutate` is the wire method:

> `$DIST/.../dsh-api-settings-controller/lib/types/index.d.ts:93`
> ```ts
>     mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<SettingsNamespaceView>;
> ```
> call site: `$DIST/.../dsh-client-ui-settings/lib/client.js:1045`
> ```js
> 					const response = await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision);
> ```
> `SettingsPathOpView` = `{ op: 'set', path: string[], value: JsonValue } | { op: 'unset', path: string[] }`
> (`dsh-settings/lib/types/types.d.ts:55-62`).

**Host side of the same namespace** (a new plugin that owns a preference registers one):
`ctx.settings.register(ns, schema, options?)` — `dsh-settings/lib/types/index.d.ts:216`.
Reminder from this workspace's own hard-won notes: a namespace must match
`/^[a-z][a-z0-9-]*$/`, and `ctx.settings` must be reached through `ctx.inject(['settings'], …)`.
(**[U]** — I did not re-verify those two lines in this pass; they are recorded in
`/Users/vanson/Documents/DSH/AGENTS.md`.)

**Is there a reusable client module that renders a schema-driven form?**

**No.** **[V]** — three independent negative checks:

1. `grep -rn "settingsForm\|SchemaForm\|schemaForm\|settings-form" $DIST/.../*/lib/client.js`
   → **0 hits**.
2. There is no registered client module for one: the 9-entry platform seed (B5) and the 55
   `dsh.client` graph rows (B6) contain no form/schema-renderer module id.
3. The seed's UI primitives module `@deepseek-ai/dsh-client-ui-primitives` exports buttons,
   inputs, `Switch`, `Modal`, `Toast`, `MarkdownText`, `JsonBlock`, `JsonTree`, ~90 icons and
   helpers — **no schema-driven form component**
   (`$DIST/.../dsh-web-frontend/dist/assets/index-DuF6ti6g.js:109`, the frozen
   `Object.defineProperty({__proto__:null, …})` export table).

Each shipped settings page hand-renders its own form from `ctx.settingsScope` +
`ctx.settingsSchema` — e.g. models rehydrates and walks the schema itself:
`$DIST/.../dsh-client-ui-settings-models/lib/client.js:1466`
```js
			const root = (0, react.useMemo)(() => schema.rehydrate(namespace.schema), [namespace.schema, schema]);
```
and `$DIST/.../dsh-client-ui-settings-models/lib/client.js:2871-2879` declares
`inject = [… "settingsScope", "settingsSchema" …]`.

**Practical consequence for the new plugin:** a schema-driven form must be built from
`ctx.settingsScope.bind({ namespace })` + `ctx.settingsSchema.rehydrate(view.schema)` inside its
own bundle, or the page must be hand-rendered. There is no `require("<something>")` that renders
one. **[V]**

### B5. The platform seed (what `require()` resolves without any declaration)

The browser's frozen module table is created by the shell:

> `$DIST/.../dsh-web-frontend/dist/assets/index-DuF6ti6g.js:109`
> ```js
> function My(){return{react:t9,"react/jsx-runtime":o9,"react-dom":u9,"react-dom/client":h9,"@deepseek-ai/cordis":H8,"@deepseek-ai/dsh-client-store":H9,"@deepseek-ai/dsh-client-ui-slots":$9,"@deepseek-ai/dsh-client-ui-primitives":Wg,"@deepseek-ai/dsh-client-ui-dockkit":Ey}}
> ```
> consumed at the same line: `this.modules=r.create({boot:t.__DSH_BOOT__,staticModules:My(),…})`

That is **9 exact seed words**:

```
react
react/jsx-runtime
react-dom
react-dom/client
@deepseek-ai/cordis
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

They land in `this.seed = new Map(Object.entries(options.staticModules))`
(`$DIST/.../dsh-client-modules/lib/client.js:205`). **[V]**

Important: **`@deepseek-ai/dsh-client-ui-slots` is a seed word, not an installed package.** It
does not exist under `$DIST/node_modules/@deepseek-ai/` (55 `dsh.client` packages exist;
`dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`, `dsh-client-store`
are *not* among them). It is provided by the shell bundle. Consequence: **its `.d.ts` is not on
disk in this install**, so the type-level details of `ctx.slots.register` /
`SlotCore.register` are only available from the embedded slot directory and from shipped usage.
**[V]** for the observation, and consequently **[U]** for any `SlotCore` type detail not quoted
above.

### B6. The graph rows available to `require()` on this machine

Resolution order for `require(spec)` is **synchronous and strict**:

> `$DIST/.../dsh-client-modules/lib/client.js:300-306`
> ```js
> 			makeRequire(edges) {
> 				return (spec) => {
> 					edges.add(spec);
> 					if (this.seed.has(spec)) return this.seed.get(spec);
> 					const id = stripClientSuffix(spec);
> 					const record = this.loadCache.get(id);
> 					if (record !== void 0) return record.exports;
> 					if (this.factories.has(id)) return this.materialize(id).exports;
> 					throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory …`);
> ```

Arrival of a dependency before materialization is driven by `dsh.client.external` (and, for
ordering only, `dsh.client.inject`):

> `$DIST/.../dsh-client-modules/lib/client.js:259-268`
> ```js
> 				for (const request of row.external) {
> 					const id = stripClientSuffix(request);
> 					if (this.seed.has(request) || this.loadCache.has(id)) continue;
> 					const dependency = this.graphRows.get(id);
> 					if (dependency !== void 0) await this.arriveGraphRow(dependency, next, visited);
> 				}
> 				for (const packageName of row.inject) {
> 					const dependency = this.graphRows.get(packageName);
> 					if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited);
> 				}
> ```

**The complete set of installed `dsh.client` packages (55) — each is a legal `require()` graph
row once it is in the boot graph.** Extracted from `package.json` `dsh.client` +
`__ModuleLoader__.load({ id })`; ids and declarations match one-to-one (55 declared, 55
registered):

```
@deepseek-ai/dsh-api-gateway
@deepseek-ai/dsh-api-remotes
@deepseek-ai/dsh-api-session-controller
@deepseek-ai/dsh-api-workspace-controller
@deepseek-ai/dsh-api-workspace-files
@deepseek-ai/dsh-client-connection
@deepseek-ai/dsh-client-file-upload
@deepseek-ai/dsh-client-hmr
@deepseek-ai/dsh-client-locale
@deepseek-ai/dsh-client-modules
@deepseek-ai/dsh-client-resources
@deepseek-ai/dsh-client-ui-agent-preset
@deepseek-ai/dsh-client-ui-approval
@deepseek-ai/dsh-client-ui-attachment
@deepseek-ai/dsh-client-ui-brand-official
@deepseek-ai/dsh-client-ui-chat
@deepseek-ai/dsh-client-ui-commands
@deepseek-ai/dsh-client-ui-conversation
@deepseek-ai/dsh-client-ui-cordis
@deepseek-ai/dsh-client-ui-deliverables
@deepseek-ai/dsh-client-ui-directory-picker-browse
@deepseek-ai/dsh-client-ui-directory-picker-native
@deepseek-ai/dsh-client-ui-goal
@deepseek-ai/dsh-client-ui-input-trigger
@deepseek-ai/dsh-client-ui-jobs
@deepseek-ai/dsh-client-ui-layout
@deepseek-ai/dsh-client-ui-message-feedback
@deepseek-ai/dsh-client-ui-model-selection
@deepseek-ai/dsh-client-ui-open-in-app
@deepseek-ai/dsh-client-ui-permission-presets
@deepseek-ai/dsh-client-ui-plan
@deepseek-ai/dsh-client-ui-reference
@deepseek-ai/dsh-client-ui-renderer
@deepseek-ai/dsh-client-ui-schedule
@deepseek-ai/dsh-client-ui-session
@deepseek-ai/dsh-client-ui-settings
@deepseek-ai/dsh-client-ui-settings-general
@deepseek-ai/dsh-client-ui-settings-models
@deepseek-ai/dsh-client-ui-settings-plugin-inventory
@deepseek-ai/dsh-client-ui-settings-plugins
@deepseek-ai/dsh-client-ui-sidebar
@deepseek-ai/dsh-client-ui-sidebar-documentpreview
@deepseek-ai/dsh-client-ui-sidebar-files
@deepseek-ai/dsh-client-ui-sidebar-right
@deepseek-ai/dsh-client-ui-skill
@deepseek-ai/dsh-client-ui-subagent
@deepseek-ai/dsh-client-ui-theme
@deepseek-ai/dsh-client-ui-tool
@deepseek-ai/dsh-client-ui-trajectory
@deepseek-ai/dsh-client-ui-user-questions
@deepseek-ai/dsh-client-ui-workflow-run
@deepseek-ai/dsh-client-ui-workspace
@deepseek-ai/dsh-cordis-client-runner
@deepseek-ai/dsh-session-log-export
@deepseek-ai/dsh-typert-registry
```

**[V]** for the enumeration.

**But the shipped settings/UIs deliberately do not use each other's module ids.** Every
`require()` in the settings family is a seed word only:

```
dsh-client-ui-settings          → @deepseek-ai/cordis, @deepseek-ai/dsh-client-store
dsh-client-ui-settings-general  → @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-primitives,
                                  @deepseek-ai/dsh-client-ui-slots, react, react/jsx-runtime
dsh-client-ui-settings-plugins  → (same three + react, react/jsx-runtime)
dsh-client-ui-settings-models   → @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-primitives,
                                  react, react/jsx-runtime
```

Cross-plugin collaboration goes through **Cordis services** (`ctx.slots`, `ctx.locale`,
`ctx.settingsScope`, `ctx.settingsSchema`, `ctx.remote.*`), not through `require`. This matches
`schema.d.ts:7-10`. **[V]**

Which rows are actually *in the boot graph* depends on the active composition (the profile's
`dsh.profile.bundles` + each bundle's patch). I did **not** dump the live boot manifest, so the
authoritative live row list for this running instance is **[U]**; the profile that would produce
it is `~/.dsh/profiles/web/package.json` (read, unmodified) whose `dsh.profile.bundles` are:
`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `huayu-yuandian-legal-data`,
`kdocs-settings`, `skills-inventory`, `dsh-kdocs-inside`, `dsh-microsoft-todo`,
`dsh-office-preview`, `dsh-apple-calendar`, `dsh-markdown-editor`, `dsh-word-reference`,
`dsh-pocket`.

### B7. The exact `package.json` `dsh` field shape for a client-capable plugin

The manifest contract:

> `$DIST/.../dsh-package-manifest/lib/types/types.d.ts:6-23`
> ```ts
> /** The `dsh` property of an npm manifest; a package may declare several roles. */
> export interface DshManifest {
>     /** Bundle metadata consumed by the profile launcher. */
>     bundle?: DshBundleManifest;
>     /** Profile metadata consumed by the profile launcher. */
>     profile?: DshProfileManifest;
>     /** Client module loading and build metadata. */
>     client?: DshClientManifest;
> ```
> `:38-52`
> ```ts
> /** Client module declaration read by client-modules and the client build. */
> export interface DshClientManifest {
>     /** Client platform identifier; the Web consumer selects `web`. */
>     platform: string;
>     /** Informational package-name dependencies, not Cordis service injection. */
>     inject?: string[];
>     /** Boot phase-one registration barrier; absent means the shared application batch. */
>     immediately?: boolean;
>     /**
>      * Exact module-table requests beyond the implicit client baseline, including
>      * subpaths such as `<pkg>/client`; absent means baseline externals only.
>      * Type-only imports are erased and create no module request.
>      */
>     external?: string[];
> }
> /** The configuration layer exported by a bundle package. */
> export interface DshBundleManifest {
>     /** Patch file path relative to the declaring package root. */
>     patch: string;
> }
> ```

The `./client` export is **mandatory**:

> `$DIST/.../dsh-client-modules/lib/index.js:155-165`
> ```
> /** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
> …
> 	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
> ```
> `$DIST/.../dsh-client-modules/lib/index.js:655`
> ```
> 		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
> ```

**Actual, working examples on this machine:**

`kdocs-settings/package.json` (client-only plugin; note the explicit-but-empty `inject`):
```json
  "exports": {
    ".": { "import": "./dist/index.mjs" },
    "./client": { "default": "./dist/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  },
```

`dsh-apple-calendar/package.json`, `dsh-office-preview/package.json`,
`dsh-markdown-editor/package.json` (all three identical in this respect):
```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
```
with `"./client": { "default": "./client.js" }` (apple-calendar) or
`"./client": { "default": "./lib/client.js" }` (office-preview, markdown-editor) in `exports`.

`cordis.patch.yml` shape (all four, and the reason it is one row, not two):

```yaml
- insert:
    - id: kdocs-settings
      name: kdocs-settings
```

`dsh-apple-calendar/cordis.patch.yml` records the trap that makes one row mandatory:
> `# @deepseek-ai/dsh-client-modules discovers a package's browser bundle by walking the Loader's *active* entries and keying each source by baseUrl + loaderName. A package reached by more than one active entry is rejected — "resolves from multiple active Loader sources" — and the rejection is not fatal: it is reported through logger.warn, the package simply gets no browser bundle, and the only symptom is a panel that never appears.`

**[V]**

Two rules that follow, both **[V]**:
* the client bundle's `__ModuleLoader__.load({ id })` **must equal the loader row's `name`** —
  for kdocs-settings both are `kdocs-settings`.
* `dsh.client.inject` is **not** Cordis injection: it is a package-name arrival list
  (`types.d.ts:42-43`, consumed at `dsh-client-modules/lib/client.js:265-268`). Cordis services
  go in the bundle's `exports.inject` (kdocs-settings: `["slots", "remote"]`).

---

## Summary of what is NOT verified

* **[U]** Live boot graph / live slot ledger for the running instance. The
  `cordis_inspect_query slots.listSubTree` path was deliberately avoided (client-platform queries
  block until a page answers; this workspace's notes record a 26-minute hang on that call), and
  `dsh web --dump-config` was not run.
* **[U]** Type-level details of `@deepseek-ai/dsh-client-ui-slots` (`SlotCore.register` overloads,
  `SlotMap` internals) — the package and its `.d.ts` are **not present** in this install; only
  the seed object and the embedded slot directory exist.
* **[U]** Any API for returning rich UI (a component, a card) from a **host** command handler.
  `CommandResult` permits only `{kind, text?, sourceEventSeq?}`.
* **[U]** Whether a third-party client plugin can render its own `commandUi` popup — no
  third-party example was inspected.
* **[U]** `ctx.settings` namespace-name regex and the "must use `ctx.inject(['settings'], …)`"
  rule were **not re-derived** here; they come from `/Users/vanson/Documents/DSH/AGENTS.md`.
* **[U]** Whether `dsh.client.external` naming another shipped plugin's id actually resolves at
  runtime on this machine — verified from code (`dsh-client-modules/lib/client.js:259-264`,
  `:300-306`) but not exercised.
* Nothing was executed; no HTTP, CLI, browser, or Cordis runtime probe was performed.

# Phase 0 — Model catalog, route resolution/preflight, reasoning effort

READ-ONLY reconnaissance. Target: local DSH **0.1.5-rc.1** installed distribution at
`/Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/` (verified: `package.json` line 5 `"version": "0.1.5-rc.1"`).

Internal packages: `…/dsh/node_modules/@deepseek-ai/*`. Every citation below is
`<relpath from @deepseek-ai/>:<line>` or a verbatim quote.

Convention: `DIST := /Users/vanson/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`.

---

## 0. Executive answer (what a plugin must call)

| Question | Answer |
|---|---|
| Catalog service | **`ctx.llm`** — a single service. There is no `ctx.models` **on the Host**. |
| List providers | `ctx.llm.listProviders(): LlmProviderInfo[]` (**sync**) |
| List models | `await ctx.llm.listModels(provider): Promise<LlmModelInfo[]>` (**advisory**) |
| Exact model metadata (context window + efforts) | `await ctx.llm.resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` |
| **The preflight a plugin should use** | `await ctx.llm.resolveCallConfig({provider, model, reasoningEffort?}, signal?): Promise<LlmCallConfig>` |
| Unknown provider | throws `LlmError` code **`NO_ADAPTER`** |
| Unknown/unsupported effort | throws `LlmError` code **`UNSUPPORTED_REASONING_EFFORT`** |
| Unknown **model** | **provider-dependent**; DeepSeek adapter **does NOT throw** (see §4) — this is the silent-fallback trap |
| `ReasoningEffortId` | `string & { readonly [BRAND]: 'ReasoningEffortId' }` — **branded free string, no runtime validation**; valid values come per-model from `LlmResolvedModelInfo.reasoning.efforts[].id` |
| Dispatch-time re-confirmation | `ctx.llm.resolveCallConfig(...)` again, or the atomic `ctx.llm.prepareCall(...)`; `listProviders()` membership is the routability check |

---

## 1. The model-catalog service: exact name and shape

### 1.1 Service name

`ctx.llm`, typed by a `declare module '@deepseek-ai/cordis'` augmentation.

`dsh-llm/lib/types/index.d.ts:28-31`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        llm: LlmRuntime;
    }
```

`dsh-llm/lib/types/index.d.ts:231`:

```ts
export declare class LlmRuntime extends TypertRemoteService {
```

`dsh-llm/lib/types/index.d.ts:409`: `export default LlmRuntime;`

**There is no Host-side `ctx.models`.** The name `models` appears in this area only as a
local variable and in a stale doc comment; the actual client-side service is
`ctx.modelDirectories` (§7). **UNVERIFIED:** whether any third-party package registers a
`models` service on the Host — none was found in the distribution.

### 1.2 `listProviders()` — provider entries

`dsh-llm/lib/types/index.d.ts:263-267`:

```ts
    /**
     * Describe provider routes with a registered adapter.
     * @returns detached provider metadata in registration order.
     */
    listProviders(): LlmProviderInfo[];
```

`dsh-llm/lib/types/types.d.ts:179-185` — **full shape (2 fields only)**:

```ts
/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
    /** Provider route key used by {@link GenerateOptions.provider}. */
    id: string;
    /** Human-readable provider name for selectors and diagnostics. */
    name: string;
}
```

**No `settingsNs`, no `models`, no routable flag here.** For the *configurable* (possibly
dormant) directory use `listConfigurableProviders()` — `index.d.ts:277-281`:

```ts
    listConfigurableProviders(): LlmConfigurableProvider[];
```

`dsh-llm/lib/types/types.d.ts:199-222` `LlmConfigurableProvider`:
`provider: string`, `displayName: string`, `settingsNs: string`, `settingsPath: readonly string[]`,
`declared?: boolean`, `error?: string`.

### 1.3 `listModels()` — model entries

`dsh-llm/lib/types/index.d.ts:338-344`:

```ts
    /**
     * Discover models advertised by one registered provider. Catalog membership
     * is advisory and never changes routing or request validation.
     * @param provider - registered provider route to inspect.
     * @returns detached model metadata in adapter-preferred order.
     */
    listModels(provider: string): Promise<LlmModelInfo[]>;
```

`dsh-llm/lib/types/types.d.ts:276-288` — **full shape**:

```ts
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
export interface LlmModelInfo {
    /** Provider route that owns this model entry. */
    provider: string;
    /** Model id passed to {@link GenerateOptions.model}. */
    id: string;
    /** Human-readable model name for selectors. */
    name: string;
    /** Optional user-facing distinction from otherwise similar models. */
    description?: string;
    /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
    inputModalities?: readonly ModelModality[];
}
```

⚠️ **`LlmModelInfo` has NO context window and NO reasoning efforts.** Confirmed against the
runtime normalizer, which builds exactly these fields:
`dsh-llm/lib/types/index.js:568-576` (returns `provider`, `id`, `name`, optional
`description`, optional `inputModalities`). Actual implementation of the whole method,
`index.js:552-576`; validation failure throws `LlmError(..., 'INVALID_CATALOG')` at
`index.js:565`.

### 1.4 `resolveModelInfo()` — the real per-model metadata (context window + efforts)

`dsh-llm/lib/types/index.d.ts:345-354`:

```ts
    /**
     * Resolve and validate all metadata from the adapter that owns one exact
     * route. The result is detached from adapter-owned objects; catalog
     * membership remains advisory and does not control request routing.
     * @param provider - registered provider route to inspect.
     * @param model - exact model id passed to the adapter.
     * @param signal - optional cancellation for adapter-owned asynchronous lookup.
     * @returns exact model identity plus available context and reasoning metadata.
     */
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
```

`dsh-llm/lib/types/types.d.ts:320-330` — **full shape**:

```ts
/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
    /** Provider-owned context capacity when known. */
    context?: LlmModelContext;
    /** Adapter-configured per-request output cap materialized when callers omit one. */
    defaultMaxTokens?: number;
    /** Adapter-owned selectable reasoning levels when exposed. */
    reasoning?: LlmModelReasoningInfo;
    /** Declared mid-conversation system prompt handling; absent means only a leading system message is read. */
    systemPromptUpdate?: SystemPromptUpdate;
}
```

Context window — `dsh-llm/lib/types/types.d.ts:289-293`:

```ts
/** Provider-owned context capacity for one exact provider/model route. */
export interface LlmModelContext {
    /** Maximum combined request and response context in tokens. */
    contextWindow: number;
}
```

➡️ **Context-window path is `resolved.context.contextWindow`** (double-nested, and the outer
`context` is optional).

### 1.5 Reasoning efforts — exact field name and value type

`dsh-llm/lib/types/types.d.ts:294-312` — **verbatim, this is the whole declaration**:

```ts
/** Display metadata for one adapter-owned reasoning effort. */
export interface LlmReasoningEffortInfo {
    /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
    id: ReasoningEffortId;
    /** Human-readable effort name for selectors and diagnostics. */
    name: string;
    /** Optional user-facing distinction from otherwise similar efforts. */
    description?: string;
}
/** Selectable reasoning efforts for one exact provider/model route. */
export interface LlmModelReasoningInfo {
    /** Supported efforts in adapter-preferred display order. */
    efforts: readonly LlmReasoningEffortInfo[];
    /**
     * Adapter-configured default materialized into requests when callers omit
     * an effort. Absence preserves the provider's own default.
     */
    defaultEffort?: ReasoningEffortId;
}
```

➡️ **Exact field path: `LlmResolvedModelInfo.reasoning.efforts[].id` (type
`ReasoningEffortId`), with `LlmResolvedModelInfo.reasoning.defaultEffort?: ReasoningEffortId`.**
The outer `reasoning` is **optional** — absent means the adapter exposes no effort metadata
at all, in which case *any* explicit effort is rejected (§4.3).

Runtime validator for these, `dsh-llm/lib/types/index.js:636-665`. Notably
`index.js:636-638`:

```js
            if (reasoning.efforts.length === 0) {
                throw new LlmError(`adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`, 'INVALID_MODEL_REASONING');
            }
```

so an adapter may not advertise an empty effort list; and `index.js:656-658` rejects a
`defaultEffort` not present in `efforts` with the same `INVALID_MODEL_REASONING` code.

---

## 2. `ReasoningEffortId` — exact type, and where valid values come from

`dsh-llm/lib/types/brand.d.ts:48-55` — **verbatim**:

```ts
/** Adapter-owned identifier for one model's selectable reasoning effort. */
export type ReasoningEffortId = Branded<'ReasoningEffortId'>;
/**
 * Brand an adapter-owned reasoning-effort identifier.
 * @param id - the opaque identifier exposed by one model capability.
 * @returns the same string, branded; no validation is performed.
 */
export declare function ReasoningEffortId(id: string): ReasoningEffortId;
```

`Branded` is defined in `dsh-brand/lib/types/index.d.ts` (lines 15-17):

```ts
/** A string carrying a compile-time-only brand `B`. */
export type Branded<B extends string> = string & {
    readonly [BRAND]: B;
};
```

Runtime constructor, `dsh-llm/lib/types/brand.js:50-52`:

```js
export function ReasoningEffortId(id) {
    return brandString(id);
}
```

**Conclusion — this is the load-bearing fact for the plugin:**

- `ReasoningEffortId` is **a plain string at runtime**, with a compile-time-only brand.
  It is **NOT** a closed union type. It is **NOT** validated by the brand function.
- The **valid set is per (provider, model)**, owned by that adapter, and discoverable only
  from `resolveModelInfo(...).reasoning.efforts[].id`.
- Effort validity is enforced **at `resolveCallConfig` / `resolveCallWithInfo` time, not at
  construction time** (§4.3).
- Therefore a plugin cannot type-check or constant-check efforts; it must fetch them from
  `resolveModelInfo` each time the route changes, and never hardcode them.

Known concrete values in this distribution (evidence that the set is free-form per adapter):
`dsh-llm-deepseek/lib/index.js:1413-1416`:

```js
const OFF_REASONING_EFFORT = ReasoningEffortId("off");
const LOW_REASONING_EFFORT = ReasoningEffortId("low");
const HIGH_REASONING_EFFORT = ReasoningEffortId("high");
const MAX_REASONING_EFFORT = ReasoningEffortId("max");
```

i.e. DeepSeek ships `["off","low","high","max"]` (lines 1417-1443), and a
thinking-disabled deployment advertises `["off"]` only (lines 1439-1443, applied at
1591-1593).

---

## 3. Where the route goes: `LlmCallConfig` and `LlmRuntime.registration()`

`dsh-llm/lib/types/call-config.d.ts:16-23` — the object `resolveCallConfig` takes:

```ts
export interface LlmCallConfig {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
}
```

`dsh-llm/lib/types/index.d.ts:368` — signature:

```ts
    resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>;
```

---

## 4. Route RESOLUTION / preflight — exact throws

### 4.1 The adapter lookup: `registration(provider)` → `NO_ADAPTER`

`dsh-llm/lib/types/index.js:765-770` — **verbatim**:

```js
        registration(provider) {
            const registration = this.adapters.get(provider);
            if (!registration)
                throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER');
            return registration;
        }
```

`LlmError` is declared at `dsh-llm/lib/types/index.d.ts:61`:

```ts
export declare class LlmError extends HarnessError {
```

`HarnessError` at `dsh-llm/lib/types/error.d.ts:12-16`:

```ts
export declare class HarnessError extends Error {
    /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
    readonly code: string;
    constructor(message: string, code: string, options?: ErrorOptions);
}
```

➡️ **Unknown provider ⇒ `LlmError` with `.code === 'NO_ADAPTER'`.** This fires from
`listModels`, `resolveModelInfo`, `resolveCallConfig`, `prepareCall`, `providerRetryPolicy`
— every one of them calls `registration(...)` first
(`index.js:553`, `:588`, `:678`, `:722`, `:519`).

### 4.2 `resolveCallConfig` → `resolveCallFor` → `resolveModelInfoFor` → `resolveCallWithInfo`

`dsh-llm/lib/types/index.js:677-712` — **verbatim, the entire preflight chain**:

```js
        async resolveCallConfig(config, signal) {
            return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
        }
        async resolveCallFor(registration, config, signal) {
            const info = await this.resolveModelInfoFor(registration, config.model, signal);
            return this.resolveCallWithInfo(config, info);
        }
        /** Validate request controls against one already-bound exact model result. */
        resolveCallWithInfo(config, info) {
            const defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
                ? { ...config, maxTokens: info.defaultMaxTokens }
                : config;
            const reasoning = info.reasoning;
            const requested = defaulted.reasoningEffort;
            let resolvedConfig = defaulted;
            if (reasoning === undefined) {
                if (requested !== undefined) {
                    throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT');
                }
            }
            else {
                const effective = requested ?? reasoning.defaultEffort;
                if (effective !== undefined) {
                    if (!reasoning.efforts.some(effort => effort.id === effective)) {
                        throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, 'UNSUPPORTED_REASONING_EFFORT');
                    }
                    if (requested !== effective)
                        resolvedConfig = { ...defaulted, reasoningEffort: effective };
                }
            }
            return {
                config: resolvedConfig,
                ...info.context === undefined ? {} : { context: info.context },
                modelInfo: info,
            };
        }
```

(`dsh-llm/lib/types/index.js:680-682` for `resolveCallFor`; `:685-712` for
`resolveCallWithInfo`.)

### 4.3 Effort rejection: `UNSUPPORTED_REASONING_EFFORT`

Two distinct throw sites, both with the same code:

- `index.js:694` — model has **no** `reasoning` metadata but caller named an effort:
  ``throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, 'UNSUPPORTED_REASONING_EFFORT');``
- `index.js:701` — model has efforts but the requested one (or the materialized default)
  is not among them: same message shape, code `UNSUPPORTED_REASONING_EFFORT`.

The contract comment states the no-silent-fallback guarantee explicitly,
`dsh-llm/lib/types/index.d.ts:358-368`:

```ts
    /**
     * Validate a conversation call config against its exact model capability and
     * materialize adapter-configured defaults. Unsupported explicit efforts
     * reject before provider I/O; no clamping or aliasing is performed. This
     * standalone query does not bind a later dispatch; use {@link prepareCall}
     * when logging and streaming must share one adapter registration.
```

➡️ **"Unsupported explicit efforts reject before provider I/O; no clamping or aliasing is
performed."** This is the primitive the plugin's effort validation rests on.

### 4.4 Unknown MODEL — the silent-fallback trap (provider-dependent)

There is **no `UNKNOWN_MODEL` throw in `dsh-llm` itself.** Model validity is delegated to
the adapter's `resolveModel`. Behavior differs per adapter, verified:

**DEEPSEEK — accepts ANY model id, never throws.** `dsh-llm-deepseek/lib/index.js:1575-1599`:

```js
	resolveModel(provider, model, _signal) {
		return Promise.resolve(this.modelInfoFor(this.config.options(), provider, model));
	}
	modelInfoFor(connection, provider, model) {
		const configured = connection.models.find((entry) => entry.id === model);
		const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
		return {
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
			...
```

A grep for `unknown model|UNKNOWN_MODEL|not found|MODEL_NOT` over that whole 2089-line file
returns **only** the `resolveModel` declaration line — no rejection exists. So for the
`deepseek` provider, an unlisted/typo'd model id **silently resolves** to a synthetic entry
whose `name` is the raw id, with the connection's default context window and maxTokens, and
the full reasoning-effort list applied. **The typo surfaces only when the provider endpoint
answers an HTTP error at request time.** A plugin that must "never silently fall back"
**has to** cross-check against `listModels()` itself for DeepSeek.

**PI-AI — throws `UNKNOWN_MODEL`.** `dsh-llm-pi-ai/lib/index.js:1767-1774`:

```js
	modelOf(snapshot, provider, model) {
		const profile = this.profileOf(snapshot, provider);
		const failure = profile.modelErrors.get(model) ?? (profile.piProvider === void 0 ? profile.catalogError : void 0);
		if (failure !== void 0) throw new LlmError(failure, "INVALID_CONFIG");
		const resolved = snapshot.models.getModel(provider, model);
		if (resolved === void 0) throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, "UNKNOWN_MODEL");
		return resolved;
	}
```

and `index.js:1763` for a provider it does not own:
``throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, "NO_ADAPTER");``

### 4.5 Other codes a preflight can surface (from the adapter boundary)

| Code | Site | Trigger |
|---|---|---|
| `NO_ADAPTER` | `dsh-llm/lib/types/index.js:768` | provider has no registered adapter |
| `UNSUPPORTED_REASONING_EFFORT` | `:694`, `:701` | effort not advertised for this route |
| `INVALID_CATALOG` | `:565` | adapter returned malformed/duplicate `listModels` entry |
| `INVALID_MODEL_INFO` | `:604`, `:616` | adapter returned bad `resolveModel` identity / systemPromptUpdate |
| `INVALID_MODEL_CONTEXT` | `:608` | `context.contextWindow` not a positive integer |
| `INVALID_MODEL_MAX_TOKENS` | `:621` | `defaultMaxTokens` not a positive safe integer |
| `INVALID_MODEL_REASONING` | `:637`, `:647`, `:657` | empty/duplicate effort list, or unknown `defaultEffort` |
| `UNKNOWN_MODEL` | `dsh-llm-pi-ai/lib/index.js:1772` | pi-ai only |
| `INVALID_CONFIG` | `dsh-llm-pi-ai/lib/index.js:1770` | pi-ai profile/catalog error for that model |
| `UNSUPPORTED_REASONING_EFFORT` | `dsh-llm-deepseek/lib/index.js:28`, `:34` | DeepSeek re-checks at request build |

`dsh-llm-deepseek/lib/index.js:28` and `:34` (verbatim):

```js
	throw new LlmError(`DeepSeek does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
```
```js
	if (defaults.thinking === "disabled" && effort !== void 0 && effort !== "off") throw new LlmError(`DeepSeek deployment does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
```

### 4.6 `prepareCall` — the atomic alternative (registration-bound)

`dsh-llm/lib/types/index.d.ts:372-380`:

```ts
    /**
     * Resolve one call under its current adapter registration. The returned
     * one-shot handle keeps that registration across header logging and dispatch,
     * so HMR cannot combine one adapter's capability result with another adapter.
     * @param config - provider/model route and optional request controls.
     * @param signal - optional cancellation for adapter-owned capability lookup.
     * @returns a prepared config and its registration-bound stream entry point.
     */
    prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>;
```

Implementation `index.js:721-764`. Two further codes exist only here,
`index.js:750` and `:753`: `'INVALID_PREPARED_CALL'`
("a prepared LLM call can only be dispatched once" / "prepared LLM call config changed
before adapter dispatch"). `PreparedLlmCall` shape at `index.d.ts:90-112`
(`config`, `retryPolicy`, `context?`, `inputModalities?`, `systemPromptUpdate?`,
`adapterDefaults`, `stream(options)`).

---

## 5. `AgentOptions` — exact fields

`dsh-agent/lib/types/runtime-types.d.ts:20-30` — **verbatim, complete**:

```ts
/** Merge-extensible agent creation options. Persona belongs to system-prompt sections. */
export interface AgentOptions {
    /** Provider route (must have a registered adapter at call time). */
    provider?: string;
    /** Model id interpreted by the selected provider adapter. */
    model?: string;
    /** Adapter-owned reasoning effort for the selected provider/model route. */
    reasoningEffort?: ReasoningEffortId;
    /** Maximum output tokens for each conversation-model request. */
    maxTokens?: number;
}
```

Merge-extended by `dsh-subagent/lib/types/depth.d.ts:9-14`:

```ts
declare module '@deepseek-ai/dsh-agent' {
    interface AgentOptions {
        /** Delegation depth: zero for a top-level agent and parent depth + 1 for a child. */
        subagentDepth?: number;
    }
}
```

➡️ **Effective `AgentOptions` = `{ provider?, model?, reasoningEffort?, maxTokens?, subagentDepth? }`.**
It is a **plain data object** (detached, no methods, no live service references) — safe for a
plugin to construct and pass. `reasoningEffort` is `ReasoningEffortId` (a branded string;
the plain string works at runtime).

`ModelSelection` (the `dsh-agent` scoped-selection shape) —
`dsh-agent/lib/types/model-selection.d.ts:8-16`:

```ts
export interface ModelSelection {
    /** Registered provider route. */
    provider: string;
    /** Provider-owned model id. */
    model: string;
    /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
    reasoningEffort?: ReasoningEffortId;
}
```

---

## 6. `dsh-tool-subagent` — how it builds and preflights child `agentOptions`

**Note on the task's file list:** `dsh-tool-subagent/lib/model-selection.js` **does not
exist**. The package's `lib/` contains exactly `index.js`, `invariant.js`,
`model-selection-settings.js`, `types/` (verified by directory listing). The
`model-selection.ts` source is **bundled into `lib/index.js`** under the region marker
`//#region lib/types/model-selection.js` (`lib/index.js:129` closes it; the region starts
near line 12). The `model-selection-settings.js` file contains a **second copy** of
`modelRouteKey`/`assertAllowedModelRoutes` (`model-selection-settings.js:15-37`) because it
imports the types but not the runtime module.

### 6.1 `requestedAgentOptions` — merging, and the route-change effort clear

`dsh-tool-subagent/lib/index.js:62-81` — **verbatim**:

```js
function requestedAgentOptions(parentOptions, configured, request, enabled) {
	if (!hasDelegationModelRequest(request)) return configured;
	if (!enabled) throw new Error("child model selection is disabled for this tool instance");
	assertNonEmpty(request.provider, "provider");
	assertNonEmpty(request.model, "model");
	assertNonEmpty(request.reasoning_effort, "reasoning_effort");
	if (request.provider === void 0 !== (request.model === void 0)) throw new Error("child LLM `provider` and `model` must be supplied together");
	const baselineProvider = configured?.provider ?? parentOptions.provider;
	const baselineModel = configured?.model ?? parentOptions.model;
	const routeChanged = request.provider !== void 0 && (request.provider !== baselineProvider || request.model !== baselineModel);
	const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {};
	return {
		...routeChanged && request.reasoning_effort === void 0 ? configuredWithoutReasoning : configured,
		...request.provider === void 0 ? {} : {
			provider: request.provider,
			model: request.model
		},
		...request.reasoning_effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) }
	};
}
```

Helpers it uses, same file:
- `hasDelegationModelRequest` — `:45-47`:
  ```js
  function hasDelegationModelRequest(request) {
  	return request.provider !== void 0 || request.model !== void 0 || request.reasoning_effort !== void 0;
  }
  ```
- `assertNonEmpty` — `:49-51`:
  ```js
  function assertNonEmpty(value, field) {
  	if (value !== void 0 && value.length === 0) throw new Error(`child LLM \`${field}\` must be non-empty`);
  }
  ```
- `hasConfiguredLlmSelection` — `:104-106`:
  ```js
  function hasConfiguredLlmSelection(options) {
  	return options?.provider !== void 0 || options?.model !== void 0 || options?.reasoningEffort !== void 0;
  }
  ```

`ReasoningEffortId` is imported from the LLM package at `lib/index.js:6`:
```js
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
```

### 6.2 `assertAllowedModelSelection` — the settings-owned allow-list

`dsh-tool-subagent/lib/index.js:91-98` — **verbatim**:

```js
function assertAllowedModelSelection(policy, parentOptions, requested, request) {
	if (policy === void 0 || !hasDelegationModelRequest(request)) return;
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	if (policy.routes.some((route) => route.provider === provider && route.model === model)) return;
	throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`);
}
```

Errors here are **plain `Error`** (no `code`), unlike the LLM layer.

### 6.3 `preflightChildLlmRoute` — THE preflight the plugin should copy

`dsh-tool-subagent/lib/index.js:117-128` — **verbatim, complete**:

```js
async function preflightChildLlmRoute(llm, parentOptions, requested, signal, inheritParentReasoningEffort = true) {
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model;
	const reasoningEffort = requested?.reasoningEffort ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : void 0);
	await llm.resolveCallConfig({
		provider,
		model,
		...reasoningEffort === void 0 ? {} : { reasoningEffort }
	}, signal);
}
```

**Key observations for the plugin:**
- The whole preflight is **one call: `llm.resolveCallConfig(config, signal)`**. It is
  `await`ed purely for its throwing side effect; the returned `LlmCallConfig` is discarded.
  This is exactly the "validate the route at dispatch time" primitive.
- `signal` is threaded through, so preflight honours tool-call cancellation.
- An omitted effort on an **unchanged** route inherits the parent's effort; an omitted effort
  on a **changed** route does **not** inherit (falls to the model's own default).
- **It does not consult `listModels()`** — so it inherits the §4.4 DeepSeek
  unknown-model hole.

### 6.4 The dispatch site — verbatim, `execute()`

`dsh-tool-subagent/lib/index.js:490-507` — **verbatim**:

```js
					async execute(args, exec) {
						const parent = exec.agent;
						if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
						const modelRequest = args;
						const parentOptions = parentAgentOptionsForDelegation(parent);
						const requiresRoutePreflight = hasDelegationModelRequest(modelRequest) || hasConfiguredLlmSelection(config.agentOptions);
						const requestedChildAgentOptions = requestedAgentOptions(parentOptions, requiresRoutePreflight && providerRouteDefaults !== void 0 ? {
							...providerRouteDefaults,
							...config.agentOptions
						} : config.agentOptions, modelRequest, modelSelectionEnabled);
						assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);
						if (requiresRoutePreflight) {
							const llm = runtimeCtx.get("llm");
							if (llm === void 0) throw new Error("cannot resolve the selected child LLM route because the `llm` service is unavailable");
							await preflightChildLlmRoute(llm, parentOptions, requestedChildAgentOptions, exec.signal, providerRouteDefaults === void 0);
							if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`);
						}
						exec.signal.throwIfAborted();
```

**Order is: merge → allow-list assert → LLM preflight → provider-identity re-check → abort check → build request.**
Note `runtimeCtx.get("llm")` (optional read with explicit undefined handling) rather than a
static `inject` — consistent with the workspace's "never statically inject a service you
read lazily" rule.

`providerRouteDefaults` comes from the subagent provider descriptor,
`lib/index.js:394`:
```js
			const providerRouteDefaults = subagentProvider.agentRouteDefaults;
```
typed at `dsh-subagent/lib/types/types.d.ts:338-347`:
```ts
    /**
     * Optional static provider-owned provider/model route for one-shot Agent
     * options. Consumers merge tool/model overrides over these values before
     * preflight; providers whose route derives from the parent omit it. The value
     * is detached immutable data and requires `agentOptions` support.
     */
    readonly agentRouteDefaults?: Readonly<{
        provider: string;
        model: string;
    }>;
```

### 6.5 Model-facing tool fields

Registered only when model selection is enabled — `lib/index.js:412-425`:

```js
						...modelSelectionEnabled ? {
							provider: {
								type: "string",
								description: providerRouteDefaults !== void 0 ? "LLM provider route for the child. Supply together with model; omit both to use configured child defaults or this provider's route defaults." : "LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route."
							},
							model: {
								type: "string",
								description: providerRouteDefaults !== void 0 ? "Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or this provider's route defaults." : "Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route."
							},
							reasoning_effort: {
								type: "string",
								description: providerRouteDefaults !== void 0 ? "Adapter-owned reasoning effort for the effective child route. Omit to use a compatible configured effort or the selected model's default." : "Adapter-owned reasoning effort for the effective child route. Omit to inherit a compatible configured/parent effort or use a newly selected model's default."
							}
						} : {},
```

Wire field name is **`reasoning_effort`** (snake_case); the in-process field is
**`reasoningEffort`**.

### 6.6 `list_subagent_models` — the model-facing catalog tool

Registered by `registerListSubagentModels` — `lib/index.js:172-197`, with the doc comment:

```js
/**
 * Register `list_subagent_models` for one owning delegation-tool instance.
 * @param ctx - Context whose tool registry owns the fixed discovery definition.
 * @param policy - Route policy captured for this Session.
 */
```

`lib/types/list-models.d.ts` in full (10 lines):

```ts
/** Model-facing discovery of LLM routes available to child Agents. */
import type { Context } from '@deepseek-ai/cordis';
import type { ModelSelectionPolicy } from './model-selection.ts';
/**
 * Register `list_subagent_models` for one owning delegation-tool instance.
 * @param ctx - Context whose tool registry owns the fixed discovery definition.
 * @param policy - Route policy captured for this Session.
 */
export declare function registerListSubagentModels(ctx: Context, policy: ModelSelectionPolicy): void;
```

Its implementation, `lib/index.js:145-166`, is the **reference read-path a plugin should
imitate** (verbatim excerpt, `:145-166`):

```js
async function listSubagentModels(ctx, policy, request, signal) {
	const llm = ctx.get("llm");
	if (llm === void 0) throw new Error("cannot discover child LLM routes because the `llm` service is unavailable");
	if (request.model !== void 0 && request.provider === void 0) throw new Error("`model` requires `provider`");
	if (request.provider === void 0) {
		const providers = llm.listProviders().filter((provider) => policy.routes.some((route) => route.provider === provider.id));
		return providers.length === 0 ? "(no LLM providers)" : providers.map((provider) => `${provider.id} — ${provider.name}`).join("\n");
	}
	if (request.provider.length === 0) throw new Error("`provider` must be non-empty");
	const allowedRoutes = policy.routes.filter((route) => route.provider === request.provider);
	if (allowedRoutes.length === 0) throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`);
	const provider = registeredProvider(llm, policy, request.provider);
	if (request.model === void 0) {
		const models = (await llm.listModels(provider.id)).filter((model) => allowedRoutes.some((route) => route.model === model.id));
		return models.length === 0 ? `(no advertised models for ${provider.id})` : models.map((model) => modelLine(provider.id, model)).join("\n");
	}
	if (request.model.length === 0) throw new Error("`model` must be non-empty");
	if (!allowedRoutes.some((route) => route.model === request.model)) throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session`);
	const model = await llm.resolveModelInfo(provider.id, request.model, signal);
	const efforts = model.reasoning?.efforts.map((effort) => `${effort.id}${model.reasoning?.defaultEffort === effort.id ? " (default)" : ""} — ${effort.name}` + (effort.description === void 0 ? "" : `: ${effort.description}`)).join("\n") || "(no advertised reasoning efforts)";
	return `${modelLine(provider.id, model)}\nReasoning efforts:\n${efforts}`;
}
```

**The exact three-step ladder for a picker:** `listProviders()` → `listModels(provider)` →
`resolveModelInfo(provider, model).reasoning.efforts[]`.

And a provider-not-registered diagnostic that names the alternatives —
`lib/index.js:132-139`:

```js
/** Resolve one registered provider with a model-correctable diagnostic. */
function registeredProvider(llm, policy, providerId) {
	const providers = llm.listProviders();
	const provider = providers.find((candidate) => candidate.id === providerId);
	if (provider !== void 0) return provider;
	const available = providers.filter((candidate) => policy.routes.some((route) => route.provider === candidate.id)).map((candidate) => candidate.id).join(", ") || "(none)";
	throw new Error(`LLM provider "${providerId}" is not registered; available providers: ${available}`);
}
```

### 6.7 `dsh-subagent` child-option resolution (the second merge layer)

`dsh-subagent/lib/index.js:446-456` — **verbatim**:

```js
function parentAgentOptionsForDelegation(parent) {
	const requestConfig = parent.session.requestHeader()?.config;
	if (requestConfig === void 0) return { ...parent.options };
	const { provider: _createdProvider, model: _createdModel, reasoningEffort: _createdReasoningEffort, ...createdOptions } = parent.options;
	return {
		...createdOptions,
		provider: requestConfig.provider,
		model: requestConfig.model,
		...requestConfig.reasoningEffort === void 0 ? {} : { reasoningEffort: requestConfig.reasoningEffort }
	};
}
```

`dsh-subagent/lib/index.js:468-484` — **verbatim**:

```js
function resolveChildAgentOptions(parent, requested, childDepth) {
	const parentOptions = parentAgentOptionsForDelegation(parent);
	const parentProvider = parentOptions.provider;
	const parentModel = parentOptions.model;
	const parentReasoningEffort = parentOptions.reasoningEffort;
	const parentMaxTokens = parentOptions.maxTokens;
	const resolved = {
		...parentProvider !== void 0 ? { provider: parentProvider } : {},
		...parentModel !== void 0 ? { model: parentModel } : {},
		...parentReasoningEffort !== void 0 ? { reasoningEffort: parentReasoningEffort } : {},
		...parentMaxTokens !== void 0 ? { maxTokens: parentMaxTokens } : {},
		...requested,
		subagentDepth: childDepth
	};
	if ((resolved.provider !== parentProvider || resolved.model !== parentModel) && requested?.reasoningEffort === void 0) delete resolved.reasoningEffort;
	return resolved;
}
```

➡️ **`resolveChildAgentOptions` performs NO LLM validation.** It only merges and clears a
stale effort. *"never silently fall back"* cannot be delegated to it — it must be enforced
by the caller's preflight (§6.3).

### 6.8 The opt-in settings service (full contract)

`dsh-tool-subagent/lib/types/model-selection-settings.d.ts` — **complete, 43 lines,
verbatim key parts**:

```ts
/** User-settings section for model-selectable subagent delegation. */
export declare const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = "subagent-model-selection";
/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
    /** Whether newly composed top-level Sessions receive model selection. */
    enabled: boolean;
    /** Exact child LLM routes offered to newly composed top-level Sessions. */
    allowedModels: AllowedModelRoute[];
}
```

Service: `ctx.subagentModelSelection` (`SubagentModelSelectionConfig extends Service`,
namespace const `"subagent-model-selection"`), registration name in
`model-selection-settings.js:56`: `super(ctx, "subagentModelSelection");`.
`current(): SubagentModelSelectionSettings` — `model-selection-settings.js:80-86`.
Validation `model-selection-settings.js:87-90`:

```js
	validate(value) {
		assertAllowedModelRoutes(value.allowedModels);
		if (value.enabled && value.allowedModels.length === 0) throw new Error("enabled subagent model selection requires at least one allowed model");
	}
```

Schema defaults are **off**: `model-selection-settings.js:44-47` —
`enabled: z.boolean().default(false)`, `allowedModels: z.array(AllowedModelRouteSchema).default([])`.

`AllowedModelRoute` (`lib/types/model-selection.d.ts:6-11`):
`{ readonly provider: string; readonly model: string }` — **no effort in the allow-list**;
effort is validated only against the model's advertised set.

`assertAllowedModelRoutes` rejects malformed/duplicate routes —
`model-selection-settings.js:23-37`; `modelRouteKey` is `` `${provider}\0${model}` ``
(`:15-17`), i.e. NUL-joined.

**Duration/persistence:** the route list is persisted per-session as the
`subagent/model-selection-policy` session event
(`lib/types/model-selection-state.d.ts:14-17`), projected as
`subagentModelSelectionPolicy: AllowedModelRoute[] | null` (`:20-25`), definition at
`model-selection-state.d.ts:27-33`.

### 6.9 `dsh-tool-subagent` config `agentOptions`

`dsh-tool-subagent/lib/types/index.d.ts:42-45`:

```ts
    /**
     * Agent options applied to every child; omitted fields use child-loop defaults.
     */
    agentOptions?: AgentOptions;
```

Also relevant, `index.d.ts:25-29`:
```ts
    /**
     * Sample the Host `subagent-model-selection` setting for each new top-level
     * Session and inherit that decision in its child Sessions.
     */
    modelSelectionSettings?: boolean;
```

---

## 7. Client side — module ids and whether a third party can `require()` them

### 7.1 The picker package

Package `@deepseek-ai/dsh-client-ui-model-selection`, mounted in the web composition as
row `ui-model-selection` — `dsh-web-app/cordis.patch.yml:324-326`:

```yaml
    # Model selection: the /model popupSelect + composer seat over session.models.
    - id: ui-model-selection
      name: '@deepseek-ai/dsh-client-ui-model-selection'
```

**Registered module id** (must equal the loader row `name`) —
`dsh-client-ui-model-selection/lib/client.js:1-2`:

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-model-selection",
```

**Declared module-graph dependencies** —
`dsh-client-ui-model-selection/package.json` `dsh.client`:

```json
{"client": {"inject": ["@deepseek-ai/dsh-api-session-controller", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-commands", "@deepseek-ai/dsh-api-remotes"], "platform": "web"}}
```

Actual `require()` calls inside the bundle (grep of `require("…")`):
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-primitives`, `react`, `react-dom`, `react/jsx-runtime`.
⚠️ `@deepseek-ai/dsh-client-store` and `@deepseek-ai/dsh-client-ui-primitives` are required
but are **not** in its `dsh.client.inject` list — they arrive via the graph row's
`external` scan instead (`WebBootEntry.external`).

**Exports — verbatim, `lib/client.js:961-964`, the complete list:**

```js
		exports.ModelDirectory = ModelDirectory;
		exports.ModelDirectoryResolver = ModelDirectoryResolver;
		exports.apply = apply;
		exports.inject = inject;
```

➡️ **`ModelSelect` (the actual React picker component) is NOT exported.** Its type file
exists (`lib/types/client/ModelSelect.d.ts`, function `ModelSelect({locked, available,
directory, load, select, t})`) but there is no runtime export for it.

### 7.2 Can a third-party client bundle `require()` it? — **YES, with one hard condition**

The mechanism, from `dsh-client-modules/lib/client.js`:

The synchronous `require` given to every factory — `client.js:300-310` — **verbatim**:

```js
			makeRequire(edges) {
				return (spec) => {
					edges.add(spec);
					if (this.seed.has(spec)) return this.seed.get(spec);
					const id = stripClientSuffix(spec);
					const record = this.loadCache.get(id);
					if (record !== void 0) return record.exports;
					if (this.factories.has(id)) return this.materialize(id).exports;
					throw new Error(`client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`);
				};
			}
```

Branch order: **seed → memoized record → registered factory → throw.** It is *synchronous*
and **cannot fetch**. So a graph row that exists but whose bundle has not yet executed will
throw.

Arrival is scheduled by the boot graph —
`client.js:253-270`, verbatim excerpt:

```js
			async arriveGraphRow(row, open = [], visited = /* @__PURE__ */ new Set()) {
				...
				for (const request of row.external) {
					const id = stripClientSuffix(request);
					if (this.seed.has(request) || this.loadCache.has(id)) continue;
					const dependency = this.graphRows.get(id);
					if (dependency !== void 0) await this.arriveGraphRow(dependency, next, visited);
				}
				for (const packageName of row.inject) {
					const dependency = this.graphRows.get(packageName);
					if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited);
				}
				await this.arrive(row);
			}
```

`WebBootEntry` wire shape — `dsh-client-modules/lib/types/client/manifest.d.ts`:

```ts
    /** Package-name dependency edges used for factory arrival and plugin composition. */
    inject?: string[];
    ...
    /** Non-baseline module specifiers this row requests; omitted when it requests none. */
    external?: string[];
```

and `stripClientSuffix` (`client.js:61-63`) normalizes a trailing `/client`, so
`require('@deepseek-ai/dsh-client-ui-model-selection')` and
`require('@deepseek-ai/dsh-client-ui-model-selection/client')` resolve to the same row.

**Conclusion:** a third-party client bundle **can** `require('@deepseek-ai/dsh-client-ui-model-selection')`
**iff both** hold:
1. the row is in the boot graph (true whenever that package is mounted — it is, via `dsh-web-app`), **and**
2. the requiring bundle declares it in its own `dsh.client.inject` (or has it statically
   discovered as an `external`) so `arriveGraphRow` registers the dependency's factory
   before the consumer materializes.

If (2) is omitted the `require` **throws the loud message at line 308** — it is not a silent
miss. **UNVERIFIED**: whether the host's `external` static scan would pick up a bare
`require('@deepseek-ai/dsh-client-ui-model-selection')` written in a plain-JS third-party
bundle without a build step; the safe route is an explicit `dsh.client.inject` entry.

### 7.3 What the client half actually offers a plugin

- **Client service `ctx.modelDirectories`** — note this is the **client** side, NOT the Host
  `models`. Registered at `client.js:272`: `super(ctx, "modelDirectories");`, declared at
  `lib/types/client/service.d.ts`:
  ```ts
  declare module '@deepseek-ai/cordis' {
      interface Context {
          modelDirectories: ModelDirectoryResolver;
      }
  }
  ```
  (Doc comment at `service.d.ts` claims "the service registers itself as `models`" — the
  runtime code at `client.js:272` proves the real name is `modelDirectories`. The comment
  is stale; **trust the code**.)
  Static inject: `["sessions", "remote", "remote.session"]` (`client.js:258-262`).
  Method: `directoryFor(sessionId: SessionId): ModelDirectory` — unknown sessions fail loud.

- **`ModelDirectory`** (`lib/types/client/directory.d.ts:34-76`):
  - `readonly store: SnapshotStore<ModelDirectoryState>`
  - `load(): Promise<ModelDirectoryState>`
  - `select(selection: ModelSelection): Promise<void>`
  - `resetConnected(): void`, `dispose(): void`
  `ModelDirectoryState` (`:13-32`): `current: ModelSelection | null`,
  `routable: boolean | null`, `groups: readonly ModelProviderGroup[]`,
  `failures: readonly ModelCatalogFailure[]`, `status`, `error`. The comment on `routable`
  is the key nuance:
  > *"Whether an adapter serves the current selection's provider, as the host reports it —
  > null before the first load, which is NOT the same as blocked. Read this rather than
  > "current matches no group": **catalog membership is advisory, so a route serving a model
  > it stopped advertising is missing from the groups yet perfectly usable.**"*

- **The slot it occupies:** `conversation.input.model` — registered via
  `scope.slots.inject("conversation.input.model", ...)` (`client.js:939-940`). A third-party
  plugin registering into that same seat must reconcile with this occupant.

- **`/model` command**: registered into `ctx.commandUi` as `name: "model"`, `ui.kind:
  "popupSelect"` (`client.js:915-937`). Both entries share one `ModelDirectory` per session.

- The package's **Host half is empty**: `lib/index.js` is `function apply() {}` with the
  comment *"Pure UI plugin: the empty apply exists so the plugin appears in the host
  cordis.yml / Loader"*.

### 7.4 Companion client package (provider config, not selection)

`@deepseek-ai/dsh-client-ui-settings-models` — module id
`"@deepseek-ai/dsh-client-ui-settings-models"` (`lib/client.js:2`), row `ui-settings-models`
(`dsh-web-app/cordis.patch.yml:243-244`). Exports: `apply`, `inject`, `refreshIfLoaded`
(`lib/client.js:2967-2969`). `dsh.client.inject`:
`["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-remotes"]`.
This is the **provider/credential configuration** page, not a per-session picker.

---

## 8. Host catalog for the browser, and dispatch-time confirmation

### 8.1 How the Host builds the browser catalog — `dsh-api-session-controller`

`dsh-api-session-controller/lib/index.js:1988-2035` — **verbatim, `buildModelCatalog`**:

```js
async function buildModelCatalog(ctx, defaultSelection = ctx.agentDefaultModel.currentSelection()) {
	const providers = ctx.llm.listProviders();
	const catalog = await Promise.all(providers.map(async (provider) => {
		try {
			const models = await ctx.llm.listModels(provider.id);
			const entries = await Promise.all(models.map(async (model) => {
				const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
				const reasoning = resolved.reasoning === void 0 ? void 0 : {
					efforts: resolved.reasoning.efforts.map((effort) => ({
						id: effort.id,
						name: effort.name,
						...effort.description === void 0 ? {} : { description: effort.description }
					})),
					...resolved.reasoning.defaultEffort === void 0 ? {} : { defaultEffort: resolved.reasoning.defaultEffort }
				};
				return {
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...reasoning === void 0 ? {} : { reasoning }
				};
			}));
			return {
				kind: "group",
				group: {
					id: provider.id,
					name: provider.name,
					models: entries
				}
			};
		} catch (error) {
			return {
				kind: "failure",
				failure: {
					id: provider.id,
					name: provider.name,
					message: error instanceof Error ? error.message : String(error)
				}
			};
		}
	}));
	return {
		default: { ...defaultSelection },
		routableProviders: providers.map((provider) => provider.id),
		groups: catalog.flatMap((item) => item.kind === "group" ? [item.group] : []).filter((group) => group.models.length > 0),
		failures: catalog.flatMap((item) => item.kind === "failure" ? [item.failure] : [])
	};
}
```

Note: it **drops `contextWindow`** — the browser catalog has no context window. And it
**filters out empty groups** (`groups: … .filter((group) => group.models.length > 0)`), while
`routableProviders` keeps every registered provider id.

Wire types — `dsh-api-session-controller/lib/types/types.d.ts:96-133`:

```ts
/** One adapter-owned reasoning effort for an exact model route. */
export interface ModelReasoningEffort {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
    readonly efforts: readonly ModelReasoningEffort[];
    readonly defaultEffort?: string;
}
/** One model displayed inside its provider group. */
export interface ModelCatalogModel {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly reasoning?: ModelReasoning;
}
/** One provider and its successfully loaded model catalog. */
export interface ModelProviderGroup {
    readonly id: string;
    readonly name: string;
    readonly models: readonly ModelCatalogModel[];
}
/** One provider whose model catalog lookup failed. */
export interface ModelCatalogFailure {
    readonly id: string;
    readonly name: string;
    readonly message: string;
}
/** Host-generation model catalog and the default used by unconfigured Sessions. */
export interface ModelCatalog {
    readonly default: ModelSelection;
    /** Provider routes currently able to serve a request, including empty catalogs. */
    readonly routableProviders: readonly string[];
    readonly groups: readonly ModelProviderGroup[];
    readonly failures: readonly ModelCatalogFailure[];
}
```

Note `ModelReasoningEffort.id` is a **plain `string`** on the wire (the brand is
compile-time only and is erased).

### 8.2 Remotes available to a client bundle

`dsh-api-session-controller/lib/typert.remote-client.d.ts`:

```ts
    modelCatalog: () => Promise<RemoteResult<ModelCatalog>>
    ...
    selectModel: (request: SessionSelectModelRequest) => Promise<RemoteResult<SessionSelectModelValue>>
```
(namespaced as `session/modelCatalog` and `session/selectModel`).

`dsh-llm/lib/typert.remote-client.d.ts` — **the ENTIRE `remote.llm` surface**:

```ts
  interface TypertRemoteNamespace$6c6c6d {
    discoverModels: (settingsNs: string, request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<RemoteResult<LlmDiscoveredModel[]>>
    listConfigurableProviders: () => Promise<RemoteResult<LlmConfigurableProvider[]>>
    listProviders: () => Promise<RemoteResult<LlmProviderInfo[]>>
  }
```

➡️ **`remote.llm` exposes `listProviders`, `listConfigurableProviders`, `discoverModels` —
and NOT `listModels`, NOT `resolveModelInfo`, NOT `resolveCallConfig`.** A client bundle
therefore **cannot** preflight a route itself; it must go through
`remote.session.modelCatalog()` (advisory, no context window) and let the Host validate via
`remote.session.selectModel`.

### 8.3 `selectModel` — the Host-side validation-and-install path

`dsh-api-session-controller/lib/index.js:605-634` — **verbatim**:

```js
	async selectModel(request) {
		const agent = await this.resolveAgent(request.sessionId);
		return this.agents.serializeImageAdmission(agent, async () => {
			try {
				const resolved = await this.ctx.llm.resolveCallConfig({
					provider: request.provider,
					model: request.model,
					...request.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }
				});
				const selected = {
					provider: resolved.provider,
					model: resolved.model,
					...resolved.reasoningEffort === void 0 ? {} : { reasoningEffort: resolved.reasoningEffort }
				};
				this.agents.selectForNextRequest(agent, selected);
				try {
					await this.ctx.agentDefaultModel.saveSelection(selected);
				} catch (error) {
					this.ctx.logger.warn(`session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`);
				}
				return { selected: { ...selected } };
			} catch (error) {
				if (remoteErrorOf(error) !== void 0) throw error;
				throw new RemoteError("session/model-unavailable", error instanceof Error ? error.message : String(error), {
					provider: request.provider,
					model: request.model
				});
			}
		});
	}
```

This is the **reference "validate at save time" implementation**, and it uses exactly
`ctx.llm.resolveCallConfig(...)`. On failure it wraps into `RemoteError` code
**`session/model-unavailable`**, declared at
`dsh-api-session-controller/lib/types/types.d.ts:166-169`:

```ts
        'session/model-unavailable': {
            readonly provider: string;
            readonly model: string;
        };
```

Request/value types — `types.d.ts:264-271`:

```ts
/** Session model-selection request. */
export interface SessionSelectModelRequest extends ModelSelection {
    readonly sessionId: SessionId;
}
/** Accepted model selection after Host resolution. */
export interface SessionSelectModelValue {
    readonly selected: ModelSelection;
}
```

### 8.4 Default model service

`dsh-agent-default-model/lib/types/index.d.ts:9-13` — service `ctx.agentDefaultModel`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Default model selection for Agents created without an explicit model. */
        agentDefaultModel: AgentDefaultModelConfig;
    }
}
```

`:48` `currentSelection(): ModelSelection`; `:55` `saveSelection(next: ModelSelection): Promise<void>`.
Settings namespace const `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = "agent-default-model"` (`:16`).
`AgentDefaultModelSettings.reasoningEffort?: string` — **plain string, not branded** (`:24`).
Composition `Config` is `{ provider: string; model: string }` only (`:29-34`), and the README
explains why (verbatim, `dsh-agent-default-model/README.md`):

> "`reasoningEffort` is deliberately not a config field: it belongs to the settings layer, so
> a complete saved selection can clear an effort when the next selected model has none,
> while a composition value would be inherited again."

and:

> "The service does not validate catalog membership: a provider route may serve an
> unadvertised model, and the consumer that opens a model request owns availability
> diagnostics."

Mounted at `dsh-base/cordis.patch.yml:76` (`name: '@deepseek-ai/dsh-agent-default-model'`).

---

## 9. Answers to the task's explicit questions

### Q: Is there a Host service a plugin can call at dispatch time to confirm a route is still valid?

**YES — `ctx.llm`.** Three tiers, all synchronous-read or awaited on the live registry:

1. **Strongest, and the one the product itself uses at both save time and dispatch time:**
   ```js
   await ctx.llm.resolveCallConfig({ provider, model, reasoningEffort? }, signal)
   ```
   Validates the provider has a live adapter (`NO_ADAPTER`), resolves exact model metadata
   through that adapter, and validates the effort against the model's advertised set
   (`UNSUPPORTED_REASONING_EFFORT`). Cited: `dsh-llm/lib/types/index.js:677-712`; used
   verbatim by `dsh-tool-subagent/lib/index.js:123-127` and
   `dsh-api-session-controller/lib/index.js:609-613`.
2. **Atomic variant when the validation and the request must share one adapter generation:**
   `await ctx.llm.prepareCall(config, signal)` → `PreparedLlmCall`
   (`dsh-llm/lib/types/index.d.ts:372-380`, `index.js:721-764`).
3. **Cheap routability probe:** `ctx.llm.listProviders().some(p => p.id === provider)`
   — this is exactly what the product uses. The helper is named `routeServed`, declared
   verbatim at `dsh-api-session-controller/lib/index.js:988-990`:

```js
function routeServed(ctx, provider) {
	return ctx.llm.listProviders().some((entry) => entry.id === provider);
}
```

   Mirrored to the browser as `ModelCatalog.routableProviders`.

⚠️ **Caveat, restated because it defeats "never silently fall back":**
`resolveCallConfig` does **not** prove model-id membership for adapters that synthesize
metadata (DeepSeek — §4.4). To get a true membership check a plugin must additionally
compare against `await ctx.llm.listModels(provider)`. DSH's own contract says catalog
membership is advisory by design (`dsh-llm/lib/types/index.d.ts:149-153`, on `LlmAdapter.listModels`):

```ts
    /**
     * List models this adapter can currently advertise for one owned provider.
     * The result is advisory: an adapter may accept unlisted model ids, and
     * consumers must not turn absence into request rejection.
```

➡️ **A plugin that must not silently accept a typo has to add its own `listModels()`
membership gate for such providers — the LLM layer deliberately will not.**

### Q: "resolveRoute / assertRoute / adapter lookup" — what exists

**Neither `resolveRoute` nor `assertRoute` exists anywhere in the distribution.** The real
names are:
- `LlmRuntime.registration(provider)` — **private**; throws `NO_ADAPTER`.
- `LlmRuntime.resolveCallConfig(config, signal)` — public preflight.
- `LlmRuntime.resolveModelInfo(provider, model, signal)` — public exact-model lookup.
- `LlmRuntime.prepareCall(config, signal)` — public atomic prepare.
- `preflightChildLlmRoute(llm, parentOptions, requested, signal, inherit?)` — a
  **module-private, non-exported** function in `dsh-tool-subagent/lib/index.js:117`; it is
  **not** importable. Proof: the package's only export statement is
  `dsh-tool-subagent/lib/index.js:659` → `export { Config, apply, inject, name };`
  (`preflightChildLlmRoute` is absent), and `dsh-tool-subagent/package.json` `exports` offers
  only `.`, `./model-selection-settings`, `./invariant`, `./src/*`, `./package.json`.
  A plugin must **re-implement** it; §6.3 gives the exact body to copy.

---

## 10. Minimal copy-pasteable contract for the plugin

```js
// Pickers / validation — Host side, ctx.llm is the ONLY model-catalog service.
const providers = ctx.llm.listProviders()                       // [{ id, name }]  (sync)
const models = await ctx.llm.listModels(providerId)              // [{ provider, id, name, description?, inputModalities? }]
const info = await ctx.llm.resolveModelInfo(providerId, modelId) // + { context:{contextWindow}, defaultMaxTokens?, reasoning?, systemPromptUpdate? }
const efforts = info.reasoning?.efforts ?? []                    // [{ id: ReasoningEffortId, name, description? }]
const dflt = info.reasoning?.defaultEffort                       // ReasoningEffortId | undefined
const ctxWindow = info.context?.contextWindow                    // number | undefined

// Preflight (SAVE time and DISPATCH time — same call, no fallback, throws instead):
await ctx.llm.resolveCallConfig({ provider, model, reasoningEffort }, signal)

// Child agent options:
const agentOptions = { provider, model, reasoningEffort, maxTokens?, subagentDepth? }
```

Thrown error shape:

```js
import { LlmError, isHarnessError } from '@deepseek-ai/dsh-llm'
// err.code ∈ { 'NO_ADAPTER', 'UNSUPPORTED_REASONING_EFFORT', 'INVALID_CATALOG',
//              'INVALID_MODEL_INFO', 'INVALID_MODEL_CONTEXT', 'INVALID_MODEL_MAX_TOKENS',
//              'INVALID_MODEL_REASONING', 'INVALID_PREPARED_CALL' }
// plus, adapter-specific: 'UNKNOWN_MODEL' (pi-ai), 'INVALID_CONFIG' (pi-ai)
```
(`isHarnessError` — `dsh-llm/lib/types/error.d.ts:72`.)

---

## 11. Explicitly UNVERIFIED / not found

1. **UNVERIFIED** — whether the Host `external` static scan in the web boot composer would
   discover a bare `require('@deepseek-ai/dsh-client-ui-model-selection')` in a third-party
   plain-JS bundle with no build step. The evidence (`dsh-client-modules/lib/client.js:259-264`)
   shows `external` is read from the **wire row**, not computed in the browser, so the answer
   depends on the Host-side scanner, which was not located in this pass. Use an explicit
   `dsh.client.inject` entry to be safe.
2. **UNVERIFIED** — no `models` Cordis service exists on the Host. Confirmed absent from
   `dsh-llm` and from every `dsh-*` type augmentation grepped; a third-party package could
   theoretically register one. Not found in this distribution.
3. **UNVERIFIED** — `dsh-tool-subagent/lib/model-selection.js` does **not** exist (verified
   by directory listing); its logic is bundled into `lib/index.js` under
   `//#region lib/types/model-selection.js`. Any tooling that resolves that path will fail.
4. **UNVERIFIED** — the exact set of reasoning-effort ids for any provider other than the
   two adapters shipped here (`deepseek`, `pi-ai`); it is adapter-owned by design.
5. **UNVERIFIED** — whether `localStorage`/`sessionStorage`-stored third-party picker state
   survives the DSH URL rewrite noted in the workspace `AGENTS.md`; not examined here.

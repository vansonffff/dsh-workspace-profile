/**
 * The unified dispatcher: one lifecycle, two entry points.
 *
 * Both `workspace_subagent` (model-initiated) and `/agent` (human-initiated) go
 * through {@link SubagentDispatcher.dispatch}. That is not tidiness — a second
 * path would drift on exactly the things that are expensive to get wrong: the
 * route preflight, the depth cap, cancellation, and the guarantee that a run is
 * always disposed. A leaked child Agent keeps a session log open and a driver
 * resident; the plan's acceptance matrix calls that out explicitly.
 *
 * ## The lifecycle, in order
 *
 * ```
 * exec.agent → Workspace id → Workspace policy → definition lookup (enabled only)
 *           → backend selection → backend preflight
 *           → persona (spawn only) + assignment compilation
 *           → ctx.subagents.start(<provider>, buildSpawnRequest() | buildCodexRequest())
 *           → await result → interpret stopReason → ALWAYS dispose → return
 * ```
 *
 * ## Two backends, two requests, and why they are separate functions
 *
 * The two backends do **not** take the same payload. An out-of-process backend
 * (the official Codex provider is one) advertises `NO_START_CAPABILITIES` — it
 * has no `agentOptions`, `persona`, `maxDepth`, `toolFilter` or `outputSchema`,
 * and the seam *rejects* a request that asks for any of them rather than
 * ignoring it. A single "one request, two backends" body would therefore either
 * fail loudly for every Codex run or quietly send a `spawn`-shaped request to a
 * backend that cannot honour it. {@link buildSpawnRequest} and
 * {@link buildCodexRequest} are the two shapes, written out.
 *
 * ## Failure separation
 *
 * `run.result` and `run.dispose()` fail for different reasons and one must never
 * erase the other. A child that hit its token ceiling still has partial output
 * worth returning; a disposal failure is a resource leak the caller should hear
 * about even though the answer arrived. So both are caught separately and both
 * are reported, the execution outcome first because that is what the caller
 * asked for.
 *
 * ## What is logged
 *
 * Metadata only: child id, key, route, status and timestamps. Never the task
 * text, never case facts, never the result. A delegation prompt routinely
 * contains the most sensitive text in the session, and a log line is the easiest
 * place for it to leak out of the workspace.
 *
 * @module dsh-workspace-profile/subagent-dispatch
 */

import {
  AmbiguousCodexBackendError,
  CodexBackendUnavailableError,
  explainStopReason,
  NoWorkspaceContextError,
  SubagentRunFailedError,
  UnknownSubagentError,
  WorkspaceProfileError,
} from './errors.js';
import {
  PERSPECTIVE_LABELS,
  PROFILE_LABELS,
  enabledSubagents,
  findSubagent,
  perspectiveLabelOf,
  resolveEffectivePerspective,
  resolveWorkspacePolicy,
  subagentBackend,
  subagentRouteLabel,
} from './policy.js';
import { compilePersona, compileTaskFor, renderSubagentOutput } from './subagent-registry.js';

/**
 * The provider name of the in-process DSH child backend.
 *
 * The UI never mentions it for a `spawn` definition: a user chooses a model, not
 * a transport, and a dropdown of `spawn`/`fork`/`acp` would be a question about
 * the harness's internals asked of someone who came to configure a matter.
 */
export const SUBAGENT_PROVIDER = 'spawn';

/**
 * The backend id a definition names when it wants the official Codex provider.
 *
 * This is a value in **our** data model, not a claim about the platform's
 * registry key — see {@link resolveCodexProvider} for how the two are related.
 */
export const CODEX_BACKEND = 'codex';

/**
 * How a registered provider name is recognised as the Codex backend.
 *
 * Case-insensitive on the whole name: `codex`, `Codex`, `CODEX`. Deliberately
 * narrow. A substring match (`codex-acp`, `my-codex-fork`) would let any
 * provider that merely mentions Codex in its name receive the user's work, and
 * this plugin's rule is that it never chooses a transport the user did not.
 */
const CODEX_PROVIDER_NAME = /^codex$/i;

/**
 * The fixed recursion cap.
 *
 * The cap is on the *child's* depth, so a top-level session's children sit at
 * depth 1 and a child's children at 2. Three therefore allows a grandchild and
 * stops there, which bounds the fan-out cost of a recursive delegation without
 * forbidding the two-level research pattern the product is for.
 *
 * It applies to the `spawn` backend only: `maxDepth` is a start capability an
 * out-of-process backend does not advertise, so a Codex request carrying it
 * would be refused outright.
 */
export const SUBAGENT_MAX_DEPTH = 3;

/**
 * The request keys the Codex backend cannot honour.
 *
 * Each corresponds one-to-one to a start capability in `SubagentCapabilities`,
 * and the seam rejects a request that asks for one rather than silently dropping
 * it. Kept as data so {@link buildCodexRequest} can assert it *by key* instead
 * of by eyeball.
 *
 * @type {readonly string[]}
 */
export const CODEX_UNSUPPORTED_REQUEST_KEYS = Object.freeze([
  'agentOptions',
  'outputSchema',
  'maxDepth',
  'toolFilter',
  'persona',
]);

/**
 * The provider names this deployment has registered, without throwing.
 *
 * @param {any} subagents - the `ctx.subagents` service, or `undefined`.
 * @returns {string[]} the registered names; `[]` when the table cannot be read.
 */
export function registeredProviderNames(subagents) {
  if (subagents === undefined || typeof subagents.list !== 'function') return [];
  try {
    const names = subagents.list();
    return Array.isArray(names) ? names.map((name) => String(name)) : [];
  } catch {
    // A table that cannot be enumerated is reported as "none known": the error
    // the caller then receives names the registered set as empty, which is the
    // only thing this function can actually establish.
    return [];
  }
}

/**
 * The registered provider a Codex Subagent should run on, if there is one.
 *
 * ## Why this is detected rather than assumed
 *
 * The official Codex provider package is not part of every DSH distribution, and
 * this plugin neither installs it nor depends on it. It also cannot import it to
 * ask what name it registers under: the provider is mounted into
 * `ctx.subagents` by the *deployment's* composition, and the registration name
 * is that composition's choice. So "is a Codex backend available here" is
 * answered from the live provider table, in this order:
 *
 * 1. the exact name `codex` — what the platform's own naming convention produces
 *    (the in-process backend is registered as `spawn`, i.e. its short id);
 * 2. otherwise the **unique** registered name equal to `codex` in another letter
 *    case.
 *
 * Two names matching is an error rather than a coin toss
 * ({@link AmbiguousCodexBackendError}). No match is `undefined`, which the
 * caller turns into {@link CodexBackendUnavailableError} — never into a
 * fallback.
 *
 * @param {any} subagents - the `ctx.subagents` service, or `undefined`.
 * @returns {string|undefined} the provider name to start, or `undefined`.
 * @throws {AmbiguousCodexBackendError} when more than one name matches.
 */
export function resolveCodexProvider(subagents) {
  if (subagents === undefined) return undefined;
  if (typeof subagents.getProvider === 'function') {
    try {
      if (subagents.getProvider(CODEX_BACKEND) !== undefined) return CODEX_BACKEND;
    } catch {
      // Fall through to the name scan: a lookup that throws is not evidence that
      // a Codex provider is absent, and the scan asks the same question through
      // the documented listing API.
    }
  }
  const candidates = registeredProviderNames(subagents).filter((name) => CODEX_PROVIDER_NAME.test(name));
  if (candidates.length > 1) throw new AmbiguousCodexBackendError(candidates);
  return candidates[0];
}

/**
 * Build the `ctx.subagents.start` request for the `spawn` backend.
 *
 * This is the in-process backend's shape: it composes the child, so it accepts —
 * and this plugin supplies — the child's route (`agentOptions`), its persona, and
 * the delegation-depth cap. Omitting `signal` when the caller gave none is not
 * cosmetic: a request carrying `signal: undefined` is a request that mentions a
 * cancellation channel, and the seam treats the property as present.
 *
 * @param {object} input - the request inputs.
 * @param {any} input.definition - the stored definition.
 * @param {any} input.agent - the parent Agent.
 * @param {string} input.prompt - the compiled assignment.
 * @param {string} input.persona - the compiled persona.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @returns {any} the request.
 */
export function buildSpawnRequest({ definition, agent, prompt, persona, signal }) {
  /** @type {any} */
  const agentOptions = { provider: definition.provider, model: definition.model };
  if (definition.reasoningEffort !== undefined) agentOptions.reasoningEffort = definition.reasoningEffort;
  return {
    label: definition.name,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    ...(signal === undefined ? {} : { signal }),
    agentOptions,
    persona,
    maxDepth: SUBAGENT_MAX_DEPTH,
  };
}

/**
 * Build the `ctx.subagents.start` request for the Codex backend.
 *
 * Four fields, and that is the whole request: who it is, what to do, on whose
 * behalf, and how to cancel it. Everything else this plugin would like to say —
 * the route, the persona, the depth cap, a tool filter, an output schema — is a
 * capability the backend does not advertise, and the seam **rejects** a request
 * that asks for one instead of ignoring it.
 *
 * The assertion at the end is not decoration: it is what makes "never send a
 * start capability to Codex" a property of this function rather than a promise
 * in a comment that the next edit can quietly break.
 *
 * @param {object} input - the request inputs.
 * @param {any} input.definition - the stored definition.
 * @param {any} input.agent - the parent Agent.
 * @param {string} input.prompt - the compiled assignment (identity included).
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @returns {any} the request.
 * @throws {WorkspaceProfileError} if a start capability ever appears in it.
 */
export function buildCodexRequest({ definition, agent, prompt, signal }) {
  /** @type {any} */
  const request = {
    label: definition.name,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    ...(signal === undefined ? {} : { signal }),
  };
  const offending = CODEX_UNSUPPORTED_REQUEST_KEYS.filter((key) => key in request);
  if (offending.length > 0) {
    throw new WorkspaceProfileError(
      'codex-request-capability',
      `internal error: the Codex request carries ${offending.join(', ')}, which that backend does not support and the subagent seam refuses. ` +
        'Nothing was started. This is a bug in dsh-workspace-profile, not a configuration problem.',
      { offending },
    );
  }
  return request;
}

/**
 * Dispatch Workspace Subagent runs.
 */
export class SubagentDispatcher {
  /**
   * @param {object} deps - dependencies.
   * @param {() => any} deps.getSubagents - resolves `ctx.subagents`, or `undefined`.
   * @param {() => any} deps.getResolver - the {@link import('./workspace-resolution.js').WorkspaceResolver}.
   * @param {() => any} deps.getStore - the {@link import('./settings.js').CompositionStore}.
   * @param {() => any} deps.getCatalog - the {@link import('./model-catalog.js').ModelCatalog}.
   * @param {() => string} [deps.now] - clock, injectable for tests.
   * @param {{ info: Function, warn: Function }} [deps.logger] - diagnostics sink.
   */
  constructor({ getSubagents, getResolver, getMatterResolver, getSessionPerspective, getStore, getCatalog, now, logger }) {
    /** @private */ this.getSubagents = getSubagents;
    /** @private */ this.getResolver = getResolver;
    /** @private */ this.getMatterResolver = getMatterResolver;
    /** @private */ this.getSessionPerspective = getSessionPerspective;
    /** @private */ this.getStore = getStore;
    /** @private */ this.getCatalog = getCatalog;
    /** @private */ this.now = now ?? (() => new Date().toISOString());
    /** @private */ this.logger = logger;
  }

  /**
   * Resolve one Agent's Workspace context, or explain why there is none.
   *
   * @param {any} agent - the Agent whose Workspace to resolve.
   * @returns {{ workspaceId: string, workspace: any, policy: any, configured: boolean }}
   *   the resolved context.
   * @throws {NoWorkspaceContextError} when the Session has no Workspace.
   */
  resolveContext(agent) {
    if (agent === undefined || agent === null) {
      throw new NoWorkspaceContextError('the caller supplied no Agent to attribute the run to');
    }
    const workspaceId = this.getResolver().workspaceIdForAgent(agent);
    if (workspaceId === undefined) {
      const cwd = agent?.session?.header?.cwd;
      throw new NoWorkspaceContextError(
        typeof cwd === 'string' && cwd !== ''
          ? `the session's working directory "${cwd}" is not a registered Workspace`
          : 'the session has no recorded working directory',
      );
    }
    const document = this.getStore().read().document;
    const { policy, configured } = resolveWorkspacePolicy(document, workspaceId, this.now());
    // Synchronous by design: the Matter was resolved and memoised at the step
    // boundary, so a delegation never blocks on the filesystem. A miss is simply
    // "no Matter", and the child gets no Matter block rather than a wrong one.
    const matter = this.getMatterResolver?.()?.matterForAgent(agent)?.facts ?? null;
    return { workspaceId, workspace: this.getResolver().describe(workspaceId), policy, configured, matter };
  }

  /**
   * The enabled definitions of the calling Agent's Workspace.
   *
   * @param {any} agent - the calling Agent.
   * @returns {{ context: any, subagents: any[] }} the Workspace context and its enabled definitions.
   * @throws {NoWorkspaceContextError} when the Session has no Workspace.
   */
  listFor(agent) {
    const context = this.resolveContext(agent);
    return { context, subagents: enabledSubagents(context.policy) };
  }

  /**
   * Run one Workspace Subagent to completion and return its answer.
   *
   * @param {object} request - the dispatch request.
   * @param {any} request.agent - the calling Agent; the run is attributed to it.
   * @param {string} request.reference - the Subagent's key or display name.
   * @param {string} request.task - the assignment, written to stand alone.
   * @param {AbortSignal} [request.signal] - caller cancellation, forwarded to the child.
   * @returns {Promise<{ text: string, subagent: any, childId: string, stopReason: string, diagnostic?: string, disposeError?: string, startedAt: string, endedAt: string }>}
   *   the rendered answer plus the metadata a caller needs to report the run.
   * @throws {NoWorkspaceContextError|UnknownSubagentError|import('./errors.js').UnresolvableRouteError|SubagentRunFailedError}
   */
  async dispatch({ agent, reference, task, signal }) {
    const { workspaceId, workspace, policy, matter } = this.resolveContext(agent);

    const definition = findSubagent(policy, reference);
    if (definition === undefined) {
      const available = enabledSubagents(policy).map((entry) => entry.key);
      throw new UnknownSubagentError(typeof reference === 'string' ? reference : String(reference), available);
    }

    // Preflight before any child resource is reserved. A backend that cannot run
    // must fail here, where nothing needs unwinding, rather than half way into a
    // child's creation.
    //
    // The two backends preflight different things, and the difference is the
    // point: `spawn` needs a working DSH LLM route (which only the live catalog
    // can answer), while `codex` needs a provider registered under its name and
    // has no DSH route at all — asking the catalog about it would demand a
    // provider/model pair a Codex definition is deliberately not required to
    // have.
    const backend = subagentBackend(definition);

    const subagents = this.getSubagents();
    if (subagents === undefined) {
      throw new NoWorkspaceContextError('the `subagents` service is not mounted in this deployment');
    }

    /** @type {string} */
    let provider;
    if (backend === CODEX_BACKEND) {
      const codex = resolveCodexProvider(subagents);
      if (codex === undefined) {
        throw new CodexBackendUnavailableError(definition.key, registeredProviderNames(subagents));
      }
      provider = codex;
    } else {
      await this.getCatalog().assertRoute(definition, signal);
      if (subagents.getProvider(SUBAGENT_PROVIDER) === undefined) {
        throw new NoWorkspaceContextError(
          `the "${SUBAGENT_PROVIDER}" subagent provider is not registered in this deployment (registered: ${
            registeredProviderNames(subagents).join(', ') || 'none'
          })`,
        );
      }
      provider = SUBAGENT_PROVIDER;
    }

    const profileLabel = PROFILE_LABELS[policy.profile] ?? policy.profile;

    // The stance **this session** is working from — not the Workspace's default.
    // A session may have moved its position with `/perspective`, and a child that
    // reverted to the default would reason from a different position than the one
    // its parent is working from. Resolved through the same function the parent's
    // prompt section uses, so the two cannot drift.
    let sessionOverride;
    try {
      sessionOverride = this.getSessionPerspective?.(agent);
    } catch (error) {
      // A broken override lookup must not cost the child its stance entirely; it
      // falls back to the Workspace default, which is what would have happened
      // before this read existed.
      this.logger?.warn?.(
        `workspace-profile: could not read the session Perspective override (${messageOf(error)})`,
      );
    }
    const { perspective, overridden } = resolveEffectivePerspective({
      profile: policy.profile,
      defaultPerspective: policy.defaultPerspective,
      sessionOverride,
    });
    const perspectiveLabel = perspectiveLabelOf(perspective);
    const workspaceTitle = workspace?.title ?? workspaceId;

    // The identity is a `spawn`-only artefact: the persona travels as its own
    // request field, and the backend that receives it is the one that advertises
    // the capability. A Codex child gets the same identity compiled into the
    // assignment instead (`compileTaskFor`), because this backend has no persona
    // channel to send it through.
    const persona = backend === CODEX_BACKEND
      ? undefined
      : compilePersona(definition, { workspaceTitle, profileLabel, perspectiveLabel });
    const prompt = compileTaskFor({
      definition,
      task,
      workspaceTitle,
      profileLabel,
      perspectiveLabel,
      perspectiveOverridden: overridden,
      matter,
    });

    const startedAt = this.now();
    const request = backend === CODEX_BACKEND
      ? buildCodexRequest({ definition, agent, prompt, signal })
      : buildSpawnRequest({ definition, agent, prompt, persona, signal });

    /** @type {any} */
    let run;
    try {
      run = await subagents.start(provider, request);
    } catch (error) {
      // The seam owns pre-publication cleanup, so there is no run to dispose.
      this.logger?.warn?.(
        `workspace-profile: could not start subagent "${definition.key}" (${subagentRouteLabel(definition)}): ${messageOf(error)}`,
      );
      throw error;
    }

    const childId = String(run.id);
    let outcome;
    let resultError;
    try {
      outcome = await run.result;
    } catch (error) {
      resultError = error;
    }

    /** @type {string|undefined} */
    let disposeError;
    try {
      await run.dispose();
    } catch (error) {
      disposeError = messageOf(error);
    }

    const endedAt = this.now();

    // Metadata only — see the module note. The route, the key and the terminal
    // state are what an operator needs; the task and the answer are not ours to
    // persist.
    this.logger?.info?.(
      `workspace-profile: subagent "${definition.key}" (${subagentRouteLabel(definition)}) ` +
        `child=${childId} stop=${outcome?.stopReason ?? 'infrastructure-error'} ${startedAt}→${endedAt}` +
        (disposeError === undefined ? '' : ` dispose-failed=${disposeError}`),
    );
    if (disposeError !== undefined) {
      this.logger?.warn?.(
        `workspace-profile: disposing subagent run ${childId} failed: ${disposeError}. The result above is still valid, but child resources may not have been released.`,
      );
    }

    if (resultError !== undefined) {
      // An infrastructure fault the seam cannot express as a stop reason. The
      // disposal outcome above still rides the message, because losing it here
      // would hide a leak behind a more visible failure.
      throw new SubagentRunFailedError(
        'error',
        disposeError === undefined ? undefined : `dispose failed: ${disposeError}`,
        `the Subagent run failed outside the model's own execution: ${messageOf(resultError)}`,
      );
    }

    /** @type {any} */
    const result = outcome ?? { output: [], stopReason: 'error' };
    const text = renderSubagentOutput(result.output);

    if (result.stopReason !== 'completed') {
      const explanation = explainStopReason(result.stopReason, result.diagnostic);
      const partial = text === '' ? '' : `\n\n--- 部分输出（不完整） ---\n${text}`;
      throw new SubagentRunFailedError(
        result.stopReason,
        disposeError === undefined ? result.diagnostic : `dispose failed: ${disposeError}`,
        `Subagent "${definition.name}" did not complete: ${explanation}${partial}`,
      );
    }

    return {
      text,
      subagent: {
        id: definition.id,
        key: definition.key,
        name: definition.name,
        /**
         * The backend this run actually used, and the label describing where it
         * ran.
         *
         * Both are reported because a caller cannot derive either one: `provider`
         * and `model` are DSH LLM route fields and are simply absent from a Codex
         * definition, so a caller rendering `${provider}/${model}` would print
         * `undefined/undefined` for a run that went perfectly well.
         */
        backend,
        routeLabel: subagentRouteLabel(definition),
        ...(definition.provider === undefined ? {} : { provider: definition.provider }),
        ...(definition.model === undefined ? {} : { model: definition.model }),
        ...(definition.reasoningEffort === undefined ? {} : { reasoningEffort: definition.reasoningEffort }),
      },
      childId,
      stopReason: 'completed',
      ...(disposeError === undefined ? {} : { disposeError }),
      startedAt,
      endedAt,
    };
  }
}

/**
 * Render an unknown thrown value as a message.
 *
 * @param {unknown} error - the caught value.
 * @returns {string} its message.
 */
function messageOf(error) {
  if (error instanceof Error) {
    const code = /** @type {any} */ (error).code;
    return typeof code === 'string' && code !== '' ? `${error.message} [${code}]` : error.message;
  }
  return String(error);
}

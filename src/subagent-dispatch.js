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
 *           → route preflight → persona + assignment compilation
 *           → ctx.subagents.start('spawn', …) → await result
 *           → interpret stopReason → ALWAYS dispose → return
 * ```
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

import { explainStopReason, NoWorkspaceContextError, SubagentRunFailedError, UnknownSubagentError } from './errors.js';
import { PROFILE_LABELS, PERSPECTIVE_LABELS, enabledSubagents, findSubagent, resolveWorkspacePolicy } from './policy.js';
import { compileDispatchTask, compilePersona, renderSubagentOutput } from './subagent-registry.js';

/**
 * The fixed provider name.
 *
 * v0.1 exposes exactly one backend. The UI never mentions it: a user chooses a
 * model, not a transport, and a dropdown of `spawn`/`fork`/`acp` would be a
 * question about the harness's internals asked of someone who came to configure
 * a matter.
 */
export const SUBAGENT_PROVIDER = 'spawn';

/**
 * The fixed recursion cap.
 *
 * The cap is on the *child's* depth, so a top-level session's children sit at
 * depth 1 and a child's children at 2. Three therefore allows a grandchild and
 * stops there, which bounds the fan-out cost of a recursive delegation without
 * forbidding the two-level research pattern the product is for.
 */
export const SUBAGENT_MAX_DEPTH = 3;

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
  constructor({ getSubagents, getResolver, getStore, getCatalog, now, logger }) {
    /** @private */ this.getSubagents = getSubagents;
    /** @private */ this.getResolver = getResolver;
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
    return { workspaceId, workspace: this.getResolver().describe(workspaceId), policy, configured };
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
    const { workspaceId, workspace, policy } = this.resolveContext(agent);

    const definition = findSubagent(policy, reference);
    if (definition === undefined) {
      const available = enabledSubagents(policy).map((entry) => entry.key);
      throw new UnknownSubagentError(typeof reference === 'string' ? reference : String(reference), available);
    }

    // Preflight before any child resource is reserved. A route that cannot run
    // must fail here, where nothing needs unwinding, rather than half way into a
    // child's creation.
    await this.getCatalog().assertRoute(definition, signal);

    const subagents = this.getSubagents();
    if (subagents === undefined) {
      throw new NoWorkspaceContextError('the `subagents` service is not mounted in this deployment');
    }
    const provider = subagents.getProvider(SUBAGENT_PROVIDER);
    if (provider === undefined) {
      throw new NoWorkspaceContextError(
        `the "${SUBAGENT_PROVIDER}" subagent provider is not registered in this deployment (registered: ${
          subagents.list().join(', ') || 'none'
        })`,
      );
    }

    const profileLabel = PROFILE_LABELS[policy.profile] ?? policy.profile;
    const perspectiveLabel =
      policy.defaultPerspective === 'none'
        ? ''
        : (PERSPECTIVE_LABELS[policy.defaultPerspective] ?? policy.defaultPerspective);
    const workspaceTitle = workspace?.title ?? workspaceId;

    const persona = compilePersona(definition, { workspaceTitle, profileLabel, perspectiveLabel });
    const prompt = compileDispatchTask({ task, workspaceTitle, profileLabel, perspectiveLabel });

    const startedAt = this.now();
    /** @type {any} */
    const agentOptions = { provider: definition.provider, model: definition.model };
    if (definition.reasoningEffort !== undefined) agentOptions.reasoningEffort = definition.reasoningEffort;

    /** @type {any} */
    let run;
    try {
      run = await subagents.start(SUBAGENT_PROVIDER, {
        label: definition.name,
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        ...(signal === undefined ? {} : { signal }),
        agentOptions,
        persona,
        maxDepth: SUBAGENT_MAX_DEPTH,
      });
    } catch (error) {
      // The seam owns pre-publication cleanup, so there is no run to dispose.
      this.logger?.warn?.(
        `workspace-profile: could not start subagent "${definition.key}" (${definition.provider}/${definition.model}): ${messageOf(error)}`,
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
      `workspace-profile: subagent "${definition.key}" (${definition.provider}/${definition.model}) ` +
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
        provider: definition.provider,
        model: definition.model,
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

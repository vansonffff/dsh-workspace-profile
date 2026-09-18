/**
 * The model-route catalog and the route preflight.
 *
 * Two different questions live here, and keeping them apart is the whole point:
 *
 * - **What may the user choose from?** — {@link ModelCatalog#catalog}. Built from
 *   `ctx.llm.listProviders()` / `listModels()` / `resolveModelInfo()`. Catalog
 *   membership is *advisory*: the LLM seam says so explicitly, because an adapter
 *   may accept an unlisted model id.
 * - **Will this exact route actually run?** — {@link ModelCatalog#assertRoute}.
 *   Authoritative, and the only question that may decide a dispatch.
 *
 * ## The silent-acceptance trap this module exists to close
 *
 * `resolveCallConfig` is the seam's own preflight, but it does not reject an
 * unknown model for every adapter: the DeepSeek adapter *synthesizes* model
 * metadata for any id it is handed, so a typo resolves cleanly and only fails at
 * the provider's HTTP boundary. "Never silently fall back" therefore cannot be
 * delegated to the seam. This module adds one membership gate of its own, and
 * applies it only when the adapter actually advertises a non-empty catalog — an
 * adapter that advertises nothing is not evidence that a model is wrong, and
 * turning its silence into a rejection would break working routes.
 *
 * The reasoning-effort list has the same shape of problem and the same answer:
 * `ReasoningEffortId` is a branded *free string* with no validation, so the only
 * legitimate source of valid values is
 * `resolveModelInfo(...).reasoning.efforts[].id`, and the final authority is
 * still `resolveCallConfig`, which rejects an unsupported explicit effort before
 * any provider I/O.
 *
 * @module dsh-workspace-profile/model-catalog
 */

import { MissingCapabilityError, UnresolvableRouteError } from './errors.js';

/**
 * How long a catalog observation stays fresh.
 *
 * The catalog is adapter-owned and changes only when an adapter is configured,
 * so a short window keeps the Settings page honest without re-querying every
 * adapter on every keystroke. `llm/adapters-updated` is a Typert event, not a
 * local one, so a plugin cannot subscribe to it Host-side; the TTL is the
 * Host-side answer, and the Settings page re-reads on its own refresh action.
 */
const CATALOG_TTL_MS = 30_000;

/**
 * Read and preflight model routes against the live `ctx.llm`.
 */
export class ModelCatalog {
  /**
   * @param {object} deps - dependencies.
   * @param {() => any} deps.getLlm - resolves the `llm` service, or `undefined` when unmounted.
   * @param {{ warn: Function }} [deps.logger] - diagnostics sink.
   * @param {() => number} [deps.now] - clock, injectable for tests.
   */
  constructor({ getLlm, logger, now }) {
    /** @private */ this.getLlm = getLlm;
    /** @private */ this.logger = logger;
    /** @private */ this.now = now ?? (() => Date.now());
    /** @private @type {{ at: number, value: any[] }|undefined} */
    this.cache = undefined;
    /** @private */ this.inflight = undefined;
  }

  /**
   * Drop the cached catalog, so the next read re-queries every adapter.
   *
   * @returns {void}
   */
  invalidate() {
    this.cache = undefined;
  }

  /**
   * The selectable providers, models and per-route reasoning efforts.
   *
   * @param {AbortSignal} [signal] - caller cancellation, forwarded to adapters.
   * @returns {Promise<Array<{ provider: string, providerName: string, models: Array<{ id: string, name: string, description?: string, contextWindow?: number, efforts: Array<{ id: string, name: string, description?: string }>, defaultEffort?: string, listed: boolean }> }>>}
   *   detached, plain-JSON data — nothing here borrows an adapter object.
   * @throws {MissingCapabilityError} when no `llm` service is mounted.
   */
  async catalog(signal) {
    const llm = this.requireLlm();
    const now = this.now();
    if (this.cache !== undefined && now - this.cache.at < CATALOG_TTL_MS) {
      return this.cache.value;
    }
    if (this.inflight !== undefined) return this.inflight;

    this.inflight = (async () => {
      const providers = llm.listProviders();
      const groups = [];
      for (const provider of providers) {
        signal?.throwIfAborted();
        let models = [];
        try {
          models = await llm.listModels(provider.id);
        } catch (error) {
          // One adapter failing discovery must not empty the picker for every
          // other provider. Report and carry on with an empty group, which the
          // route preflight still handles correctly.
          this.logger?.warn?.(
            `workspace-profile: could not list models for provider "${provider.id}": ${messageOf(error)}`,
          );
        }
        const entries = [];
        for (const model of models) {
          signal?.throwIfAborted();
          entries.push(await this.describeModel(llm, provider.id, model, signal));
        }
        groups.push({
          provider: provider.id,
          providerName: provider.name,
          models: entries.sort((a, b) => compareText(a.name, b.name)),
        });
      }
      const value = groups.sort((a, b) => compareText(a.providerName, b.providerName));
      this.cache = { at: now, value };
      return value;
    })();

    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  /**
   * Resolve one model's detect metadata: context window and reasoning efforts.
   *
   * A model whose metadata cannot be resolved is still offered, with `listed`
   * naming whether the adapter's catalog mentioned it. Suppressing it instead
   * would hide a route that may well work — the seam treats the catalog as
   * advisory, and so does the picker; it is the preflight that decides.
   *
   * @param {any} llm - the `llm` service.
   * @param {string} provider - provider id.
   * @param {any} model - one `LlmModelInfo`.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<any>} the detached catalog entry.
   */
  async describeModel(llm, provider, model, signal) {
    /** @type {any} */
    const entry = {
      id: model.id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      listed: true,
      efforts: [],
    };
    if (typeof model.description === 'string') entry.description = model.description;
    try {
      const resolved = await llm.resolveModelInfo(provider, model.id, signal);
      const window = resolved?.context?.contextWindow;
      if (typeof window === 'number' && Number.isFinite(window)) entry.contextWindow = window;
      const reasoning = resolved?.reasoning;
      if (reasoning !== undefined && Array.isArray(reasoning.efforts)) {
        entry.efforts = reasoning.efforts.map((effort) => {
          /** @type {any} */
          const row = { id: String(effort.id), name: typeof effort.name === 'string' ? effort.name : String(effort.id) };
          if (typeof effort.description === 'string') row.description = effort.description;
          return row;
        });
      }
      if (reasoning?.defaultEffort !== undefined) entry.defaultEffort = String(reasoning.defaultEffort);
    } catch (error) {
      // Unknown to its own adapter. Keep the entry (the catalog is advisory)
      // and record that its metadata is unavailable, so the UI can say so
      // rather than silently rendering a route with no effort list.
      entry.metadataError = messageOf(error);
    }
    return entry;
  }

  /**
   * Whether a route is currently usable, without throwing.
   *
   * The Settings page needs a per-row verdict for every saved definition,
   * including ones this deployment can no longer serve, so this reports rather
   * than rejects. {@link ModelCatalog#assertRoute} is the throwing face used
   * before a dispatch.
   *
   * @param {{ provider?: unknown, model?: unknown, reasoningEffort?: unknown }} route - the saved route.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ available: boolean, reason?: string, code?: string, providerName?: string }>}
   *   the verdict; `reason` is user-facing prose.
   */
  async routeStatus(route, signal) {
    try {
      const detail = await this.assertRoute(route, signal);
      return { available: true, ...detail };
    } catch (error) {
      if (error instanceof UnresolvableRouteError || error instanceof MissingCapabilityError) {
        return { available: false, reason: error.message, code: error.code };
      }
      throw error;
    }
  }

  /**
   * Assert that a route will actually run, and report what it resolved to.
   *
   * Order matters and is deliberate:
   * 1. shape — provider and model must both be present and non-blank;
   * 2. provider registered — `NO_ADAPTER` is a configuration fact worth naming;
   * 3. model membership — only when the adapter advertises a catalog;
   * 4. effort membership — only when the route declares an effort list;
   * 5. `resolveCallConfig` — the seam's own preflight, and the final authority.
   *
   * @param {{ provider?: unknown, model?: unknown, reasoningEffort?: unknown }} route - the route to check.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string, providerName?: string, modelName?: string }>}
   *   the validated route, ready to hand to `AgentOptions`.
   * @throws {UnresolvableRouteError} when any step fails, with a message that
   *   names the failing part and the next action.
   * @throws {MissingCapabilityError} when no `llm` service is mounted.
   */
  async assertRoute(route, signal) {
    const provider = typeof route?.provider === 'string' ? route.provider.trim() : '';
    const model = typeof route?.model === 'string' ? route.model.trim() : '';
    const effort =
      typeof route?.reasoningEffort === 'string' && route.reasoningEffort.trim() !== ''
        ? route.reasoningEffort.trim()
        : undefined;

    if (provider === '' || model === '') {
      throw new UnresolvableRouteError(
        `this Subagent has no complete model route: provider=${provider === '' ? '(missing)' : `"${provider}"`}, model=${model === '' ? '(missing)' : `"${model}"`}. ` +
          'Every Subagent must name its own provider and model; this plugin never substitutes the parent session\'s model. Edit it in Settings → Workspace Composition.',
        { provider, model, reasoningEffort: effort },
      );
    }

    const llm = this.requireLlm();
    const providerInfo = llm
      .listProviders()
      .find((entry) => entry.id === provider);
    if (providerInfo === undefined) {
      const known = llm
        .listProviders()
        .map((entry) => entry.id)
        .join(', ');
      throw new UnresolvableRouteError(
        `the model provider "${provider}" has no registered adapter in this deployment (registered: ${known === '' ? 'none' : known}). ` +
          'Configure the provider in Settings → Models, or pick a different provider for this Subagent.',
        { provider, model, reasoningEffort: effort },
      );
    }

    /** @type {any} */
    const detail = { provider, model, providerName: providerInfo.name };
    if (effort !== undefined) detail.reasoningEffort = effort;

    const resolved = await this.resolveMetadata(llm, provider, model, signal);
    if (resolved !== undefined) {
      if (typeof resolved.name === 'string' && resolved.name !== '') detail.modelName = resolved.name;
      if (resolved.advertised !== undefined && !resolved.advertised) {
        throw new UnresolvableRouteError(
          `the provider "${provider}" does not advertise a model "${model}"${suggest(modelsOf(resolved), model)}. ` +
            'This usually means a typo, or a model that was removed from the provider configuration. Pick a model in Settings → Workspace Composition, or update the provider in Settings → Models.',
          { provider, model, reasoningEffort: effort },
        );
      }
      const efforts = resolved.efforts;
      if (effort !== undefined && efforts !== undefined && efforts.length > 0) {
        const match = efforts.find((entry) => entry.id === effort);
        if (match === undefined) {
          throw new UnresolvableRouteError(
            `the model "${provider}/${model}" does not support reasoning effort "${effort}" (it declares: ${efforts
              .map((entry) => entry.id)
              .join(', ')}). Choose one of those, or clear the effort to use the model default.`,
            { provider, model, reasoningEffort: effort },
          );
        }
      }
    }

    // Final authority. Anything the checks above could not see — an effort on a
    // route that declares no effort list, an adapter-specific capability rule —
    // is decided here, before any provider I/O.
    try {
      const config = { provider, model };
      if (effort !== undefined) config.reasoningEffort = effort;
      await llm.resolveCallConfig(config, signal);
    } catch (error) {
      throw new UnresolvableRouteError(
        `the route "${provider}/${model}"${effort === undefined ? '' : ` at reasoning effort "${effort}"`} was refused by the model runtime: ${messageOf(error)}. ` +
          'Correct the route in Settings → Workspace Composition.',
        { provider, model, reasoningEffort: effort, cause: messageOf(error) },
      );
    }
    return detail;
  }

  /**
   * Resolve authoritative metadata for one route, plus its catalog membership.
   *
   * @param {any} llm - the `llm` service.
   * @param {string} provider - provider id.
   * @param {string} model - model id.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{ name?: string, efforts?: Array<{id: string}>, advertised?: boolean, catalog: string[] }|undefined>}
   *   `undefined` when the adapter cannot describe the model at all — in which
   *   case membership stays undecided and the preflight decides alone.
   */
  async resolveMetadata(llm, provider, model, signal) {
    let catalog = [];
    try {
      const models = await llm.listModels(provider);
      catalog = models.map((entry) => entry.id);
    } catch {
      // An adapter that cannot enumerate its catalog gives no membership
      // evidence; leaving `catalog` empty means the gate does not fire.
    }

    try {
      const resolved = await llm.resolveModelInfo(provider, model, signal);
      const out = {
        catalog,
        ...(typeof resolved?.name === 'string' ? { name: resolved.name } : {}),
        ...(Array.isArray(resolved?.reasoning?.efforts)
          ? { efforts: resolved.reasoning.efforts.map((entry) => ({ id: String(entry.id) })) }
          : {}),
      };
      // Membership is only asserted when the adapter advertised something.
      if (catalog.length > 0) out.advertised = catalog.includes(model);
      return out;
    } catch {
      // The adapter refused to describe it. If it also advertised a catalog that
      // omits the id, that IS membership evidence; otherwise we say nothing.
      if (catalog.length > 0) return { catalog, advertised: catalog.includes(model) };
      return undefined;
    }
  }

  /**
   * Read the `llm` service or explain its absence.
   *
   * @returns {any} the service.
   * @throws {MissingCapabilityError} when unmounted.
   */
  requireLlm() {
    const llm = this.getLlm();
    if (llm === undefined) {
      throw new MissingCapabilityError(
        'the `llm` service',
        'model routes cannot be listed or validated, and Workspace Subagents cannot be dispatched',
      );
    }
    return llm;
  }
}

/**
 * Suggest a near match for a mistyped model id.
 *
 * A one-line hint is the difference between "pick a model" and "you meant
 * `deepseek-flash`", and the edit distance needed for that is three lines.
 *
 * @param {string[]} catalog - advertised model ids.
 * @param {string} wanted - the id the user saved.
 * @returns {string} a hint suffix, or `''` when nothing is close.
 */
function suggest(catalog, wanted) {
  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of catalog) {
    const distance = editDistance(candidate.toLowerCase(), wanted.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Only suggest a plausible typo: within a third of the length, and small in
  // absolute terms. Beyond that the list itself is the useful answer.
  if (best === undefined || bestDistance > Math.max(2, Math.floor(wanted.length / 3))) return '';
  return ` (did you mean "${best}"?)`;
}

/**
 * Levenshtein distance over two short strings.
 *
 * @param {string} a - first string.
 * @param {string} b - second string.
 * @returns {number} the edit distance.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Extract the ids from a catalog snapshot, tolerating a malformed one.
 *
 * @param {any} value - the value returned by `resolveMetadata`.
 * @returns {string[]} the ids.
 */
function modelsOf(value) {
  return Array.isArray(value?.catalog) ? value.catalog : [];
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

/**
 * Deterministic text comparison, so the picker's order never depends on locale.
 *
 * @param {string} a - first string.
 * @param {string} b - second string.
 * @returns {number} negative, zero, or positive.
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { CATALOG_TTL_MS };

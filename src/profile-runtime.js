/**
 * Profile text, Perspective text, and the injected prompt section.
 *
 * ## Why the text lives in files
 *
 * A Profile is not a label with behaviour attached; it is a body of professional
 * working standards that someone has to be able to read, review and diff. Keeping
 * it as Markdown beside the code means a change to what the model is told is a
 * reviewable change to a document, not a change buried in a template literal.
 * {@link loadProfileTexts} reads them once at activation and {@link ProfileRuntime}
 * serves them from memory afterwards.
 *
 * ## Why separate sections, evaluated per assembly
 *
 * `systemPrompt.section` accepts a function of `AssembleContext`, and the agent
 * plane sets `context.agent` on every per-agent assembly. Registering **global**
 * sections whose text is computed at each assembly is what makes "a configuration
 * change takes effect from the next step" true by construction: there is no
 * cached policy to invalidate, because the policy is read while the prompt is
 * built.
 *
 * Profile and Perspective are registered as **separate** sections rather than
 * concatenated into one because they have independent lifecycles: the Profile
 * changes when the user reconfigures the Workspace, the Perspective additionally
 * when they run `/perspective`, and folding them together would mean a change to
 * either one rewrites the other's text. Separate contributions also let a
 * consumer (a diagnostic view, a test) read one of them alone.
 *
 * They stay on the **system-prompt** channel rather than
 * `systemPrompt.context()` on purpose. The runtime-context channel is volatile
 * per-turn state (`cwd`, date, …) and is *suppressible* — `dsh-persona` disables
 * it wholesale when `includeRuntimeContext` is false, and any scoped plugin can
 * call `suppressRuntimeContext()`. A standing stance that silently disappears
 * when some other row suppresses runtime context is a far worse failure than a
 * system prompt that changes, so the standing instruction goes where it cannot
 * be suppressed.
 *
 * The text function must be **synchronous** — `PromptSection.text` is
 * `string | ((context) => string)` — which is exactly why
 * {@link WorkspaceResolver} and {@link SessionPerspectiveStore} keep synchronous
 * in-memory indexes.
 *
 * ## What the sections may and may not do
 *
 * They may state domain background and stable working requirements, and they must
 * state, in their own text, that AGENTS.md, tool permissions, approval and the
 * sandbox outrank them. They may not restate AGENTS content, and they may not
 * claim a Perspective is an established fact: a Perspective is a *position taken
 * for this work*, and the model is told so in as many words.
 *
 * @module dsh-workspace-profile/profile-runtime
 */

import { readFile } from 'node:fs/promises';

import { sanitizeTemplateText } from './subagent-registry.js';
import {
  PROFILE_IDS,
  PROFILE_LABELS,
  PERSPECTIVE_LABELS,
  perspectiveLabelOf,
  resolveEffectivePerspective,
  PERSPECTIVES_BY_PROFILE,
  enabledSubagents,
  perspectivesFor,
  recommendedSkills,
} from './policy.js';

/**
 * Centrally allocated prompt-section orders this plugin sits between, measured
 * from the running distribution rather than assumed:
 * `DEPLOYMENT_PERSONA_PREFIX` is 0, `PLAN_POLICY` is 500, `TOOL_BASH` is 1000,
 * and `DEPLOYMENT_PERSONA_SUFFIX` is 10200.
 *
 * 400 places the Workspace section immediately after the deployment persona and
 * before plan/team/tool guidance, which is where "who you are working as" reads
 * naturally. It deliberately does **not** claim one of the reserved names: those
 * are positions other packages own, and `getSectionOrder` exists so a plugin
 * does not have to invent a colliding one.
 */
export const PROFILE_SECTION_ORDER = 400;

/** Stable section name. Renaming it would orphan the section in a live process. */
export const PROFILE_SECTION_NAME = 'workspace-profile:context';

/**
 * Stable name for the Perspective section.
 *
 * A separate section from {@link PROFILE_SECTION_NAME} because it has a separate
 * lifecycle: the Profile changes when the Workspace is reconfigured, the
 * Perspective additionally when `/perspective` moves the session's stance.
 *
 * It sits immediately after the Profile so the two read as one passage to the
 * model while remaining independently replaceable.
 */
export const PERSPECTIVE_SECTION_NAME = 'workspace-profile:perspective';

/** Order for the Perspective section; immediately after the Profile section. */
export const PERSPECTIVE_SECTION_ORDER = 401;

/** Stable name for the model-visible expert directory section. */
export const AGENTS_SECTION_NAME = 'workspace-profile:subagents';

/**
 * Order for the expert directory. Next to `TOOL_SUBAGENT` (2800), because it is
 * read as part of deciding whether and how to delegate.
 */
export const AGENTS_SECTION_ORDER = 2800;

/**
 * The Perspective bodies, keyed by Profile then Perspective id.
 *
 * Derived from {@link PERSPECTIVES_BY_PROFILE} rather than restated, so a
 * Perspective added to the vocabulary cannot be silently missing its text — the
 * loader would look for a file that the table promises, and the missing-file path
 * warns instead of failing quietly. `none` is dropped because it has no file:
 * "no Perspective" is the absence of a stance, and a file saying so would only
 * invite the model to treat the silence as a stance.
 */
const PERSPECTIVE_FILES = Object.freeze(
  Object.fromEntries(
    Object.entries(PERSPECTIVES_BY_PROFILE).map(([profile, ids]) => [
      profile,
      Object.freeze(ids.filter((id) => id !== 'none')),
    ]),
  ),
);

/**
 * Load every Profile and Perspective body from the package.
 *
 * @param {string} packageRoot - absolute path of the package directory.
 * @returns {Promise<{ profiles: Record<string,string>, perspectives: Record<string, Record<string,string>> }>}
 *   the loaded bodies. A missing or unreadable file is reported as an empty
 *   string with a warning rather than failing activation: a packaging mistake
 *   should degrade the injected context, not take down the composition.
 */
export async function loadProfileTexts(packageRoot, logger) {
  /** @type {Record<string, string>} */
  const profiles = {};
  for (const id of PROFILE_IDS) {
    profiles[id] = await readText(`${packageRoot}/profiles/${id}.md`, logger);
  }
  /** @type {Record<string, Record<string, string>>} */
  const perspectives = {};
  for (const [profile, ids] of Object.entries(PERSPECTIVE_FILES)) {
    perspectives[profile] = {};
    for (const perspective of ids) {
      perspectives[profile][perspective] = await readText(
        `${packageRoot}/perspectives/${profile}/${perspective}.md`,
        logger,
      );
    }
  }
  return { profiles, perspectives };
}

/**
 * Read one text file, reporting failures as warnings.
 *
 * @param {string} path - absolute file path.
 * @param {{ warn: Function }} [logger] - diagnostics sink.
 * @returns {Promise<string>} the file's UTF-8 text, or `''`.
 */
async function readText(path, logger) {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (error) {
    logger?.warn?.(
      `workspace-profile: could not read ${path} (${error instanceof Error ? error.message : String(error)}); that context will be omitted`,
    );
    return '';
  }
}

/**
 * Compose the Workspace context section for one Agent.
 *
 * Returns `''` — which the assembly drops — whenever there is nothing truthful
 * to say: no Workspace, or a Workspace the user has not configured. That last
 * case is a hard requirement, not politeness: an unconfigured Workspace must not
 * silently acquire Bankruptcy rules just because Bankruptcy is the interesting
 * Profile.
 *
 * @param {object} input - the inputs.
 * @param {any} input.policy - the resolved Workspace policy, or `undefined`.
 * @param {boolean} input.configured - whether the user actually saved a policy.
 * @param {any} [input.workspace] - the Workspace projection, for the title.
 * @param {{ profiles: Record<string,string>, perspectives: Record<string, Record<string,string>> }} input.texts - loaded bodies.
 * @returns {string} the section text, or `''`.
 */
export function composeProfileSection({ policy, configured, workspace, texts }) {
  if (policy === undefined || configured !== true) return '';

  const parts = [];
  // The Workspace title is user-authored and renameable, so it is sanitized like
  // every other user text that reaches a prompt section: section text is
  // interpolated with strict `{{variable}}` references, and a stray delimiter
  // would abort assembly for the whole session.
  const title = sanitizeTemplateText(workspace?.title ?? '(未命名工作区)');
  parts.push(
    `## 当前工作区\n\n工作区：${title}\n类型（Profile）：${PROFILE_LABELS[policy.profile] ?? policy.profile}`,
  );

  const profileBody = texts?.profiles?.[policy.profile];
  if (typeof profileBody === 'string' && profileBody !== '') {
    parts.push(profileBody);
  }

  // Named, never installed — and named as a *preference*, not as a capability.
  // The list cannot be checked against the live catalog here: this function is
  // synchronous by contract, and the catalog is an asynchronous, per-Agent read.
  // Saying "prefer these if available" is therefore the honest phrasing, and it
  // is also the correct one — a Skill named here that is not installed simply
  // does not appear in the catalog the model already has.
  const recommended = recommendedSkills(policy);
  if (recommended.length > 0) {
    parts.push(
      '## 本工作区推荐的 Skill\n\n'
        + '下列 Skill 是这个工作区类型对应的常用工作方法，**在可用时优先使用**'
        + '（若未安装或已被停用，则不在你的 Skill 目录中，按现有方法处理即可）：\n\n'
        + recommended.map((entry) => `- \`${entry.name}\``).join('\n'),
    );
  }

  // The precedence statement is part of the section, not a comment in this file:
  // the model only reads what is injected, and "Profile never overrides AGENTS"
  // is precisely the rule it must be able to apply when the two disagree.
  parts.push(
    '## 约束优先级\n\n' +
      '本节的 Profile 只提供领域背景与工作要求。**AGENTS.md、项目规则文件、工具权限、审批策略与沙箱策略优先于本节全部内容。**' +
      '当本节与它们冲突时，以它们为准，并在回答中指出该冲突。本节不扩大任何权限，也不豁免任何审批。',
  );

  return parts.join('\n\n');
}

/**
 * Compose the Perspective section: the stance this work is done from.
 *
 * ## Why this reports its own source
 *
 * The stance can come from two places — the session's `/perspective` override, or
 * the Workspace default — and the model is told which, because the difference is
 * actionable. A session override is a statement about *this* conversation; a
 * Workspace default is a statement about the matter as a whole. A model that
 * knows the current stance is a temporary session override can treat "从投资人角度
 * 重新看" as the change it is, rather than assuming the Workspace itself moved.
 *
 * ## Why it repeats the precedence rule
 *
 * The section must be safe to read alone. Sections are independent contributions:
 * a consumer may render one without the other, and the model may attend to them
 * separately. Restating "this is a position, not a fact" here is cheap; failing
 * to state it where the stance actually appears is not.
 *
 * @param {object} input - the inputs.
 * @param {any} input.policy - the resolved Workspace policy, or `undefined`.
 * @param {boolean} input.configured - whether the user actually saved a policy.
 * @param {string|undefined} input.override - the session's `/perspective` override, if any.
 * @param {{ profiles: Record<string,string>, perspectives: Record<string, Record<string,string>> }} input.texts - loaded bodies.
 * @returns {string} the section text, or `''`.
 */
export function composePerspectiveSection({ policy, configured, override, texts }) {
  if (policy === undefined || configured !== true) return '';

  const profile = policy.profile;

  // Which stance is in force is decided in `policy.js`, not here: a dispatched
  // child's assignment asks the same question, and the two must not be able to
  // answer it differently. See `resolveEffectivePerspective`.
  const { perspective, overridden } = resolveEffectivePerspective({
    profile,
    defaultPerspective: policy.defaultPerspective,
    sessionOverride: override,
  });

  if (perspective === 'none') return '';

  const label = perspectiveLabelOf(perspective) || perspective;
  const source =
    overridden ? '当前会话通过 `/perspective` 指定的立场' : '当前工作区配置的默认立场';

  const parts = [`## 当前立场\n\n${label}（来源：${source}）`];

  const body = texts?.perspectives?.[profile]?.[perspective];
  if (typeof body === 'string' && body !== '') {
    parts.push(body);
  }

  parts.push(
    '> 立场是**本次工作的观察位置**，不是已核实的事实，也不改变任何事实认定要求。' +
      '用户在当前会话中的明确指示优先于本立场；' +
      'AGENTS.md、项目规则、工具权限、审批策略与沙箱策略同样优先于本立场。',
  );

  return parts.join('\n\n');
}

/**
 * Compose the model-visible expert directory.
 *
 * This is the *dispatch* prompt's counterpart on the parent side: the model has
 * to know which Workspace Subagents exist before it can decide to delegate, and
 * it has to know the exact `key` to pass. Only enabled definitions appear, so a
 * disabled agent is not merely refused — it is invisible.
 *
 * ## Why this does not consult `configured`
 *
 * It used to, and that was a bug with a confusing symptom. `configured` answers
 * "did the user pick a Profile?", which is the right gate for injecting a
 * *Profile* — nobody's domain choice should be guessed. It is the wrong gate for
 * this list, because every entry in it was created deliberately by the user: an
 * explicit act of configuration that then produced no effect at all. A Workspace
 * whose owner had added an expert but had not yet chosen a Profile showed the
 * expert in Settings while the model was never told it existed, so the expert
 * could never be dispatched, and nothing anywhere said why.
 *
 * The empty case is still handled, and by the only condition that actually
 * matters: a Workspace with no stored policy resolves to a default with no
 * Subagents, so `enabledSubagents` is empty and the section is empty.
 *
 * @param {any} policy - the resolved Workspace policy.
 * @returns {string} the section text, or `''` when there is nothing to list.
 */
export function composeAgentDirectorySection(policy) {
  if (policy === undefined) return '';
  const subagents = enabledSubagents(policy);
  if (subagents.length === 0) return '';

  const rows = subagents.map((definition) => {
    const route = `${definition.provider}/${definition.model}${definition.reasoningEffort ? ` · ${definition.reasoningEffort}` : ''}`;
    // Name and description are user-authored; see the sanitizer's contract.
    return `- \`${definition.key}\` — ${sanitizeTemplateText(definition.name)}（${route}）：${sanitizeTemplateText(definition.description)}`;
  });

  return (
    '## 本工作区可用的专家 Subagent\n\n' +
    '调用 `workspace_subagent` 时，`agent` 参数填下面的 key 或名称：\n\n' +
    rows.join('\n') +
    '\n\n' +
    '派遣时**必须**把任务写成脱离本会话也能独立执行的完整说明：要解决的问题、必要事实与限制、' +
    '可读取的材料或成果路径、当前有效立场、预期输出格式，以及无法核验时如何表达。' +
    '不得只写"查一下这个问题""继续分析"这类脱离上下文无法理解的文本——child Agent 看不到本会话的历史。'
  );
}

/**
 * The Profile/Perspective side of the runtime.
 *
 * Owns the loaded texts and the two prompt sections. Registration goes through
 * `ctx.effect` so that unloading the plugin withdraws both sections and leaves
 * no dangling prompt contribution.
 */
export class ProfileRuntime {
  /**
   * @param {object} deps - dependencies.
   * @param {{ profiles: Record<string,string>, perspectives: Record<string, Record<string,string>> }} deps.texts - loaded bodies.
   * @param {(agent: any) => { policy: any, configured: boolean, workspace: any }} deps.resolveFor - synchronous policy resolution per Agent.
   * @param {(agent: any) => (string|undefined)} [deps.overrideFor] - synchronous per-Agent session Perspective override.
   * @param {{ warn: Function }} [deps.logger] - diagnostics sink.
   */
  constructor({ texts, resolveFor, overrideFor, logger }) {
    /** @private */ this.texts = texts;
    /** @private */ this.resolveFor = resolveFor;
    /** @private */ this.overrideFor = overrideFor;
    /** @private */ this.logger = logger;
  }

  /**
   * The Profile section text for one assembly.
   *
   * @param {any} context - the assembly context; `context.agent` identifies the Agent.
   * @returns {string} the section text, or `''`.
   */
  textFor(context) {
    const agent = context?.agent;
    if (agent === undefined || agent === null) return '';
    try {
      const resolved = this.resolveFor(agent);
      return composeProfileSection({ ...resolved, texts: this.texts });
    } catch (error) {
      // A prompt-section provider that throws fails the whole assembly, which
      // would take down the Agent's step. Degrading to no section is strictly
      // better: the session keeps working, and the reason is in the log.
      this.logger?.warn?.(
        `workspace-profile: could not compose the Profile section (${error instanceof Error ? error.message : String(error)})`,
      );
      return '';
    }
  }

  /**
   * The Perspective section text for one assembly.
   *
   * The session override is read here rather than cached when `/perspective`
   * runs. `/perspective` moves a *session*, and a session holds many Agents over
   * its life (a fresh Agent per step is the norm), so the override is looked up
   * per assembly from the Agent's own session id. Nothing needs invalidating when
   * it changes: the next assembly simply reads the new value.
   *
   * @param {any} context - the assembly context.
   * @returns {string} the section text, or `''`.
   */
  perspectiveTextFor(context) {
    const agent = context?.agent;
    if (agent === undefined || agent === null) return '';
    try {
      const resolved = this.resolveFor(agent);
      let override;
      try {
        override = this.overrideFor?.(agent);
      } catch (error) {
        // A broken override lookup must not cost the Workspace default stance.
        this.logger?.warn?.(
          `workspace-profile: could not read the session Perspective override (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return composePerspectiveSection({ ...resolved, override, texts: this.texts });
    } catch (error) {
      this.logger?.warn?.(
        `workspace-profile: could not compose the Perspective section (${error instanceof Error ? error.message : String(error)})`,
      );
      return '';
    }
  }

  /**
   * The expert-directory section text for one assembly.
   *
   * @param {any} context - the assembly context.
   * @returns {string} the section text, or `''`.
   */
  agentsTextFor(context) {
    const agent = context?.agent;
    if (agent === undefined || agent === null) return '';
    try {
      const { policy } = this.resolveFor(agent);
      return composeAgentDirectorySection(policy);
    } catch (error) {
      this.logger?.warn?.(
        `workspace-profile: could not compose the Subagent directory (${error instanceof Error ? error.message : String(error)})`,
      );
      return '';
    }
  }

  /**
   * Register the sections against the `systemPrompt` service.
   *
   * Each registration goes through `ctx.effect`, so unloading the plugin
   * withdraws all three and leaves no dangling prompt contribution.
   *
   * @param {any} ctx - the context that will own and withdraw the registrations.
   * @param {any} systemPrompt - the `systemPrompt` service.
   * @returns {void}
   */
  register(ctx, systemPrompt) {
    ctx.effect(() =>
      systemPrompt.section({
        name: PROFILE_SECTION_NAME,
        order: PROFILE_SECTION_ORDER,
        text: (context) => this.textFor(context),
      }),
    );
    ctx.effect(() =>
      systemPrompt.section({
        name: PERSPECTIVE_SECTION_NAME,
        order: PERSPECTIVE_SECTION_ORDER,
        text: (context) => this.perspectiveTextFor(context),
      }),
    );
    ctx.effect(() =>
      systemPrompt.section({
        name: AGENTS_SECTION_NAME,
        order: AGENTS_SECTION_ORDER,
        text: (context) => this.agentsTextFor(context),
      }),
    );
  }
}

/**
 * The Perspective ids a Profile offers, for the Settings page.
 *
 * Re-exported rather than duplicated so the page and the validator cannot drift.
 *
 * @param {string} profile - a Profile id.
 * @returns {readonly string[]} the selectable Perspective ids.
 */
export function perspectivesForProfile(profile) {
  return perspectivesFor(profile);
}

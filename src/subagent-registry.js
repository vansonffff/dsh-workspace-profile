/**
 * Workspace Subagent definitions: creation, editing, and the two compilers.
 *
 * ## What a Workspace Subagent is, and is not
 *
 * It is a **reusable definition**, not a resident agent. Every call creates a
 * fresh child Agent, runs one foreground one-shot task, returns the result and
 * releases the child. Nothing here keeps state between calls except the
 * definition itself, which is data in the settings document.
 *
 * ## The compilers, and why there are three
 *
 * - {@link compilePersona} builds the child's *identity*: who it is, what it is
 *   responsible for, what it must not do. It is injected as the child's persona
 *   and shadows the deployment persona for that child alone. **Only the `spawn`
 *   backend can receive it** — an out-of-process backend advertises no persona
 *   capability, and a request carrying one is refused at `start` rather than
 *   accepted and ignored.
 * - {@link compileBaseTask} builds the part every backend needs: which Workspace
 *   (and Matter) this is, the caller's verbatim task, and the standing
 *   requirements. The `spawn` backend inherits zero parent context, so the
 *   assignment has to stand alone. The compiler supplies the parts the model
 *   cannot be trusted to remember (the effective Perspective, the workspace
 *   framing, and the fact that no parent history exists); it does **not** rewrite
 *   the model's task text, because the model — not this plugin — is the one that
 *   knows what the user asked for.
 * - {@link compileCodexTask} is the `codex` backend's assignment, and it exists
 *   because that backend cannot carry a persona: the role identity, the
 *   responsibility line and the supplementary guidance are compiled **into the
 *   task text** instead. Without it, a Codex child would receive an anonymous
 *   assignment and would have no idea which expert it is standing in for.
 *
 * {@link compileSpawnTask} is `spawn`'s name for the base assignment. It is a
 * separate function because the plan names it and because it is the seam a
 * spawn-only paragraph would go in — duplicating the persona text into the task
 * as well would send every identity statement twice, to a backend that is
 * already receiving it properly.
 *
 * ## Which requirements a child is sent
 *
 * The requirements block is split by **domain** — `legal`, `engineering`,
 * `general` — because the same numbered list used to end with "引用法条…引用案例…"
 * for every agent in every Workspace, which told a coding agent to cite statutes.
 * See {@link subagentDomain} for how the domain is decided and why `legal`
 * remains the fallback.
 *
 * ## Template safety
 *
 * Both compiled texts become `systemPrompt` sections, and section text is
 * interpolated with **strict** `{{variable}}` references: an unknown reference
 * throws and takes down the prompt assembly. Subagent names, descriptions and
 * instructions are user-authored, so a stray `{{…}}` in them would break the
 * parent's *own* next step — a failure a long way from its cause and very hard
 * to attribute. {@link sanitizeTemplateText} neutralizes the delimiter before
 * any user text enters a section.
 *
 * @module dsh-workspace-profile/subagent-registry
 */

import { randomUUID } from 'node:crypto';

import { InvalidSubagentError } from './errors.js';
import {
  SUBAGENT_BACKENDS,
  defaultKeyFor,
  findDuplicateKey,
  subagentBackend,
  validateSubagentEdit,
} from './policy.js';

/**
 * Neutralize prompt-template delimiters in user-authored text.
 *
 * `{{` becomes `{ {` and `}}` becomes `} }`. The rendered text still reads
 * naturally and no reference is ever formed, which is the point: the section
 * interpolation is strict, so an accidental `{{foo}}` would abort prompt
 * assembly for the *parent* session rather than for the Subagent it was typed
 * into.
 *
 * @param {unknown} value - user-authored text.
 * @returns {string} text safe to place in a prompt section.
 */
export function sanitizeTemplateText(value) {
  if (typeof value !== 'string') return '';
  return value.replaceAll('{{', '{ {').replaceAll('}}', '} }');
}

/**
 * Build a new definition from user input.
 *
 * The id is assigned here and never again; the key defaults to an opaque but
 * grammar-valid form when the user has not chosen one, because transliterating
 * a Chinese name automatically produces a key nobody can predict or remember.
 *
 * @param {object} input - the fields the user supplied.
 * @param {string} input.name - display name.
 * @param {string} [input.key] - requested key; defaults to `agent-<short id>`.
 * @param {string} input.description - one-line responsibility.
 * @param {'spawn'|'codex'} [input.backend] - the execution backend; defaults to `spawn`.
 * @param {string} [input.provider] - LLM route provider; required for `spawn`.
 * @param {string} [input.model] - LLM route model; required for `spawn`.
 * @param {string} [input.reasoningEffort] - adapter-owned effort id.
 * @param {string} [input.instructions] - supplementary working guidance.
 * @param {boolean} [input.enabled] - defaults to enabled.
 * @param {Record<string, any>} existing - the Workspace's current definitions by id.
 * @param {string} now - ISO-8601 instant to stamp.
 * @returns {any} the complete, validated definition.
 * @throws {InvalidSubagentError} when any field or the key uniqueness rule fails.
 */
export function createDefinition(input, existing, now) {
  const id = randomUUID();
  const key = typeof input.key === 'string' && input.key.trim() !== '' ? input.key.trim() : defaultKeyFor(id);
  /** @type {any} */
  const candidate = {
    id,
    key,
    name: typeof input.name === 'string' ? input.name.trim() : '',
    description: typeof input.description === 'string' ? input.description.trim() : '',
    // A create is exactly the moment the plan says an explicit backend is
    // written: "只有用户新建或者主动编辑 Subagent 时，才保存明确的 backend". An
    // *unspecified* backend becomes `spawn` — but an unrecognised one is passed
    // through so validation refuses it, rather than being quietly rewritten to
    // the transport this build happens to prefer.
    backend: input.backend === undefined ? SUBAGENT_BACKENDS[0] : input.backend,
    provider: typeof input.provider === 'string' ? input.provider.trim() : '',
    model: typeof input.model === 'string' ? input.model.trim() : '',
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  if (typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim() !== '') {
    candidate.reasoningEffort = input.reasoningEffort.trim();
  }
  if (typeof input.instructions === 'string' && input.instructions.trim() !== '') {
    candidate.instructions = input.instructions;
  }

  assertValid(undefined, candidate, existing);
  return candidate;
}

/**
 * Apply a patch to an existing definition.
 *
 * `id` and `key` are never *changed* here: they are the definition's durable
 * address, and offering an "edit" affordance for them would invite a rename that
 * silently breaks every delegation text already written in a session log.
 * Changing a key means duplicating and deleting.
 *
 * ## Why the immutability check compares values, not key presence
 *
 * It used to refuse any patch that merely **mentioned** `id`, `key` or
 * `createdAt` — and that broke every edit this plugin offers, silently, for two
 * reasons that are worth writing down because both are still true:
 *
 * - **The Settings page echoes the whole definition back.** The enable/disable
 *   switch sends `{...definition, enabled: !enabled}` and the editor sends the
 *   form's fields, so `id` and `key` are in every patch by construction. The
 *   refusal arrived as `{saved:false, code:'invalid-subagent'}` and rendered as
 *   an error notice, so the switch looked broken rather than refused.
 * - **`validateSubagentEdit` already checks the values.** It compares
 *   `previous.id !== next.id` and `previous.key !== next.key`. The presence check
 *   added nothing except a false refusal.
 *
 * The loud refusal is still here — it just fires when a value actually differs,
 * which is the thing the rule is about. `createdAt` is included because nothing
 * else protects it: this function starts from `{...previous}` and would
 * otherwise ignore an attempt to rewrite the creation stamp.
 *
 * @param {any} previous - the stored definition.
 * @param {Record<string, any>} patch - the fields to change.
 * @param {Record<string, any>} existing - the Workspace's current definitions by id.
 * @param {string} now - ISO-8601 instant to stamp.
 * @returns {any} the updated, validated definition.
 * @throws {InvalidSubagentError} when the patch is malformed or the result invalid.
 */
export function updateDefinition(previous, patch, existing, now) {
  if (previous === undefined || previous === null) {
    throw new InvalidSubagentError('cannot update a Subagent that does not exist');
  }
  const forbidden = ['id', 'key', 'createdAt']
    .filter((field) => field in patch && patch[field] !== previous[field]);
  if (forbidden.length > 0) {
    throw new InvalidSubagentError(
      `${forbidden.join(', ')} cannot be changed after creation. To change a key, duplicate this Subagent under the new key and delete the original.`,
      { fields: forbidden },
    );
  }

  /** @type {any} */
  const candidate = { ...previous };
  for (const field of ['name', 'description', 'provider', 'model']) {
    if (field in patch) {
      candidate[field] = typeof patch[field] === 'string' ? patch[field].trim() : patch[field];
    }
  }
  // `backend` is not trimmed and not defaulted. An *absent* key, or one
  // explicitly `undefined`, means "this write says nothing about the backend",
  // which is the compatibility rule: a pre-0.6.0 definition edited by a caller
  // that does not know the field keeps running exactly where it ran. Any other
  // value replaces it, including a bad one — validation refuses that loudly
  // instead of letting a typo silently move the work to `spawn`.
  if ('backend' in patch && patch.backend !== undefined) {
    candidate.backend = patch.backend;
  }
  if ('instructions' in patch) {
    const value = patch.instructions;
    if (typeof value !== 'string' || value.trim() === '') {
      delete candidate.instructions;
    } else {
      candidate.instructions = value;
    }
  }
  if ('reasoningEffort' in patch) {
    const value = patch.reasoningEffort;
    if (typeof value !== 'string' || value.trim() === '') {
      delete candidate.reasoningEffort;
    } else {
      candidate.reasoningEffort = value.trim();
    }
  }
  if ('enabled' in patch) {
    candidate.enabled = patch.enabled === true;
  }
  candidate.updatedAt = now;

  assertValid(previous, candidate, existing);
  return candidate;
}

/**
 * Assert that an edit is allowed, raising one error that names every problem.
 *
 * A field-level error per problem would make the Settings dialog report one
 * problem per save attempt; collecting them lets it show all of them at once.
 *
 * @param {any} previous - the stored definition, or `undefined` for a create.
 * @param {any} candidate - the proposed definition.
 * @param {Record<string, any>} existing - the Workspace's definitions by id.
 * @returns {void}
 * @throws {InvalidSubagentError} with every problem in the message.
 */
function assertValid(previous, candidate, existing) {
  const problems = validateSubagentEdit(previous, candidate);
  if (problems.length > 0) {
    throw new InvalidSubagentError(`this Subagent cannot be saved: ${problems.join('; ')}`, { problems });
  }

  const others = { ...existing };
  delete others[candidate.id];
  const clash = Object.values(others).find((definition) => definition?.key === candidate.key);
  if (clash !== undefined) {
    throw new InvalidSubagentError(
      `the key "${candidate.key}" is already used by "${clash.name}" in this Workspace. Keys must be unique within a Workspace; the same key in a different Workspace is fine.`,
      { key: candidate.key, conflictWith: clash.id },
    );
  }

  // A create must not push the Workspace over the uniqueness rule either; this
  // runs the same check the read path runs, so a document that somehow holds a
  // duplicate cannot be extended.
  const duplicate = findDuplicateKey({ ...existing, [candidate.id]: candidate });
  if (duplicate !== null) {
    throw new InvalidSubagentError(`the key "${duplicate}" is already used by another Subagent in this Workspace`);
  }
}

/**
 * Compile a definition's persona.
 *
 * The persona states identity, responsibility and the boundaries the agent must
 * not cross. It deliberately does **not** restate case facts, the AGENTS file,
 * or any Skill body: the child reads AGENTS itself, and case facts belong in the
 * assignment, where they can be attributed to a source.
 *
 * @param {any} definition - the stored definition.
 * @param {object} context - the Workspace context to bind the agent to.
 * @param {string} context.workspaceTitle - the Workspace's display title.
 * @param {string} context.profileLabel - the Profile's display label.
 * @param {string} context.perspectiveLabel - the effective Perspective's label, or `''`.
 * @returns {string} the persona text, already template-safe.
 */
export function compilePersona(definition, context) {
  const name = sanitizeTemplateText(definition.name);
  const description = sanitizeTemplateText(definition.description);
  const instructions = sanitizeTemplateText(definition.instructions ?? '');

  const lines = [`你是本工作区（${sanitizeTemplateText(context.workspaceTitle)}）的「${name}」。`, ''];
  lines.push('职责：', description, '');
  if (instructions !== '') {
    lines.push('补充要求：', instructions, '');
  }
  lines.push(
    `你当前所处的工作区类型是 ${sanitizeTemplateText(context.profileLabel)}${
      context.perspectiveLabel === '' ? '' : `，工作立场是 ${sanitizeTemplateText(context.perspectiveLabel)}`
    }。`,
  );
  lines.push(
    '你受到当前 Workspace 的 AGENTS、Profile、Perspective、Skill、工具与权限规则的约束；' +
      '这些规则优先于本段人设，本段人设不扩大任何权限，也不豁免任何审批。',
  );
  lines.push('你没有父会话的历史记录，只能依据本次任务说明和你自己读到的材料工作。');
  return lines.join('\n');
}

/**
 * The built-in engineering roles, by key.
 *
 * Requirement 2 of the assignment differs by domain, and 0.6.0 deliberately adds
 * **no** stored field for it (the plan's own preference: "如果不想新增字段，也可以
 * 先由内置模板决定。建议优先后者"). What decides the domain is therefore the
 * role the definition stands in for, and for the three engineering roles of this
 * plugin that is their key — the same keys the built-in templates create.
 *
 * This table is not a routing rule and does not pick an agent; it only decides
 * which *requirements paragraph* the chosen agent is sent.
 *
 * @type {readonly string[]}
 */
export const ENGINEERING_SUBAGENT_KEYS = Object.freeze(['coding', 'code-expert', 'code-architect']);

/**
 * Which requirement set a definition is sent.
 *
 * `legal` is the fallback, and that is a deliberate compatibility decision rather
 * than a classification of anyone's work: every definition stored before 0.6.0
 * received the legal requirements paragraph, and silently dropping it from a
 * real legal agent's assignment would be a regression this upgrade is not
 * allowed to cause. So only the cases the plan actually names move:
 *
 * - a `codex` definition is engineering work by construction (the backend exists
 *   to run repository tasks), and
 * - the three built-in engineering template keys are engineering work wherever
 *   they are used — including inside a litigation Workspace, where the fallback
 *   would otherwise hand 码农 the statute-citation rule.
 *
 * `general` is implemented by {@link requirementLines} and reachable through
 * {@link compileBaseTask}'s `domain` argument, but no definition resolves to it
 * in this version. Doing so would require either a stored `domain` field or a
 * heuristic over names, and both would change what existing definitions receive.
 * It is recorded in `docs/MILESTONE-0.6.md` as a deliberate deferral.
 *
 * @param {any} definition - the stored definition.
 * @returns {'legal'|'engineering'} the requirement set to compile.
 */
export function subagentDomain(definition) {
  if (subagentBackend(definition) === 'codex') return 'engineering';
  const key = definition?.key;
  return typeof key === 'string' && ENGINEERING_SUBAGENT_KEYS.includes(key) ? 'engineering' : 'legal';
}

/**
 * The numbered requirements every assignment ends with, by domain.
 *
 * @param {'legal'|'engineering'|'general'} domain - which requirement set.
 * @returns {string[]} the numbered lines, already prefixed.
 */
export function requirementLines(domain) {
  const verifiability = '只依据可核验的材料与来源下结论；无法核验的内容必须显式标注，不得作为事实陈述。';
  const conclusions = '结论前先写成立条件；信息不足时说明缺什么，而不是用一般性表述填补。';
  const language = '输出使用与任务相同的语言。';
  if (domain === 'engineering') {
    return [
      `1. ${verifiability}`,
      '2. 引用代码必须给出文件路径与函数/符号名；没有实际读过的代码不得凭记忆引用。',
      '3. 区分「已核实（实际读过或实际运行过）/ 推断 / 未验证」，不要把推断写成已验证的结论。',
      `4. ${conclusions}`,
      `5. ${language}`,
    ];
  }
  if (domain === 'general') {
    return [
      `1. ${verifiability}`,
      '2. 区分「已核实 / 推断 / 未知」，不要把推断写成事实。',
      `3. ${conclusions}`,
      `4. ${language}`,
    ];
  }
  return [
    `1. ${verifiability}`,
    '2. 引用法条给出法规名称与条号，引用案例给出案号与法院；不确定时说明不确定。',
    '3. 区分「已查明事实 / 当事人主张 / 推断 / 未知」，不要把推断写成事实。',
    `4. ${conclusions}`,
    `5. ${language}`,
  ];
}

/**
 * The workspace framing and the caller's verbatim task, without the requirements.
 *
 * Split out so {@link compileBaseTask} and {@link compileCodexTask} cannot drift
 * on the part that must be identical in both: the Perspective the child works
 * from, the Matter it sits inside, and the task text itself.
 *
 * @param {object} input - the framing inputs (see {@link compileBaseTask}).
 * @returns {string[]} the lines, in order.
 */
function taskBlockLines({ task, workspaceTitle, profileLabel, perspectiveLabel, perspectiveOverridden, matter }) {
  const body = typeof task === 'string' ? task.trim() : '';
  return [
    '下列任务由同一工作区中的主 Agent 派遣，你没有父会话的历史，请仅依据本说明与自行读取的材料完成。',
    '',
    `工作区：${sanitizeTemplateText(workspaceTitle)}`,
    `工作区类型：${sanitizeTemplateText(profileLabel)}`,
    perspectiveLabel === ''
      ? '工作立场：未指定'
      : `工作立场：${sanitizeTemplateText(perspectiveLabel)}`
        + (perspectiveOverridden === true ? '（本次会话指定）' : '（工作区默认）'),
    ...matterContextLines(matter),
    '',
    '任务：',
    '"""',
    body,
    '"""',
  ];
}

/**
 * Compile the assignment handed to a child Agent.
 *
 * The task text is the model's own and is passed through verbatim inside a
 * delimiter — rewriting it here would silently substitute this plugin's reading
 * of the request for the user's. What the compiler adds is the context the child
 * cannot recover on its own: which Workspace and stance it is working under, and
 * the standing requirements for its domain.
 *
 * @param {object} input - the compilation inputs.
 * @param {string} input.task - the task text, verbatim from the caller.
 * @param {string} input.workspaceTitle - the Workspace's display title.
 * @param {string} input.profileLabel - the Profile's display label.
 * @param {string} input.perspectiveLabel - the effective Perspective's label, or `''`.
 * @param {boolean} [input.perspectiveOverridden] - whether that stance came from the
 *   session rather than the Workspace. The parent's own section states its source,
 *   so the child is told the same thing rather than being left to assume the stance
 *   is the permanent one.
 * @param {object|null} [input.matter] - the CaseBench Matter the Workspace sits
 *   inside, when one was discovered. Its fields come off a file in the user's own
 *   workspace, so every one of them is sanitized like any other user-authored text.
 * @param {'legal'|'engineering'|'general'} [input.domain] - which requirement set
 *   to append. Defaults to `legal`, the pre-0.6.0 behaviour for every definition.
 * @returns {string} the complete prompt for the child.
 */
export function compileBaseTask(input) {
  return [
    ...taskBlockLines(input),
    '',
    '要求：',
    ...requirementLines(input.domain ?? 'legal'),
  ].join('\n');
}

/**
 * Compile the assignment for the `spawn` backend.
 *
 * The identity and the route ride the request's own fields for this backend
 * (`persona`, `agentOptions`), so the assignment is the base text and nothing
 * else. See the module note for why this is a named function rather than an
 * alias.
 *
 * @param {object} input - the same inputs {@link compileBaseTask} takes.
 * @returns {string} the complete prompt for the child.
 */
export function compileSpawnTask(input) {
  return compileBaseTask(input);
}

/**
 * The engineering working principles a Codex child is held to.
 *
 * Stated in the assignment rather than in a persona because this backend has no
 * persona channel. They are general engineering discipline, not facts about the
 * repository: nothing here may claim what the code does before it has been read.
 */
const CODEX_ENGINEERING_PRINCIPLES = Object.freeze([
  '先读后改：动手前先读相关源码、配置与项目约束，不凭猜测修改代码。',
  '优先复用：先找项目已有的架构、工具与基础设施，不为"以后可能有用"新增抽象。',
  '自己验收：改完要跑一遍相关测试、构建或检查；跑不了的，说明为什么跑不了。',
  '说清边界：明确区分"实际检查/修改了什么"与"没有验证的部分"，以及需要人工决定的问题。',
]);

/**
 * Compile the assignment for the `codex` backend.
 *
 * This backend advertises **no** persona capability, so the identity has to live
 * in the text: the role name, the responsibility line and the supplementary
 * guidance are prepended here, together with the engineering principles the role
 * is held to. Apart from that, the framing and the verbatim task are the same
 * lines {@link compileBaseTask} produces — one implementation, two backends.
 *
 * @param {object} input - the compilation inputs.
 * @param {any} input.definition - the stored definition, for the role text.
 * @param {string} input.task - the task text, verbatim.
 * @param {string} input.workspaceTitle - the Workspace's display title.
 * @param {string} input.profileLabel - the Profile's display label.
 * @param {string} input.perspectiveLabel - the effective Perspective's label, or `''`.
 * @param {boolean} [input.perspectiveOverridden] - whether the stance came from the session.
 * @param {object|null} [input.matter] - the resolved Matter facts, if any.
 * @returns {string} the complete prompt for the child.
 */
export function compileCodexTask({ definition, ...input }) {
  const name = sanitizeTemplateText(definition?.name);
  const description = sanitizeTemplateText(definition?.description);
  const instructions = sanitizeTemplateText(definition?.instructions ?? '');
  const role = ['角色：' + name, '', '职责：', description];
  if (instructions !== '') {
    role.push('', '补充要求：', instructions);
  }
  return [
    ...role,
    '',
    ...taskBlockLines(input),
    '',
    '工程原则：',
    ...CODEX_ENGINEERING_PRINCIPLES.map((line) => `- ${line}`),
    '',
    '验收要求：',
    ...requirementLines(input.domain ?? 'engineering'),
  ].join('\n');
}

/**
 * Compile the assignment for one definition, by backend.
 *
 * The single place the backend selects a compiler, so a caller cannot assemble a
 * Codex request out of spawn's pieces (or the reverse) by accident.
 *
 * @param {object} input - the compilation inputs (see {@link compileBaseTask}).
 * @param {any} input.definition - the stored definition.
 * @returns {string} the prompt for the child.
 */
export function compileTaskFor({ definition, ...input }) {
  return subagentBackend(definition) === 'codex'
    ? compileCodexTask({ definition, ...input, domain: 'engineering' })
    : compileSpawnTask({ ...input, domain: subagentDomain(definition) });
}

/**
 * The Matter context a child cannot recover on its own.
 *
 * A dispatched child gets no parent history, so without this it would not know
 * which matter it is working on. The **effective** stance is already the 工作立场
 * line immediately above; the Matter's **formal** role is printed here so the two
 * are adjacent and a disagreement between them is visible rather than hidden —
 * the stance in force is the one to work from, and this records what the matter
 * itself says.
 *
 * @param {object|null|undefined} matter - the resolved Matter facts, or nothing.
 * @returns {string[]} the lines to append, or `[]` when there is no Matter.
 */
function matterContextLines(matter) {
  if (matter === null || matter === undefined || typeof matter !== 'object') return [];
  const field = (label, value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text === '' ? null : `  ${label}：${sanitizeTemplateText(text)}`;
  };
  const fields = [
    field('名称', matter.name),
    field('Matter ID', matter.id),
    field('类型', matter.type),
    field('正式角色', matter.role),
    field('程序阶段', matter.stage),
  ].filter((line) => line !== null);
  if (fields.length === 0) return [];
  return ['', '案件 (Matter)：', ...fields];
}

/**
 * Render the child's terminal output as text for the parent's tool result.
 *
 * `output` is the child's last non-empty assistant message as content blocks.
 * Only text blocks are rendered: an image or file block cannot be inlined into
 * a tool result faithfully, and silently dropping it would misrepresent the
 * child's answer, so it is named instead.
 *
 * @param {readonly any[]} output - the `SubagentResult.output` blocks.
 * @returns {string} the rendered text; `''` when the child produced none.
 */
export function renderSubagentOutput(output) {
  if (!Array.isArray(output) || output.length === 0) return '';
  const parts = [];
  for (const block of output) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block?.type !== undefined) {
      parts.push(`[${block.type} 内容块已省略]`);
    }
  }
  return parts.join('\n').trim();
}

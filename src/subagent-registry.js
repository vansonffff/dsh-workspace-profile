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
 * ## Two compilers, two audiences
 *
 * - {@link compilePersona} builds the child's *identity*: who it is, what it is
 *   responsible for, what it must not do. It is injected as the child's persona
 *   and shadows the deployment persona for that child alone.
 * - {@link compileDispatchTask} builds the child's *assignment*. The `spawn`
 *   backend inherits zero parent context, so the assignment has to stand alone.
 *   The compiler supplies the parts the model cannot be trusted to remember (the
 *   effective Perspective, the workspace framing, and the fact that no parent
 *   history exists); it does **not** rewrite the model's task text, because the
 *   model — not this plugin — is the one that knows what the user asked for.
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
import { defaultKeyFor, findDuplicateKey, validateSubagentEdit } from './policy.js';

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
 * @param {string} input.provider - LLM route provider.
 * @param {string} input.model - LLM route model.
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
 * `id` and `key` are absent from the accepted patch keys entirely: they are the
 * definition's durable address, and offering an "edit" affordance for them would
 * invite a rename that silently breaks every delegation text already written in
 * a session log. Changing a key means duplicating and deleting.
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
  const forbidden = ['id', 'key', 'createdAt'].filter((field) => field in patch);
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
 * Compile the assignment handed to a child Agent.
 *
 * The task text is the model's own and is passed through verbatim inside a
 * delimiter — rewriting it here would silently substitute this plugin's reading
 * of the request for the user's. What the compiler adds is the context the child
 * cannot recover on its own: which Workspace and stance it is working under, and
 * the standing rule that unverifiable claims must be labelled rather than
 * asserted.
 *
 * @param {object} input - the compilation inputs.
 * @param {string} input.task - the task text, verbatim from the caller.
 * @param {string} input.workspaceTitle - the Workspace's display title.
 * @param {string} input.profileLabel - the Profile's display label.
 * @param {string} input.perspectiveLabel - the effective Perspective's label, or `''`.
 * @returns {string} the complete prompt for the child.
 */
export function compileDispatchTask({ task, workspaceTitle, profileLabel, perspectiveLabel }) {
  const body = typeof task === 'string' ? task.trim() : '';
  const lines = [
    '下列任务由同一工作区中的主 Agent 派遣，你没有父会话的历史，请仅依据本说明与自行读取的材料完成。',
    '',
    `工作区：${sanitizeTemplateText(workspaceTitle)}`,
    `工作区类型：${sanitizeTemplateText(profileLabel)}`,
    perspectiveLabel === '' ? '工作立场：未指定' : `工作立场：${sanitizeTemplateText(perspectiveLabel)}`,
    '',
    '任务：',
    '"""',
    body,
    '"""',
    '',
    '要求：',
    '1. 只依据可核验的材料与来源下结论；无法核验的内容必须显式标注，不得作为事实陈述。',
    '2. 引用法条给出法规名称与条号，引用案例给出案号与法院；不确定时说明不确定。',
    '3. 区分「已查明事实 / 当事人主张 / 推断 / 未知」，不要把推断写成事实。',
    '4. 结论前先写成立条件；信息不足时说明缺什么，而不是用一般性表述填补。',
    '5. 输出使用与任务相同的语言。',
  ];
  return lines.join('\n');
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

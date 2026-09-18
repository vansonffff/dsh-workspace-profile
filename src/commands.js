/**
 * The `/agent` and `/perspective` human commands.
 *
 * ## One dispatcher, two entry points
 *
 * `/agent` calls the same {@link import('./subagent-dispatch.js').SubagentDispatcher}
 * the model tool does. A second implementation would drift on the route
 * preflight, the depth cap, cancellation and disposal — none of which a user can
 * see, and all of which matter. What this module owns is only the *grammar* of a
 * typed line, which is the one thing a command has that a tool call does not.
 *
 * ## Why the grammar is parsed here
 *
 * The command seam has no argument specification — `input` is a placeholder hint
 * and nothing more — so every command parses its own `rawInput`. That is not a
 * limitation to work around: it is where the spellings these commands accept are
 * decided, and where a rejected one can explain itself.
 *
 * ## Why `/perspective` is the *only* way a stance changes
 *
 * A user who says "从投资人角度分析一下" means *that question*, not "reconfigure
 * this matter". Classifying that sentence is exactly the kind of inference that
 * is wrong often enough to be worse than not trying: one misread permanently
 * reframes the conversation, and the user has no way to see that it happened.
 * So the runtime never infers a stance. It changes when the user configures the
 * Workspace, or when they type `/perspective` — both explicit, both reversible,
 * and the second is scoped to one session so trying a stance on cannot silently
 * become the matter's position.
 *
 * @module dsh-workspace-profile/commands
 */

import { SubagentRunFailedError, WorkspaceProfileError } from './errors.js';
import { PERSPECTIVE_LABELS, perspectivesFor } from './policy.js';
import { sessionIdOf } from './session-perspective.js';

/** The registered command name, without the leading slash. */
export const AGENT_COMMAND = 'agent';

/** The `/perspective` command name, without the leading slash. */
export const PERSPECTIVE_COMMAND = 'perspective';

/** The argument that clears a session override. */
export const PERSPECTIVE_DEFAULT_ARG = 'default';

/**
 * Register `/agent`.
 *
 * @param {any} ctx - a context that has the `commands` service.
 * @param {object} deps - dependencies.
 * @param {() => any} deps.getDispatcher - the unified dispatcher.
 * @returns {string} the registered command name.
 */
export function registerAgentCommand(ctx, { getDispatcher }) {
  ctx.commands.register({
    name: AGENT_COMMAND,
    description:
      '列出当前工作区可用的专家 Subagent，或直接调用其中一个：/agent <key> <完整任务>。'
      + '与模型工具 workspace_subagent 共用同一套派遣逻辑。',
    input: {
      hint: '<key> <完整任务> — 留空则列出当前工作区可用的 Subagent',
    },
    // The task text is the user's own words and already rides the session log as
    // the command's input; recording it again in `command/run` would duplicate
    // it for no reader.
    recordInput: true,
    async handler(invocation) {
      const dispatcher = getDispatcher();
      try {
        const { reference, task } = parseAgentInput(invocation.rawInput);

        if (reference === undefined) {
          return { kind: 'success', text: renderAgentList(dispatcher.listFor(invocation.agent)) };
        }
        if (task === '') {
          return {
            kind: 'error',
            text:
              `用法：/agent ${reference} <完整任务>\n\n`
              + '任务必须写得脱离本会话也能独立执行——child Agent 看不到这次对话的历史。请写清：要解决的具体问题、'
              + '必要事实与限制、可读取的材料路径、当前立场、预期输出格式，以及无法核验时如何表达。',
          };
        }

        const outcome = await dispatcher.dispatch({
          agent: invocation.agent,
          reference,
          task,
          signal: invocation.signal,
        });
        const route = `${outcome.subagent.provider}/${outcome.subagent.model}${
          outcome.subagent.reasoningEffort === undefined ? '' : ` · ${outcome.subagent.reasoningEffort}`
        }`;
        return {
          kind: 'success',
          text: `【${outcome.subagent.name}】(${route}) 已完成：\n\n${outcome.text === '' ? '（没有文本输出）' : outcome.text}`,
        };
      } catch (error) {
        return { kind: 'error', text: describeFailure(error) };
      }
    },
  });
  return AGENT_COMMAND;
}

/**
 * Parse `/agent`'s input.
 *
 * The first whitespace-delimited token is the agent reference; everything after
 * it, verbatim, is the task. Only the leading separator runs are collapsed — a
 * task's internal newlines and spacing are the user's formatting and are
 * preserved, because a task is prose that gets handed to a model.
 *
 * @param {string} rawInput - the text after the command name.
 * @returns {{ reference: string|undefined, task: string }} the parsed parts.
 */
export function parseAgentInput(rawInput) {
  const text = typeof rawInput === 'string' ? rawInput : '';
  const trimmed = text.replace(/^[\s\u3000]+/, '');
  if (trimmed === '') return { reference: undefined, task: '' };
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (match === null) return { reference: trimmed, task: '' };
  return { reference: match[1], task: match[2].replace(/^[\s\u3000]+/, '') };
}

/**
 * Render the list of enabled Subagents.
 *
 * @param {{ context: any, subagents: any[] }} listing - the dispatcher's listing.
 * @returns {string} the model-facing text.
 */
export function renderAgentList({ context, subagents }) {
  const title = context.workspace?.title ?? context.workspaceId;
  if (subagents.length === 0) {
    return (
      `工作区「${title}」还没有配置任何可用的专家 Subagent。\n\n`
      + '到 Settings → Workspace Composition 添加一个，或在其他工作区中复用同样的配置方式。'
    );
  }
  const rows = subagents.map((definition) => {
    const route = `${definition.provider}/${definition.model}${
      definition.reasoningEffort === undefined ? '' : ` · ${definition.reasoningEffort}`
    }`;
    return `  ${definition.key.padEnd(20)} ${definition.name}  (${route})\n      ${definition.description}`;
  });
  return (
    `工作区「${title}」可用的专家 Subagent：\n\n${rows.join('\n')}\n\n`
    + '调用：/agent <key> <完整任务>\n'
    + '任务必须脱离本会话也能独立执行——child Agent 看不到这次对话的历史。'
  );
}

/**
 * Turn a dispatch failure into text a human can act on.
 *
 * @param {unknown} error - the caught value.
 * @returns {string} the message.
 */
export function describeFailure(error) {
  if (error instanceof WorkspaceProfileError) return error.message;
  if (error instanceof SubagentRunFailedError) return error.message;
  if (error instanceof Error) {
    const code = /** @type {any} */ (error).code;
    return typeof code === 'string' && code !== '' ? `${error.message} [${code}]` : error.message;
  }
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* /perspective                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register `/perspective`.
 *
 * @param {any} ctx - a context that has the `commands` service.
 * @param {object} deps - dependencies.
 * @param {(agent: any) => { policy: any, configured: boolean, workspace: any }} deps.resolveFor - synchronous policy resolution.
 * @param {() => any} deps.getSessionStore - the session override store.
 * @returns {string} the registered command name.
 */
export function registerPerspectiveCommand(ctx, { resolveFor, getSessionStore }) {
  ctx.commands.register({
    name: PERSPECTIVE_COMMAND,
    description:
      '查看或切换**当前会话**的工作立场（Perspective）。只影响本会话，不修改工作区配置：'
      + '/perspective <id> 切换，/perspective default 恢复工作区默认。',
    input: {
      hint: '<id> — 留空则显示当前立场与可选值；default 恢复工作区默认',
    },
    recordInput: true,
    async handler(invocation) {
      try {
        const store = getSessionStore();
        if (store === undefined) {
          return { kind: 'error', text: 'Perspective 状态存储不可用，无法切换立场。' };
        }
        const sessionId = sessionIdOf(invocation.agent);
        if (sessionId === undefined) {
          return { kind: 'error', text: '当前会话没有 session id，无法记录会话级立场。' };
        }

        const { policy, configured } = resolveFor(invocation.agent);
        if (policy === undefined || configured !== true) {
          return {
            kind: 'error',
            text: '当前工作区还没有配置 Profile，因此没有可选的工作立场。请先到 Settings → 工作区 选择工作区类型。',
          };
        }

        const vocabulary = perspectivesFor(policy.profile);
        const argument = (typeof invocation.rawInput === 'string' ? invocation.rawInput : '')
          .trim()
          .toLowerCase();

        if (argument === '') {
          return {
            kind: 'success',
            text: renderPerspectiveStatus({ policy, vocabulary, override: store.get(sessionId), durable: store.durable }),
          };
        }

        if (argument === PERSPECTIVE_DEFAULT_ARG) {
          const had = store.get(sessionId);
          await store.clear(sessionId);
          const fallback = policy.defaultPerspective ?? 'none';
          return {
            kind: 'success',
            text:
              had === undefined
                ? '当前会话本来就没有设置立场覆盖。\n\n' + renderPerspectiveStatus({ policy, vocabulary, override: undefined, durable: store.durable })
                : `已清除当前会话的立场覆盖，恢复工作区默认：${labelOf(fallback)}。\n\n`
                  + renderPerspectiveStatus({ policy, vocabulary, override: undefined, durable: store.durable }),
          };
        }

        // A Profile with no vocabulary beyond `none` genuinely has no stances —
        // say that, rather than reporting an unknown id, because the user's
        // mistake is asking for something this Workspace type does not have.
        if (vocabulary.length <= 1) {
          return {
            kind: 'error',
            text:
              `当前工作区类型（${policy.profile}）不支持 Perspective，因此只有「不设定」一种状态。\n\n`
              + '如果需要按立场工作，请到 Settings → 工作区 把工作区类型改为诉讼或破产重整。',
          };
        }

        if (argument === 'none') {
          // `none` is a legal id, but its meaning as an *override* is "do not use
          // the Workspace default", which is not the same as clearing back to it.
          await store.set(sessionId, 'none');
          return {
            kind: 'success',
            text:
              '当前会话已设为「不设定」：本会话不再使用工作区默认立场，也不注入任何立场说明。\n'
              + '（若要恢复工作区默认立场，请用 `/perspective default`。）',
          };
        }

        if (!vocabulary.includes(argument)) {
          return {
            kind: 'error',
            text:
              `未知的 Perspective「${argument}」。当前工作区类型（${policy.profile}）可选：`
              + `${vocabulary.map((id) => `${id}（${labelOf(id)}）`).join('、')}。`,
          };
        }

        await store.set(sessionId, argument);
        return {
          kind: 'success',
          text:
            `当前会话的立场已切换为：${labelOf(argument)}。\n`
            + '本会话的下一个 step 起生效；工作区默认立场未被修改，新开的会话仍使用默认值。'
            + (store.durable ? '' : '\n\n⚠️ 本次运行没有可用的持久化存储，该立场不会在重启后保留。'),
        };
      } catch (error) {
        return { kind: 'error', text: describeFailure(error) };
      }
    },
  });
  return PERSPECTIVE_COMMAND;
}

/** Human-readable label for a Perspective id. */
function labelOf(id) {
  return PERSPECTIVE_LABELS[id] ?? String(id);
}

/**
 * Render the current stance and what may replace it.
 *
 * @param {object} input - the inputs.
 * @param {any} input.policy - the resolved Workspace policy.
 * @param {readonly string[]} input.vocabulary - the Profile's Perspective ids.
 * @param {string|undefined} input.override - the session override, if any.
 * @param {boolean} input.durable - whether the override survives a restart.
 * @returns {string} the model-facing text.
 */
export function renderPerspectiveStatus({ policy, vocabulary, override, durable }) {
  const fallback = policy.defaultPerspective ?? 'none';
  const lines = [`工作区类型：${policy.profile}`];
  lines.push(`工作区默认立场：${labelOf(fallback)}`);
  lines.push(`本会话覆盖：${override === undefined ? '（无）' : labelOf(override)}`);

  // The effective value is spelled out because it is the one the model actually
  // reads, and computing it from the two lines above is exactly the kind of
  // precedence reasoning a user should not have to do.
  const effective = override === undefined ? fallback : override;
  lines.push(`本会话实际生效：${labelOf(effective)}`);

  if (vocabulary.length <= 1) {
    lines.push('', '该工作区类型没有可选立场。');
  } else {
    lines.push(
      '',
      `可选：${vocabulary.map((id) => `${id}（${labelOf(id)}）`).join('、')}`,
      '用法：/perspective <id> 切换本会话；/perspective default 恢复工作区默认。',
    );
  }
  if (durable === false) {
    lines.push('', '⚠️ 本次运行没有可用的持久化存储，会话立场不会在重启后保留。');
  }
  return lines.join('\n');
}

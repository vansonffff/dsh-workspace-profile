/**
 * The model-facing delegation tool: `workspace_subagent`.
 *
 * ## Why the description carries the delegation contract
 *
 * A `spawn` child inherits **zero** parent context. The tool's schema cannot tell
 * "search the cases on issue two" from a sentence that only makes sense with the
 * conversation in view, so the rule has to live in the description — and it has
 * to be stated as an obligation with examples, because this is the single failure
 * mode that turns a delegation into a wasted child Agent. The description names
 * what a standalone task must contain rather than saying "be specific".
 *
 * ## Why errors are thrown rather than returned
 *
 * A thrown error is what the runtime reports as a failed call, which is what the
 * model needs: it must not read a refusal as an answer. Every message says what
 * to do next, because the model is the reader.
 *
 * @module dsh-workspace-profile/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { WorkspaceProfileError } from './errors.js';

/** The wire name of the tool. */
export const WORKSPACE_SUBAGENT_TOOL = 'workspace_subagent';

/**
 * Register the delegation tool.
 *
 * @param {any} ctx - a context that has the `tools` service.
 * @param {object} deps - dependencies.
 * @param {() => any} deps.getDispatcher - the unified dispatcher.
 * @param {() => any} deps.getCatalog - the model catalog, for call-time revalidation.
 * @returns {string} the registered tool name.
 */
export function registerWorkspaceSubagentTool(ctx, { getDispatcher }) {
  ctx.tools.register(
    defineTool({
      name: WORKSPACE_SUBAGENT_TOOL,
      description:
        'Delegate one self-contained task to a Workspace Subagent — an expert configured for the current Workspace with '
        + 'its own model and role. Use it when the user names one of the Workspace\'s agents ("让案例检索员查一下这个问题"), or '
        + 'when a task clearly belongs to one of the roles listed in the Workspace context.\n\n'
        + 'The child Agent CANNOT see this conversation. Pass a task that stands on its own: the concrete question to answer, '
        + 'the facts and constraints that matter, the paths of any materials it should read, the working stance it should '
        + 'take, the output format you expect, and how it should express what it could not verify. A task like "查一下这个'
        + '问题" or "继续分析" is unusable on its own and will produce a confident answer to the wrong question.\n\n'
        + 'The agent runs in the foreground and returns its final answer. It uses the route (provider, model, reasoning '
        + 'effort) configured for it in Settings → Workspace Composition; you cannot override it here, and the parent '
        + 'session\'s model is never substituted.',
      parameters: {
        agent: {
          type: 'string',
          required: true,
          description:
            'The Workspace Subagent to run: its key (for example "case-researcher") or its display name (for example '
            + '"案例检索员"). The available keys are listed in the Workspace context under "本工作区可用的专家 Subagent".',
        },
        task: {
          type: 'string',
          required: true,
          description:
            'The complete, standalone assignment. Expand every "this", "the above" and "继续" into explicit text: what to '
            + 'answer, the facts and limits that apply, where to read, the stance to take, the expected output shape, and '
            + 'what to do about anything that cannot be verified.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            key: { type: 'string', required: true },
            name: { type: 'string', required: true },
            provider: { type: 'string', required: true },
            model: { type: 'string', required: true },
            reasoningEffort: { type: 'string' },
            childId: { type: 'string', required: true },
            stopReason: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const dispatcher = getDispatcher();
        try {
          const outcome = await dispatcher.dispatch({
            agent: exec.agent,
            reference: args.agent,
            task: args.task,
            signal: exec.signal,
          });
          const route = `${outcome.subagent.provider}/${outcome.subagent.model}${
            outcome.subagent.reasoningEffort === undefined ? '' : ` · ${outcome.subagent.reasoningEffort}`
          }`;
          const header = `【${outcome.subagent.name}】(${route}) 已完成。\n\n`;
          return {
            summary: header + (outcome.text === '' ? '（该 Subagent 没有返回文本输出）' : outcome.text),
            key: outcome.subagent.key,
            name: outcome.subagent.name,
            provider: outcome.subagent.provider,
            model: outcome.subagent.model,
            ...(outcome.subagent.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: outcome.subagent.reasoningEffort }),
            childId: outcome.childId,
            stopReason: outcome.stopReason,
          };
        } catch (error) {
          // Rethrown, not returned: a refusal must reach the model as a failure.
          // The message is already written for that reader; a generic wrapper
          // would throw that away.
          if (error instanceof WorkspaceProfileError) throw error;
          throw error;
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: `Delegate to ${args.agent}`,
          kind: 'read',
          rawInput: args.agent,
        };
      },
    }),
  );
  return WORKSPACE_SUBAGENT_TOOL;
}

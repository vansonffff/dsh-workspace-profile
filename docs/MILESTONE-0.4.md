# MILESTONE 0.4 — A third factory template: 码农

> What this round added, how it was verified, and what it deliberately does not do.
> `docs/MILESTONE-0.3.md` covers the template mechanism itself; this round only adds
> an entry to it. The running record is `../../logs/dsh-workspace-profile.md`.

## What it is

0.3.0 shipped the template dropdown with two legal presets. This round adds the
**first non-legal one**: 码农 (`coding`).

| Template | Key | Route | Scope |
|---|---|---|---|
| 独立评审员 | `reviewer` | `kimi-coding/k3` · max | legal |
| 律师助理 | `assist` | `deepseek-official/deepseek-flash` · max | legal |
| **码农** | **`coding`** | **`deepseek-official/deepseek-flash` · max** | **engineering** |

Its duties, as specified:

> 阅读并分析代码仓库；定位、复现并修复 Bug；编写或修改代码；编写脚本；修改工程配置；
> 编写、运行并修复测试；重构；分析依赖、接口与实现机制；承接 DSH 插件及其他工程开发任务。

## The decision worth recording: the duties stay enumerated

The template's `description` is a single line, and it is the line the model reads
when deciding whether a request belongs to this agent. It would have been shorter
as "负责软件开发" or "写代码、改 Bug" — and both would have been worse, because the
nine duties are not interchangeable:

- **阅读并分析代码仓库** and **分析依赖、接口与实现机制** are read-only
  investigation. They are often what should be delegated *before* anyone edits
  anything, and a description that only says "写代码" would not attract them.
- **DSH 插件及其他工程开发任务** is what makes this template usable in *this*
  workspace at all. The other two templates are legal; this one is the reason a
  Litigation or Bankruptcy Workspace can hand over a plugin fix without first
  re-typing a Subagent.
- **编写、运行并修复测试** explicitly includes *running* tests. Delegating a change
  without running its tests is a different (and worse) delegation than this one.

So the line is a list, punctuated with `；` rather than prose. A test asserts the
duties survive: it checks the description still contains each of the nine as tokens,
so a punctuation tidy-up passes while dropping a duty fails.

## Not domain-specific, on purpose

The other two templates make sense in a legal Workspace. This one does not — and
that is fine, because a template is only ever a *suggestion* in a form: nothing is
stored until 创建 is pressed. It appears in every Workspace, including 诉讼 and 破产
ones. The alternative (offering it only in workspaces that look like development)
would need a notion of "what kind of work this workspace does", which the plugin
does not have and this round does not invent.

## How it was verified

- **230 tests passing** (`node --test "test/*.test.js"`), the same count as before:
  this round extended an existing test rather than adding one.
- The extended test pins `{ key: 'coding', name: '码农', provider: 'deepseek-official',
  model: 'deepseek-flash', effort: 'max' }` and the nine duty tokens.
- The existing catalogue cross-check covers the new template automatically, because
  it walks every `deepseek-official` template and compares the model id against the
  catalogue the local installation declares.
- **Three negative controls, all red as expected:**

  | Deliberately introduced | Test that went red |
  |---|---|
  | `重构；` removed from the duties | the configured templates |
  | `model: 'deepseek-v41-flash'` (display name as id) | the configured templates **and** the catalogue cross-check |
  | `reasoningEffort: 'high'` instead of `'max'` | the configured templates |

  The second control is the useful one: it shows the catalogue cross-check really
  walks this template rather than the two it was written for.

## What it deliberately does not do

- **No new mechanism.** The template schema, the form patch, the create-only
  dropdown and the live route preflight are all from 0.3.0 and unchanged. This round
  adds one array entry, one test extension and documentation.
- **No change to the two legal templates.** Their routes and wording are untouched.
- **No host change**, so no Host restart is involved.

## Relationship to the delegation policy

The owner's rules reserve judgement work (legal relations, disputed issues,
reliability of facts, strategy, the final opinion, final document structure) to the
main Agent, and push mechanical, verifiable, low-judgement work to Subagents. This
template is the engineering counterpart of that split: a Subagent may read a
repository, reproduce a bug and run tests; whether a change is *right* stays with the
main Agent, which reviews the diff and the evidence before accepting it.

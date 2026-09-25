# MILESTONE 0.3 — Subagent factory templates

> What this round added, how it was verified, what it deliberately does not do, and
> why it lives in the browser half. `docs/MILESTONE-0.1*.md` and `MILESTONE-0.2.md`
> cover the earlier rounds. The running record is `../../logs/dsh-workspace-profile.md`.

## What it is

「添加子 Agent」 used to be a blank form: name, key, description, route, guidance —
five fields typed from scratch for every expert, in every Workspace. This round adds
a **模板** dropdown at the top of the create dialog holding factory presets.

```
添加子 Agent
  ├─ 模板        reviewer · assist        ← new: fills the fields below
  ├─ 名称 / Key
  ├─ Route       provider · model · effort
  ├─ 职责描述
  ├─ 补充工作指引
  └─ 启用
```

Picking a template fills name, key, description, route and guidance. Nothing is
saved until 创建 is pressed, and every field stays editable.

Two templates ship:

| Template | Key | Route | Responsibility |
|---|---|---|---|
| 独立评审员 | `reviewer` | `kimi-coding/k3` · max | Independently review a legal position or document from the outside: do not presume the conclusion correct, look for counter-examples and gaps, point out where the basis is thin, and separate 已查明事实 / 主张 / 推断 / 未知. |
| 律师助理 | `assist` | `deepseek-official/deepseek-flash` · max | Carry the bulk repetitive work: collating files, summaries, timelines, party/amount/date/evidence lists, mechanical cross-material comparison, format and table conversion, preliminary retrieval, clearly-ruled batch tasks. |

They are the two halves of the owner's delegation policy: what the assistant may
take over wholesale, and what only an independent party may challenge. Neither
template touches the judgement work reserved to the main Agent (legal relations,
disputed issues, reliability of facts, strategy, the final opinion, the final
document structure) — see "Relationship to the delegation policy" below.

## The decision worth recording: this lives in `client.js`, not the host half

A template is pre-fill material. There is nothing to persist, nothing to share
between machines, and nothing to validate on the host: the route a template
suggests is preflighted **live** by the same `validateRoute` call the dialog already
makes for a hand-typed route.

| | Client half (chosen) | Host half (rejected) |
|---|---|---|
| Editing a template requires | a browser hot reload | **a Host restart** |
| Unit coverage of the data's shape | `test/client-bundle.test.js` | host test |
| Everything else | identical — the route is preflighted either way | |

The host half is a **loader row, fixed at assembly time**; the client bundle
hot-reloads. Paying a restart per template edit to buy a test that can be written
on the client side anyway is the wrong trade. This round therefore changed **no host
file**, and was verified against a running instance without restarting it.

The two rules that follow from "a template is a preset, not a definition":

- **No `id`.** The Host assigns definition ids. A template carrying one would turn
  every "create from template" into an *edit* of whichever Subagent already holds
  that id.
- **No `enabled`.** Whether a new agent starts enabled is the user's answer, not a
  preset's.

Empty string is a **value**, not "leave it alone": the templates carry empty
`instructions`, and "this template adds no extra guidance" has to be sayable rather
than silently meaning "keep whatever was in the box".

## The correction this round produced: `deepseek-v41-flash` is not a model id

The route was specified as `deepseek-v41-flash`. **No such id exists.** From
`dsh-llm-deepseek/lib/index.js` (`deepseek-official`'s default catalogue):

```
id: "deepseek-flash"   name: "DeepSeek-V41-Flash"
id: "deepseek-v4-pro"  name: "DeepSeek-V4-Pro"
```

"V41" belongs to the **display name**. The template writes `deepseek-flash`, and a
test cross-checks every `deepseek-official` template against the catalogues the
local installation actually declares rather than against a copy — a copy would keep
passing after a rename, which is precisely the failure the dialog's preflight would
then report. `max` is a valid effort on that provider.

## Two things that did **not** need configuring

- **`spawn`.** `SUBAGENT_PROVIDER = 'spawn'` is a hard-coded constant in
  `src/subagent-dispatch.js`, and the UI deliberately never mentions it. "All
  Subagents use spawn" was already true; there is no per-definition transport field.
- **Reach of Skills and plugins.** A child is started with `parent: agent` and
  inherits the parent context's Skill and tool reachability. Existing `case-view`
  and `coding` definitions already work this way.

Stating "you may call the Workspace's Skills" inside a template's `instructions`
would be prompt persuasion, not a permission switch — a different thing, and not
done here.

## How it was verified

**Tests: 230 passing** (`node --test "test/*.test.js"`), 225 before, 5 added.

| Added test | What it pins |
|---|---|
| a template is a form preset, never a stored definition | id grammar, no `enabled`, key grammar, required fields, unique ids |
| the two configured templates keep the routes they were given | exact key/name/provider/model/effort for `reviewer` and `assist` |
| a template route names a model the installation actually declares | `deepseek-flash` against the live catalogue |
| applying a template overwrites the fields it owns and nothing else | the patch's exact shape; no `id`; no `enabled`; empty clears |
| the create dialog offers the templates and the edit dialog does not | create-only rendering, placeholder first, the change handler |

**Four negative controls, all red as expected:**

| Deliberately introduced | Tests that went red |
|---|---|
| `model: 'deepseek-v41-flash'` (display name as id) | 3, including the catalogue cross-check |
| `enabled: true` in the template patch | applying a template |
| `onChange` removed from the dropdown | the create-dialog wiring |
| the dropdown rendered in edit mode too | the create-dialog wiring |

The catalogue cross-check is **not silently skipped**: it reads the locally
installed `dsh-llm-deepseek/lib/index.js` (measured 6.1 ms), and negative control 1
turned it red, which is what proves it ran.

**Real browser** (a dedicated tab, not the page the owner was using): selecting each
template read back as

```
reviewer → 独立评审员 | reviewer | kimi-coding       | k3             | max | 模型路由可用
assist   → 律师助理   | assist   | deepseek-official | deepseek-flash | max |
```

`Model` renders as `DeepSeek-V41-Flash`; the stored id is `deepseek-flash`.

## Deployment

**No Host restart and no page hard-refresh were needed** — the change is entirely in
the client bundle, which hot-reloads. A tab opened after the edit carries it. The
running instance was **not** restarted during this round.

## What it deliberately does not do

- **No injection into new Workspaces.** Nothing is written into a Workspace the user
  did not configure; templates only ever fill a form the user then submits.
- **No "save this Subagent as a template".** A template is package data. Making
  templates user-authored would introduce a second store, a migration path and a
  sync question, for a list that is currently two entries long.
- **No layout work on edit mode.** The template control is guarded by `created`, so
  it cannot appear while editing; that guard is pinned by a test, and the browser
  observation covers the create path.

## Relationship to the delegation policy

The owner's delegation rules (`~/.dsh/AGENTS.md` → 工作区子代理委派原则) split work
into "mechanical, verifiable, low judgement density → delegate" and "judgement →
the main Agent". The two templates map onto that split:

- `assist` covers the enumerated delegate list — file extraction, summaries,
  timelines, party/amount/date/evidence lists, mechanical comparison, format
  conversion, preliminary retrieval, batch repetitive tasks.
- `reviewer` is the "independent challenge" role: it may contest and propose
  alternatives, and it does **not** hold the final opinion. Review is delegated;
  adjudication is not.

One rule from that policy applies to every result either template returns and is not
enforceable by any template field: **a child's output is not automatically correct**.
Where an important legal conclusion is involved, the main Agent re-reads the source
material before forming it.

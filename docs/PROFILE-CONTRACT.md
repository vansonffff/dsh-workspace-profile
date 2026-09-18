# Profile and Perspective contract

> This document is the reviewable contract for the text this plugin injects into
> a model's system prompt. `docs/COMPATIBILITY.md` §7 records the *mechanism*;
> this records what may be said with it.

## 1. The four concepts, and where each one lives

```
AGENTS.md          strong, long-lived project rules and permission red lines
Profile            the professional domain and its stable working standards
Perspective        the position this work is done from
Skill              a callable working method
Workspace Subagent who executes a class of subtask, with which route
Workspace Composition  resolves the above per Workspace
```

The first line is not this plugin's. `AGENTS.md`, tool permissions, approval
policy and the sandbox are owned by DSH and are **never** restated, re-parsed or
weakened here.

## 2. Where the text lives

```
profiles/general.md
profiles/litigation.md
profiles/bankruptcy.md
perspectives/bankruptcy/administrator.md
perspectives/bankruptcy/debtor.md
perspectives/bankruptcy/investor.md
perspectives/bankruptcy/creditor.md
perspectives/bankruptcy/restructuring-advisor.md
```

Markdown files beside the code, read once at activation, served from memory. A
change to what the model is told is therefore a reviewable change to a document
rather than an edit buried in a template literal.

`none` has **no file**. "No Perspective" is the absence of a stance, and a file
saying so would invite the model to treat the silence as a stance.

## 3. Prompt section order and stable names

| Section name | Order | Content |
|---|---|---|
| `workspace-profile:context` | 400 | Workspace header, Profile body, Perspective body, the precedence statement |
| `workspace-profile:subagents` | 2800 | The enabled expert directory |

Both are registered **globally** (this plugin's row is in the host composition),
and both compute their text per assembly from `AssembleContext.agent`. Order 400
places the Workspace context after the deployment persona (0) and before
`PLAN_POLICY` (500). Order 2800 sits beside `TOOL_SUBAGENT`, where delegation is
decided. See `docs/COMPATIBILITY.md` §7 for the measured anchor table.

**The names are stable.** Renaming a section name orphans it in a live process
and duplicates it after a reload.

## 4. What a Profile may say

- Domain background: what kinds of matter this is, what the recurring concepts
  are, what a competent practitioner checks first.
- Stable working requirements that hold across every task in the domain.
- The boundaries of the Profile itself.

## 5. What a Profile may not do

1. **It may not override AGENTS, permissions, approval, or the sandbox.** Every
   Profile body ends with a section saying so, and the composed section carries a
   `## 约束优先级` block stating it again **in the injected text** — the model only
   reads what is injected, and this is precisely the rule it must apply when the
   two disagree.
2. **It may not assert facts.** A Profile says how to work, never what is true
   about a matter.
3. **It may not restate AGENTS.** The model reads AGENTS itself; duplication
   creates two copies that can drift, and the injected one would win by position.
4. **It may not carry a case's facts.** Those belong in the conversation and in
   the materials, where they can be attributed.
5. **It may not name a Skill as required.** Recommendations live in a data table
   (`PROFILE_RECOMMENDED_SKILLS`) and are advisory; a recommended Skill that is
   not installed renders as 未安装 and is never written as enabled.

## 6. What a Perspective may say

A Perspective is a **position**, and it must read as one:

- whose position it is, and what that role is responsible for;
- what that role tends to check first;
- what that role must not do — the boundaries that keep it a position rather
  than a licence;
- a closing `## 边界` section stating that it changes nothing except the vantage
  point.

Every injected Perspective is additionally followed by this line, in the injected
text:

> 立场是**本次工作的观察位置**，不是已核实的事实，也不改变任何事实认定要求。
> 用户在当前会话中的明确指示优先于本立场。

The first half exists so the model cannot present a stance as a finding. The
second half exists because a session's explicit instruction outranks the
Workspace default — the user is the one who knows whether today's question is
being asked from the other side.

## 7. Business rules on the Profile/Perspective pair

- `general` and `litigation` accept only `none`.
- `bankruptcy` accepts all six Perspective ids.
- An impossible stored pair is **repaired toward safety** on read (Profile falls
  back to `general`, Perspective to `none`) rather than injected as-is; the
  Settings page keeps showing the stored record so the repair is visible.
- An **unconfigured** Workspace resolves to `general + none + no overrides` at
  runtime — every consumer needs an answer — but **injects nothing at all**. It
  never silently acquires Bankruptcy rules because Bankruptcy is the interesting
  Profile. This is asserted twice: `test/profile-runtime`-level unit coverage and
  `test/integration-plugin.test.js`.

## 8. The expert directory section

`workspace-profile:subagents` lists **only enabled** definitions, one row each:

```
- `case-researcher` — 案例检索员（kimi-coding/k3 · high）：检索并核验…
```

A disabled Subagent is therefore not merely refused — it is invisible, and cannot
be listed and then called.

The section also carries the delegation contract in prose, because the tool schema
cannot express it: the child has **no** parent context, so the assignment must
state the question, the necessary facts and limits, the readable material paths,
the effective stance, the expected output shape, and how to express what could not
be verified. See `docs/COMPATIBILITY.md` §9.

## 9. Template safety

Section text is rendered with **strict** `{{variable}}` interpolation: an unknown
reference throws and aborts assembly for the whole session. Everything
user-authored that enters a section — Workspace title, Subagent name,
description, instructions — is neutralized by `sanitizeTemplateText` first
(`{{` → `{ {`). `test/compilers.test.js` proves the real renderer accepts hostile
input and that no live reference survives.

## 10. Versioning a Profile change

An edit to a Profile body changes what every agent in every Workspace using that
Profile is told — but only **after the Host is restarted**. §2 says the bodies are
read once at activation and served from memory; nothing watches the files
afterwards, and the `hmr` row that would reload host modules ships
`disabled: true` in `dsh-base` and is opt-in per profile. What is true is that
there is no *invalidation* to perform and no history to rewrite — the section text
is composed per assembly, so a reloaded body takes effect at the next step. The
**file read**, however, happens once. Accordingly:

1. A Profile edit is a **product change**, reviewed as one, not a typo fix.
2. The change must describe a **stable** working standard. Anything that is true
   only for one matter belongs in that matter's materials.
3. The precedence and boundary sections must survive the edit. A Profile body
   without `## 与 AGENTS 的关系` is incomplete.
4. `docs/MILESTONE-0.1.md` records what changed and when, because prompt text has
   no runtime version marker a reader could otherwise find.

> Corrected in 0.1.2. This section used to say "no restart", which contradicted §2
> and would have sent a reader to edit a file and watch nothing happen. The
> `查看` button in Settings → 工作区 is the way to confirm what is really loaded:
> it reads the same in-memory texts the sections read.

# Milestone — v0.1.1: the Perspective becomes two layers, and a probe stops lying

> Scope: what changed **after** `MILESTONE-0.1.md`, once the first half of the
> development plan arrived. That half turned out to specify three things the first
> delivery did not have, and one thing that cannot be built on this machine.

## Why this round happened

The original brief was the *second* half of a plan. The first half then arrived,
and it contained the state model the rest of the design assumes:

- **§11** — `Profile → Workspace default Perspective → Session override` — three
  layers, where only two existed.
- **§12** — `/perspective <id> | default`, refusing an unsupported Profile.
- **§15** — session state in its own plugin-owned storage, deliberately *not* in
  the Workspace settings document.
- **§16** — Profile and Perspective as two independent prompt contributions.
- **§7** — `ctx.systemPrompt.context()` rather than `section()`.
- **§17/§18** — Skills in three states, with the recommendation's source shown.

It also asked for something that has to be refused. See "The fork that could not
be built" below.

## What was delivered

| Change | Where |
|---|---|
| Perspective vocabulary moved onto the **Profile** | `src/policy.js` — `PERSPECTIVES_BY_PROFILE` |
| Five **Litigation** perspectives | `perspectives/litigation/{plaintiff,defendant,third-party,appellant,respondent}.md` |
| Session override + storage domain | `src/session-perspective.js` |
| `/perspective` command | `src/commands.js` |
| Profile and Perspective split into two sections | `src/profile-runtime.js` |
| Workspace-level `recommended` Skill state + recommendation source | `src/policy.js`, `src/skill-policy.js`, `src/remote/operations.js` |
| A probe isolation guard | `scripts/isolated-home.mjs` |

The Perspective vocabulary now belongs to the Profile rather than to the plugin:
Litigation offers litigation positions, Bankruptcy offers insolvency roles, and
General offers none. A position from the wrong domain is refused as a *pair*,
which is what stops a Bankruptcy Administrator being stored under a Litigation
Workspace and then injected into a lawsuit.

## The `/perspective` layer model

```
Workspace default  ──┐
                     ├──▶  effective stance  ──▶  the Perspective section
Session override   ──┘        (override wins)
```

`none` is a legal override and means **"no stance for this session"** — which is
why `/perspective default` exists separately, to mean "go back to the Workspace's
answer". Collapsing the two would make it impossible to silence a stance for one
conversation without also changing what every future session gets.

An override deliberately outlives a Workspace reconfiguration — it is keyed by
session, not by Workspace — so a Workspace that moved from Bankruptcy to
Litigation can still hold an override naming `administrator`. That override is
**dropped, not translated**: the Workspace default applies instead. Injecting an
insolvency stance into a lawsuit because of a stale key would be the worse failure.

## Evidence

### Automated (117 tests, all passing)

```bash
node --test "test/*.test.js"        # 117 / 117
```

New this round: the three-valued vocabulary's internal consistency (every id
labelled, no cross-Profile collision, no orphan label), cross-domain refusal as a
*property* over every Profile pair, the recommendation merge (Profile ⊕ Workspace,
disabled wins, shared name reported once), the storage domain spec checked by the
storage layer's own `defineDomain`, the store's hydrate/write-through/failed-write
paths, and fourteen `/perspective` command behaviours.

The storage double is deliberately as strict as the contract it stands in for —
synchronous reads, asynchronous writes, reads that throw once closed, and a *fresh
domain instance* per `open()`. A looser double is how "tests green, real machine
broken" happens.

### Real boot (`scripts/perspective-probe.mjs`) — 17/17

Seeds a throwaway home, boots the **user's actual plugin composition**, creates a
real Agent in a configured Litigation Workspace, and drives the real
`commands.execute`:

| Claim | Result |
|---|---|
| `ctx.storageDomain` is mounted in the real web profile | ✔ |
| `/perspective` is registered and reachable | ✔ |
| Workspace default `none` injects no stance | ✔ (empty section) |
| Profile section carries the Litigation body | ✔ |
| Profile section names recommended Skills | ✔ (`legal-case-bench`) |
| Profile section no longer states a stance | ✔ |
| `/perspective plaintiff` → stance injected | ✔ `原告代理人 (Plaintiff)`, source = session override |
| the stance restates the precedence rule | ✔ |
| per-session record persisted | ✔ `storages/workspace_profile_session/perspectives/<sessionId>.json` |
| another session is unaffected | ✔ |
| a Bankruptcy stance under Litigation is refused | ✔ with the vocabulary listed |
| the refusal did not change the stance | ✔ |
| `/perspective default` restores the Workspace default | ✔ |
| status separates default / override / effective | ✔ |

### Real boot, regression (`boot-probe`, `remote-probe`)

Row present and `fiberState: 2`; settings namespace registered; tool and command
registered; `dsh-workspace-profile` in `typert.listPackages()`; prompt sections
present. The Remote snapshot reports the per-Profile vocabulary and
`skillStates: ["recommended","enabled","disabled"]`.

## The fork that could not be built

The first half's §3 recommended forking `dsh-client-ui-settings-skills` as a
"60–70% base". Measured, it is **1,286 lines of TypeScript** across four files
(`policy.ts` 259, `index.ts` 568, `wire.ts` 65, `SkillManagementSection.tsx` 394),
built with `scripts/build.mjs`, pinning `0.1.0-rc.6` and declaring a client
dependency (`@deepseek-ai/dsh-client-runtime`) that does not exist in `0.1.5`.

Its *capability* claims are accurate — it really does implement a shadow provider
that removes a disabled Skill from the model catalog. Its *size* is the problem:
there is no base to fork, and on this machine the build could not run at all,
because `@deepseek-ai/dsh` ships as a built distribution with no TypeScript and no
build step. The equivalent functionality already existed here, verified, so the
fork was declined with the reasoning recorded rather than silently skipped.

Note also that the repo is narrower than the plan credits: it manages only
user-level and project Skills — `custom` and bundled Skills are "never shown or
toggled".

## Where the plan is wrong as written

| Plan | Reality |
|---|---|
| §14 namespace `workspace-context.policy` | **Rejected.** `dsh-settings` validates `/^[a-z][a-z0-9-]*$/`; a dot is illegal. And the rejection surfaces inside a `ctx.inject` callback, where Cordis swallows it — the plugin reports "activated" while the namespace was never registered. |
| §21 TypeScript layout | Impossible here (no build step). |
| §22 two HTTP endpoints via `ctx.webServer` | Typert Remote is the native surface, already in place. The plan's *intent* — "do not design a dozen endpoints" — is honoured. |
| §7 `systemPrompt.context()` for Profile/Perspective | **Deliberately declined.** `section()` and `context()` take the same `text: (context) => string` and differ only in channel. The runtime-context channel is volatile per-turn state and is *suppressible* — `dsh-persona` disables it wholesale with `includeRuntimeContext: false`, and any scoped plugin can call `suppressRuntimeContext()`. A standing stance that silently vanishes when another row suppresses runtime context is a worse failure than a system prompt that changes. |
| §6.3 "`litigation` may only use `none`" | Superseded by decision: Litigation now has five positions. The plan's own §2 definition of Perspective ("在这个领域内，我当前站在什么位置处理问题") is domain-neutral; only §10 narrowed it to insolvency. |

## A probe that was not isolated, and the bug it hid

The three original probes took `--home` and handed it to `loadProfile` — but they
never set `DSH_HOME`, and every row that persists anything resolves its root
through `dshHomePath()`, which reads that variable and otherwise falls back to the
*real* `~/.dsh`. `--home` is only part of how the harness finds its state.

Two consequences, both real:

1. **The isolation claim was false.** The probes booted a throwaway *profile*
   against the user's real harness home. Session logs from three runs landed in the
   user's real `~/.dsh/sessions/`; they were identified by their encoded
   `dsh-perspective-probe` path, removed, and the remaining session directories
   confirmed to be exactly the user's two.
2. **It produced a false negative that read like a plugin bug.** The new probe's
   first runs reported the Workspace as unconfigured. The registry was listing the
   *user's* Workspaces — `DSH`, `2026民57-…` — while the seeded one was invisible,
   so every policy lookup missed. The plugin was correct throughout.

`scripts/isolated-home.mjs` now refuses to run without an explicit `--home`,
refuses to run when it canonicalises to the real `~/.dsh` (including via a
non-canonical spelling), and sets `DSH_HOME` before anything composes a root.
Verified in four directions, including that a genuine throwaway home is *allowed*.

## Known limits

- The section order `20` still ties with `agent-presets` on the Settings page
  (cosmetic; the two pages do not conflict).
- `dsh-workspace` emits no events, so a newly created Workspace appears only on
  the next read rather than live.
- The Skill catalog needs a live Agent to include preset-layer Skills; the Host
  reports `scoped: false` with an explanatory sentence when none is live.
- Not browser-verified: a real revision conflict between two windows, the
  not-installed-Skill display path, and UI cancellation of a running child.
- `/perspective` reports the stance change as taking effect from the next step; the
  probe verifies the next *assembly*, which is the same boundary a step crosses.

---

# Addendum — three findings from a real user session

Driven by a user report after using the page: "perspective 生效了" but the
subagent test was inconclusive, plus two screenshots.

## 1. A stored Subagent was invisible to the model (real bug, fixed)

**Symptom.** The user added a Workspace Subagent (高级顾问 / `legal-anylist`). It
saved correctly, appeared in Settings, had `enabled: true` and a route that
preflights clean (`validateRoute kimi-coding/k3/max` → `available: true`). The
model never used it.

**Cause.** `composeAgentDirectorySection(policy, configured)` returned `''` unless
the Workspace was `configured`, and `configured` is derived from
`onboardingStatus === 'configured'` — which records only whether a *Profile* was
picked. `ensurePolicy` (the write path for adding a Subagent) sets timestamps and
nothing else, so a Workspace with a hand-built expert and no Profile resolves to
`configured: false`. The expert directory was therefore suppressed, the model was
never told the expert existed, and nothing anywhere said so.

**Fix.** The gate is gone; the section renders whenever there are enabled
Subagents. `configured` still gates the *Profile* section, which is the question
it was designed for — nobody's domain choice should be inferred. The empty case
needs no flag: a Workspace with no stored policy resolves to a default with no
Subagents.

**Why the tests missed it.** A test named *"an unconfigured workspace contributes
no section at all"* asserted `composeAgentDirectorySection(policy, false) === ''`.
It encoded the bug as a requirement. It is replaced by *"a configured expert is
advertised even before a Profile is chosen"*, which is negative-controlled against
the old code (it fails there) and backed by an integration test asserting the
whole assembly, not just the composer.

## 2. Two blocks on one page disagreed, and the page did not say why (UX, fixed)

Block 一 edits a **draft**; block 二 reports what is **stored** — which is what the
runtime injects. The user set Profile = Litigation and 默认视角 = 原告代理人 in the
form, saw them, and reasonably read them as applied. The stored document had
neither, so nothing was injected at all. `settings.yaml` mtime confirmed no save
had happened.

The unsaved indicator existed, but only in the save bar at the bottom of a long
page. Block 二 now carries a warning when the draft differs from the stored policy,
its heading reads 二、当前生效（已保存）, and block 一's heading says 保存后生效.

## 3. AGENTS 状态 was reported correctly; the screenshot was stale

The user's screenshot showed `Project AGENTS.md 未发现` for the `DSH` workspace,
whose `AGENTS.md` exists (31,967 bytes).

**Not a bug.** Verified by reading the live page — not by inference:

| Workspace | Path has AGENTS.md | Panel says |
|---|---|---|
| DSH | yes | 已发现 ✔ |
| 2026民57-酬诺弹簧-毛坤霞-货款纠纷 | no | 未发现 ✔ |

Getting this right required knowing *which* workspace the panel was showing. An
earlier read of the same DOM returned 已发现 without establishing the selection,
and was one step from being reported as "correct" on no evidence — the exact
failure this repository already has a rule about. The selection was confirmed from
the highlighted list row's `backgroundColor` in the same snapshot as the pill.

## 4. A crowded row crushed its own labels (fixed)

`SubagentRow` is a flex row holding a name, a route and four buttons. The buttons
had neither `white-space: nowrap` nor `flex-shrink: 0`, so an over-constrained row
shrank everything: 高级顾问 broke to one character per line and 编辑 rendered as
编/辑. Buttons now refuse to shrink, the name has a `5em` floor so it cannot be
crushed, the route ellipsises, and the row wraps instead. Measured in the live
browser after the client bundle hot-reloaded: name 107 px on one line, buttons
51 × 27 px with full labels.

## Not a bug: no `AGENTS.md` is injected

Asked whether the plugin should inject a preset `AGENTS.md` into a project that
has none. It should not, and the reason is structural rather than a v0.1 scope
cut: the harness already loads `AGENTS.md` itself and gives more specific files
precedence, so a plugin-written copy would be a second source for the same file
with no way to reconcile them. What the Profile layer exists to contribute is
*runtime* context — domain and stance — precisely because it must not be
duplicated into a file it does not own. Scaffolding a starting `AGENTS.md` for a
new case Workspace is a coherent v0.2 feature, but it is a *generator the user
invokes*, never silent injection.

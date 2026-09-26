# dsh-workspace-profile

**Workspace Composition for DeepSeek Harness.** Give each project directory a
professional working environment: which domain it is, which stance to work from,
which Skills are available, and which expert subagents can be delegated to.

It is an external DSH plugin. It does not fork, patch, or modify DSH Core.

```
Workspace "华北地产重整"     → Profile: Bankruptcy      Perspective: Administrator
                              Skills: legal-case-bench, prc-legal-research-*
                              case-researcher   kimi-coding/k3 · high
                              finance-reviewer  deepseek-official/deepseek-v4-pro · high
```

Then, in a session inside that Workspace:

> 让案例检索员检索争议焦点二的相关案例，并列明可核验来源。

## Editing a Profile or a Perspective

The two bodies the model reads are Markdown files in this package, not fields in
the Settings page. Settings chooses *which* ones apply; the text lives here:

```
profiles/<profile>.md                    general · litigation · bankruptcy
perspectives/<profile>/<stance>.md       litigation/plaintiff.md, bankruptcy/debtor.md, …
```

`none` has no file: "no stance" is the absence of one, and a file saying so would
invite the model to treat the silence as a stance.

**The Host must be restarted for an edit to take effect.** The bodies are read
once, at activation, into memory, and nothing watches them — `hmr`, the row that
would reload host modules, ships `disabled: true` and is opt-in per profile.
(Restarting the browser page is not enough, and neither is the client hot reload.)
To confirm what is actually loaded, open **查看** next to Profile or 默认视角: it
composes from those same in-memory texts.

Two things to know before writing:

- **Do not repeat the framing.** The code already emits `## 当前工作区`, the
  Workspace title and Profile label, the recommended-Skill list and the
  precedence paragraph around a Profile body; around a Perspective body it emits
  `## 当前立场`, the label with its source, and its own precedence blockquote.
  Bodies start at `#` and say only what is theirs to say.
- **Do not write `{{…}}`.** Profile and Perspective bodies are package files and
  are *not* run through the template sanitizer that guards the Workspace title and
  Subagent descriptions. Section text is interpolated strictly, so an accidental
  `{{…}}` aborts prompt assembly for the session.

`docs/PROFILE-CONTRACT.md` is the rulebook: what each may say, what each must not
do, and why a Profile edit is a product change rather than a typo fix.

## What it is

DSH already owns the mechanisms: `AGENTS.md`, agent presets, skills, the model
catalogue, subagents, approvals and the sandbox. This plugin adds the layer that
says **which of those apply to this project**, and persists that answer per
Workspace:

| Concept | Meaning |
|---|---|
| **Profile** | the professional domain — General, Litigation, Bankruptcy |
| **Perspective** | the position this work is done from — e.g. 原告代理人 / 被告代理人 under Litigation, 管理人 / 债务人 / 投资人 under Bankruptcy |
| **Skill policy** | which Skills agents in this Workspace may use: 推荐 / 可用 / 禁用 |
| **Workspace Subagent** | a reusable definition: who does what class of subtask, with which model |
| **Matter** | the CaseBench case this Workspace *is* — read from `matter.yaml`, compared with the Profile and Perspective, never written to |

A Profile is a body of reviewable Markdown, not a label. A Perspective is a
position, and the model is told in as many words that it is not a verified fact.
Neither can override `AGENTS.md`, tool permissions, approval or the sandbox — the
injected text says so, in the injected text.

The Perspective vocabulary belongs to the **Profile**, not to the plugin: a
Litigation Workspace offers litigation positions, a Bankruptcy Workspace offers
insolvency roles, and General deliberately offers none. A position from the wrong
domain is refused rather than translated.

The Perspective has **two layers**, and they are stored separately because they
have different lifetimes:

| Layer | Set where | Applies to | Lifetime |
|---|---|---|---|
| Workspace default | Settings → 工作区 | every session in the Workspace | until changed |
| Session override | `/perspective <id>` | the current session only | the session (`/perspective default` clears it) |

So `/perspective investor` tries a stance on without reconfiguring the matter, and
a new session goes back to the Workspace's own answer. The plugin never infers a
stance from what you type — "从投资人角度分析一下" is an instruction to the model
for that question, not a permanent change of position.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-workspace-profile
```

Then **restart the Host**. The host half is a loader row, and rows are fixed at
assembly time; a page refresh alone will not pick it up.

The row is a single one in `cordis.patch.yml`. That is not stylistic: a package
whose browser bundle is reached by two active loader rows is dropped by
`dsh-client-modules` with only a `logger.warn`, and the only symptom is a Settings
section that never appears.

To turn it off without uninstalling, patch the row in your profile's
`cordis.patch.yml`:

```yaml
- id: workspace-profile
  config:
    enabled: false
```

## Use

**Settings → 工作区 / Workspaces.** Pick a Workspace, set its Profile and default
Perspective, set each Skill's state, and add expert subagents. The model picker is
built from the live `ctx.llm` catalogue, so a route is validated against the same
runtime that will run it — with a live verdict in the dialog.

**Skills have three states, not two.** ★ 推荐 is a hint, not a gate: a recommended
Skill stays fully usable and invocable, and is additionally named in the Workspace's
injected Profile section as a method to reach for first. A recommendation can come
from the workspace *type* (every Litigation Workspace recommends case research) or
from *this* workspace; the row says which, because the two mean different things.
✓ 可用 is the ordinary state and is stored as the absence of an override.
× 禁用 is the scope shadow described below.

**Two ways to delegate.** The model can call `workspace_subagent` on its own when
a request names one of the configured experts or plainly belongs to one of them.
A person can call the same dispatcher directly:

```
/agent                          list this Workspace's experts
/agent case-researcher <task>   run one, in the foreground
```

Both go through one lifecycle, so the route preflight, the depth cap, cancellation
and disposal cannot drift apart between them.

**Templates when creating one.** 添加子 Agent opens with a **模板** dropdown
holding a few factory presets:

| Template | Key | Route |
|---|---|---|
| 独立评审员 | `reviewer` | `kimi-coding/k3` · max |
| 律师助理 | `assist` | `deepseek-official/deepseek-flash` · max |
| 码农 | `coding` | `deepseek-official/deepseek-flash` · max |

Picking one fills name, key, description, route and guidance; nothing is saved until you press 创建,
and every field stays editable. A template is a *starting point*, so it carries no
`id` (the Host assigns that, and a template with one would turn every create into
an edit of the same Subagent) and no `enabled` (whether an agent starts enabled is
your answer, not a preset's). The route it suggests is preflighted live in the same
dialog: if that model is not available in this deployment, the dialog says so rather
than silently substituting one.

They live in `client.js` rather than the host half on purpose: a template is
pre-fill material — nothing to persist, nothing to sync across machines — and its
route is validated by the live preflight anyway, so keeping it in the browser bundle
means editing a template does **not** require restarting the Host.

**The working stance, per session.** `/perspective` reads or moves the position
*this session* works from, without touching what the Workspace is configured to do:

```
/perspective                    show the Workspace default, this session's
                                override, and which one is in effect
/perspective plaintiff          work from this position for this session
/perspective none               use no position for this session
/perspective default            drop the override, back to the Workspace default
```

An override is stored per session (a `workspace_profile_session` storage domain), so
it survives a restart with the session and never leaks into another one. If the
deployment has no storage domain, `/perspective` still works and says that the
choice will not survive a restart, rather than losing it quietly.

## Is it actually in effect, or is this just a UI?

Both halves of that question are real, and they have different answers — which is
why the Settings page now answers them separately.

**The prompt text really is injected.** `src/profile-runtime.js` registers three
dynamic sections against `ctx.systemPrompt`, and each is recomputed at every
prompt assembly. The evidence is in the session transcript: a `system/message`
record carrying the sections in this order.

```
## 当前工作区          ← the Profile body plus the recommended-Skill list
## 本工作区推荐的 Skill
## 约束优先级
## 当前立场            ← the Perspective body
## 本工作区可用的专家 Subagent
```

Measured 2026-09-16 by parsing the JSONL of real sessions recorded 2026-09-14 in a
configured Workspace: one `system/message` of 10,375 characters containing all
five headings, and another session whose turn 1 and turn 4 assemblies (10,047 /
10,139 characters) each carried them — so it is recomputed, not written once. (8
of the 9 session directories there carry the injection; the ninth records no
system message.) The same scan over the 44 session directories of the `DSH`
Workspace found **0** injections — see the next paragraph for why that is correct
and what the page used to say about it.

**And a Workspace can be configured while injecting nothing.** The Profile and
Perspective sections are gated on `onboardingStatus === 'configured'`, which
records that a Profile was *chosen*. Skill toggles and Subagents are stored
configuration too, so a Workspace whose only stored value is a Skill toggle shows
the header badge 已配置 while the prompt stays empty. Two different questions;
before 0.1.2 the page answered only the first.

Three ways to check, in increasing order of directness:

1. **Settings → 工作区 → 查看**, one button after each of the Profile and 默认视角
   controls. Both open the same dialog: the prompt is written as a whole, and the
   dialog labels its three sections. It opens with the verdict — 已注入 plus which
   parts, or 未注入 plus why — and then the literal text, section by section,
   composed by the same functions the sections call. Empty sections are shown as
   empty rather than omitted, so "not injected" and "does not exist" stay
   distinguishable. When the form above holds unsaved edits the dialog says so,
   and previews what saving would produce alongside what is in force.
2. **`/perspective`** in a session: reports the Workspace default, this session's
   override, and which one is in effect.
3. **The session transcript** — `~/.dsh/sessions/<encoded-cwd>/<session-id>/`
   holds a zstd-compressed JSONL; the `system/message` records are the assembled
   prompt.

Two limits are stated in the dialog rather than papered over: it shows the
Workspace **default** stance (a per-session `/perspective` override is not
readable from a Workspace-scoped read), and it shows what is **saved** (the form
above is a draft).

The preview is a Host-side read, so on an installation whose browser bundle is
newer than its Host process the button reports 宿主还没有重启 rather than a
transport error. Restart DSH and reopen the page.

## What it will not do

- It never infers a Perspective from a sentence. "从投资人角度分析一下" is a
  request about one question; only Settings and `/perspective` change the stored
  state, so a passing instruction cannot silently reframe the matter.
- It never applies a stance the current Profile does not define. A session override
  outlives a Workspace reconfiguration, so an override naming a Bankruptcy role
  under a Workspace that has since become Litigation is dropped, not translated.
- It never substitutes the parent session's model for a Subagent's own route.
  A Subagent with no usable route fails loudly instead.
- It never installs a Skill. A recommended Skill that is not present shows as
  未安装 and is never written as enabled.
- It never recommends a Skill you disabled, and never disables one to satisfy a
  recommendation: the two fields cannot contradict each other in the injected text.
- It never deletes configuration because a directory moved. A policy whose
  Workspace left the registry is kept and shown as 孤立的配置 until you delete it.
- It never disables a Skill globally. A disable is a per-Agent scope shadow;
  another Workspace is untouched, and removing it restores the catalog exactly.
- It never writes without the revision it read. A concurrent edit produces a
  refusal and an offer to copy your edits, never a silent overwrite.
- It never picks between two Matters. A Workspace whose declared directories hold
  two different `matter.yaml` files is reported as an ambiguity, and the fix is to
  leave one of them declared — not for the plugin to choose by directory order.
- It never infers a Matter from a directory name, a CaseBench registry entry or a
  Workspace id. Identity comes from `matter.id` inside the file, and the file has to
  be in a directory the Workspace actually declares.

### Where the Matter is looked for

A DSH Workspace is **not necessarily one directory** — `dsh-multi-project` can add
writable directories to it, and the plugin reads that set through the
`ctx.workspaceDirs` service it publishes. This matters because of how case work is
actually laid out here: the Workspace is the team drive holding the case files,
while the CaseBench Matter lives in `My Legal-agents/<案件>/matter.yaml` as an added
directory.

The search is:

1. the session's own directory, walking up — but never above the topmost declared
   directory that contains it;
2. then each other declared directory, as itself.

The first step is CaseBench's rule unchanged. The second is what makes an added
directory work. A directory is never searched *through*: a Matter above an added
directory stays unreachable unless you declare that higher directory too. Without
`dsh-multi-project` the plugin sees one directory and behaves exactly as it did
before it could read the set. The page names every directory it searched whenever
there is more than one, so "no matter.yaml" is a statement about the set rather than
about a directory you never configured.

## Layout

```
src/                 host half
  index.js             the composition root — acquires each seam, owns no logic
  policy.js            the data model: pure functions in, values out
  settings.js          the namespace, the store, revision fencing
  workspace-resolution.js  cwd → WorkspaceId
  workspace-roots.js   the declared directory set: the registry path, then ctx.workspaceDirs
  session-perspective.js   the per-session stance, and its storage domain
  profile-runtime.js   the three injected prompt sections
  matter-yaml.js       the matter.yaml subset reader (strict: it refuses, never guesses)
  matter-resolution.js the declared directory set → Matter Root, with a synchronous lookup
  matter-match.js      Matter type/role → Profile/Perspective, and the verdicts
  skill-policy.js      per-Agent Skill shadows
  model-catalog.js     route catalogue and preflight
  subagent-registry.js definitions, persona and dispatch-prompt compilers
  subagent-dispatch.js the one lifecycle
  tools.js commands.js the entry points (`workspace_subagent`, `/agent`, `/perspective`)
  remote/              the business operations behind the browser surface
client.js            the Settings section (classic script, no bundler)
profiles/ perspectives/   the Profile and Perspective bodies, as Markdown
scripts/             probes that run against a real booted composition, plus
                       matter-probe.mjs and matter-yaml-golden.py for the Matter reader
test/                247 tests, and fixtures/ holding the PyYAML golden pair
docs/                ARCHITECTURE · COMPATIBILITY · PROFILE-CONTRACT · MILESTONE-0.1 · 0.1.1 · 0.1.2 · 0.2 · 0.3 · 0.4 · 0.5
```

## Requirements

`@deepseek-ai/dsh` `0.1.7-rc.1` (locally verified). There is no bundler and no build step: the host
half is plain ESM with JSDoc, and the browser half is a classic script that
`require`s only `react` and `react/jsx-runtime` from the platform seed.

## Tests

`src/` and the tests import `@deepseek-ai/dsh-*` — the platform packages, which DSH
provides rather than this plugin depending on them. `node_modules/` is gitignored,
so **a fresh clone has none of them and seven test files cannot even load**. Link
them from a DSH installation first:

```bash
node scripts/link-platform-deps.mjs                      # ~/.dsh/profiles/node_modules
node scripts/link-platform-deps.mjs --from /path/to/node_modules
node scripts/link-platform-deps.mjs --check              # report, change nothing
```

It links exactly what the sources and tests import (12 packages today) and fails
loudly on any it cannot find, so it cannot paper over a dependency that was never
declared. Then:

```bash
node --test "test/*.test.js"                             # 230 tests
```

Probes that need a real booted composition. They each **require** an explicit
`--home` pointing at a throwaway directory, and refuse to run without one or when
it resolves to your real `~/.dsh` — `--home` alone is not enough, because the rows
that persist anything resolve their root through `DSH_HOME`, and a probe that
leaves it unset reads your real Workspaces and writes session logs into your real
home. Both happened before the guard existed.

Two things the throwaway home needs before a probe will boot, neither obvious from
the error you get without them:

1. **The `web` profile, installed.** Copying `~/.dsh/profiles` is not enough on its
   own: the profile's plugin bundles must resolve, or `loadProfile` fails with
   `cannot resolve profile bundle …`.
2. **The same directory depth as `~/.dsh`.** The bundles are *relative* symlinks
   (`…/node_modules/kdocs-settings -> ../../../../Documents/DSH/kdocs-settings`), so
   a home at `/tmp/probe` resolves them to `/tmp/Documents/…` and they dangle. A
   sibling of `~/.dsh` — `~/.dsh-probe` — resolves them correctly.

A probe that answers "workspace … is not registered" is working: it reads whatever
workspace registry the home has, and a fresh home has none. To exercise a Workspace
against a real case, register that case directory first.

```bash
node scripts/boot-probe.mjs   --home /tmp/dsh-probe-home
node scripts/remote-probe.mjs snapshot --home /tmp/dsh-probe-home
node scripts/prompt-probe.mjs --home /tmp/dsh-probe-home --cwd /your/workspace
node scripts/perspective-probe.mjs        # seeds and cleans up its own home
node scripts/matter-probe.mjs --workspace /your/case/workspace   # read-only
node scripts/matter-yaml-golden.py       # needs Python + PyYAML; see --help
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modules, data flow, and the
  decisions worth not re-litigating.
- [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) — every DSH seam this plugin
  depends on, with the evidence and the negative control for each. Read this
  before changing anything that talks to the platform.
- [`docs/PROFILE-CONTRACT.md`](docs/PROFILE-CONTRACT.md) — what a Profile and a
  Perspective may and may not say, and how the injected text is composed.
- [`docs/MILESTONE-0.1.md`](docs/MILESTONE-0.1.md) — what was verified, how, the
  defects this round found, and the limitations stated plainly.
- [`docs/MILESTONE-0.1.1.md`](docs/MILESTONE-0.1.1.md) — the session Perspective
  layer, the per-Profile vocabulary, the three Skill states, and the probe that
  was not actually isolated.
- [`docs/MILESTONE-0.1.2.md`](docs/MILESTONE-0.1.2.md) — proving the prompt is
  really injected, the injection preview, and the two verdicts that used to be
  one.
- [`docs/MILESTONE-0.2.md`](docs/MILESTONE-0.2.md) — Matter integration: reading a
  CaseBench `matter.yaml`, comparing it with the Workspace, and why the reader
  refuses rather than guesses.
- [`docs/MILESTONE-0.3.md`](docs/MILESTONE-0.3.md) — Subagent factory templates,
  why they live in the browser half, and the `deepseek-v41-flash` correction.
- [`docs/MILESTONE-0.4.md`](docs/MILESTONE-0.4.md) — the 码农 (`coding`) template,
  and why its duties stay an enumerated list.
- [`docs/MILESTONE-0.5.md`](docs/MILESTONE-0.5.md) — the Matter of a multi-directory
  Workspace: why every real Workspace reported none, the `ctx.workspaceDirs` seam,
  and what is verified versus still owed.

## Release

Current version: **0.5.0** (`package.json` is the single source of truth). What
changed in each release, and what was deliberately not done, is in
[`CHANGELOG.md`](CHANGELOG.md); tagged releases are on
[GitHub](https://github.com/vansonffff/dsh-workspace-profile/releases).

## Licence

MIT. No third-party code was copied; see `THIRD_PARTY_NOTICES.md`.

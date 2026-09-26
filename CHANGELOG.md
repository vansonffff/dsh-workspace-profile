# Changelog

All notable changes to `dsh-workspace-profile` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.2.0 were developed in a private workspace and are not itemised
here; `v0.1.2` is the last of those (`docs/MILESTONE-0.1*.md`).

## [0.5.0] — 2026-09-26

### Fixed

- **A Matter in a directory added to the Workspace is now found.** The plugin
  searched only the Workspace's own registry path, so a Workspace whose case files
  live in a team drive while its CaseBench Matter lives in
  `My Legal-agents/<案件>/` — an added directory — reported "这个目录下没有
  matter.yaml" for every such Workspace. The search now covers the whole declared
  set: the session's own chain first (CaseBench's rule, unchanged), then each
  declared directory as itself.

  A directory is never searched *through*: a Matter above an added directory stays
  unreachable unless that higher directory is declared too. If two declared
  directories hold two different `matter.yaml` files, the answer is a reported
  ambiguity rather than a choice made by directory order.

### Added

- **`ctx.workspaceDirs`** (published by `dsh-multi-project`) is consumed as an
  optional seam. Without that plugin the declared set is the registry path alone,
  which is the previous behaviour, so this is not a new hard dependency.
- The Matter card shows **案件目录**, the directory the Matter was read from, and
  when there is no Matter and the Workspace declares more than one directory, it
  names every directory that was searched instead of talking about "这个目录".

### Changed

- `findMatter`/`MatterResolver` take the Workspace's **directory set** rather than a
  single boundary path. `findMatter(start, { workspaceRoot })` becomes
  `findMatter(start, { roots })`; `resolvePath(path, workspaceRoot)` becomes
  `resolvePath(path, roots)`. Callers that passed one path pass `[path]`.

## [0.4.0] — 2026-09-25

### Added

- **A third factory template: 码农 (`coding`)** — `deepseek-official/deepseek-flash` · max.
  It takes the engineering work: reading and analysing a repository; locating,
  reproducing and fixing bugs; writing or changing code; writing scripts; changing
  project configuration; writing, running and fixing tests; refactoring; analysing
  dependencies, interfaces and implementation mechanisms; and DSH-plugin and other
  engineering development.

  Its description is the owner's own list of duties, enumerated rather than
  summarised: that line is what the model reads when deciding whether a request
  belongs to this agent, and collapsing nine duties into "写代码" would hide
  repository analysis and plugin work behind the same two words.

  Unlike the two legal templates, this one is not domain-specific — it is offered
  in every Workspace, including ones whose Profile is Litigation or Bankruptcy.

## [0.3.0] — 2026-09-25

### Added

- **Subagent factory templates.** 添加子 Agent now opens with a **模板** dropdown
  holding preconfigured experts. Selecting one fills name, key, description, route
  and guidance; nothing is saved until 创建 is pressed and every field stays
  editable. Two templates ship:
  - 独立评审员 (`reviewer`) — `kimi-coding/k3` · max. Independently reviews a legal
    position or document from the outside: presumes nothing correct, hunts for
    counter-examples and gaps, and separates 已查明事实 / 主张 / 推断 / 未知.
  - 律师助理 (`assist`) — `deepseek-official/deepseek-flash` · max. Carries bulk
    repetitive work: collating files, summaries, timelines, party/amount/date and
    evidence lists, mechanical cross-material comparison, format and table
    conversion, preliminary retrieval.
- A template carries **no `id`** (the Host assigns definition ids, and a template
  with one would turn every *create* into an *edit* of the same Subagent) and **no
  `enabled`** (whether an agent starts enabled is the user's answer, not a
  preset's). An empty template field is a value: it clears the field.

### Changed

- The route a template suggests is preflighted by the dialog's existing live
  `validateRoute` call. An unavailable model reports itself; it is never
  silently substituted.
- Templates live in the **browser bundle**, not the host half, so editing a
  template does **not** require restarting the Host. No host file changed in this
  round; the change was verified against a running instance without a restart.

### Fixed

- `deepseek-official`'s model was written as `deepseek-v41-flash` during design.
  **No such id exists** — "DeepSeek-V41-Flash" is the *display name* of the model
  whose id is `deepseek-flash`. The templates use the id, and a test cross-checks
  every `deepseek-official` template against the catalogue the local installation
  actually declares.

### Documentation

- `docs/MILESTONE-0.3.md` — what this round added, why it lives in the client half,
  the `deepseek-v41-flash` correction, the verification record, and what it
  deliberately does not do.
- `docs/ARCHITECTURE.md` — why the templates are browser-side.
- `README.md` — a **Templates when creating one** section.

### Verified

- 230 tests passing (`node --test "test/*.test.js"`), 5 added this round.
- Four negative controls, all red as expected: the display name used as a model id
  (3 tests, including the catalogue cross-check), `enabled` in the template patch,
  the dropdown's change handler removed, and the dropdown rendered in edit mode.

## [0.2.1] — 2026-09-24

### Changed

- **DSH 0.1.7-rc.1 compatibility.** Host and client Typert codecs moved to
  `create()`; the legacy `SettingsProvider` / `register()` path moved to Profile
  Config `describe()` / `mutate()` / `update()`.

### Fixed

- **Desktop: 可用技能 listed deployment-level Skills only,** and showed
  "no session is running in this Workspace" even while a session was open. The
  desktop app embeds its own copy of `dsh-scope`, so this package's
  `scopeParentOf` read a *different module instance* whose private `WeakMap` was
  empty — every scope lookup answered `undefined`. The lookup now goes through the
  0.1.7 `agentPresets` registry, whose scope keys are produced and consumed inside
  the platform's own module instance, with the old path kept as a fallback when
  `agentPresets` is absent.
- `scoped` can now be `true` with no live session (the standing preset scope). The
  explanatory note appears only when no preset layer is reachable at all.

## [0.2.0] — 2026-09-21

### Added

- **CaseBench Matter integration.** The plugin now *sees* the case a directory
  belongs to: it discovers the nearest `matter.yaml`, reads its subset, compares
  `matter.type` against the Workspace Profile and `engagement.role` against the
  default Perspective, and reports both verdicts in Settings → 工作区. The
  Matter's facts also travel into a dispatched child, which has no parent history.
- A restricted `matter.yaml` reader (`src/matter-yaml.js`). The package still has
  **no dependencies and no build step**: the file is read as the subset CaseBench
  actually writes, and the reader refuses what it does not model rather than
  guessing.

### Changed

- Whatever a Matter declares is **read and reported, never applied**. A mismatch is
  shown; nothing re-points a Workspace because a file on disk changed.

### Fixed

- Trust-boundary gaps raised by an independent review (seven in one round).
- The two places this consumer is deliberately stricter than CaseBench's own
  validator are now documented.
- A fresh clone is runnable: `scripts/link-platform-deps.mjs` links exactly the
  platform packages the sources and tests import, and fails loudly on any it
  cannot find.
- Real client data was removed before this repository was published.

[0.4.0]: https://github.com/vansonffff/dsh-workspace-profile/releases/tag/v0.4.0
[0.3.0]: https://github.com/vansonffff/dsh-workspace-profile/releases/tag/v0.3.0
[0.2.1]: https://github.com/vansonffff/dsh-workspace-profile/compare/2a87487...v0.3.0
[0.2.0]: https://github.com/vansonffff/dsh-workspace-profile/compare/1949717...2a87487

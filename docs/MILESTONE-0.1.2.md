# Milestone 0.1.2 — proving the prompt is really injected

> Status: **code complete, unit-verified; the browser check is pending a Host
> restart** (see §5). Every claim below is either a measurement with its command,
> or marked as unverified.

## 1. The question this round answers

It was asked plainly: *"我们之前预设的 profile、立场，有没有实际生效，相关提示词有
没有实际写入，还是说指示是个 UI 界面而已?"*

It deserved a measurement, not an assurance. The measurement:

| Claim | Evidence |
|---|---|
| The sections are really written into the prompt | `~/.dsh/sessions/--Users-vanson-Documents-0-…--/457b26b2-…/session.v3.jsonl.zstd`: the single `system/message` record (10,375 chars) contains, in order, `## 当前工作区` + `# 诉讼工作区 (Litigation)`, `## 本工作区推荐的 Skill`, `## 约束优先级`, `## 当前立场` + `# 立场：原告代理人 (Plaintiff)`, `## 本工作区可用的专家 Subagent` |
| It is recomputed, not written once | `session-9c79d1cd-…`: two `system/message` records (turn 1 step 1, turn 4 step 1), both carrying all five headings, 10,047 and 10,139 chars |
| It is not an artefact of one session | 8 of 9 case-workspace session directories with a recorded system message carry the injection (`session-6f2f2dd0-…` records none) |
| …and it was **absent everywhere** in this Workspace | all 44 session directories under the `DSH` Workspace: 0 injections |

The reading method matters, and the first attempt was wrong: a naive
`grep -c '## 当前工作区'` over the JSONL counts **tool output** too — this
repository's own `src/profile-runtime.js` contains that literal, so any session in
which the file was read scores a hit. The numbers above come from parsing the
JSONL and looking only at `type: 'system/message'` records.

## 2. The defect, and why it was a defect of the page rather than of the plugin

The Workspace this plugin is developed in (`2833702c…`, path `DSH`) has **no
`profile`** in `~/.dsh/settings.yaml` — only `skillOverrides`. The Profile and
Perspective sections are gated on `onboardingStatus === 'configured'`
(`src/policy.js` `resolveWorkspacePolicy`), so that Workspace injects nothing, in
every session, correctly.

The page said otherwise. The header badge used `hasStoredPolicy()`, which is true
when **any** of `onboardingStatus`, `skillOverrides` or `subagents` exists — so a
Workspace with one disabled Skill showed a green **已配置** while the prompt was
empty. `hasStoredPolicy` is *right* about what it means ("something is stored"),
and the code comment defends that choice; what was missing was the other half of
the answer. A green badge over an empty prompt is indistinguishable from a UI that
does nothing, which is exactly how it was read.

## 3. What changed

- **`previewInjection({ workspaceId[, profile, perspective] })`** — a read-only
  Remote method that returns the literal text, composed by
  `composeProfileSection` / `composePerspectiveSection` /
  `composeAgentDirectorySection`, the very functions the three
  `systemPrompt.section` registrations call. A preview that reimplemented the
  composition would relocate the original problem; `test/injection-preview.test.js`
  asserts the two are equal, so a second implementation cannot appear unnoticed.
- **A 查看 button per field** — one directly after the Profile control, one after
  默认视角, both labelled 查看 and both carrying 查看注入的提示词 as their tooltip. A
  row of form controls is no place for a sentence, which is what the first attempt
  put there. They open the same dialog, because the prompt is written as a whole
  and the dialog labels its three sections; the point is that neither field is left
  without a way to ask. The dialog shows the saved composition, and — when the form
  is dirty — what saving would produce beside it. Empty sections are shown **as**
  empty: hiding them would make "not injected" and "does not exist" look the same.
- **The verdict lives in that dialog, not in a row of its own.** A first attempt
  added a `提示词注入` row to the second card; it was removed on request, because
  that card already shows the Profile and 默认视角 values and a third line
  restating them is noise. The dialog now opens with the verdict — 已注入 plus the
  parts, or 未注入 plus the reason — taken from the **Host's** `parts`, not decided
  again in the browser. The cost is the at-a-glance signal for the 已配置/未注入
  distinction; the answer is one click away instead.
- **A missing method is reported as what it is.** Until the Host is restarted the
  call fails with a transport 404, and the dialog says 宿主还没有重启 rather than
  surfacing the raw failure — that state is the *normal* one for a half-updated
  plugin here, because the browser bundle hot-reloads and the Host does not.
- **Dead code removed**: `client.js` carried
  `onboardingStatus: policy.onboardingStatus === 'configured' ? 'configured' : 'configured'`.
  Both branches were identical and the field was never read by a save (which
  writes `'configured'` outright), so the draft no longer carries it.

## 4. Verification

`node --test "test/*.test.js"` — **162/162** (146 before, plus 8 host-side and 8
bundle-side). `node --check` clean over `client.js`, `src/**` and `typert.*.js`.

Seven mutations were planted and each had to turn a specific test red. A test that
cannot fail on the bug it describes is not evidence:

| Planted defect | Test that went red |
|---|---|
| `active` derived from the gate instead of the composed text | *an enabled expert is advertised even before a Profile is chosen* |
| the dialog drops empty sections | *the 查看 button opens the injected prompt, section by section* |
| `textsLoaded` hard-coded to `true` | *an unloaded Profile body is declared…* |
| the `提示词注入` row restored in the second card | *each field carries its own 查看 button…* and *the dialog gives the verdict…* |
| only the 默认视角 field keeps a 查看 button | *each field carries its own 查看 button…* |
| the buttons labelled 查看注入的提示词 again | *each field carries its own 查看 button…* |
| the 404 surfaced raw instead of naming the restart | *a 404 for the new method is explained as "the Host has not restarted"* |

Note what these can and cannot cover. The verdict is now derived on the client
from the Host's `parts`, so the gate itself is pinned by the **host-side** test
(*a workspace whose only stored configuration is a skill toggle injects
nothing*), which fails if `resolveWorkspacePolicy` stops treating
`onboardingStatus` as the gate.

## 5. Limits, stated plainly

- **Not yet browser-verified.** Adding a Remote method changes the **Host** half,
  so the running instance must be restarted before the dialog exists; the client
  bundle alone hot-reloads and would call a method the old Host does not have.
  Until that restart, the dialog's end-to-end behaviour rests on the bundle tests
  and the operation tests, which is not the same thing as having looked at it.
- **The dialog shows the Workspace default stance**, never a session
  `/perspective` override. The override is keyed by session and a Remote read is
  Workspace-scoped; the dialog says so rather than leaving the gap to be inferred.
- **The dialog shows what is saved.** It refuses to present a draft as in force,
  and previews the draft only when `validateProfilePerspective` accepts the pair —
  a preview of a state that can never be stored would be a new way to mislead.
- **Version history correction.** `package.json` was stamped `0.1.0` while the
  tree already contained the `0.1.1` work documented in
  `docs/MILESTONE-0.1.1.md`; `0.1.1` was therefore never a stamp anyone could
  check out. This round sets the version to `0.1.2` — the truthful continuation
  rather than a back-dated `0.1.1` — and records the gap here instead of editing
  the older document.

## 6. Still open

The `bundled` Skill question from `logs/dsh-workspace-profile.md` — four
`prc-legal-research-*` Skills are registered by `huayu-yuandian-legal-data` with
`source: 'bundled'`, and Settings shows them read-only, so they cannot be turned
off per Workspace. That is a policy decision, not a mechanism: the write path
accepts them unchanged. It remains unanswered and is **not** addressed here.

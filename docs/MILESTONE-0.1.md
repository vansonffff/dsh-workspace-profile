# Milestone v0.1

> Baseline: `@deepseek-ai/dsh` `0.1.5-rc.1`, macOS, Node 24.14.0.
> Verified: 2026-09-13 on an **isolated probe instance** — a separate
> `DSH_HOME` sharing the real profile's module trees, booting the real `web`
> composition on an OS-assigned port, so nothing here touched the user's
> sessions, settings document, workspace registry or credentials store.

## 1. What is done

Every Phase 0–7 deliverable in the plan is implemented. The v0.1 scope is exactly
the plan's: Settings-first configuration, one fixed `spawn` backend, foreground
one-shot delegation, Workspace default Perspective only. No Workspace creation
flow is modified, nothing pops up, and there is no background or continuable
subagent.

## 2. Verification, by the plan's own categories

The plan (§15.4) forbids substituting a README or a self-reported test count for
this round's evidence. Each row below names the artifact that produced it.

### 2.1 Static / contract checks

| Check | Result |
|---|---|
| `test/manifest.test.js` — package/row/client-id agreement, mandatory exports, every bare import resolves, client requires nothing beyond the seed | 5 pass |
| `test/remote-contract.test.js` — Host manifest ≡ shared table ≡ the client copy; each `remoteX` exists with descriptor-matching arity and plain-identifier parameters | 7 pass |
| `test/client-bundle.test.js` — the bundle loaded in a `vm` with a stand-in `__ModuleLoader__`; descriptor table ≡ Host manifest; `apply` mounts exactly one contribution; every `jsx` call has one props argument | 7 pass |

### 2.2 Unit tests

`test/policy.test.js` (18), `test/compilers.test.js` (9),
`test/model-catalog.test.js` (11), `test/settings-store.test.js` (8),
`test/dispatcher.test.js` (12). Every rule-guarding assertion is paired with a
negative control — a validator that accepts everything passes a happy path.

### 2.3 Integration tests

`test/skill-policy.test.js` (7) runs against the **real** `SkillRegistry`.
`test/integration-plugin.test.js` (7) mounts the real plugin in a real Cordis
context over real `SettingsProvider`, `SkillRegistry`, `SystemPrompt`,
`CommandRuntime`, `ToolRuntime` and `TypertRegistry` services.

**92 tests, 92 pass** (`node --test "test/*.test.js"`).

### 2.4 Probes against a fully booted real composition

| Probe | Observation |
|---|---|
| `scripts/boot-probe.mjs` | row `workspace-profile` present, `fiberState: 2` (active); `ctx.workspaceProfile` present; `workspace-profile` in the settings namespaces; `workspace_subagent` registered; `/agent` registered; `dsh-workspace-profile` in `typert.listPackages()` |
| `scripts/remote-probe.mjs` | `gateway.claimsEndpoint('workspaceProfile/snapshot')` → `true`; the operation resolves in 2 ms |
| `dsh web --dump-config` | the row appears in the assembled web composition |
| Boot payload | `dsh-workspace-profile/client.js` is in the mounted client roster the browser requests |

### 2.5 Real browser (the user's own browser, via the WebBridge)

Driven against the probe instance with synthetic DOM events; the assertions read
the live DOM and the Host's own files.

| Plan criterion | Observation |
|---|---|
| Settings section visible | 工作区组合 appears in the Settings nav beside 模型 / 插件 / Agent 预设, and opens |
| Chinese/English | the section renders bilingual labels (`破产重整 (Bankruptcy)`, `管理人 (Administrator)`) |
| Profile/Perspective selection | changing Profile to 破产重整 repopulated the Perspective list with all six ids; 管理人 selected |
| Save | status moved 未配置 → 已配置, 配置版本 0 → 1 |
| Error boundary | **fired and reported a real bug** — `TypeError: … reading 'bind'` rendered in the panel instead of a blank seat (see §3) |
| Two Workspaces, independent policy | DSH → bankruptcy/administrator **and** a second Workspace (2026民57-酬诺弹簧-毛坤霞-货款纠纷) → litigation/none, stored under separate keys in `settings.yaml` |
| Orphaned policy | a policy whose Workspace left the registry appears under 孤立的配置, is **not** deleted, and offers an explicit delete |
| Persistence across restart | the probe was restarted repeatedly; `settings.yaml` retained `workspace-profile` with exactly the fields written (path ops, never a wholesale replacement) |
| Skill catalog | 6 Skills with sources `bundled` / `user-agents`; `bundled` rows render 只读 (per the plan's managed/unmanaged split) |
| Subagent dialog | live route verdict 模型路由可用; the effort list came from the adapter (`off/low/high/max`), not from a hardcoded set |
| **Real child creation and result return** | from the composer: *"让案例检索员用一句话回答：中华人民共和国企业破产法自何时起施行？"* → the model called `workspace_subagent` with key `case-researcher`; the tool card renders `workspace_subagent · case-researcher`; DSH's header counts **1 个子代理**; the child returned *《中华人民共和国企业破产法》自 2007 年 6 月 1 日起施行（第一百三十六条）。* in 9 s |
| `/agent` | `/agent` listed the Workspace's expert with its key, route and description |
| Prompt injection (real tree) | `scripts/prompt-probe.mjs` on a configured Workspace: `workspace-profile:context` = 2041 chars containing the Bankruptcy Profile body, the Administrator Perspective body, the "stance is not a verified fact" line, and the precedence statement |

## 3. Defects this round found, and how

Recording these matters more than the pass counts: each was invisible to the
tests that existed at the time, and each now has a guard.

1. **The client never mounted its Remote contribution.** `dsh-api-remotes`
   mounts a hard-coded list and discovers nothing, so a third-party namespace
   exists only because the plugin's own bundle calls `ctx.remote.$mount(...)`.
   The Host half was correct and the section simply never appeared — a pending
   `ctx.inject` reports nothing at all. Guarded by `test/client-bundle.test.js`.
2. **A Remote call passed a trailing `undefined`.** `snapshot(undefined)` built
   the call with one argument too many; the endpoint never answered, the panel sat
   on 正在读取配置, and the browser's per-origin connection pool filled until
   official endpoints queued behind it. Guarded by the same file.
3. **A missing prop in the slot's `inject` factory.** The body destructured
   `locale`, the factory never returned it, and the error boundary rendered the
   `TypeError` — which is exactly why every slot body is wrapped. The factory's
   props are now asserted against what the body reads.
4. **User-authored text reached a strict-interpolation prompt section
   unsanitized.** A `{{…}}` in a Subagent name, description or the Workspace title
   would have aborted assembly for the *parent* session. Found by rendering the
   composed sections through the real `renderPrompt`.
5. **`releaseFor` did not await `scope.dispose()`.** A re-apply raced its own
   teardown and could leave the previous Skill policy in force. Found by the
   restore assertion in the Skill test.
6. **The model-typo suggestion list was always empty.** A helper that reads
   `.catalog` off its argument was handed the catalog array itself. Found by the
   negative control that asserts the hint text.

### 3.1 Found in production use, after the milestone run

Both were reported from a screenshot of the first real user session — the class of
defect the probe instance cannot produce, because a probe does not read a list.

7. **Skill names were truncated to indistinguishability.** In a narrow Settings
   panel, one row had to fit a checkbox, a 34-character name, up to two badges
   and a source label; four different Skills all rendered as
   `prc-legal-research-ca…`, `-co…`, `-la…`, `-se…` — and the distinguishing part
   is exactly the suffix. A one-line row cannot hold both a name and a source, so
   whichever is given `min-width: 0` loses. The row is now two lines: the name
   owns line one (wrapping, with the description on hover), the metadata owns
   line two. Nothing is truncated, at any panel width.
8. **The status badge contradicted the page beneath it.** A Workspace with a
   saved — and enforced — Skill override still read 未配置, because the badge was
   driven by `onboardingStatus`, which answers a different question ("was a
   Profile and Perspective chosen"). The badge now reports whether *anything* is
   stored for the Workspace; block 二 remains the place that reports what is in
   effect. Prompt injection is unchanged: it still requires a chosen Profile, so
   a Workspace where only a Skill was toggled injects nothing.

Both fixes are in `client.js` only, so the client HMR receiver picks them up
without a Host restart.

## 4. Deliberately not done in v0.1

Per the plan's §3.1 exclusion list, and additionally:

- **Workspace creation flow untouched; no post-create popup.**
- **No Session Perspective Override and no `/perspective`.**
- **No background or continuable subagent.** `runInBackground` is absent from the
  tool schema, not merely disabled.
- **No run history database.** Metadata goes to the log; the child session itself
  is DSH's own record.
- **No `WorkspaceTemplate` prefill.**
- **The Skill toggle is not offered for `bundled` sources.** Enforcement is
  broader than the affordance on purpose (see `docs/ARCHITECTURE.md` §5).

## 5. Known limitations, stated plainly

1. **Workspace increments are polled, not pushed.** `dsh-workspace` declares no
   events. The Settings page re-reads on open and after every write, and the
   plugin re-reads on `agent/created` and at every step boundary, so nothing
   user-visible is stale — but v0.2's post-create wizard needs a real watcher,
   and that is a prerequisite, not a detail.
2. **The Skill catalog needs a live Agent to be complete.** In a Web deployment
   the local filesystem provider is mounted per agent preset, so with no running
   session in the Workspace only the deployment's own Skills are visible. The Host
   reports this and the page says so in a sentence rather than letting
   "recommended but not installed" read as a fact.
3. **The Settings section and `agent-presets` share nav order 20.** Order alone
   does not decide; the shell's sort is stable, so this is cosmetic. It is
   recorded because the number should change if the page is ever reordered.
4. **Not exercised in this round:** an actual revision conflict between two
   browser windows; the not-installed-Skill display path against a real missing
   Skill; cancellation of a running child from the UI. All three are covered by
   unit-level negative controls, and none is claimed as browser-verified.

## 6. Release checklist

| Item | State |
|---|---|
| `node --test "test/*.test.js"` | 92 / 92 |
| `dsh web --dump-config` shows the row | yes |
| Real Host start (isolated probe, real web composition) | yes |
| Real browser Settings | yes |
| Real child dispatch and result return | yes |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/COMPATIBILITY.md`, `docs/PROFILE-CONTRACT.md` | yes |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | yes |
| Registered in the `web` profile | yes — **done; the Host was restarted and the plugin is live** |
| Verified in the user's own instance after that restart | yes — Settings section, Skill toggles, badge, revision |

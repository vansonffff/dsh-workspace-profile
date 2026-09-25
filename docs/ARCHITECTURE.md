# Architecture

## 1. The shape

```
   cordis loader row "workspace-profile"   (one row — see COMPATIBILITY §2)
              │
       apply(ctx, config)                  src/index.js
              │
   ┌──────────┴───────────────────────────────────────────────────────────┐
   │  ctx.settings        → src/settings.js   the stored document         │
   │  ctx.workspaceRegistry → src/workspace-resolution.js  cwd → id       │
   │  ctx.systemPrompt    → src/profile-runtime.js   three dynamic sections │
   │  ctx.skills          → src/skill-policy.js  per-Agent shadows        │
   │  ctx.llm             → src/model-catalog.js  catalog + preflight     │
   │  ctx.subagents       → src/subagent-dispatch.js  the child Agent     │
   │  ctx.tools/commands  → src/tools.js, src/commands.js  entry points   │
   │  ctx.typert          → src/service.js + src/remote/  browser surface │
   └──────────────────────────────────────────────────────────────────────┘
```

`src/index.js` is the composition root. It owns no logic; it acquires each seam
through `ctx.inject` and hands it to the module that owns it.

## 2. Why everything is acquired through `ctx.inject`

A static `inject` array makes the whole plugin wait for a service; reading a
service that is not there yet **poisons the context permanently**
(`cannot get property "x" without inject`), so a `?.` does not save it. Each seam
is therefore taken as it arrives, and the plugin degrades honestly when one never
does:

| Missing | Consequence |
|---|---|
| `settings` | no configuration; reads answer from an empty document, writes fail with a named error |
| `workspaceRegistry` | no Workspace resolves; no section, no dispatch |
| `systemPrompt` | no injection; the tool and command still work |
| `skills` | a Workspace's disable policy is not enforced; a warning says so |
| `llm` | routes cannot be listed or preflighted; dispatch refuses with a named error |
| `subagents` / `spawn` | the tool explains that delegation is unavailable |
| `typert` | no browser surface; tool, command and injection unaffected |

The `capabilities()` map reports which of those happened, and the Settings page
renders the gaps rather than a control that fails.

## 3. Module map

| Module | Owns | Depends on |
|---|---|---|
| `src/errors.js` | the error vocabulary and `explainStopReason` | nothing |
| `src/policy.js` | the data model: defaults, validation, migration, resolution, the recommendation table | `errors` |
| `src/settings.js` | the permissive schema, the store, revision fencing | `policy`, `schemastery` |
| `src/workspace-resolution.js` | cwd → `WorkspaceId`, sync index + async canon | nothing |
| `src/matter-yaml.js` | the `matter.yaml` subset reader; refuses everything else | nothing |
| `src/matter-resolution.js` | cwd → Matter Root, sync lookup + async discovery | `matter-yaml` |
| `src/matter-match.js` | CaseBench type/role → Profile/Perspective, and the verdicts | `policy`, `matter-contract` |
| `src/matter-contract.js` | the CaseBench 3.2.8 vocabulary and its validator | nothing |
| `src/profile-runtime.js` | Profile/Perspective text loading and the three sections | `policy`, `subagent-registry` (sanitizer) |
| `src/skill-policy.js` | per-Agent shadows; the Settings skill catalog | `policy`, `dsh-scope` |
| `src/model-catalog.js` | provider/model/effort catalog, route preflight | `errors` |
| `src/subagent-registry.js` | definition CRUD, persona and dispatch-prompt compilers | `policy`, `errors` |
| `src/subagent-dispatch.js` | the one lifecycle both entry points share | `policy`, `errors`, `subagent-registry` |
| `src/tools.js` | `workspace_subagent` | `dsh-tools`, `errors` |
| `src/commands.js` | `/agent` and its grammar | `errors` |
| `src/instructions-probe.js` | AGENTS.md *presence* for the Settings page | nothing |
| `src/remote/operations.js` | the business operations behind the Remote | most of the above |
| `src/service.js` | the `TypertRemoteService` and its `remoteX` aliases | `dsh-typert-protocol` |
| `client.js` | the Settings section, and the Subagent factory templates | platform seed only |

### Why the Subagent templates live in `client.js`

`SUBAGENT_TEMPLATES` and `templateFormPatch` are browser-side on purpose. A template
is pre-fill material for the create dialog: there is nothing to persist, nothing to
share between machines, and its suggested route is validated by the dialog's live
`validateRoute` call regardless of where the template was defined. Host-side
placement would buy only a host unit test on the data's shape — and would cost a
**Host restart for every template edit**, because the host half is a loader row
fixed at assembly time. The client bundle hot-reloads.

Both are exported from the bundle for the same reason the dialog is hard to test:
the create dialog only renders while it is open, and the browser harness builds a
static tree, so the rules have to be observable as data (see `test/client-bundle.test.js`).

## 4. Data flow

### A configuration change

```
Settings page → remote.savePolicy({ workspaceId, expectedRevision, patch })
              → operations.savePolicy  validates the Profile/Perspective PAIR
              → store.write(pathOps, expectedRevision)      ← revision fence
              → settings provider persists + commits
              → store.watch fires → readiness memo replaced, catalog invalidated
              → the next `agent/pre-step` re-applies the Skill policy
              → the next prompt assembly computes the section text fresh
```

Nothing invalidates a cache by hand and nothing rewrites history. "Takes effect
from the next Agent step" is a consequence of computing the text at assembly time.

### A delegation

```
workspace_subagent | /agent
        └─→ SubagentDispatcher.dispatch
              resolve Workspace → read policy → find enabled definition
              → catalog.assertRoute(...)         ← before any child resource
              → compile persona + assignment
              → ctx.subagents.start('spawn', { agentOptions, persona, maxDepth: 3 })
              → await run.result   ┐ both caught separately
              → await run.dispose()┘ so neither erases the other
              → interpret stopReason → text
```

### Reading a Matter

```
Settings → 工作区 → the Matter card
        └─→ remote.matter({ workspaceId })
              → operations.matter
              → getResolver().describe(id).path      ← the Workspace directory
              → MatterResolver.resolvePath(path)
                    → findMatter   walk up to the nearest matter.yaml
                    → parseMatterYaml   the strict subset reader
              → matchMatter({ matter, policy })      ← the tables in matter-match.js
              → { discovered, matter, problem, match }
```

The same resolver is primed at every step boundary (`agent/created` and
`agent/pre-step`), so a delegation reads the Matter synchronously and never blocks
on the filesystem. **Nothing in this path writes**: the page reports a mismatch, it
does not re-point the Workspace. See `docs/MILESTONE-0.2.md`.

### Reading the injected text back

```
Settings → 工作区 → 查看注入的提示词
        └─→ remote.previewInjection({ workspaceId[, profile, perspective] })
              → operations.previewInjection
              → composeInjectionSections  ─┐ the same three functions the
                (profile-runtime.js)       ─┘ systemPrompt sections call
              → { saved, draft, textsLoaded, note }
```

`saved` is composed from the stored policy; `draft` only when the caller passes a
pair that `validateProfilePerspective` accepts, and it is composed through the
gate a save would leave behind (`configured: true`). The section names and orders
are the live registration's constants, so the dialog's headings and the session
transcript's headings are the same strings. Nothing here writes, and the session
`/perspective` override is deliberately out of reach — it belongs to a session,
and this is a Workspace-scoped read.

## 5. Decisions worth not re-litigating

**The schema is permissive; validation is explicit.** `SettingsProvider.register`
rejects the *registration* when a stored section fails its schema, which would
leave the page unable to fix the document it is complaining about. See
`docs/COMPATIBILITY.md` §4.

**Writes are path-addressed and revision-fenced, never wholesale.** A caller
holding a partial view cannot delete a field it never saw. A write with no
`expectedRevision` is refused outright.

**Business failures are returned, not thrown, from write operations.** The wire
error code is a closed set this plugin cannot extend, so a conflict cannot ride as
one. The result key is `saved`, not `ok`, because the client API already wraps
every call in `{ ok, value }`.

**One dispatcher, two entry points.** A second path would drift on the route
preflight, the depth cap, cancellation and disposal — none of which a user can
see, and all of which matter.

**Skill disabling is a per-Agent scope shadow.** `SkillRegistry` has no filter
hook; layering is the mechanism, and it gives isolation, child consistency and
invalidation for free. Excluding a built-in Skill means *not offering the toggle*
in Settings, not refusing to honour a saved override — a Skill's source can change
under a saved policy, and silently re-enabling something the user turned off is
the worse failure.

**The Matter reader refuses rather than guesses.** `matter.yaml` is YAML and this
package has no dependencies, so it reads the subset CaseBench actually writes
(PyYAML `safe_dump`, block style) and throws on everything else. A parser that
guessed would not fail loudly — it would return a wrong `role`, and a wrong role
silently selects the wrong professional stance for a live matter. An unreadable
Matter degrades to "no Matter", which the page can show.

**The upstream Contract is pinned, not followed.** `src/matter-contract.js`
transcribes CaseBench 3.2.8's vocabulary and validates against it. Deriving the
table from the upstream would pin nothing; transcribing it means a CaseBench change
shows up as a failing test here, which is what a consumer of a frozen Contract
should get. Strict YAML *syntax* was never enough — `type: nonsense` used to fall
back to `general` and produce a confident, ordinary answer about a broken Matter.

**One function decides the effective Perspective.** `resolveEffectivePerspective`
in `policy.js` is called by the parent's prompt section and by the subagent
dispatcher. They ask the same question, and before this they could answer it
differently: a session that moved its stance with `/perspective` had its child
inherit the Workspace default instead.

**Matter discovery is bounded by the Workspace.** The upstream rule is "up to the
workspace root, never across it", and the boundary arrives from the Workspace the
session already resolved into. Without it, a Workspace that is an ordinary project
directory inside a directory holding a `matter.yaml` would be adopted as that
Matter.

**The Matter mapping is a table, not name coincidence.** CaseBench's role tokens and
this plugin's Perspective ids were specified separately. For `litigation` and
`bankruptcy` they coincide, and that is *recorded* in `TYPE_TO_PROFILE` /
`ROLE_TO_PERSPECTIVE` rather than relied upon; non-litigation diverges on purpose
(`debtor` → `debtor-oc`). A Matter whose own type/role pair is impossible is
reported, never translated.

**The Matter is not injected into the parent prompt.** The requirement is a Settings
readout. The section names and orders are frozen and measured
(`docs/COMPATIBILITY.md` §7), so a new prompt contribution is a cost paid for a
purpose — and the Workspace's own Profile and Perspective sections already tell the
model its domain and stance. What a Matter *does* reach is the child: a dispatched
subagent has no parent history, so its assignment carries the Matter's identity.

**User-authored text is sanitized before it enters a prompt section.** Section
interpolation is strict, so an accidental `{{…}}` would abort assembly for the
parent session.

**Two questions that used to be one.** "Has this Workspace been configured"
(`hasStoredPolicy`: any stored value) and "does this Workspace write anything into
the prompt" (`onboardingStatus === 'configured'`) are different predicates, and
the page used to answer only the first — with a green badge. It now reports both:
the badge keeps its meaning, and a separate 提示词注入 row answers the second, per
part, because the expert directory is not gated on a Profile. See
`docs/MILESTONE-0.1.2.md`.

**The client bundle mounts its own Remote contribution.** `dsh-api-remotes`
discovers nothing; a namespace exists only because the plugin's bundle mounts it.

**Everything user-visible is in Chinese, with the English term beside it.** The
Settings nav reads 工作区组合 / Workspace Composition; the Profile labels read
破产重整 (Bankruptcy). A reader who knows either language can navigate.

## 6. What this plugin does not own

`AGENTS.md`; Agent presets; the agent loop; model providers and adapters; tools,
approval and sandbox; Workspace and Session creation, persistence and resume;
the child-session base; the original project files.

It reads all of those and writes to exactly one place: its own settings
namespace.

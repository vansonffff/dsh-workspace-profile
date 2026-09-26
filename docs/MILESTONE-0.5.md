# Milestone 0.5 — the Matter of a multi-directory Workspace

**Status: 0.5.0.** This round fixes one reported defect: the Matter card answered
"这个目录下没有 matter.yaml" for Workspaces that do have a Matter.

> Names, ids and paths below are placeholders. The real ones are client data and are
> deliberately not in this repository; `test/no-client-data.test.js` enforces that
> against the private workspace's own registry.

---

## The report

> workplace profile 有一个 bug？不能正常识别案件 matter

The screenshot was the Matter card for one litigation Workspace saying its directory
holds no `matter.yaml`. The reading was not wrong about the directory it looked at —
it was wrong about which directories the Workspace has.

## What was actually there, measured

```
$ ls "…/团队文档/示例系列案件_1/matter.yaml"
No such file or directory

$ node scripts/matter-probe.mjs --workspace "/Users/…/My Legal-agents"
示例系列案件  litigation/appellant -> litigation/appellant  ok
              id=11111111-2222-3333-4444-555555555555
… 6/6 mapped to a pair this plugin offers
```

The Matter exists, parses, and maps. It lives in the **product directory**; the
Workspace points at the **case directory**. And the Workspace declares both:

```
$ python3 -c "import sqlite3,json; …" ~/.dsh-codex-project/dirs.db
af87ea27-…-30e53aca841a
  path: /Users/…/团队文档/示例系列案件_1                  ← no matter.yaml
  dirs: ["/Users/…/My Legal-agents/示例系列案件"]         ← matter.yaml
```

Reproduced through the plugin's own functions, in the shape `operations.matter`
calls them:

```
primary only   (what it did)  -> {"discovered":false,"problem":null}
additional dir (declared)     -> {"discovered":true,"id":"11111111-…","name":"示例系列案件"}
```

So the defect was not in the reader — the reader is exact, and its six-for-six run
above is the control. The defect was that **both callers passed one path**, so a
Workspace that declares its Matter in an added directory could never be recognised.

**Every registered Workspace on this machine had that shape.** One is the same case
(its added directory *is* its Matter Root); another adds the parent of six Matters,
which is deliberately not enough — see "not searched through" below.

### Why it was not caught

`docs/MILESTONE-0.2.md` records the reason in its own words: at the time, *"no case
directory on this machine is registered as a DSH Workspace, so a positive `matter`
answer had no Workspace to be positive about."* The milestone went to the trouble of
building a throwaway probe home to get a positive case at all — and tested it with a
Workspace that *is* a Matter Root. The real Workspaces are not shaped that way.

### This is not the deferred Registry Binding

MILESTONE-0.2 worked out and then deferred a **Registry Binding**: matching a
Workspace to a Matter through CaseBench's `_registry.json`. That is still not done,
and this round did not do it. The `case_dir` field it would have matched on is
absent from every real `matters[]` entry (a migration defect upstream), and
CaseBench's own rule 6 forbids inferring a Matter from a Registry name.

This round uses the **user's own declaration** instead: `dsh-multi-project` records
which directories were added to a Workspace, and the Matter is read from a file in
one of them. Nothing is inferred from a name, a registry entry or a Workspace id;
identity still comes from `matter.id` inside `matter.yaml`. The trigger conditions
written down in MILESTONE-0.2 stay as they were — none of them fired. What changed
is that the gap those conditions were *about* ("the plugin is inert for the real
Workspaces") no longer needs the Registry to close.

---

## The change

Two packages, because the record of the declared set belongs to the plugin that owns
it.

**`dsh-multi-project` — a read-only face** (`src/workspace-dirs.ts`):

- `ctx.provide('workspaceDirs', { dirsFor(workspaceId) })`, registered on the
  plugin's own fiber so it leaves with the row;
- one derivation of roots, shared with the fence: `additionalDirsOf(record)` is now
  the single place a record is split into surviving and vanished dirs, and both
  `matchingWorkspace` (the fence) and the new face answer from it — AGENTS.md's
  "fence 只改一处";
- the face answers with the **additional** dirs only, never the record's own `path`:
  the workspace registry is the authority for that, and a second copy could disagree
  after a Workspace is repointed;
- `undefined` ("no record") and `{ dirs: [] }` ("declared nothing extra") stay
  distinguishable;
- a read never creates the store. `loadWorkspaceDirs()` would create the DB and its
  parent — correct for a write path, wrong for a lookup.

**`dsh-workspace-profile` — search the declared set** (`src/matter-resolution.js`):

- `findMatter(start, { roots })`, `searchOrigins(start, declared)`, and one boundary
  rule: **the walk from any start stops at the topmost declared directory that
  contains it**. With one directory that is CaseBench's rule unchanged;
- the session's own chain is searched first and is decisive. Only when it answers
  nothing are the other declared directories searched, each as itself;
- a start that strictly contains another start is dropped (the deeper walk covers
  it); a session cwd outside every declared directory is not searched at all;
- a directory is **not searched through**: a Matter above an added directory is
  unreachable unless that higher directory is declared too. Declaring the *parent*
  of several Matters therefore still resolves nothing — which is why the fix for that
  Workspace is to declare the specific case directory, not for the plugin to scan
  children;
- two declared directories holding two Matters is a reported ambiguity. Picking one
  would attribute a session to a case on the strength of directory order;
- `ctx.workspaceDirs` is consumed as an **optional** seam: without
  `dsh-multi-project` the set is the registry path alone, i.e. the old behaviour;
- when the seam throws (an unreadable store), the Settings read surfaces the failure
  rather than narrowing to one directory, and the Agent path bounds itself to the
  cwd rather than walking to the filesystem root. Fail closed, not open.

**The card** now shows 案件目录 (`facts.root`) and, for a Workspace with more than
one declared directory and no Matter anywhere in the set, names every directory that
was searched. `searched` is part of the Remote answer for that reason: "这个目录下
没有" was a statement about one directory that the user never made.

---

## Verification

```
dsh-workspace-profile   node --test "test/*.test.js"     247 / 247   (was 230)
dsh-multi-project       vitest run                       9 failed | 244 passed  (baseline: 9 failed | 233 passed)
```

The nine failures in `dsh-multi-project` are the pre-existing `/var` vs
`/private/var` canonicalisation failures in `context-injection`, `dirs-api` and
`search-upload` — the same nine, in the same three files, before and after. The
package's own record calls that the environment baseline.

**The composition is its own tested function.** The six lines that decide which
directories are searched — the Workspace's own path, then `ctx.workspaceDirs` — began
inside `apply`, where no test could see them: the operation tests supply their own
`getWorkspaceRoots`, so dropping an added directory in the real composition would
have failed nothing. They are now `src/workspace-roots.js`, unit-tested for order,
de-duplication, unusable entries and a surprising `extra` shape, and the same
extraction is what the card's `searched` list and the Agent path both go through.
The negative control for it: emptying the `extra` loop turns the new cases red.

**The shipped artifact was checked, not just the sources.** `dsh-multi-project` is
loaded by the desktop app as `lib/index.js`, so the built file was mounted in a real
Cordis context with a consumer that uses the published contract; the provider was the
built `apply`, not the TypeScript entry. It answered with the canonical added
directory. (The sources are covered by the vitest suite; this closes the gap between
"the source provides it" and "what the app loads provides it".)

**A real Cordis context, two plugins** (`tests/workspace-dirs.spec.ts`): a provider
that calls `provideWorkspaceDirs`, and a consumer written the way this plugin writes
it (`inject: ['workspaceDirs']`, then `ctx.workspaceDirs.dirsFor(id)`). This is the
one link a stubbed context cannot show. The paired case asserts the other half: with
no provider mounted the consumer never runs, so a profile without
`dsh-multi-project` degrades instead of refusing to activate.

**Negative controls** — each planted defect turned the named test red, then the tree
was restored and re-run green:

| Planted defect | Turned red |
|---|---|
| `operations.matter` passes only the primary path | the added-directory operation test, and the two-matter one |
| the Agent path ignores the declared set | the two readers agree; both added-directory tests |
| only the session chain is searched | 6 cases, including the searchOrigins boundaries |
| ambiguity resolved by taking the first finding | both ambiguity cases |
| the card drops the several-directory wording | the searched-list case |
| the face echoes the record's `path` | 4 cases, including the shape guard |
| the read creates the store | the no-creation case |
| vanished dirs dropped instead of reported | the split and anti-drift cases |
| `apply` no longer provides the service (multi-project) | the plugin-shape case |
| the service renamed on the provider side | the real-context consumer case |
| `composeWorkspaceRoots` drops the added dirs | the composition cases |

One real leak was caught by the repository's own guard during this round: the first
draft of the operation test used a real matter name, and `no-client-data.test.js`
failed the build with the file and the name. It is now a fixture name, and the test
says why.

### What is verified, and what is not

Verified: discovery, boundaries, ambiguity and the wiring of the seam, at unit and
integration level, against real files on this machine and a real Cordis context. The
six real Matters still read end to end through the probe.

Not verified: **the running Host**. `scripts/remote-probe.mjs` cannot boot this
installation any more — under 0.1.7-rc.1 every platform row fails to import in the
probe's composed tree (151 rows), before any plugin of this package is reached. That
is a defect in the probe, not in this change, and it is left as its own task rather
than worked around inside this round. The consequence: the settings card has not been
seen in the running GUI with the new copy; the acceptance for that is a restart plus
a look at one of the affected Workspaces.

### Acceptance (2026-09-26, desktop app, reported by the owner)

The Host half was accepted by hand on the desktop app after a restart, which closes
the paragraph above. The Matter card for the affected Workspace reads:

```
名称                 示例系列案件
案件目录              …/My Legal-agents/示例系列案件      ← the new row: an ADDED directory
Matter ID             11111111-…                        (matches matter.yaml)
类型                  litigation
正式角色              appellant
程序阶段              unknown
类型与工作区配置       一致
正式角色与默认视角      一致
```

Two things this settles beyond "the bug is gone". The **案件目录** row is the added
directory rather than the team drive, so the answer now says *which* directory it came
from instead of leaving that in a log. And the verdicts are `一致`/`一致`, which is the
value a Workspace configured for the Matter it actually holds must report — a page that
had found the Matter but mis-mapped it would have shown a mismatch here.

Not part of this acceptance: the Workspace whose added directory is the *parent* of
several Matters still resolves nothing, by design; its fix is to declare the specific
case directory. Stated again because it is the one place where "it still says no Matter"
is the correct answer.

---

## Corrections to earlier records

- MILESTONE-0.2's architecture sketch ends at `MatterResolver.resolvePath(path)`.
  The signature is now `resolvePath(path, roots)`, and the roots come from
  `getWorkspaceRoots`, not from the registry path alone.
- The claim in MILESTONE-0.2 that manual Profile + Perspective configuration is
  "the plan" is unchanged: nothing here applies a Profile automatically. What
  changed is that the *reporting* layer now has something to report for the
  Workspaces that actually exist.

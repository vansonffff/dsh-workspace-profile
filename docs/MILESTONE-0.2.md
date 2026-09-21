# MILESTONE 0.2 — Matter integration

> What this round added, how it was verified, the defects it found, and what it
> deliberately does not do. `docs/MILESTONE-0.1*.md` cover the earlier rounds.

## What it is

A CaseBench **Matter** is a legal case with a stable identity, recorded in a
`matter.yaml` at the case directory. Until now this plugin knew only *which
Workspace* a session was in; it had no idea a directory could also be a case, and
no way to notice that a Workspace's Profile disagreed with the matter it was
sitting inside.

This round makes the plugin **see** the Matter:

```
matter.yaml in the directory
      │
      ├─ Matter Discovery      cwd → nearest matter.yaml above it
      ├─ Matter Header         Settings → 工作区 → the Matter card
      ├─ Profile Match         matter.type      vs the Workspace Profile
      ├─ Perspective Match     engagement.role vs the default Perspective
      └─ SubAgent Context      the facts travel into a dispatched child
```

Whatever the Matter declares, **it is read and reported, never applied.** A
mismatch is shown; nothing re-points a Workspace because a file on disk changed.

## The decision worth recording: how `matter.yaml` is read

`matter.yaml` is YAML, and this package has **no dependencies and no build step**.
Three options were considered:

1. add a YAML library — loses both properties the package is built on;
2. have CaseBench emit a JSON sidecar — requires changing a frozen upstream, and
   creates a second source of truth for the same facts;
3. read the subset CaseBench actually writes.

Option 3, in `src/matter-yaml.js`. CaseBench writes the file with PyYAML
`safe_dump(..., default_flow_style=False, sort_keys=False)`, so the shapes are
enumerable: nested block mappings, block sequences (at the *same* indent as their
key — PyYAML's default), `[]` / `{}`, scalars, single-quoted strings.

**The load-bearing half of the contract is what happens to everything else: it
throws.** A parser that guessed would not surface a parse error; it would surface a
wrong `type` or `role` — and a wrong role silently selects the wrong professional
stance for a live matter. Refusing turns that into "no Matter", which the page can
state honestly.

Measured, not assumed — and **reproducible from this repository**, which the
first version of this document could not honestly claim:

```
test/fixtures/matter.golden.yaml   real PyYAML 6.0.3 safe_dump output
test/fixtures/matter.golden.json   what PyYAML parsed that text back to
   asserted equal to this reader's answer   →  a golden fixture, not a hand-written one
   regenerate: python3 scripts/matter-yaml-golden.py [--pyyaml <dir>]

14 shapes outside the subset (anchors, aliases, tags, multiple
documents, flow collections with content, tabs, block scalars,
inline comments, duplicate keys, …)        each refused by name, in unit tests
whole-line comments and blank lines        ignored, not refused

node scripts/matter-probe.mjs --workspace <real workspace>
   reads every matter.yaml and prints what was found; exit 0 = all mapped
   --json emits the same answer for diffing against PyYAML (the recipe is in
   the script's header, and it was run: six live matters, field for field
   identical)
```

## The mapping, and why it is a table

CaseBench froze `litigation` / `bankruptcy` / `non-litigation` with their own role
tokens; this plugin froze its Perspective ids independently. The two were never
required to agree, and **they do not**:

| CaseBench `type` | Profile | CaseBench `role` | Perspective |
|---|---|---|---|
| `litigation` | `litigation` | `plaintiff` … `respondent-to-application` | same token |
| `bankruptcy` | `bankruptcy` | `administrator` … `restructuring-advisor` | same token |
| `non-litigation` | `non-litigation` | `debtor` | `debtor-oc` |

`litigation` and `bankruptcy` coincide, and that is **recorded** in
`ROLE_TO_PERSPECTIVE` rather than relied upon — a rename on either side should show
up as a changed table, not as a silent mismatch at runtime.

Non-litigation diverges deliberately. It was added this round, and its ids carry an
`-oc` suffix ("out of court") because a `debtor` inside a proceeding and a `debtor`
outside one are different jobs: in a proceeding the work is procedural (claims,
voting, court approval), outside it the work is negotiation, timeline and leverage.
The id is what gets typed at `/perspective`, so it is abbreviated; the label spells
the meaning out.

The two escape hatches are **not** the same kind of thing, and are mapped
differently:

- `role: unknown` / `role: other` → **no stance** (`none`). "We have not decided
  which side we are on yet" does not make the domain unknown.
- `type: other` / `type: unclassified` → the **`general` Profile**, which offers no
  stance. Here it is the *domain* that is unknown.

## Defects this round found

Every one was found by a test or by running against the real corpus, not by review.

1. **`stat()` follows symlinks, so a symlinked `matter.yaml` was accepted.**
   CaseBench requires the contract to be a real file — a link is how one Matter
   Root comes to impersonate another. `lstat` now.
2. **The identity mapping had no guard.** `litigation + administrator` returned
   `administrator` — an id belonging to the *Bankruptcy* Profile. `matchMatter`
   caught it, but a careless caller could have stored it. The mapping now returns
   `null` for an impossible pair.
3. **"Impossible pair" and "no stance" were the same value.** A domain with a table
   that does not list a role has no such position — that is bad data, not an
   undecided user. `null` and `none` are now distinct.
4. **A `useEffect` read `revision` before its declaration** — a temporal dead zone,
   caught by the client-bundle tests as 29 failures at once.
5. **The page said "there is no matter.yaml here" about a file that exists but
   could not be read.** Absence and unreadability share `discovered: false` and must
   not share a sentence.

Three descriptor tables had to stay in step (host `invocations.js`,
`typert.remote-client.js`, and the copy inlined in `client.js`); two existing tests
caught the first two omissions immediately, which is exactly what they are for.

## What it deliberately does not do

- **It does not inject the Matter into the parent session's prompt.** The
  requirement is a Settings readout. Section names and orders are frozen and
  measured (`docs/COMPATIBILITY.md` §7); a new prompt contribution is a cost paid
  for a purpose.
- **It does not apply a recommendation.** No button writes a Profile or a
  Perspective from the Matter. A file can change without the user touching this
  page, and silently reconfiguring a Workspace would be making a professional
  judgement on their behalf.
- **It does not write to the Matter.** The read is a read; `matter.yaml` is never
  modified, and the plugin never creates one. A directory without a Matter is an
  ordinary project directory.
- **It does not infer identity from a directory name.** The name is a label;
  `matter.id` is identity, and only the file carries it. A test renames a directory
  to match one matter while holding another matter's contract, and asserts the file
  wins.
- **It does not resolve a nested Matter per-tool-call.** The Matter is resolved at
  the session's cwd at step boundaries. A session that walks into a *different*
  matter's directory mid-task keeps the Matter it started with.

## Limitations, stated plainly

- **The YAML reader is a subset reader.** A hand-edited `matter.yaml` using anchors,
  flow collections with content, or block scalars is refused — the page will say the
  file could not be read. That is deliberate, and the alternative is a wrong answer.
- **The Matter is resolved from the session's cwd, not from the Workspace root.**
  If a session starts in a subdirectory of the matter, discovery walks up and finds
  it; if it starts outside, there is no Matter even when the Workspace contains one.
- **`procedure.kind` and `procedure.stage` are read and displayed but not mapped.**
  Their vocabulary is not frozen upstream, so nothing depends on their values.
- **A Matter resolving per session means a directory moved mid-session is not
  noticed** until the next session, which is the same lifetime the Workspace
  resolution has.

## Verification

```
node --test "test/*.test.js"     220 tests, all passing (was 162 before this round)
   (run `node scripts/link-platform-deps.mjs` first on a fresh clone)
                                    +8  matter-yaml    the subset reader, both halves
                                    +33 matter-match   discovery, boundary, Contract,
                                                        mapping tables, verdicts
                                    +5  dispatcher     the stance a child inherits
                                    +3  compilers      the dispatch Matter block
                                    +4  client-bundle  the Matter card
                                    +1  no-client-data the published-repo guard
```

Against the real corpus, via the probe (not via a one-off script that leaves no
trace): the six live matters in the working workspace were read end to end —
discovered, parsed, mapped and compared — and each maps to a pair the plugin
offers. A Workspace configured from its Matter reports `match/match`; the same
Matter against a different Workspace reports `mismatch/mismatch`.

---

## Revision 2 — trust boundaries and context propagation

An independent review of `82d1ec3` held the milestone at HOLD and named seven
gaps. All seven were real; none was a disagreement about direction. They are
fixed here, in its order.

### 1. A dispatched child inherited the Workspace default, not the session's stance

The child's assignment used `policy.defaultPerspective`. The parent's own prompt
section has always read the *session's* `/perspective` override first, so:

```
session: /perspective investor
parent works from:   investor
child was told:      administrator
```

and nothing on either side said so. `compileDispatchTask`'s own comment promised
"the effective stance".

Fixed by extracting `resolveEffectivePerspective()` into `policy.js` — one function
that both the prompt section and the dispatcher call, so parent and child cannot
answer the same question differently. It also records in the child's assignment
whether the stance is the session's or the Workspace's, because a stance that lasts
one conversation is a different fact from a stance that is permanent.

Tests: the session's stance reaches the child; `none` silences the child too; a
stance the current Profile does not define is dropped rather than translated; a
broken lookup costs the child its override but not its stance.

### 2. Matter discovery crossed the Workspace boundary

`findMatterFile` walked to the filesystem root. CaseBench's Contract stops at the
workspace root and forbids crossing it. A Workspace that is an ordinary project
directory sitting inside a directory that happens to hold a `matter.yaml` would
have been adopted as that Matter. `findMatter`/`findMatterFile` now take
`workspaceRoot`, supplied from the Workspace the session already resolved into.

The boundary comparison is by path segment, not string prefix: `/work/matter-old`
starts with `/work/matter` but is a sibling.

### 3. Strict about YAML syntax, not about the Contract

`matter-yaml.js` refused unknown *syntax*, but a document that parsed was taken at
face value: `schema_version: 999` was not noticed, `type: nonsense` fell back to
the `general` Profile, and `id: not-a-uuid` was accepted. The page could therefore
report a confident, ordinary answer about a broken Matter — the failure the strict
reader exists to prevent, one level up.

`src/matter-contract.js` now pins CaseBench **3.2.8**'s vocabulary — transcribed,
not derived, because a table that followed the upstream would pin nothing — and
validates `schema_version`, the id's UUID form, a non-empty name, the type
vocabulary, and the type↔role constraint.

It also checks the **case state**: `_case_state.json` must exist, be State v4, and
carry the same `matter_id`. `matter.yaml` alone is not the identity, and telling a
child "you are working on Matter AAA" while the state says BBB is a false statement
about a live matter.

### 4. "Recorded, not assumed" was only half true

The module argued that a name coincidence should be recorded in a table rather than
relied upon — and then only `non-litigation` had one, with everything else falling
through a `table === undefined ? roleKey` fallback. Every type now has an explicit
row, the fallback is gone (an unknown type maps to nothing, not to itself), and a
test asserts each row lists exactly the roles the Contract defines — so a rename on
either side turns red.

### 5. `lstat` failures were all read as "no file here"

`ENOENT` and `EACCES` are different answers. Collapsing them sent an unreadable
candidate's walk *upward*, where it could find a different Matter and attribute the
session to that one. Only `ENOENT` and `ENOTDIR` mean absence now; anything else is
reported and stops the walk.

### 6. The privacy guard's skip was a pass

`catch { return }` inside `node:test` reports **pass**, not skip — so a fresh clone
or CI showed a green tick on a check that ran nothing. It now calls `t.skip()`, and
`RELEASE_CHECK=1` turns the skip into a failure, so a release either checks or
refuses rather than shipping unexamined.

### 7. Documentation drift

The test counts in this file and the README were stale.

### Still not done, deliberately

- **No prompt injection for the parent session.** The requirement is a Settings
  readout; section names and orders are frozen and measured.
- **No apply affordance.** A file can change without the user touching the page.
- **`procedure.stage` is read, displayed, and not mapped.** Its vocabulary is not
  frozen upstream.
- The three `/Users/vanson/...` paths in the probes and dev notes are pre-existing
  and already public in the `v0.1.2` release. One of them
  (`perspective-probe.mjs`'s `REAL_HOME`) is a safety guard that refuses to operate
  on the real home directory; generalizing the probes is a separate change.

## Revision 3 — the Settings read and the Agent read of one Workspace disagreed

The second review passed the architecture and the seven fixes, and then found a
bug in the seam *between* two things that were each individually correct.

`findMatter` already stopped at the Workspace boundary. The Agent path already
passed it. The Settings Matter card did not:

```js
await matterResolver.resolvePath(workspace.path);              // walked to /
await matterResolver.resolvePath(workspace.path, workspace.path);  // stops here
```

So one Workspace had two answers:

```text
/Parent/
    matter.yaml          ← Matter A
    /OrdinaryWorkspace/  ← the DSH Workspace
        src/

Agent     → no Matter
Settings  → Matter A
```

### What made this worth more than a one-line fix

The constructor of `MatterResolver` carried a comment I had written to explain
why the missing argument was fine:

> *absent the walk is unbounded — correct for the Settings read, which passes the
> Workspace path as its own start, and never correct for an Agent.*

That reasoning is wrong, and writing it down is what let the bug survive the
first review round: a reader who wondered about the unbounded walk found a
sentence telling them it was deliberate. Starting *at* the Workspace path does
not stop the walk *at* it. The comment is now replaced with what actually holds,
and `resolvePath`'s JSDoc says what omitting the boundary costs.

The generalisable lesson is about where the tests were. Discovery had thorough
coverage of the boundary rule; the caller that forgot to use it had none. A test
of `findMatter` cannot fail when `operations.matter` declines to pass the
argument, so `test/matter-operation.test.js` drives `operations.matter()`.

### The four tests, and why the count matters

| Test | Before the fix |
| --- | --- |
| A Workspace with no Matter of its own reports none, not the enclosing one | **fails** |
| A Workspace holding a Matter reports it, with its identity and its match | passes (control) |
| The Settings read and the Agent read of one Workspace agree | **fails** |
| The boundary is the Workspace itself, so a nested Matter is found | passes (control) |

Both control tests pass before and after on purpose: they show the fix repairs
the broken case without changing the working ones. The two that fail are the
regression guard, verified by reverting the one-line change and re-running.

The third test is the one that generalises. It asserts the *property that broke*
— two readers of one Workspace giving one answer — rather than either answer on
its own, and it exercises both directory shapes (an ordinary project directory
and a real Matter Root) so neither side can drift alone.

220 tests (was 216).

### Verified end to end, not only in tests

The previous round could not complete the Host-level checks: no case directory on
this machine is registered as a DSH Workspace, so a *positive* `matter` answer had
no Workspace to be positive about. That is now closed using a throwaway probe home
rather than by changing the user's Workspaces — `DSH_HOME` is redirected, so the
real `~/.dsh` is read-only to the probe, and the seeded Workspace lives in the
probe home's own registry.

Both directions, through a real booted Host and a real gateway:

```text
positive   a Workspace that IS a Matter Root
           → discovered: true, id from matter.id, match computed
             {"discovered":true,
              "matter":{"id":"11111111-…","name":"探针案件","type":"bankruptcy",
                        "role":"administrator","status":"active"},
              "problem":null,
              "match":{"profile":{"verdict":"mismatch"},
                       "perspective":{"verdict":"mismatch"}}}

negative   an ordinary project directory inside a directory holding a matter.yaml
           → discovered: false, matter: null, problem: null
             (the enclosing Matter is NOT adopted — the bug this revision fixes)
```

The `mismatch` verdicts in the positive case are correct, not a failure: the probe
Workspace carries no stored policy, so its effective configuration is the built-in
`general` and the Matter's expected Profile is `bankruptcy`. A page that reported
`match` there would be lying.

### A probe line that had always said FAILED

Running the gateway check above exposed a defect in `remote-probe.mjs` itself. It
called `gateway.invoke` with `args: new Map()`; the gateway validates the argument
shape against the method's descriptor and rejected it, so the line printed
`FAILED` for calls that were perfectly reachable. Two wrong guesses were needed to
get it right — `new Map()`, then a blanket `{ args: {} }` for every method, which
`snapshot` rejects because it declares no parameters. The probe now uses the
descriptor's shape: `{}` when no arguments were given, `{ args }` otherwise.

Worth recording because a probe that reports a false failure is worse than no
probe: it is evidence pointing the wrong way, and this one would have been read as
a plugin defect.

## Frozen at 0.2.0 — Registry Binding deliberately deferred

**Status: 0.2.0 is the frozen release of this milestone.** Not 0.2.1. The proposed
Registry Binding round was worked out in full and then *not* started, and the
reason is worth recording so the question does not have to be reopened from
scratch.

### What was actually measured first

The proposal rested on a claim about the real workflow: that a DSH Workspace is a
KDocs/WPS materials directory rather than the Matter Root. That claim is true here.
Of the four registered Workspaces, one is exactly that — a WPS Cloud Files cache
directory — and it is a `case_dir` in the CaseBench registry.

It is *also* true that this plugin is inert for it. Running the real discovery
against that path returns `facts: null`. No Profile Match, no Perspective Match,
no Matter context for a dispatched child. So the gap is real, not theoretical.

### Why it is still not worth doing yet

Two findings changed the shape of the decision.

**Profile and Perspective do not depend on Matter at all.** Both prompt sections
gate on `policy` and `configured` alone (`profile-runtime.js:193`, `:265`).
Configuring them by hand in Settings already delivers the workspace title, the
full Profile body, the full Perspective body, the recommended-Skill list and the
precedence statement. The professional content layer — the part that changes what
the model does — is already there.

What Registry Binding would add is narrower than it looks:

| | manual configuration | with Registry Binding |
| --- | --- | --- |
| Professional content layer injected | yes | yes |
| Plugin knows which Matter this is | no | yes |
| A wrong or missing Profile is *reported* | no — a silent `unknown` | yes, `match` / `mismatch` |
| Dispatched child receives Matter identity | no, silently omitted | yes |
| The manual step is removed | no | **no** — nothing auto-applies by design |

So it buys verification and identity propagation. It does not remove the manual
step, and it is not a core capability.

**It would add a lifecycle and an identity mapping**, not a line of code: Workspace
↔ Registry ↔ Matter Root ↔ per-step refresh ↔ Settings ↔ SubAgent. That is real
complexity, and the honest trigger for accepting it is a felt pain, not a
theoretical gap.

### The trigger conditions, written down

Revisit only if one of these actually happens in use:

- forgetting to set Profile, or setting the wrong Perspective
- a dispatched child producing work that went wrong because it did not know which
  matter it was working on
- needing to look up Matter state from inside DSH often enough to be annoying
- enough matters that mapping them to `My Legal-agents` by hand is a real cost
- wanting KDocs, To Do and Calendar to move around `matter_id` automatically

Until then, manual Profile + Perspective is the plan, and it is a sound one.

### Two upstream facts a future round will run into

Both were verified against the real registry and the CaseBench source, and both are
recorded in that project's own log. Summarised here only as far as they affect this
plugin:

- `case_dir` — the field a Registry Binding would match on — is absent from every
  one of the six real Matters' `matters[]` entries, and present in `cases[]`, the
  legacy projection that CaseBench's own rule says v2 readers must not trust. The
  cause is a migration defect (`matter_migration.py:799` builds the entry without
  passing `case_dir`), not an architecture one: the field already exists in the v2
  schema.
- Creating a Matter without `--case-dir` produces no binding at all, and there is no
  `set` or `bind` command to add one afterwards. The Skill's own references never
  mention the flag, so a Matter created by following the documented workflow lands
  unbound every time.

Neither is this plugin's to fix, and neither blocks the freeze.

### What "frozen" means here

`0.2.0` is the release. Further work on this milestone stops unless a trigger above
fires. Thin Skill rework is deferred the same way, for the same reason: which
references actually carry the context cost is a question that real use answers and
architecture guessing does not.


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
node --test "test/*.test.js"     197 tests, all passing (was 162 before this round)
                                    +6  matter-yaml    the subset reader, both halves
                                    +21 matter-match   discovery, mapping, verdicts
                                    +3  compilers      the dispatch Matter block
                                    +4  client-bundle  the Matter card
```

Against the real corpus, via the probe (not via a one-off script that leaves no
trace): the six live matters in the working workspace were read end to end —
discovered, parsed, mapped and compared — and each maps to a pair the plugin
offers. A Workspace configured from its Matter reports `match/match`; the same
Matter against a different Workspace reports `mismatch/mismatch`.

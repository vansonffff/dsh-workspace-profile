# Third-party notices

## No third-party code is included

**This package contains no copied third-party code, and therefore carries no
third-party licence obligation.**

The plan that produced it named three projects as possible interaction
references. None was consulted while writing this package, and no line from any
of them was copied, adapted or paraphrased into it. Every question was answered
from the installed `@deepseek-ai/dsh` distribution and from the two third-party
plugins already present on the development machine — `kdocs-settings` and
`dsh-apple-calendar` — which were read as *behavioural* evidence for the DSH
client contract, not copied.

| Project | Owner | Consulted | Copied |
|---|---|---|---|
| `dsh-client-ui-settings-skills` | `dsh-mixxed` | no | nothing |
| `dsh-specify-subagent-suite` | `Cho-Geer` | no | nothing |
| [`dsh-settings-ui`](https://github.com/KaramachiA217/dsh-settings-ui) | `KaramachiA217` | no | nothing |

`dsh-settings-ui` is listed because it is the only one of the three whose
repository could be resolved at the time of writing, so a future reader can find
it. It is **not** a runtime dependency: the browser half requires only `react` and
`react/jsx-runtime` from the platform seed, and `test/manifest.test.js` asserts
exactly that.

## If that changes

Copying code from any of the above, or from any other project, obliges this file
to record, before the first line is copied:

- the project, its owner and its repository URL;
- the exact commit copied from;
- the licence, with its text reproduced if the licence requires it;
- which files were copied and how they were modified.

`docs/COMPATIBILITY.md` §13 records the same obligation for the Phase 0 review.

## Dependencies

Runtime dependencies are the DSH distribution itself, linked from the profile's
own module tree (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`,
`@deepseek-ai/dsh-typert-protocol`, `@deepseek-ai/dsh-scope`,
`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-home-paths`, `zod`) plus
`node:crypto` and `node:fs/promises`. They are not vendored, not bundled, and not
redistributed by this package.

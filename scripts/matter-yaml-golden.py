#!/usr/bin/env python3
"""Regenerate the PyYAML golden fixture the matter.yaml reader is tested against.

`test/matter-yaml.test.js` asserts that `src/matter-yaml.js` parses
`test/fixtures/matter.golden.yaml` into exactly `test/fixtures/matter.golden.json`.

The point of the pair is its provenance: the YAML is real PyYAML `safe_dump`
output — the same call CaseBench's `matter_io._dump_yaml` makes — and the JSON is
what PyYAML parsed that document back to. So the expected value is *the writer's
own answer*, not this package's opinion of what the writer would say. A fixture
written by hand could only ever prove that the reader agrees with its author.

Run this after any change to what the reader accepts:

    python3 scripts/matter-yaml-golden.py

Requires Python 3.11+ and PyYAML. CaseBench vendors PyYAML at
`scripts/vendor/`; point `--pyyaml` at it if PyYAML is not installed:

    python3 scripts/matter-yaml-golden.py \\
        --pyyaml "/Users/you/Documents/Shared Legal Skills/scripts/vendor"

**Never hand-edit the fixtures.** If the reader and the fixture disagree, one of
them is wrong and the diff is the evidence.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

# The document deliberately exercises every shape the reader claims to support,
# and a few it must merely preserve: non-empty block sequences, deep nesting,
# both quote styles inside a plain scalar, a value PyYAML quotes to keep it a
# string (the timestamp), booleans, ints, null, and the empty collections.
DOCUMENT = {
    "schema_version": 1,
    "matter": {
        "id": "11111111-2222-3333-4444-555555555555",
        "code": None,
        "name": "含'单引号'与\"双引号\"的案名",
        "aliases": ["别名一", "alias-two"],
        "type": "bankruptcy",
        "subtypes": [],
        "status": "active",
    },
    "jurisdiction": {"country": None, "province": None, "city": None, "court": "上海三中院"},
    "engagement": {"role": "administrator", "represented_party": None},
    "procedure": {"kind": "reorganization", "stage": "claim-review"},
    "governance": {"case_tier": None},
    "modules": ["bankruptcy.real-estate", "bankruptcy.construction"],
    "bindings": {"court": "SH-03", "nested": {"deep": {"deeper": "value"}}},
    "metadata": {
        "created_at": "2026-09-19T07:27:01+08:00",
        "updated_at": "2026-09-19T07:27:01+08:00",
        "created_by": "dsh",
        "count": 42,
        "flag": True,
        "nothing": None,
        "empty_list": [],
        "empty_map": {},
    },
}

# The output directory must not be resolved through a symlink for the golden
# files' own paths to mean anything; resolve() keeps the write honest.
FIXTURES = pathlib.Path(__file__).resolve().parents[1] / "test" / "fixtures"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pyyaml",
        default=None,
        help="directory to add to sys.path so `import yaml` works (CaseBench vendors PyYAML here)",
    )
    args = parser.parse_args()

    if args.pyyaml:
        sys.path.insert(0, args.pyyaml)
    try:
        import yaml  # noqa: PLC0415
    except ImportError:
        print("PyYAML is not importable; pass --pyyaml <dir> or install it.", file=sys.stderr)
        return 2

    FIXTURES.mkdir(parents=True, exist_ok=True)
    # Exactly the call CaseBench makes. `sort_keys=False` matters: the reader is
    # tested against the key order the writer produces, not a sorted one.
    yaml_text = yaml.safe_dump(
        DOCUMENT, allow_unicode=True, default_flow_style=False, sort_keys=False
    )
    # Read the text back rather than re-serializing the Python object: what is
    # committed as "expected" must be what PyYAML understood from the committed
    # text, not what we happened to build in memory.
    parsed = yaml.safe_load(yaml_text)

    (FIXTURES / "matter.golden.yaml").write_text(yaml_text, encoding="utf-8")
    (FIXTURES / "matter.golden.json").write_text(
        json.dumps(parsed, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"wrote {FIXTURES / 'matter.golden.yaml'} (PyYAML {yaml.__version__})")
    print(f"wrote {FIXTURES / 'matter.golden.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

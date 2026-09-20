import assert from 'node:assert/strict';
import test from 'node:test';

import { MatterYamlError, parseMatterYaml } from '../src/matter-yaml.js';

// The two halves of this reader's contract are equally load-bearing, and they are
// tested as such: it must read exactly what CaseBench writes, and it must refuse
// everything else rather than guess. A guess would not surface as a parse error —
// it would surface as a wrong `role`, and a wrong role silently selects the wrong
// professional stance for a live matter.

test('reads the shape CaseBench writes', () => {
  // Produced by PyYAML `safe_dump(..., default_flow_style=False, sort_keys=False)`,
  // which is what `matter_io._dump_yaml` calls. Note the block sequences sitting at
  // the *same* indent as their key — that is PyYAML's default, not a quirk of the
  // fixture, and a parser that required deeper indentation would reject every real
  // file that has a non-empty list.
  const text = [
    'schema_version: 1',
    'matter:',
    '  id: 11111111-2222-3333-4444-555555555555',
    '  code: null',
    "  name: 含'引号'与\"双引号\"的案名",
    '  aliases:',
    '  - 别名一',
    '  - alias-two',
    '  type: bankruptcy',
    '  subtypes: []',
    '  status: active',
    'engagement:',
    '  role: administrator',
    '  represented_party: null',
    'procedure:',
    '  kind: reorganization',
    '  stage: claim-review',
    'modules:',
    '- bankruptcy.real-estate',
    'bindings: {}',
    'metadata:',
    "  created_at: '2026-09-19T07:27:01+08:00'",
    '  count: 42',
    '  flag: true',
    '  nested:',
    '    deeper: value',
  ].join('\n');

  const doc = parseMatterYaml(text);
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.matter.id, '11111111-2222-3333-4444-555555555555');
  assert.equal(doc.matter.code, null);
  assert.equal(doc.matter.name, '含\'引号\'与"双引号"的案名');
  assert.deepEqual(doc.matter.aliases, ['别名一', 'alias-two']);
  assert.deepEqual(doc.matter.subtypes, []);
  assert.equal(doc.engagement.role, 'administrator');
  assert.equal(doc.procedure.stage, 'claim-review');
  assert.deepEqual(doc.modules, ['bankruptcy.real-estate']);
  assert.deepEqual(doc.bindings, {});
  // A quoted timestamp stays a string; `safe_dump` quotes it precisely so a
  // reader does not turn it into a date.
  assert.equal(doc.metadata.created_at, '2026-09-19T07:27:01+08:00');
  assert.equal(doc.metadata.count, 42);
  assert.equal(doc.metadata.flag, true);
  assert.equal(doc.metadata.nested.deeper, 'value');
});

test('single quotes inside a single-quoted scalar are doubled, not terminated', () => {
  assert.equal(parseMatterYaml("name: 'it''s here'").name, "it's here");
});

test('blank lines and whole-line comments are ignored', () => {
  assert.deepEqual(parseMatterYaml('# head\n\na: 1\n\n# middle\nb: 2\n'), { a: 1, b: 2 });
});

test('a key with no value and no block is null, not an error', () => {
  assert.deepEqual(parseMatterYaml('a:\nb: 1\n'), { a: null, b: 1 });
});

test('everything outside the subset is refused by name', () => {
  const refused = [
    ['anchor', 'a: &x 1'],
    ['alias', 'a: 1\nb: *x'],
    ['tag', 'a: !!str 1'],
    ['a second document', 'a: 1\n---\nb: 2'],
    ['a flow sequence with content', 'a: [1, 2]'],
    ['a flow mapping with content', 'a: {b: 1}'],
    ['tab indentation', 'a:\n\tb: 1'],
    ['a block scalar', 'a: |\n  text'],
    ['an inline comment', 'a: 1 # note'],
    ['a duplicate key', 'a: 1\na: 2'],
    ['a non-mapping top level', '- 1\n- 2'],
    ['an empty file', ''],
    ['an indentation jump', 'a: 1\n    b: 2'],
    ['a mapping inside a sequence item', 'a:\n- k: v'],
  ];
  for (const [what, text] of refused) {
    assert.throws(
      () => parseMatterYaml(text),
      MatterYamlError,
      `${what} must be refused, not guessed at`,
    );
  }
});

test('the error names the line, so a hand-edited file can be fixed', () => {
  assert.throws(() => parseMatterYaml('a: 1\nb: *x'), /line 2/);
});

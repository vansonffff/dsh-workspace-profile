/**
 * The panel's own copy, asserted rather than assumed.
 *
 * Two rules, both of which were broken before this file existed and neither of
 * which any other test could see: the tests render through a `t()` stand-in that
 * returns the *key*, so every existing assertion is about which keys were used and
 * says nothing about what a user reads.
 *
 * 1. **No Chinese label is left as bare English.** The panel is read by a Chinese
 *    reader; an English-only label ("Profile", "Key", "Matter ID") is a term they
 *    have to translate before they can decide what the control does. Where the
 *    English term is one they meet elsewhere — `AGENTS.md`, CaseBench's own
 *    `Matter ID`, the `key` a Subagent is addressed by — it is kept, but beside the
 *    Chinese, never instead of it.
 * 2. **The two bundles carry the same keys.** A missing key in one language falls
 *    back to the key name itself on screen, which reads as a defect only in the
 *    language nobody on this machine uses — so nothing catches it by accident.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/** At least one Han character. */
const CJK = /[\u3400-\u9fff]/;

/**
 * Read the two dictionaries out of the bundle source.
 *
 * The bundle is a classic script that registers itself with `__ModuleLoader__`, and
 * the browser-only half of it (React, slots) cannot be imported here — but the copy
 * is plain data at a known place, and reading it as text is what makes this test
 * independent of the render harness.
 *
 * Each language is sliced by **brace matching**, not by "everything after `en: {`":
 * the first draft of this test ran to the end of the file and collected `key`,
 * `role` and `type` out of unrelated object literals further down, which reported a
 * key-parity failure that did not exist. Single-quoted strings are skipped, so a
 * brace inside a label cannot end a slice early.
 *
 * @returns {{ zh: Record<string, string>, en: Record<string, string> }} both bundles.
 */
function dictionaries() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const dicts = source.indexOf('const DICTS = {');
  assert.ok(dicts > 0, 'the DICTS bundles moved; fix this test rather than deleting it');

  /**
   * The object literal following one `label: {` marker.
   *
   * @param {string} marker - `'zh: {'` or `'en: {'`.
   * @returns {string} the slice from `{` to its matching `}`.
   */
  const slice = (marker) => {
    const at = source.indexOf(marker, dicts);
    assert.ok(at > 0, `${marker} not found in the bundle`);
    const open = source.indexOf('{', at);
    let depth = 0;
    let quote = false;
    for (let index = open; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === "'") quote = false;
        continue;
      }
      if (char === "'") quote = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(open, index + 1);
      }
    }
    throw new Error(`unbalanced braces after ${marker}`);
  };

  const read = (block) => {
    const out = {};
    for (const match of block.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*):\s*'((?:[^'\\]|\\.)*)',/gm)) {
      out[match[1]] = match[2];
    }
    return out;
  };
  return { zh: read(slice('zh: {')), en: read(slice('en: {')) };
}

test('no Chinese label is left as bare English', () => {
  const { zh } = dictionaries();
  assert.ok(Object.keys(zh).length > 100, 'the Chinese bundle was not read');
  const bare = Object.entries(zh).filter(([, value]) => !CJK.test(value));
  assert.deepEqual(
    bare,
    [],
    `these Chinese labels have no Chinese in them:\n  ${bare.map(([key, value]) => `${key} = ${value}`).join('\n  ')}`,
  );
});

test('the two bundles carry exactly the same keys', () => {
  const { zh, en } = dictionaries();
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key));
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key));
  assert.deepEqual({ missingInEn, missingInZh }, { missingInEn: [], missingInZh: [] });
});

test('a label keeps the Chinese first and the English term beside it', () => {
  // Not every bilingual label, but the ones where a reader looks for a word they
  // already know from AGENTS.md, CaseBench or a dispatch prompt. If one of these is
  // ever "cleaned up" to English only, the rule above turns red — this case says
  // *which* terms must survive, so the fix is not to drop the English.
  const { zh } = dictionaries();
  assert.equal(zh.profile, '类型（Profile）');
  assert.equal(zh.matterId, 'Matter ID（案件标识）');
  assert.equal(zh.fKey, '标识（Key）');
  assert.equal(zh.globalAgents, '全局 AGENTS.md');
  assert.equal(zh.projectAgents, '项目 AGENTS.md');
});

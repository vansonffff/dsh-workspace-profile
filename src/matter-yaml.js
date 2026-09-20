/**
 * A strict reader for the `matter.yaml` subset CaseBench actually writes.
 *
 * ## Why this exists, and why it refuses rather than guesses
 *
 * `matter.yaml` is YAML, and this package has no dependencies and no build step.
 * The two honest options were to add a YAML library and lose both properties, or
 * to read the subset that is really there. This is the second: CaseBench writes
 * the file with PyYAML `safe_dump(..., default_flow_style=False, sort_keys=False)`,
 * so the shapes that can occur are enumerable — nested block mappings, block
 * sequences, `[]` / `{}`, scalars, and single-quoted strings.
 *
 * The important half of the contract is what happens to everything else: **this
 * reader throws**. A parser that guessed would not produce a parse error, it would
 * produce a *wrong `type` or `role`* — and a wrong role silently selects the wrong
 * professional stance for a live matter. That is the single worst failure this
 * plugin could have, so an unreadable Matter must degrade to "no Matter", which
 * the UI can show, rather than to a confident wrong answer.
 *
 * Deliberately unsupported, each throwing by name: anchors and aliases (`&`/`*`),
 * tags (`!`), multiple documents (`---`), flow collections with content
 * (`[a, b]`, `{a: b}`), tabs for indentation, and block scalars (`|`, `>`).
 *
 * @module dsh-workspace-profile/matter-yaml
 */

/** Raised when the text is outside the supported subset, or is not well formed. */
export class MatterYamlError extends Error {
  /**
   * @param {string} message - what is wrong, naming the line.
   */
  constructor(message) {
    super(message);
    this.name = 'MatterYamlError';
  }
}

/** A mapping key line: `key:` optionally followed by an inline value. */
const KEY_LINE = /^([^:#][^:]*):(?:[ \t]+(.*))?$/;

/**
 * Parse the supported subset into plain JavaScript values.
 *
 * @param {string} text - the file's UTF-8 content.
 * @returns {Record<string, unknown>} the top-level mapping.
 * @throws {MatterYamlError} on anything outside the subset.
 */
export function parseMatterYaml(text) {
  const lines = [];
  const raw = String(text).split(/\r?\n/);
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index];
    if (line.includes('\t')) {
      throw new MatterYamlError(`line ${index + 1}: tab used for indentation`);
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '---' || trimmed === '...') {
      throw new MatterYamlError(`line ${index + 1}: multiple documents are not supported`);
    }
    const indent = line.length - line.trimStart().length;
    lines.push({ indent, text: trimmed, number: index + 1 });
  }
  if (lines.length === 0) throw new MatterYamlError('the file is empty');

  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next !== lines.length) {
    throw new MatterYamlError(`line ${lines[next].number}: unexpected content`);
  }
  if (!isMapping(value)) throw new MatterYamlError('the top level must be a mapping');
  return value;
}

/**
 * Parse one block — a mapping or a sequence — at a given indent.
 *
 * @param {Array<{indent: number, text: string, number: number}>} lines - the significant lines.
 * @param {number} start - index of the block's first line.
 * @param {number} indent - the block's indentation.
 * @returns {[unknown, number]} the value and the index after the block.
 */
function parseBlock(lines, start, indent) {
  if (lines[start].text.startsWith('- ') || lines[start].text === '-') {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

/**
 * Parse a block mapping.
 *
 * @param {Array<{indent: number, text: string, number: number}>} lines - the significant lines.
 * @param {number} start - index of the first key line.
 * @param {number} indent - the mapping's indentation.
 * @returns {[Record<string, unknown>, number]} the mapping and the index after it.
 */
function parseMapping(lines, start, indent) {
  /** @type {Record<string, unknown>} */
  const result = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new MatterYamlError(`line ${line.number}: unexpected indentation`);
    }
    if (line.text.startsWith('- ')) break;

    const match = KEY_LINE.exec(line.text);
    if (match === null) {
      throw new MatterYamlError(`line ${line.number}: not a \`key: value\` mapping entry`);
    }
    const key = String(match[1]).trim();
    if (Object.hasOwn(result, key)) {
      throw new MatterYamlError(`line ${line.number}: duplicate key ${JSON.stringify(key)}`);
    }
    const inline = match[2];

    if (inline !== undefined && inline !== '') {
      result[key] = parseScalar(inline, line.number);
      index += 1;
      continue;
    }

    // No inline value: the value is a nested block. CaseBench's writer emits a
    // block sequence at the *same* indent as its key, so a `- ` line here — not
    // only a deeper one — belongs to this key.
    const next = lines[index + 1];
    if (next === undefined || next.indent < indent) {
      result[key] = null;
      index += 1;
      continue;
    }
    if (next.indent === indent && !next.text.startsWith('- ')) {
      result[key] = null;
      index += 1;
      continue;
    }
    const [value, after] = parseBlock(lines, index + 1, next.indent);
    result[key] = value;
    index = after;
  }
  return [result, index];
}

/**
 * Parse a block sequence.
 *
 * @param {Array<{indent: number, text: string, number: number}>} lines - the significant lines.
 * @param {number} start - index of the first `- ` line.
 * @param {number} indent - the sequence's indentation.
 * @returns {[unknown[], number]} the sequence and the index after it.
 */
function parseSequence(lines, start, indent) {
  /** @type {unknown[]} */
  const result = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent !== indent || !line.text.startsWith('-')) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      const next = lines[index + 1];
      if (next === undefined || next.indent <= indent) {
        result.push(null);
        index += 1;
        continue;
      }
      const [value, after] = parseBlock(lines, index + 1, next.indent);
      result.push(value);
      index = after;
      continue;
    }
    if (KEY_LINE.test(rest)) {
      // An inline mapping entry inside a sequence item, e.g. `- key: value`.
      // CaseBench does not emit this; refuse rather than half-support it.
      throw new MatterYamlError(`line ${line.number}: mappings inside sequences are not supported`);
    }
    result.push(parseScalar(rest, line.number));
    index += 1;
  }
  return [result, index];
}

/**
 * Parse a single scalar.
 *
 * @param {string} text - the scalar's source text, already trimmed.
 * @param {number} lineNumber - for error messages.
 * @returns {unknown} the value.
 */
function parseScalar(text, lineNumber) {
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text === 'null' || text === '~' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  if (text.startsWith("'")) return parseSingleQuoted(text, lineNumber);
  if (text.startsWith('"')) return parseDoubleQuoted(text, lineNumber);

  const first = text[0];
  if (first === '&' || first === '*') {
    throw new MatterYamlError(`line ${lineNumber}: anchors and aliases are not supported`);
  }
  if (first === '!') {
    throw new MatterYamlError(`line ${lineNumber}: tags are not supported`);
  }
  if (first === '|' || first === '>') {
    throw new MatterYamlError(`line ${lineNumber}: block scalars are not supported`);
  }
  if (first === '[' || first === '{') {
    throw new MatterYamlError(
      `line ${lineNumber}: flow collections with content are not supported`,
    );
  }
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  // A plain scalar. `#` cannot start a comment mid-scalar per YAML only when
  // preceded by whitespace; CaseBench quotes anything that could be ambiguous,
  // so a bare `#` here means hand-edited content this reader will not guess at.
  if (/(^|\s)#/.test(text)) {
    throw new MatterYamlError(`line ${lineNumber}: inline comments are not supported`);
  }
  return text;
}

/**
 * Parse a single-quoted scalar, in which `''` is a literal quote.
 *
 * @param {string} text - the scalar including its quotes.
 * @param {number} lineNumber - for error messages.
 * @returns {string} the value.
 */
function parseSingleQuoted(text, lineNumber) {
  if (!text.endsWith("'") || text.length < 2) {
    throw new MatterYamlError(`line ${lineNumber}: unterminated single-quoted scalar`);
  }
  return text.slice(1, -1).replaceAll("''", "'");
}

/**
 * Parse a double-quoted scalar, with the escape sequences a writer emits.
 *
 * @param {string} text - the scalar including its quotes.
 * @param {number} lineNumber - for error messages.
 * @returns {string} the value.
 */
function parseDoubleQuoted(text, lineNumber) {
  if (!text.endsWith('"') || text.length < 2) {
    throw new MatterYamlError(`line ${lineNumber}: unterminated double-quoted scalar`);
  }
  const body = text.slice(1, -1);
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[index + 1];
    index += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === '"') out += '"';
    else if (next === '\\') out += '\\';
    else throw new MatterYamlError(`line ${lineNumber}: unsupported escape \\${String(next)}`);
  }
  return out;
}

/**
 * Whether a parsed value is a mapping.
 *
 * @param {unknown} value - the value to test.
 * @returns {boolean} whether it is a non-null, non-array object.
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

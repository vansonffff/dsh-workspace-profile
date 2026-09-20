/**
 * Validate a `matter.yaml` against the CaseBench Contract version this plugin
 * consumes, and check it against the case state that carries the same identity.
 *
 * ## Why a consumer validates at all
 *
 * CaseBench owns the Contract and enforces it on write. This plugin reads files it
 * did not write, from directories a person can edit, so "CaseBench would have
 * refused to produce this" is not the same as "this is valid". Without a check
 * here, a hand-edited file passes the YAML reader — which is strict about
 * *syntax* — and then flows into the mapping, where `type: nonsense` quietly
 * becomes the `general` Profile. The page would report a confident, ordinary
 * answer about a broken Matter, which is precisely the failure this package's
 * reader exists to prevent. Strict syntax is not strict semantics.
 *
 * ## The version is pinned on purpose
 *
 * The vocabulary below is CaseBench **3.2.8**'s, transcribed rather than derived:
 * this plugin consumes a frozen upstream, and a table that silently followed the
 * upstream would not be pinning anything. When CaseBench moves, this file is the
 * one place that has to be revisited, and `docs/COMPATIBILITY.md` says so.
 *
 * The two escape hatches are not a domain:
 *
 * - `role: unknown` / `role: other` mean "no stance", and every type allows them.
 * - `type: other` / `type: unclassified` mean "the domain is not known", and then
 *   no *specific* role is meaningful beside them.
 *
 * @module dsh-workspace-profile/matter-contract
 */

/** The Matter Contract version this plugin knows how to consume. */
export const CASEBENCH_SCHEMA_VERSION = 1;

/** Case State version that carries the matching `matter_id`. */
export const CASEBENCH_STATE_SCHEMA_VERSION = 4;

/** `matter.type`, as CaseBench 3.2.8 freezes it. */
export const CASEBENCH_TYPES = Object.freeze([
  'litigation',
  'bankruptcy',
  'non-litigation',
  'other',
  'unclassified',
]);

/** Role values meaning "no stance", allowed beside every type. */
export const NO_STANCE_ROLES = Object.freeze(['unknown', 'other']);

/**
 * `engagement.role`, per type, as CaseBench 3.2.8 freezes it.
 *
 * A type with an empty list offers only the escape hatches — that is the Contract,
 * not an omission here.
 */
export const CASEBENCH_ROLES = Object.freeze({
  litigation: Object.freeze([
    'plaintiff',
    'defendant',
    'third-party',
    'appellant',
    'respondent',
    'applicant',
    'respondent-to-application',
  ]),
  bankruptcy: Object.freeze([
    'administrator',
    'debtor',
    'creditor',
    'investor',
    'restructuring-advisor',
  ]),
  'non-litigation': Object.freeze([
    'debtor',
    'creditor',
    'investor',
    'restructuring-advisor',
  ]),
  other: Object.freeze([]),
  unclassified: Object.freeze([]),
});

/** A canonical UUID in its lowercase, hyphenated form. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a value is a non-null, non-array object.
 *
 * @param {unknown} value - the value to test.
 * @returns {boolean} whether it is a mapping.
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed `matter.yaml` against the CaseBench Contract.
 *
 * Returns every problem rather than the first, because a reader looking at a
 * rejected Matter wants the whole list, not a second round trip per mistake.
 *
 * @param {unknown} document - the parsed document.
 * @returns {string[]} the problems; empty means valid.
 */
export function validateMatterDocument(document) {
  /** @type {string[]} */
  const problems = [];

  if (!isMapping(document)) return ['matter.yaml 的顶层必须是映射'];

  if (document.schema_version !== CASEBENCH_SCHEMA_VERSION) {
    problems.push(
      `schema_version 必须是 ${CASEBENCH_SCHEMA_VERSION}，实为 ${JSON.stringify(document.schema_version)}`,
    );
  }

  const matter = document.matter;
  if (!isMapping(matter)) {
    problems.push('缺少 matter 映射');
    return problems;
  }

  if (typeof matter.id !== 'string' || !UUID.test(matter.id)) {
    problems.push(`matter.id 必须是规范 UUID，实为 ${JSON.stringify(matter.id)}`);
  }
  if (typeof matter.name !== 'string' || matter.name.trim() === '') {
    problems.push('matter.name 必须是非空字符串');
  }

  const type = matter.type;
  if (typeof type !== 'string' || !CASEBENCH_TYPES.includes(type)) {
    problems.push(`matter.type 必须是 ${CASEBENCH_TYPES.join(' / ')} 之一，实为 ${JSON.stringify(type)}`);
    // The role can only be judged against a type we understood.
    return problems;
  }

  const engagement = document.engagement;
  const role = isMapping(engagement) ? engagement.role : undefined;
  if (typeof role !== 'string' || role === '') {
    problems.push('engagement.role 必须是非空字符串');
    return problems;
  }
  const allowed = [...CASEBENCH_ROLES[type], ...NO_STANCE_ROLES];
  if (!allowed.includes(role)) {
    problems.push(
      `engagement.role ${JSON.stringify(role)} 不是 type=${type} 的合法角色；允许：${allowed.join('、')}`,
    );
  }
  return problems;
}

/**
 * Check the case state carries the same identity as the Matter Contract.
 *
 * `matter.yaml` alone is not the identity: CaseBench treats the pair as the
 * contract, and hard-stops when the two disagree. A consumer that skipped this
 * could tell a child "you are working on Matter AAA" while the case state says
 * BBB — a false statement about a live matter, made confidently.
 *
 * @param {object} input - the inputs.
 * @param {unknown} input.state - the parsed `_case_state.json`, or `undefined` when absent.
 * @param {string} input.matterId - `matter.id` from the contract.
 * @returns {string[]} the problems; empty means the pair agrees.
 */
export function validateMatterState({ state, matterId }) {
  if (state === undefined || state === null) {
    return ['缺少 _case_state.json：Matter 必须同时具备 matter.yaml 与案件状态'];
  }
  if (!isMapping(state)) return ['_case_state.json 的顶层必须是映射'];

  /** @type {string[]} */
  const problems = [];
  if (state.schema_version !== CASEBENCH_STATE_SCHEMA_VERSION) {
    problems.push(
      `_case_state.json 的 schema_version 必须是 ${CASEBENCH_STATE_SCHEMA_VERSION}，实为 ${JSON.stringify(state.schema_version)}`,
    );
  }
  if (state.matter_id !== matterId) {
    problems.push(
      `身份不一致：matter.yaml 的 matter.id=${JSON.stringify(matterId)}，而 _case_state.json 的 matter_id=${JSON.stringify(state.matter_id)}`,
    );
  }
  return problems;
}

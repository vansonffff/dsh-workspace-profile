/**
 * Compare a CaseBench Matter against a Workspace's configuration.
 *
 * ## The mapping, and why it is an explicit table
 *
 * A Matter carries `matter.type` and `engagement.role`; a Workspace carries a
 * Profile and a Perspective. The two vocabularies were specified separately —
 * CaseBench froze `litigation`/`bankruptcy`/`non-litigation` with their own role
 * tokens, this plugin froze `general`/`litigation`/`bankruptcy` with its own
 * Perspective ids — so the correspondence is asserted here, in one place, rather
 * than assumed from matching names.
 *
 * For `litigation` and `bankruptcy` the tokens happen to coincide, which is a
 * coincidence worth *recording* rather than relying on: the tables below state it
 * so a future rename on either side shows up as a changed table, not as a silent
 * mismatch at runtime.
 *
 * Non-litigation is where the two genuinely diverge, and deliberately: CaseBench's
 * role is `debtor`, this plugin's Perspective is `debtor-oc`, because "the debtor"
 * inside a proceeding and "the debtor" outside one are different jobs and the
 * Perspective id is what a person types.
 *
 * ## `unknown` and `other` are not a domain
 *
 * `role: unknown` / `role: other` mean "no stance" — they map to `none`, which is
 * every Profile's first Perspective. They do **not** push the Workspace to
 * `general`: a bankruptcy matter whose stance is not yet known is still a
 * bankruptcy workspace.
 *
 * `type: other` / `type: unclassified` are the opposite case — the *domain* is
 * unknown — so those map to the `general` Profile, which offers no stance at all.
 *
 * @module dsh-workspace-profile/matter-match
 */

import { perspectivesFor, validateProfilePerspective } from './policy.js';
import { NO_STANCE_ROLES } from './matter-contract.js';

/**
 * CaseBench `matter.type` → this plugin's Profile id.
 *
 * A type absent from this table is a domain this plugin has no Profile for; the
 * caller falls back to `general`, which claims nothing.
 */
export const TYPE_TO_PROFILE = Object.freeze({
  litigation: 'litigation',
  bankruptcy: 'bankruptcy',
  'non-litigation': 'non-litigation',
});

/** The Profile used when the Matter's domain is unknown. */
export const FALLBACK_PROFILE = 'general';

/**
 * CaseBench `engagement.role` → this plugin's Perspective id, per type.
 *
 * A type absent from this table maps by identity: the two vocabularies use the
 * same tokens, and that is asserted rather than relied upon.
 */
export const ROLE_TO_PERSPECTIVE = Object.freeze({
  // Litigation and Bankruptcy happen to use the same tokens on both sides. That is
  // *recorded here* rather than assumed: with these two rows absent, the fallback
  // below would treat "no table" as "same name", and a rename on either side would
  // drift silently instead of turning a test red.
  litigation: Object.freeze({
    plaintiff: 'plaintiff',
    defendant: 'defendant',
    'third-party': 'third-party',
    appellant: 'appellant',
    respondent: 'respondent',
    applicant: 'applicant',
    'respondent-to-application': 'respondent-to-application',
  }),
  bankruptcy: Object.freeze({
    administrator: 'administrator',
    debtor: 'debtor',
    creditor: 'creditor',
    investor: 'investor',
    'restructuring-advisor': 'restructuring-advisor',
  }),
  // The one place the two vocabularies genuinely diverge. A `debtor` inside a
  // proceeding and a `debtor` outside one are different jobs, and the Perspective
  // id is what a person types at `/perspective`, so it is abbreviated while the
  // label spells the meaning out.
  'non-litigation': Object.freeze({
    debtor: 'debtor-oc',
    creditor: 'creditor-oc',
    investor: 'investor-oc',
    'restructuring-advisor': 'advisor-oc',
  }),
  // No rows: these types offer only "no stance", so a specific role beside them is
  // an impossible pair rather than an unmapped one.
  other: Object.freeze({}),
  unclassified: Object.freeze({}),
});

/**
 * Role values that mean "no stance".
 *
 * Re-exported from the Contract module rather than restated: the mapping and the
 * validator must agree about what "no stance" is, or a role could be valid to read
 * and impossible to map.
 */
export { NO_STANCE_ROLES } from './matter-contract.js';

/** The Perspective id meaning "no stance". */
export const NO_PERSPECTIVE = 'none';

/**
 * The Profile a Matter's type implies.
 *
 * @param {unknown} type - `matter.type`.
 * @returns {string} a Profile id; `general` when the type names no known domain.
 */
export function profileForMatterType(type) {
  const key = typeof type === 'string' ? type : '';
  return TYPE_TO_PROFILE[key] ?? FALLBACK_PROFILE;
}

/**
 * The Perspective a Matter's type and role imply.
 *
 * Returns `null` — not an id — when the pair yields a Perspective its own Profile
 * does not offer, which happens when a Matter carries a combination CaseBench
 * would have refused (a hand-edited file). Returning the id anyway would let a
 * careless caller store a stance from another domain; `null` forces the caller to
 * decide, and `matchMatter` reports it.
 *
 * @param {object} input - the inputs.
 * @param {unknown} input.type - `matter.type`.
 * @param {unknown} input.role - `engagement.role`.
 * @returns {string|null} a Perspective id, `none`, or `null` for an impossible pair.
 */
export function perspectiveForMatter({ type, role }) {
  const roleKey = typeof role === 'string' ? role : '';
  if (roleKey === '' || NO_STANCE_ROLES.includes(roleKey)) return NO_PERSPECTIVE;
  const typeKey = typeof type === 'string' ? type : '';
  const table = ROLE_TO_PERSPECTIVE[typeKey];
  // Every type has a row. A type without one is a type this plugin does not know,
  // and guessing "the tokens probably match" is the drift the table exists to
  // prevent — so it maps to nothing rather than to itself.
  if (table === undefined) return null;
  const candidate = table[roleKey];
  // A domain that does not list this role has no such position — that is an
  // impossible pair, not "no stance". The two must stay distinguishable: `none`
  // means the user has not chosen, `null` means the data is wrong.
  if (candidate === undefined) return null;
  const profile = profileForMatterType(typeKey);
  return perspectivesFor(profile).includes(candidate) ? candidate : null;
}

/**
 * Compare a resolved Matter against a Workspace policy.
 *
 * The verdicts are deliberately three, not two, because "the Workspace does not
 * agree with the Matter" and "this session deliberately chose otherwise" are
 * different facts and only one of them is a problem:
 *
 * - `match` — the Workspace's own configuration is what the Matter implies;
 * - `mismatch` — it is not, and nothing says the user chose that;
 * - `override` — a session override is in force. Reported even when it agrees,
 *   because the point of an override is that the session knows something the
 *   Workspace does not.
 *
 * This function never writes. Applying a recommendation is the user's action.
 *
 * @param {object} input - the inputs.
 * @param {{facts: object|null, problem: string|null}} input.matter - from the resolver.
 * @param {{profile: string, defaultPerspective: string}} input.policy - the Workspace policy.
 * @param {string|undefined} [input.sessionOverride] - this session's `/perspective`, if any.
 * @returns {object} the comparison, as plain JSON.
 */
export function matchMatter({ matter, policy, sessionOverride }) {
  const facts = matter?.facts ?? null;
  /** @type {string[]} */
  const problems = [];
  if (matter?.problem) problems.push(matter.problem);

  if (facts === null) {
    return {
      matter: null,
      profile: { expected: null, actual: policy.profile, verdict: 'unknown' },
      perspective: {
        expected: null,
        workspaceDefault: policy.defaultPerspective,
        sessionOverride: sessionOverride ?? null,
        effective: sessionOverride ?? policy.defaultPerspective,
        verdict: 'unknown',
      },
      problems,
    };
  }

  const expectedProfile = profileForMatterType(facts.type);
  const mapped = perspectiveForMatter(facts);
  // A Matter whose own pair does not validate is reported, not translated: this
  // plugin will not invent a stance the Matter's domain does not offer. CaseBench
  // enforces the same pairing, so reaching here means a hand-edited file.
  const invalid = mapped === null
    ? `unknown Perspective for the ${expectedProfile} Profile (type=${facts.type}, role=${facts.role})`
    : validateProfilePerspective(expectedProfile, mapped);
  const expectedPerspective = mapped ?? NO_PERSPECTIVE;
  if (invalid !== null) problems.push(`Matter 的 type/role 组合无法映射：${invalid}`);

  const effective = sessionOverride ?? policy.defaultPerspective;
  const profileVerdict = expectedProfile === policy.profile ? 'match' : 'mismatch';

  let perspectiveVerdict;
  if (invalid !== null) perspectiveVerdict = 'unknown';
  else if (sessionOverride !== undefined && sessionOverride !== null) perspectiveVerdict = 'override';
  else perspectiveVerdict = expectedPerspective === policy.defaultPerspective ? 'match' : 'mismatch';

  return {
    matter: facts,
    profile: { expected: expectedProfile, actual: policy.profile, verdict: profileVerdict },
    perspective: {
      expected: expectedPerspective,
      workspaceDefault: policy.defaultPerspective,
      sessionOverride: sessionOverride ?? null,
      effective,
      verdict: perspectiveVerdict,
      // Whether an override happens to agree. An override that agrees is still an
      // override; the UI should be able to say so without calling it a match.
      effectiveAgrees: invalid === null && effective === expectedPerspective,
    },
    problems,
  };
}

/**
 * Whether a Profile offers a Perspective, for callers that need the check without
 * the comparison.
 *
 * @param {string} profile - the Profile id.
 * @param {string} perspective - the Perspective id.
 * @returns {boolean} whether the pair is valid.
 */
export function isOffered(profile, perspective) {
  return perspectivesFor(profile).includes(perspective);
}

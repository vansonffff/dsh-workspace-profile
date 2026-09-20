/**
 * The Workspace Composition data model, as pure functions.
 *
 * Everything here is a value in, a value out: no Cordis context, no I/O, no
 * clock read unless one is passed. That is deliberate — the model is the part
 * of this plugin whose bugs are silent (a policy that resolves to the wrong
 * Profile still renders, it just injects the wrong domain rules), so it is the
 * part that must be testable without booting a harness.
 *
 * The stored document is one settings section, keyed by official `WorkspaceId`:
 *
 * ```
 * { schemaVersion: 1, initializedAt, workspaces: { [workspaceId]: WorkspacePolicyV1 } }
 * ```
 *
 * The Workspace *title* and *path* are never persisted. Titles are renameable
 * and paths are canonicalized by `fs.realpath`, so neither is a stable primary
 * key; the id is a generated uuid and is the only durable address.
 *
 * @module dsh-workspace-profile/policy
 */

import { InvalidSubagentError, UnsupportedSchemaVersionError } from './errors.js';

/** The schema version this build reads and writes. */
export const SCHEMA_VERSION = 1;

/** The settings namespace. Must match `/^[a-z][a-z0-9-]*$/` or `register` throws. */
export const SETTINGS_NS = 'workspace-profile';

/** Profile ids, in the order the Settings page offers them. */
export const PROFILE_IDS = Object.freeze(['general', 'litigation', 'bankruptcy', 'non-litigation']);

/** Human-facing Profile labels (zh-CN primary, matching the product's locale). */
export const PROFILE_LABELS = Object.freeze({
  general: '通用 (General)',
  litigation: '诉讼 (Litigation)',
  bankruptcy: '破产重整 (Bankruptcy)',
  'non-litigation': '非诉 (Non-litigation)',
});

/**
 * The Perspective vocabulary, per Profile.
 *
 * A Perspective is "the position this work is done from", which only means
 * something inside a domain that has positions. The vocabulary therefore lives
 * on the Profile, not on the plugin: Bankruptcy has insolvency roles, Litigation
 * has litigation roles, and General deliberately has none.
 *
 * `none` is always first and always legal — "no stance" is a real answer, and it
 * is the only honest one until the user picks something.
 *
 * A Profile with no vocabulary beyond `none` is still a valid Profile; it simply
 * offers no stance to choose. That is a *vocabulary* fact, not a special case in
 * the validation path, which is why {@link profileSupportsPerspectives} is
 * derived from this table rather than hard-coded to a Profile id.
 */
export const PERSPECTIVES_BY_PROFILE = Object.freeze({
  general: Object.freeze(['none']),
  litigation: Object.freeze([
    'none',
    'plaintiff',
    'defendant',
    'third-party',
    'appellant',
    'respondent',
    'applicant',
    'respondent-to-application',
  ]),
  bankruptcy: Object.freeze([
    'none',
    'administrator',
    'debtor',
    'investor',
    'creditor',
    'restructuring-advisor',
  ]),
  // Non-litigation. The ids are deliberately distinct from Bankruptcy's: a
  // `debtor` inside a proceeding and a `debtor` outside one are different jobs,
  // and this table's own rule is that an id means the same thing wherever it
  // appears. Sharing them would also let a matter that moves from out-of-court
  // into a proceeding keep its stored stance and silently swap the injected
  // text; the transition should force a new choice, not hide itself.
  //
  // `-oc` is short for "out of court": the id is what gets typed at
  // `/perspective`, so it is abbreviated, while the label below spells the
  // meaning out. `/perspective` with no argument lists every id with its label,
  // which is the discoverable form of this abbreviation.
  'non-litigation': Object.freeze([
    'none',
    'debtor-oc',
    'creditor-oc',
    'investor-oc',
    'advisor-oc',
  ]),
});

/**
 * Human-facing Perspective labels, keyed by Perspective id.
 *
 * Keyed by id rather than by `profile → id` because the id *is* the identity:
 * `creditor` means the same thing wherever it appears, and the Settings page,
 * the `/perspective` command and the prompt composer all have an id in hand and
 * need its label. Ids are globally unique across Profiles, which
 * `test/policy.test.js` asserts — a collision would silently relabel a stance.
 */
export const PERSPECTIVE_LABELS = Object.freeze({
  none: '不设定 (None)',
  // Litigation
  plaintiff: '原告代理人 (Plaintiff)',
  defendant: '被告代理人 (Defendant)',
  'third-party': '第三人 (Third party)',
  appellant: '上诉人 (Appellant)',
  respondent: '被上诉人 (Respondent)',
  applicant: '再审申请人 (Applicant for retrial)',
  'respondent-to-application': '再审被申请人 (Respondent to retrial application)',
  // Bankruptcy
  administrator: '管理人 (Administrator)',
  debtor: '债务人 (Debtor)',
  investor: '投资人 (Investor)',
  creditor: '债权人 (Creditor)',
  'restructuring-advisor': '重整顾问 (Restructuring advisor)',
  // Non-litigation
  'debtor-oc': '债务人 · 庭外重组 (Debtor, out of court)',
  'creditor-oc': '债权人 · 庭外重组 (Creditor, out of court)',
  'investor-oc': '投资方 · 并购 / 尽调 / 投资 (Investor, out of court)',
  'advisor-oc': '顾问 · 非诉 (Advisor, out of court)',
});

/** Onboarding lifecycle states. v0.1 recognises `skipped` but never produces it. */
export const ONBOARDING_STATUSES = Object.freeze(['unconfigured', 'configured', 'skipped']);

/**
 * Per-Skill override states.
 *
 * `recommended` is a *hint*, not a gate: a recommended Skill is fully usable,
 * model-invocable and user-invocable exactly as an enabled one is. It differs
 * only in that the Workspace's Profile section names it as a method to reach for
 * first, and the Settings row is badged. Modelling "recommended" as a third state
 * rather than as a separate list keeps one source of truth per Skill: two
 * independent fields could disagree, and a Skill that is both recommended and
 * disabled would have no defined answer.
 */
export const SKILL_STATES = Object.freeze(['recommended', 'enabled', 'disabled']);

/**
 * Profile → recommended Skill names.
 *
 * A *recommendation*, never an installation. Nothing here can create a Skill:
 * a name that resolves to no Skill in the live catalog renders as "not
 * installed" in Settings, and is never written as enabled. That rule is the
 * whole reason this table is data rather than an installer.
 */
export const PROFILE_RECOMMENDED_SKILLS = Object.freeze({
  general: Object.freeze([]),
  litigation: Object.freeze([
    'legal-case-bench',
    'prc-legal-research-case-search',
    'prc-legal-research-law-search',
  ]),
  bankruptcy: Object.freeze([
    'legal-case-bench',
    'prc-legal-research-case-search',
    'prc-legal-research-law-search',
    'prc-legal-research-company-search',
  ]),
  'non-litigation': Object.freeze([
    'legal-case-bench',
    'prc-legal-research-law-search',
    'prc-legal-research-company-search',
    'prc-legal-research-case-search',
  ]),
});

/**
 * The `key` grammar: lowercase letters, digits and hyphens, always starting
 * with a letter or digit.
 *
 * A key is addressed in three places that do not share a validator — a model
 * tool argument, a slash-command argument, and a JSON object key in the settings
 * document — so the grammar is asserted once here and reused.
 */
export const SUBAGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Whether a string is a usable Subagent key.
 *
 * @param {unknown} key - candidate.
 * @returns {boolean} whether it matches {@link SUBAGENT_KEY_PATTERN}.
 */
export function isValidSubagentKey(key) {
  return typeof key === 'string' && SUBAGENT_KEY_PATTERN.test(key);
}

/**
 * Derive a default key for a newly created Subagent.
 *
 * Chinese names cannot be transliterated deterministically and a wrong guess is
 * worse than an opaque one, so the default is derived from the id's short form
 * and the user is expected to replace it before saving. The result is always
 * grammar-valid.
 *
 * @param {string} id - the new definition's uuid.
 * @returns {string} a key like `agent-3f9a2c1b`.
 */
export function defaultKeyFor(id) {
  const short = String(id).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || 'new';
  return `agent-${short}`;
}

/**
 * A fresh, unconfigured Workspace policy.
 *
 * `unconfigured` here means "the user has not decided", which is distinct from
 * "the user decided to use General". Only the former is shown as 未配置 in
 * Settings; both resolve to General at runtime (see {@link resolveWorkspacePolicy}).
 *
 * @param {string} now - ISO-8601 instant to stamp.
 * @returns {any} a complete `WorkspacePolicyV1`.
 */
export function defaultWorkspacePolicy(now) {
  return {
    onboardingStatus: 'unconfigured',
    profile: 'general',
    defaultPerspective: 'none',
    skillOverrides: {},
    subagents: {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A fresh root document.
 *
 * @param {string} now - ISO-8601 instant to stamp as `initializedAt`.
 * @returns {any} a `WorkspaceCompositionDocumentV1` with no Workspaces.
 */
export function emptyDocument(now) {
  return { schemaVersion: SCHEMA_VERSION, initializedAt: now, workspaces: {} };
}

/**
 * The Perspectives a Profile offers.
 *
 * @param {string} profile - a Profile id.
 * @returns {readonly string[]} the selectable Perspective ids; `['none']` for an
 *   unknown Profile, because an unrecognised Profile must never be a way to
 *   obtain a stance.
 */
export function perspectivesFor(profile) {
  return PERSPECTIVES_BY_PROFILE[profile] ?? Object.freeze(['none']);
}

/**
 * Whether a Profile offers any Perspective beyond `none`.
 *
 * Derived from the vocabulary rather than naming a Profile: adding a Profile's
 * Perspectives must not require remembering to update a second place.
 *
 * @param {string} profile - a Profile id.
 * @returns {boolean} whether Perspectives apply.
 */
export function profileSupportsPerspectives(profile) {
  return perspectivesFor(profile).length > 1;
}

/**
 * The Perspective actually in force, from the two places one can come from.
 *
 * A session's `/perspective` override and the Workspace's default are the same
 * question asked twice, and **every consumer must answer it the same way** — the
 * parent's prompt section and a dispatched child's assignment are the same
 * professional stance, and a child that silently worked from the Workspace default
 * while its parent worked from an override would be reasoning from a different
 * position than the one it was asked to take.
 *
 * The rules, in one place:
 *
 * - an override counts only where it is **legal for the current Profile**. An
 *   override is keyed by session and deliberately outlives a Workspace
 *   reconfiguration, so a Workspace that moved from Bankruptcy to Litigation can
 *   still hold one naming `administrator`; it is dropped, never translated.
 * - `none` is a legal override and means "this session uses no stance". It is not
 *   the same as an absent override, which falls back to the Workspace.
 * - the fallback is the Workspace default when that is itself legal, and `none`
 *   otherwise.
 *
 * @param {object} input - the inputs.
 * @param {string} input.profile - the Profile id.
 * @param {string|undefined} input.defaultPerspective - the Workspace's own answer.
 * @param {string|undefined|null} input.sessionOverride - the session's answer, if any.
 * @returns {{ perspective: string, overridden: boolean, ignoredOverride: boolean }}
 *   the effective id, whether it came from the session, and whether a session
 *   answer was present but unusable here.
 */
export function resolveEffectivePerspective({ profile, defaultPerspective, sessionOverride }) {
  const vocabulary = perspectivesFor(profile);
  const isLegal = (id) => typeof id === 'string' && id !== '' && vocabulary.includes(id);

  if (isLegal(sessionOverride)) {
    return { perspective: sessionOverride, overridden: true, ignoredOverride: false };
  }
  return {
    perspective: isLegal(defaultPerspective) ? defaultPerspective : 'none',
    overridden: false,
    ignoredOverride: sessionOverride !== undefined && sessionOverride !== null && sessionOverride !== '',
  };
}

/**
 * The human-facing label for a Perspective, or `''` for "no stance".
 *
 * Empty rather than "不设定" because callers use the empty string to mean "state
 * nothing about the stance", which is different from stating that there is none.
 *
 * @param {string|undefined|null} perspective - the Perspective id.
 * @returns {string} its label, or `''`.
 */
export function perspectiveLabelOf(perspective) {
  if (typeof perspective !== 'string' || perspective === '' || perspective === 'none') return '';
  return PERSPECTIVE_LABELS[perspective] ?? perspective;
}

/**
 * Validate a Profile/Perspective pair against the business rules.
 *
 * The pair is checked as a pair, not as two independent fields: a Perspective
 * that is real but belongs to another domain is refused. Offering a Bankruptcy
 * stance under the Litigation Profile would be a category error the model would
 * then act on, so the combination is refused at write time and re-checked at
 * resolve time.
 *
 * @param {unknown} profile - candidate Profile id.
 * @param {unknown} perspective - candidate Perspective id.
 * @returns {string|null} an explanation when invalid, `null` when acceptable.
 */
export function validateProfilePerspective(profile, perspective) {
  if (!PROFILE_IDS.includes(/** @type {string} */ (profile))) {
    return `unknown Profile "${String(profile)}"; expected one of ${PROFILE_IDS.join(', ')}`;
  }
  const vocabulary = perspectivesFor(/** @type {string} */ (profile));
  if (!vocabulary.includes(/** @type {string} */ (perspective))) {
    return `unknown Perspective "${String(perspective)}" for the ${String(profile)} Profile; expected one of ${vocabulary.join(', ')}`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Validation of one Subagent definition                                       */
/* -------------------------------------------------------------------------- */

/**
 * Validate a Subagent definition's field-level rules.
 *
 * `key` immutability is *not* checked here: it is a property of an edit against
 * a stored definition, not of the definition alone, so it lives in
 * {@link validateSubagentEdit}. This function answers "is this a well-formed
 * definition at all".
 *
 * @param {any} candidate - the proposed definition.
 * @returns {string[]} every problem found, empty when the definition is sound.
 */
export function validateSubagentDefinition(candidate) {
  const problems = [];
  if (candidate === null || typeof candidate !== 'object') {
    return ['a Subagent definition must be an object'];
  }
  if (typeof candidate.id !== 'string' || candidate.id === '') {
    problems.push('id is required and must be a non-empty string');
  }
  if (!isValidSubagentKey(candidate.key)) {
    problems.push(
      'key must be 1–64 characters of lowercase letters, digits and hyphens, starting with a letter or digit (for example "case-researcher")',
    );
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    problems.push('name is required and must not be blank');
  }
  if (typeof candidate.description !== 'string' || candidate.description.trim() === '') {
    problems.push(
      'description is required: it is what the model reads when choosing an agent, so "案例检索员" alone is not enough',
    );
  }
  if (typeof candidate.provider !== 'string' || candidate.provider === '') {
    problems.push('provider is required (the LLM route provider id, for example "kimi-coding")');
  }
  if (typeof candidate.model !== 'string' || candidate.model === '') {
    problems.push('model is required (the model id within that provider)');
  }
  if (candidate.reasoningEffort !== undefined && typeof candidate.reasoningEffort !== 'string') {
    problems.push('reasoningEffort, when present, must be a string');
  }
  if (candidate.instructions !== undefined && typeof candidate.instructions !== 'string') {
    problems.push('instructions, when present, must be a string');
  }
  if (typeof candidate.enabled !== 'boolean') {
    problems.push('enabled must be a boolean');
  }
  return problems;
}

/**
 * Validate an edit against the definition it replaces.
 *
 * Two rules cannot be expressed on a definition in isolation:
 *
 * - `id` is assigned by the store and never changes;
 * - `key` is addressable from a model tool argument, a slash command, and any
 *   delegation text already written into a session log, so it freezes at
 *   creation. Changing it means duplicating the definition and deleting the
 *   old one, which is a visible two-step action rather than a silent rewrite.
 *
 * @param {any} previous - the stored definition, or `undefined` for a create.
 * @param {any} next - the proposed definition.
 * @returns {string[]} every problem found, empty when the edit is allowed.
 */
export function validateSubagentEdit(previous, next) {
  const problems = validateSubagentDefinition(next);
  if (previous === undefined) return problems;
  if (previous.id !== next.id) {
    problems.push('id cannot be changed after creation');
  }
  if (previous.key !== next.key) {
    problems.push(
      `key cannot be changed after creation (it is "${previous.key}"). Duplicate this Subagent under the new key and delete the old one instead.`,
    );
  }
  return problems;
}

/**
 * Assert that a Workspace's Subagent keys are unique.
 *
 * Keys are unique *within* a Workspace and deliberately not across Workspaces:
 * two matters can each have a `case-researcher` with different routes, and
 * nothing needs to address them together.
 *
 * @param {Record<string, any>} subagents - the Workspace's definitions by id.
 * @returns {string|null} the duplicated key, or `null` when all are unique.
 */
export function findDuplicateKey(subagents) {
  const seen = new Set();
  for (const definition of Object.values(subagents ?? {})) {
    const key = definition?.key;
    if (typeof key !== 'string') continue;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Migration                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Explicit migrations, keyed by the version they read *from*.
 *
 * Each entry returns the next version's document. A version with no entry and
 * no equality to {@link SCHEMA_VERSION} is a hard stop — the plugin never
 * guesses at a document it does not understand, because the failure mode of a
 * wrong guess is injecting the wrong professional rules into a live matter.
 *
 * @type {Record<number, (doc: any) => any>}
 */
export const MIGRATIONS = Object.freeze({
  // No released version precedes 1. The map is present, and exercised by a test
  // through a synthetic entry, so the *mechanism* is proven before the first
  // real migration needs it.
});

/**
 * Fill in every field a stored policy may be missing, without changing meaning.
 *
 * Unknown fields are preserved: a document written by a newer build that still
 * shares this `schemaVersion` must not lose data because this build happened to
 * be older. `schemaVersion` is the only compatibility contract.
 *
 * @param {any} raw - a stored policy, possibly partial.
 * @param {string} now - ISO-8601 instant used for absent timestamps.
 * @returns {any} a complete `WorkspacePolicyV1`.
 */
export function normalizeWorkspacePolicy(raw, now) {
  const base = defaultWorkspacePolicy(now);
  if (raw === null || typeof raw !== 'object') return base;
  const merged = {
    ...base,
    ...raw,
    skillOverrides:
      raw.skillOverrides !== null && typeof raw.skillOverrides === 'object' ? { ...raw.skillOverrides } : {},
    subagents: raw.subagents !== null && typeof raw.subagents === 'object' ? { ...raw.subagents } : {},
  };
  // A stored pair that breaks the business rules is repaired toward safety
  // rather than trusted: an impossible combination would otherwise be injected
  // into every step of the Workspace. Repair is visible — the record keeps its
  // timestamps, so Settings can show that the value differs from what was saved.
  //
  // The Profile is repaired first, then the Perspective is re-checked against the
  // *repaired* Profile's vocabulary. Doing it in the other order would validate a
  // stance against a Profile that is about to be replaced — which is exactly how
  // a Bankruptcy Administrator could survive into a General Workspace.
  if (validateProfilePerspective(merged.profile, merged.defaultPerspective) !== null) {
    if (!PROFILE_IDS.includes(merged.profile)) merged.profile = base.profile;
    if (!perspectivesFor(merged.profile).includes(merged.defaultPerspective)) {
      merged.defaultPerspective = 'none';
    }
  }
  if (!ONBOARDING_STATUSES.includes(merged.onboardingStatus)) merged.onboardingStatus = base.onboardingStatus;
  return merged;
}

/**
 * Keep the first non-null of two version markers.
 *
 * A multi-step migration walks through several versions; the value worth
 * reporting is the one the document *started* at, so only the first assignment
 * sticks.
 *
 * @param {number} first - the value to prefer.
 * @param {number|null} current - the value already recorded.
 * @returns {number} the earlier-recorded value.
 */
function defined(first, current) {
  return current === null ? first : current;
}

/**
 * Migrate and normalize a stored document to the current schema version.
 *
 * @param {any} raw - the raw settings section, or `undefined` when absent.
 * @param {string} now - ISO-8601 instant used for absent timestamps.
 * @param {Record<number, (doc: any) => any>} [migrations] - the migration table;
 *   injectable so the runner can be exercised before the first real migration
 *   exists, rather than being taken on faith until it is needed.
 * @returns {{ document: any, migratedFrom: number|null, changed: boolean }} the
 *   normalized document, the version it was migrated from (or `null`), and
 *   whether normalization changed anything worth persisting.
 * @throws {UnsupportedSchemaVersionError} when the version is unknown.
 */
export function normalizeDocument(raw, now, migrations = MIGRATIONS) {
  if (raw === undefined || raw === null) {
    return { document: emptyDocument(now), migratedFrom: null, changed: false };
  }
  if (typeof raw !== 'object') {
    throw new UnsupportedSchemaVersionError(raw, SCHEMA_VERSION);
  }
  const original = raw;
  let working = raw;
  let migratedFrom = null;

  const declared = typeof working.schemaVersion === 'number' ? working.schemaVersion : undefined;
  if (declared !== undefined) {
    // A *declared* version that is not this one is a real migration: the
    // document says it was written to a different contract, and the result must
    // be persisted so the next boot does not repeat the work.
    let version = declared;
    while (version !== SCHEMA_VERSION) {
      const step = migrations[version];
      if (step === undefined) throw new UnsupportedSchemaVersionError(version, SCHEMA_VERSION);
      working = step(working);
      version = typeof working.schemaVersion === 'number' ? working.schemaVersion : version + 1;
      migratedFrom = defined(declared, migratedFrom);
    }
  }
  // An ABSENT version is not a migration. It means the section predates
  // versioning — most often because a user hand-wrote it — and guessing that it
  // needs rewriting would be a write nobody asked for. It is read as version 1,
  // and the first ordinary save stamps `schemaVersion` through a path op.

  // Absent timestamps fall back to the document's own `initializedAt`, never to
  // the current clock: a clock-derived fallback changes on every read, so a
  // record would appear to have been created just now, every time it was looked
  // at. An empty string is the honest answer when nothing was ever stamped.
  const fallback = typeof working.initializedAt === 'string' && working.initializedAt !== '' ? working.initializedAt : '';

  const workspaces = {};
  const rawWorkspaces = working.workspaces !== null && typeof working.workspaces === 'object' ? working.workspaces : {};
  for (const [workspaceId, policy] of Object.entries(rawWorkspaces)) {
    workspaces[workspaceId] = normalizeWorkspacePolicy(policy, fallback);
  }

  const document = {
    ...working,
    schemaVersion: SCHEMA_VERSION,
    initializedAt: typeof working.initializedAt === 'string' ? working.initializedAt : '',
    workspaces,
  };

  return {
    document,
    migratedFrom,
    // Only a real migration is worth persisting. Normalization that merely fills
    // defaults is reproduced identically on the next read, so writing it back
    // would be churn — and churn on a watched document is a needless revision
    // bump that invalidates every open Settings page.
    changed: migratedFrom !== null,
  };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the effective policy for one Workspace.
 *
 * An unconfigured Workspace still resolves — to `general + none + no overrides`
 * — because every runtime consumer needs an answer and "no answer" is not one.
 * What it does *not* do is become configured: Settings keeps showing 未配置, and
 * nothing here writes back.
 *
 * @param {any} document - a normalized document.
 * @param {string} workspaceId - the Workspace to resolve.
 * @param {string} now - ISO-8601 instant used for a synthesized policy.
 * @returns {{ policy: any, configured: boolean }} the effective policy and
 *   whether the user actually saved one.
 */
export function resolveWorkspacePolicy(document, workspaceId, now) {
  const fallback = typeof document?.initializedAt === 'string' && document.initializedAt !== '' ? document.initializedAt : now;
  const stored = document?.workspaces?.[workspaceId];
  if (stored === undefined) {
    return { policy: defaultWorkspacePolicy(fallback), configured: false };
  }
  const policy = normalizeWorkspacePolicy(stored, fallback);
  return { policy, configured: policy.onboardingStatus === 'configured' };
}

/**
 * Whether a Skill is enabled for a Workspace.
 *
 * Absence of an override means enabled: the catalog is the source of truth for
 * what exists, and this map only records deliberate departures from it.
 *
 * @param {any} policy - a resolved Workspace policy.
 * @param {string} skillName - the Skill to test.
 * @returns {boolean} whether the Skill is enabled.
 */
export function isSkillEnabled(policy, skillName) {
  return policy?.skillOverrides?.[skillName] !== 'disabled';
}

/**
 * The Skill names this Workspace disables.
 *
 * @param {any} policy - a resolved Workspace policy.
 * @returns {string[]} disabled Skill names, sorted.
 */
export function disabledSkills(policy) {
  return Object.entries(policy?.skillOverrides ?? {})
    .filter(([, state]) => state === 'disabled')
    .map(([name]) => name)
    .sort();
}

/**
 * The Skill names this Workspace recommends, and where each came from.
 *
 * Two things can recommend a Skill, and the UI has to tell them apart: the
 * **Profile**, which recommends methods for its domain and applies to every
 * Workspace using that Profile, and the **Workspace**, which recommends something
 * specific to this matter. A name recommended by both is reported once, as coming
 * from the Profile: the broader source is the one worth showing, and listing it
 * twice would make one Skill look like two entries.
 *
 * A disabled Skill is never recommended. A Skill the user turned off is not a
 * method to reach for, and naming it in the prompt would tell the model to use
 * something it cannot load — one field contradicting the other in the same breath.
 *
 * @param {any} policy - a resolved Workspace policy.
 * @returns {{ name: string, source: 'profile'|'workspace' }[]} recommendations, sorted by name.
 */
export function recommendedSkills(policy) {
  const overrides = policy?.skillOverrides ?? {};
  const fromProfile = PROFILE_RECOMMENDED_SKILLS[policy?.profile] ?? [];
  /** @type {Map<string, 'profile'|'workspace'>} */
  const byName = new Map();
  for (const name of fromProfile) {
    if (overrides[name] !== 'disabled') byName.set(name, 'profile');
  }
  for (const [name, state] of Object.entries(overrides)) {
    if (state !== 'recommended' || byName.has(name)) continue;
    byName.set(name, 'workspace');
  }
  return [...byName]
    .map(([name, source]) => ({ name, source }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The enabled Subagent definitions of a Workspace, sorted by key.
 *
 * This is the model's expert directory *and* the dispatch lookup table, from
 * one function — a disabled agent is absent from both, so it cannot be listed
 * and then called.
 *
 * @param {any} policy - a resolved Workspace policy.
 * @returns {any[]} enabled definitions, key-sorted.
 */
export function enabledSubagents(policy) {
  return Object.values(policy?.subagents ?? {})
    .filter((definition) => definition?.enabled === true)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Find a definition by key or by display name.
 *
 * Key wins when both match different definitions, because a key is the thing a
 * user can type unambiguously; a name is a convenience for "让案例检索员查…".
 * The match is exact — no fuzzy prefix — so a typo fails loudly instead of
 * silently running the wrong expert.
 *
 * @param {any} policy - a resolved Workspace policy.
 * @param {unknown} reference - the key or name to resolve.
 * @returns {any|undefined} the matching enabled definition.
 */
export function findSubagent(policy, reference) {
  if (typeof reference !== 'string') return undefined;
  const wanted = reference.trim();
  if (wanted === '') return undefined;
  const enabled = enabledSubagents(policy);
  const byKey = enabled.find((definition) => definition.key === wanted);
  if (byKey !== undefined) return byKey;
  return enabled.find((definition) => definition.name === wanted);
}

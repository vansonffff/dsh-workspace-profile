/**
 * Codecs for the two Remote faces.
 *
 * The Host face gets real zod schemas, because the Gateway parses every parameter
 * and every result through them and zod is already present on the Host. The
 * client face gets passthrough codecs: inlining zod into a hand-written browser
 * bundle would need a bundler this profile does not have, and no safety is lost —
 * the Host is the side that validates.
 *
 * @module dsh-workspace-profile/remote/schemas
 */

/**
 * A Host-side schema for one wire value.
 *
 * `record` rather than `any` for the free-form case: a caller that sends a string
 * or an array where an argument object belongs is a bug worth rejecting at the
 * wire, and a record still accepts every shape the service understands. The
 * *interior* is validated by the service, which produces far better messages than
 * a schema rejection would ("key must be lowercase letters, digits and hyphens"
 * rather than "invalid string").
 *
 * @param {any} z - the zod module.
 * @param {string} [kind] - the value kind.
 * @returns {any} a zod schema.
 */
export function hostSchema(z, kind = 'freeObject') {
  switch (kind) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    default:
      return z.record(z.string(), z.unknown());
  }
}

/**
 * A browser-side codec: satisfies the Gateway's `mode: 'strict'` contract
 * without importing zod.
 *
 * @returns {{ mode: string, parse: (value: unknown) => unknown }} the codec body.
 */
export function passthroughSchema() {
  return { mode: 'strict', parse: (value) => value };
}

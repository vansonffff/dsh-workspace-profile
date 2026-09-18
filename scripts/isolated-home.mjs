/**
 * Make "an isolated probe home" true rather than aspirational.
 *
 * ## The failure this exists to prevent
 *
 * Every probe here takes `--home` and hands it to `loadProfile`, which is only
 * *part* of how the harness finds its state. Rows that persist anything resolve
 * their root through `dshHomePath()`, which reads the `DSH_HOME` environment
 * variable and otherwise falls back to the real `~/.dsh` — it never consults the
 * `--home` argument. So a probe that passes `--home /tmp/throwaway` while leaving
 * `DSH_HOME` unset boots a throwaway *profile* against the **real** harness home:
 *
 * - the Workspace registry lists the user's own Workspaces and the probe's seeded
 *   one is invisible, so every check fails in a way that reads like a plugin bug;
 * - session logs are written into the user's real `~/.dsh/sessions/`.
 *
 * Both happened. The second is the serious one: a probe is supposed to be
 * incapable of touching real data, and this one silently was not.
 *
 * ## What this does
 *
 * Refuses to run without an explicit home, refuses to run against the real one,
 * and sets `DSH_HOME` before any harness module can read it. It must be called
 * before the first `dshHomePath()` call — in practice, before `loadProfile`,
 * because composing the profile evaluates those roots.
 *
 * @module dsh-workspace-profile/scripts/isolated-home
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** The real harness home, which no probe may write to. */
const REAL_HOME = resolve(process.env.HOME ?? '/nonexistent', '.dsh');

/**
 * Resolve a path without requiring it to exist.
 *
 * @param {string} path - an absolute or relative path.
 * @returns {string} its canonical form when it exists, else its resolved form.
 */
function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Assert a probe home is a throwaway directory, and point the harness at it.
 *
 * @param {string|undefined} home - the `--home` argument.
 * @returns {string} the canonical probe home.
 * @throws {Error} when the home is missing or is the real harness home.
 */
export function requireIsolatedHome(home) {
  if (typeof home !== 'string' || home === '') {
    throw new Error(
      'this probe writes real runtime state and needs an explicit --home pointing at a throwaway directory '
        + '(for example: --home "$(mktemp -d)")',
    );
  }
  const target = canonical(home);
  const real = canonical(REAL_HOME);
  if (target === real || target.startsWith(real + sep)) {
    throw new Error(
      `refusing to run against the real harness home (${target}): this probe writes sessions and storage there`,
    );
  }
  // The load-bearing line. Everything rooted by `dshHomePath()` keys off this, and
  // it is read lazily, so setting it here is early enough.
  process.env.DSH_HOME = target;
  return target;
}

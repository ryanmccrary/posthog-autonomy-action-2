/**
 * Version stamp for the bot. Read at startup and logged so a CI run's
 * output makes it obvious which version of the action is executing —
 * useful when verifying that a PR's changes are actually deployed.
 *
 * Two pieces:
 *   - `VERSION`: the npm package version from package.json (single source
 *     of truth — bump there, here is just a re-export).
 *   - `COMMIT_SHA`: the GitHub-provided sha of the workflow run, when
 *     available. Falls back to "local" outside of Actions.
 *
 * `package.json` is bundled by ncc at build time because we use
 * `resolveJsonModule: true` (see tsconfig.json), so this works in both
 * source and bundled execution.
 */

// Plain JSON import — works under our tsconfig's `resolveJsonModule: true`.
// We avoid the `with { type: 'json' }` attribute form because it requires
// `module: nodenext` (or similar) and the project pins `module: ES2022`.
import pkg from '../package.json';

export const VERSION: string = pkg.version;

/**
 * Short (7-char) commit sha if running inside GitHub Actions, otherwise
 * "local". `GITHUB_SHA` is set by Actions to the commit that triggered
 * the workflow.
 */
export const COMMIT_SHA: string = (process.env.GITHUB_SHA ?? 'local').slice(0, 7);

/**
 * One-line tag you can grep for in CI logs, e.g.:
 *   [autonomy-bot] posthog-pr-autonomy-bot v0.2.0 (rev a244cb6)
 */
export function versionTag(): string {
  return `${pkg.name} v${VERSION} (rev ${COMMIT_SHA})`;
}

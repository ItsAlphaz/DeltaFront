import { APP_VERSION } from "./AppVersion";
import { ClientEnv } from "./ClientEnv";

// Two different pieces of information, kept apart on purpose:
//  - the VERSION (APP_VERSION, "0.1.0" from package.json) names a release. It
//    is what the nav bar shows under the logo;
//  - the COMMIT (ClientEnv.gitCommit) names one particular build. It is what
//    the footer shows, and what a player is asked to quote in a bug report.
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SHORT_COMMIT_LENGTH = 7;

/**
 * The label identifying this build in the footer: the 7-char commit.
 *
 * Falls back, in order, to the commit text when it is not a sha (the local dev
 * server's "DEV", or the "desktop" placeholder an Electron shell predating
 * OPE-358 injects) and to the version when no commit is known at all, so the
 * label is never blank.
 *
 * Pure, and takes both inputs, so it can be tested without a page.
 */
export function composeBuildLabel(
  rawVersion: string,
  gitCommit: string,
): string {
  const commit = gitCommit.trim();
  if (SHA_RE.test(commit)) {
    return commit.slice(0, SHORT_COMMIT_LENGTH).toLowerCase();
  }
  if (commit !== "") return commit;
  // Unreachable in a live client -- ClientEnv.get() throws long before this
  // if BOOTSTRAP_CONFIG is absent -- but the label must never come back blank.
  return taggedGameVersion(rawVersion);
}

/**
 * composeBuildLabel applied to this page.
 *
 * Called at render time rather than evaluated at module scope: the commit
 * comes from BOOTSTRAP_CONFIG, which the server injects into the page, and
 * which is not guaranteed to exist when this module is first imported.
 */
export function currentBuildLabel(): string {
  return composeBuildLabel(APP_VERSION, currentGitCommit());
}

/** The version with a leading "v": "0.1.0" and "v0.1.0" both give "v0.1.0". */
export function taggedGameVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

/** The nav bar's version elements, in both the mobile and desktop nav bars. */
const NAV_VERSION_SELECTOR = "#game-version, .game-version-display";

/**
 * Stamps the version (never the commit) onto the nav bar, and reports how many
 * elements it found so the caller can warn when the markup has moved out from
 * under it.
 *
 * Lives here rather than inline in Main.ts so it can be tested without
 * importing Main.ts, which is a module of side effects.
 */
export function renderNavVersion(root: ParentNode = document): number {
  const elements = root.querySelectorAll(NAV_VERSION_SELECTOR);
  const label = taggedGameVersion(APP_VERSION);
  elements.forEach((el) => {
    (el as HTMLElement).style.fontFamily = "var(--font-display)";
    el.textContent = label;
  });
  return elements.length;
}

// ClientEnv.get() throws when BOOTSTRAP_CONFIG is missing. A cosmetic label
// must never be the thing that takes the page down, so read it defensively and
// let composeBuildLabel treat "" as "no commit known".
function currentGitCommit(): string {
  try {
    return ClientEnv.gitCommit();
  } catch {
    return "";
  }
}

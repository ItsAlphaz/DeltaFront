/**
 * The game version, e.g. "0.1.0": `version` in package.json, injected at build
 * time by vite.config.ts (dev server, production build and tests alike). It is
 * the only definition: to release, bump it there (`npm version`), never here.
 *
 * Separate from the Git commit, which identifies one particular build
 * (ClientEnv.gitCommit, shown in the footer): the version names a release.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = __APP_VERSION__;

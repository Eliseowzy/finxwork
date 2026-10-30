// What was fixed when the app was built (electron.vite.config.ts, from
// scripts/build-app.mjs): nothing at run time changes these.

declare const __FINXWORK_RELEASES__: string;
declare const __FINXWORK_TEST_HOME__: string;

/** The GitHub releases the app updates from; empty for a build that does not update (development, ad-hoc signed). */
export const releasesURL: string = __FINXWORK_RELEASES__;

/**
 * Test builds only (scripts/update-e2e.mjs): the folder holding the app's
 * profile and FINX_HOME. Built in, so the version Squirrel relaunches after
 * an update uses it too.
 */
export const testHome: string = __FINXWORK_TEST_HOME__;

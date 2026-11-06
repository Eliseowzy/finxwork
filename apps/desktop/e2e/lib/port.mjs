// A debugging port for the app under test. Scripts run side by side (e2e/run.mjs), and one that
// reached another's app would pass or fail on what that app shows: the process id keeps them apart,
// the count keeps a restart in one script off a port its last app may still be leaving. The range
// stays above 10080, the last port `fetch` refuses, and below the system's ephemeral ports.
let launches = 0;

export function cdpPort() {
  return 11000 + (process.pid % 4700) * 8 + (launches++ % 8);
}

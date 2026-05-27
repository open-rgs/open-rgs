// Single source of truth for @open-rgs/core's own version.
//
// MUST be bumped in lockstep with packages/core/package.json. The two
// can't easily be auto-synced without a build step, so we keep them
// adjacent and rely on the publish.sh script to catch drift (it reads
// version from package.json for the npm publish  - if it goes out and
// CORE_VERSION here is stale, the /healthz response will lie).
//
// Surfaced via /healthz so operators can confirm exactly which core
// shipped with a deployed pod.
export const CORE_VERSION = "0.3.0";

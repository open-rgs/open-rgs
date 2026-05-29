// Single source of truth for @open-rgs/core's own version.
//
// Read straight from package.json so it can never drift — the previous
// hardcoded constant went stale ("0.3.0" while the package was 0.5.1), so
// /healthz and the startup banner lied about which core was live. npm
// always ships package.json in the published tarball, and Bun resolves the
// JSON import at runtime, so this is correct both in-repo and when consumed.
//
// Surfaced via /healthz so operators can confirm exactly which core
// shipped with a deployed pod.
import pkg from "../package.json";

export const CORE_VERSION: string = pkg.version;

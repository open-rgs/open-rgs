// Singleton logger for @open-rgs/core. Thin wrapper around the
// instantiable @open-rgs/log package — gives the rest of core a fixed
// import path while keeping the heavy lifting in a peer package.
//
// Game integrators who want their own Logger (per-request scopes,
// custom sinks, sampling) should import createLogger from
// @open-rgs/log directly.

import { createLogger, type Logger, type LogLevel } from "@open-rgs/log";

let inner: Logger = createLogger({
  service: "open-rgs",
  version: "0.0.0",
});

interface CoreLog extends Logger {
  /** Re-init the singleton with service identity. Called once from
   *  createServer(). Safe to call before any log lines are emitted. */
  init(name: string, version: string, isDev: boolean): void;
}

export const log: CoreLog = {
  init(name: string, version: string, isDev: boolean) {
    const env = process.env["LOG_LEVEL"];
    const minLevel: LogLevel | undefined =
      env === "debug" || env === "info" || env === "warn" || env === "error" || env === "fatal"
        ? env
        : (isDev ? "debug" : "info");
    inner = createLogger({
      service: name,
      version,
      environment: isDev ? "development" : "production",
      minLevel,
    });
  },
  debug: (m, f) => inner.debug(m, f),
  info:  (m, f) => inner.info(m, f),
  warn:  (m, f) => inner.warn(m, f),
  error: (m, f) => inner.error(m, f),
  fatal: (m, f) => inner.fatal(m, f),
  exception: (m, e, f) => inner.exception(m, e, f),
  child: (bind) => inner.child(bind),
  getRecent: (level, limit) => inner.getRecent(level, limit),
  setLevel: (l) => inner.setLevel(l),
  getLevel: () => inner.getLevel(),
};

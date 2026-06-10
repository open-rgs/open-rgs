// createServer: top-level entry point game integrators call. Wires
// orchestrator + transport + admin + metrics + idempotency together,
// installs a SIGTERM handler for graceful shutdown, returns a stop()
// that drains in-flight requests before exiting.
//
// Port topology:
//   - Default (single-port): admin + probes + WS upgrade all served
//     on the transport's port. Pass nothing for adminPort.
//   - Legacy (two-port): admin on its own Bun.serve. Opt in by setting
//     adminPort to a value DIFFERENT from the transport port. Useful
//     for tests or for deployments that want admin on a private
//     interface unreachable from public ingress.

import type {
  GameManifest, PlatformAdapter, ClientTransport, IdempotencyConfig,
} from "@open-rgs/contract";
import { createOrchestrator } from "./orchestrator.js";
import { createAdminHandler, startAdmin } from "./admin.js";
import { createAuditLog, type AuditSink } from "./audit-log.js";
import { log } from "./log.js";
import { CORE_VERSION } from "./version.js";
import { createRgsMetrics, type RgsMetrics } from "./metrics-rgs.js";

export interface ServerConfig {
  manifest: GameManifest;
  platform: PlatformAdapter;
  transport: ClientTransport;
  /** Version of the consumer service (the game server). Surfaced in
   *  /healthz as game_version. Pass your package.json version. Default
   *  "unknown"  - pass it so /healthz doesn't lie about what's deployed. */
  version?: string;
  /** Unique id of THIS running instance. Every instance generates its own
   *  at boot (`rgs-<8 hex>`); the `OPEN_RGS_INSTANCE_ID` env var overrides
   *  the generation (e.g. the pod name via the k8s downward API), and an
   *  explicit value here wins over both. Surfaced as the `instance_id`
   *  label on `rgs_build_info`, as `instance_id` in /healthz, and as
   *  `service.instance.id` on every log line  - so per-instance metrics,
   *  logs, and health all correlate on one key. */
  instanceId?: string;
  /** HTTP admin port. Default: same as transport port (single-port mode,
   *  routes mounted under /admin/* + /livez + /readyz + /healthz). Set
   *  to a distinct port to spin up a separate admin Bun.serve  - ideally on
   *  a private interface behind a default-deny NetworkPolicy. */
  adminPort?: number;
  /** Bearer token required on /admin/* and the detailed /healthz. Falls back
   *  to the OPEN_RGS_ADMIN_TOKEN env var. In production, if neither is set,
   *  those routes fail closed (403)  - admin shares the public client port in
   *  single-port mode, so it must not be open. */
  adminToken?: string;
  /** CORS origin allowlist for browser operator dashboards hitting /admin/*.
   *  Default none (no CORS headers). Never wildcard. */
  adminAllowedOrigins?: string[];
  /** Exact base path your ingress serves admin under (one declared rewrite,
   *  e.g. "/api"). Default "" -> exact canonical routes. */
  adminRouteBasePath?: string;
  /** Serve /healthz WITHOUT auth  - for operator dashboards or external
   *  uptime probers that can't inject an admin token. /admin/* stays
   *  gated. Default false. See AdminConfig.publicHealthz for the
   *  trade-offs. Prefer /readyz for plain "is it up?" checks. */
  adminPublicHealthz?: boolean;
  /** Override the env-detected dev flag. */
  isDev?: boolean;
  /** Enable the dev-only forced-outcome cheat path (client sends a cheat in
   *  `params.cheat`). Default false. Cheats are ALWAYS off in production
   *  (`NODE_ENV=production`) regardless of this flag, and off everywhere
   *  unless this is true or `OPEN_RGS_ENABLE_CHEATS=1`. Never enable for a
   *  real-money deployment. */
  enableCheats?: boolean;
  /** Bring your own metrics registry, or omit to use the standard one. */
  metrics?: RgsMetrics;
  /** Idempotency-key generator + retention. See @open-rgs/contract. */
  idempotency?: IdempotencyConfig;
  /** Durable, append-only sink for the tamper-evident game-outcome audit log.
   *  When set, every money-moving round records a hash-chained event. Provide
   *  a durable sink in production (file+fsync, object storage, Kafka, ...);
   *  `memoryAuditSink`/`jsonlStdoutAuditSink` are for dev only. */
  auditSink?: AuditSink;
  /** "mandatory" makes the wallet-side `updateComplex` action-log checkpoint
   *  block-and-fail a complex-round step if dropped (for jurisdictions that
   *  require a server-side action log). Default "best-effort". */
  auditMode?: "best-effort" | "mandatory";
  /** Interval for the in-process financial snapshot log line (lifetime
   *  bets/wins per currency + derived GGR and RTP, read straight from the
   *  in-memory counters - no external aggregation involved). Default
   *  600_000 (10 min). Set 0 to disable. */
  financialLogIntervalMs?: number;
  /** Graceful-shutdown drain window in ms. Default 30_000. */
  shutdownDrainMs?: number;
  /** Install a SIGTERM handler that calls stop(). Default true; set
   *  false in test harnesses. */
  installSignalHandlers?: boolean;
}

export interface ServerHandle {
  /** Drain in-flight requests, disconnect platform, stop admin + transport. */
  stop(opts?: { drainMs?: number }): Promise<void>;
  /** Shared metrics registry, surfaced for tests and custom dashboards. */
  metrics: RgsMetrics;
}

export async function createServer(cfg: ServerConfig): Promise<ServerHandle> {
  const isDev       = cfg.isDev ?? process.env["NODE_ENV"] !== "production";
  const gameVersion = cfg.version ?? "unknown";
  // Self-generated per-boot identity; env (k8s pod name) or config override.
  const instanceId  = cfg.instanceId
    ?? process.env["OPEN_RGS_INSTANCE_ID"]
    ?? `rgs-${crypto.randomUUID().slice(0, 8)}`;

  // Forced-outcome cheats: fail closed. Require an explicit opt-in AND a
  // non-production NODE_ENV. The old gate keyed off `isDev`, which defaults
  // to ON whenever NODE_ENV is anything other than exactly "production"
  // (unset, "prod", "staging", a typo)  - so a misconfigured env shipped a
  // live forced-win path. Now the env can't enable cheats; only a
  // deliberate opt-in can, and never in production.
  const isProduction = process.env["NODE_ENV"] === "production";
  const cheatsEnabled = !isProduction
    && (cfg.enableCheats ?? process.env["OPEN_RGS_ENABLE_CHEATS"] === "1");

  log.init(`open-rgs-${cfg.manifest.id}`, gameVersion, isDev, instanceId);
  log.info("RGS starting", {
    "event.category": "process",
    "event.action":   "startup",
    "game.id":             cfg.manifest.id,
    "game.version":        gameVersion,
    "core.version":        CORE_VERSION,
    "game.declared_rtp":   cfg.manifest.declaredRtp,
    "game.modes":          Object.keys(cfg.manifest.modes),
    "service.environment": isDev ? "development" : "production",
  });

  // Math identity per mode  - log so operators can verify the live
  // source matches what the simulator validated.
  for (const [id, mode] of Object.entries(cfg.manifest.modes)) {
    log.info("Math loaded", {
      "event.category": "process",
      "event.action":   "math_loaded",
      "mode.id":             id,
      "math.name":           mode.math.name,
      "math.version":        mode.math.version,
      "math.kind":           mode.math.kind,
      "math.rtp":            mode.math.rtp,
      "math.content_hash":   mode.math.contentHash,
    });
  }

  // declaredRtp consistency: a mode's declaredRtp should match its
  // math.rtp (the simulator-verified value), and the manifest's overall
  // declaredRtp should match the modes for single-mode games. We warn
  // rather than fail because multi-mode games legitimately use blended
  // figures; the warning prompts a human check.
  for (const [id, mode] of Object.entries(cfg.manifest.modes)) {
    const modeDeclared = mode.declaredRtp ?? mode.math.rtp;
    if (Math.abs(modeDeclared - mode.math.rtp) > 1e-6) {
      log.warn("declaredRtp / math.rtp mismatch  - audit risk", {
        "event.category": "process",
        "event.action":   "rtp_mismatch",
        "mode.id":            id,
        "mode.declared_rtp":  modeDeclared,
        "math.rtp":           mode.math.rtp,
        "drift":              modeDeclared - mode.math.rtp,
      });
    }
  }
  const modeKeys = Object.keys(cfg.manifest.modes);
  if (modeKeys.length === 1) {
    const onlyMode = cfg.manifest.modes[modeKeys[0]!]!;
    const onlyDeclared = onlyMode.declaredRtp ?? onlyMode.math.rtp;
    if (Math.abs(cfg.manifest.declaredRtp - onlyDeclared) > 1e-6) {
      log.warn("manifest.declaredRtp differs from sole mode's declaredRtp", {
        "event.category": "process",
        "event.action":   "rtp_mismatch",
        "manifest.declared_rtp": cfg.manifest.declaredRtp,
        "mode.id":               modeKeys[0],
        "mode.declared_rtp":     onlyDeclared,
        "drift":                 cfg.manifest.declaredRtp - onlyDeclared,
      });
    }
  }

  // Connect platform first; orchestrator events depend on it.
  try {
    await cfg.platform.connect();
  } catch (e) {
    log.exception("Platform initial connect failed", e, { "event.category": "platform" });
  }

  const metrics = cfg.metrics ?? createRgsMetrics();

  // Identity series (constant 1) - dashboards join per-instance panels on
  // instance_id; a new series appearing marks an instance (re)start.
  metrics.buildInfo.set(1, {
    instance_id:  instanceId,
    game:         cfg.manifest.id,
    core_version: CORE_VERSION,
    game_version: gameVersion,
  });

  // Platform SLA watcher: connected gauge + flap counter, sampled every
  // second off the adapter's own isHealthy. platformLastOk is stamped by
  // the orchestrator on every successful RPC - baseline it to boot time so
  // an instance that hasn't served a round yet reads as "silent since
  // boot", not "silent since the epoch".
  metrics.platformLastOk.set(Date.now() / 1000);
  // Declared RTP per mode - the target line dashboards draw live RTP against.
  for (const [modeId, mode] of Object.entries(cfg.manifest.modes)) {
    metrics.declaredRtp.set(mode.math.rtp ?? cfg.manifest.declaredRtp, { mode: modeId });
  }

  // Financial snapshot log: lifetime totals straight from the in-memory
  // counters - the server aggregates its own money picture, no database
  // round-trip. Per currency: raw components + the two standard
  // derivations (GGR = real bets - all wins paid; RTP = wins / stakes).
  const finLogMs = cfg.financialLogIntervalMs ?? 600_000;
  const finLog = finLogMs > 0 ? setInterval(() => {
    const byCurrency = new Map<string, Record<string, number>>();
    const fold = (rows: ReadonlyArray<{ labels: string; value: number }>, kind: "bets" | "wins") => {
      for (const { labels, value } of rows) {
        // label key format: `k="v",k="v"` in label-name order
        const l = Object.fromEntries(labels.split(",").map((kv) => {
          const eq = kv.indexOf("=");
          return [kv.slice(0, eq), kv.slice(eq + 1).replace(/^"|"$/g, "")] as [string, string];
        }));
        const cur = l["currency"] ?? "?";
        const slot = byCurrency.get(cur) ?? { bets_real: 0, bets_promo: 0, wins_real: 0, wins_promo: 0 };
        slot[`${kind}_${l["funding"] ?? "real"}`] = (slot[`${kind}_${l["funding"] ?? "real"}`] ?? 0) + value;
        byCurrency.set(cur, slot);
      }
    };
    fold(metrics.betsMinor.snapshot(), "bets");
    fold(metrics.winsMinor.snapshot(), "wins");
    if (byCurrency.size === 0) return;
    const fin: Record<string, unknown> = {};
    for (const [cur, t] of byCurrency) {
      const stakes = t["bets_real"]! + t["bets_promo"]!;
      const wins = t["wins_real"]! + t["wins_promo"]!;
      fin[cur] = {
        ...t,
        ggr_minor: t["bets_real"]! - wins,
        rtp_lifetime: stakes > 0 ? Number((wins / stakes).toFixed(4)) : null,
      };
    }
    log.info("Financial snapshot (lifetime, this instance)", {
      "event.category": "financial",
      "event.action":   "financial_snapshot",
      "financial":      fin,
    });
  }, finLogMs) : undefined;

  let platformWasHealthy = cfg.platform.isHealthy;
  metrics.platformConnected.set(platformWasHealthy ? 1 : 0);
  const platformWatch = setInterval(() => {
    const healthy = cfg.platform.isHealthy;
    if (healthy !== platformWasHealthy) {
      metrics.platformTransitions.inc(1, { direction: healthy ? "up" : "down" });
      log.info(`Platform connection ${healthy ? "restored" : "lost"}`, {
        "event.category": "platform",
        "event.action":   healthy ? "platform_up" : "platform_down",
      });
      platformWasHealthy = healthy;
    }
    metrics.platformConnected.set(healthy ? 1 : 0);
  }, 1_000);

  if (cheatsEnabled) {
    log.warn("CHEATS ENABLED  - forced-outcome hints from params.cheat are active. " +
      "This must NEVER be on for real-money play.", {
      "event.category": "process",
      "event.action":   "cheats_enabled",
    });
  }

  const orchestrator = createOrchestrator({
    manifest: cfg.manifest,
    platform: cfg.platform,
    cheatsEnabled,
    metrics,
    ...(cfg.idempotency ? { idempotency: cfg.idempotency } : {}),
    ...(cfg.auditSink ? { auditLog: createAuditLog(cfg.auditSink) } : {}),
    ...(cfg.auditMode ? { auditMode: cfg.auditMode } : {}),
  });

  // Single-port mode: mount the admin handler on the transport's
  // Bun.serve. Only kicks in for the bundled binaryTransport (which
  // is the one >99% of consumers use). A custom transport that
  // wasn't built with extraFetch in mind just won't expose admin
  // on its port  - the caller can still pass adminPort to get the
  // legacy separate-port behaviour.
  const singlePort = cfg.adminPort === undefined;
  let separateAdmin: { stop: () => void } | undefined;

  // Admin auth: token from config or env; required (fail-closed) in
  // production. The audit's "every request is from a trusted operator"
  // assumption is false when admin shares the public client port.
  const adminToken = cfg.adminToken ?? process.env["OPEN_RGS_ADMIN_TOKEN"];
  const requireAuth = !isDev;
  const adminAuth = {
    ...(adminToken ? { authToken: adminToken } : {}),
    requireAuth,
    ...(cfg.adminAllowedOrigins ? { allowedOrigins: cfg.adminAllowedOrigins } : {}),
    ...(cfg.adminRouteBasePath ? { routeBasePath: cfg.adminRouteBasePath } : {}),
    ...(cfg.adminPublicHealthz ? { publicHealthz: true } : {}),
  };
  if (requireAuth && !adminToken) {
    log.warn(
      singlePort
        ? "Production single-port mode with no admin token  - /admin/* and /healthz will 403. " +
          "Set adminToken / OPEN_RGS_ADMIN_TOKEN, or bind admin to a private adminPort."
        : "Production admin has no token  - /admin/* and /healthz will 403 until adminToken / OPEN_RGS_ADMIN_TOKEN is set.",
      { "event.category": "process", "event.action": "admin_auth_unset" },
    );
  }

  if (singlePort) {
    const handler = createAdminHandler({
      manifest:     cfg.manifest,
      platform:     cfg.platform,
      orchestrator,
      metrics,
      gameVersion,
      instanceId,
      ...adminAuth,
    });
    if (typeof (cfg.transport as { setExtraFetch?: unknown }).setExtraFetch === "function") {
      (cfg.transport as unknown as { setExtraFetch: (fn: typeof handler.fetch) => void }).setExtraFetch(handler.fetch);
    } else {
      log.warn("Custom transport in single-port mode  - admin not mounted; pass adminPort for legacy mode", {
        "event.category": "process",
        "event.action":   "admin_unmounted",
      });
    }
  }

  const { port } = await cfg.transport.start(orchestrator);

  if (!singlePort && cfg.adminPort !== undefined) {
    separateAdmin = startAdmin({
      port: cfg.adminPort,
      manifest: cfg.manifest,
      platform: cfg.platform,
      orchestrator,
      metrics,
      gameVersion,
      instanceId,
      ...adminAuth,
    });
  }

  log.info("RGS ready", {
    "event.category": "process",
    "event.action":   "ready",
    "transport.port": port,
    "admin.mode":     singlePort ? "single-port" : "separate-port",
    "admin.port":     singlePort ? port : cfg.adminPort,
  });

  const drainDefault = cfg.shutdownDrainMs ?? 30_000;
  let stopped = false;

  async function stop(opts: { drainMs?: number } = {}): Promise<void> {
    if (stopped) return;
    stopped = true;
    const drainMs = opts.drainMs ?? drainDefault;
    log.info("RGS stopping", {
      "event.category": "process",
      "event.action":   "shutdown_start",
      "drain.ms":       drainMs,
    });
    clearInterval(platformWatch);
    if (finLog) clearInterval(finLog);
    try {
      // 1. Stop accepting new connections + drain in-flight requests.
      const transportStop = cfg.transport.stop({ drainMs });
      if (transportStop instanceof Promise) await transportStop;
      // 2. Stop admin HTTP if it's on its own port. In single-port
      //    mode admin is on the transport server we just stopped.
      separateAdmin?.stop();
      // 3. Disconnect platform (close WS, settle in-flight RPCs).
      cfg.platform.disconnect();
    } catch (e) {
      log.exception("RGS stop failed", e, { "event.category": "process" });
    }
    log.info("RGS stopped", {
      "event.category": "process",
      "event.action":   "shutdown_complete",
    });
  }

  if (cfg.installSignalHandlers !== false) {
    const onSignal = (sig: NodeJS.Signals) => {
      log.info(`Received ${sig}`, {
        "event.category": "process",
        "event.action":   "signal_received",
        "signal":         sig,
      });
      stop().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT",  onSignal);
  }

  return { stop, metrics };
}


// createServer: top-level entry point game integrators call. Wires
// orchestrator + transport + admin + metrics + idempotency together,
// installs a SIGTERM handler for graceful shutdown, returns a stop()
// that drains in-flight requests before exiting.
//
// Port topology:
//   • Default (single-port): admin + probes + WS upgrade all served
//     on the transport's port. Pass nothing for adminPort.
//   • Legacy (two-port): admin on its own Bun.serve. Opt in by setting
//     adminPort to a value DIFFERENT from the transport port. Useful
//     for tests or for deployments that want admin on a private
//     interface unreachable from public ingress.

import type {
  GameManifest, PlatformAdapter, ClientTransport, IdempotencyConfig,
} from "@open-rgs/contract";
import { createOrchestrator } from "./orchestrator.js";
import { createAdminHandler, startAdmin } from "./admin.js";
import { log } from "./log.js";
import { CORE_VERSION } from "./version.js";
import { createRgsMetrics, type RgsMetrics } from "./metrics-rgs.js";

export interface ServerConfig {
  manifest: GameManifest;
  platform: PlatformAdapter;
  transport: ClientTransport;
  /** Version of the consumer service (the game server). Surfaced in
   *  /healthz as game_version. Pass your package.json version. Default
   *  "unknown" — pass it so /healthz doesn't lie about what's deployed. */
  version?: string;
  /** HTTP admin port. Default: same as transport port (single-port mode,
   *  routes mounted under /admin/* + /livez + /readyz + /healthz). Set
   *  to a distinct port to spin up a separate admin Bun.serve. */
  adminPort?: number;
  /** Override the env-detected dev flag. */
  isDev?: boolean;
  /** Bring your own metrics registry, or omit to use the standard one. */
  metrics?: RgsMetrics;
  /** Idempotency-key generator + retention. See @open-rgs/contract. */
  idempotency?: IdempotencyConfig;
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

  log.init(`open-rgs-${cfg.manifest.id}`, gameVersion, isDev);
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

  // Math identity per mode — log so operators can verify the live
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
      log.warn("declaredRtp / math.rtp mismatch — audit risk", {
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

  const orchestrator = createOrchestrator({
    manifest: cfg.manifest,
    platform: cfg.platform,
    isDev,
    metrics,
    ...(cfg.idempotency ? { idempotency: cfg.idempotency } : {}),
  });

  // Single-port mode: mount the admin handler on the transport's
  // Bun.serve. Only kicks in for the bundled binaryTransport (which
  // is the one >99% of consumers use). A custom transport that
  // wasn't built with extraFetch in mind just won't expose admin
  // on its port — the caller can still pass adminPort to get the
  // legacy separate-port behaviour.
  const singlePort = cfg.adminPort === undefined;
  let separateAdmin: { stop: () => void } | undefined;

  if (singlePort) {
    const handler = createAdminHandler({
      manifest:     cfg.manifest,
      platform:     cfg.platform,
      orchestrator,
      metrics,
      gameVersion,
    });
    if (typeof (cfg.transport as { setExtraFetch?: unknown }).setExtraFetch === "function") {
      (cfg.transport as unknown as { setExtraFetch: (fn: typeof handler.fetch) => void }).setExtraFetch(handler.fetch);
    } else {
      log.warn("Custom transport in single-port mode — admin not mounted; pass adminPort for legacy mode", {
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


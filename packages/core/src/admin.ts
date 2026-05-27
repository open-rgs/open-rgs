// Admin / health HTTP routes.
//
// Exports two shapes:
//
//   • createAdminHandler(cfg) — returns a fetch handler + stop fn. The
//     handler returns Response when the request matched an admin route,
//     or undefined when it didn't. Designed to be composed inside
//     another Bun.serve (e.g. mounted on the binary transport's port).
//
//   • startAdmin(cfg) — legacy path: spins up its own Bun.serve on
//     cfg.port. Kept for tests + the rare deployment that genuinely
//     wants a separate admin port. createServer prefers single-port.
//
// Path matching:
//   Routes match by SUFFIX, not equality. The example-cluster Istio
//   ingress rewrites /api/<gameId>/<rest> → /api/<rest> (drops the
//   game-id segment, keeps /api/). Other deployments rewrite to /,
//   to /api/<rest>, or not at all. Suffix matching is robust to all
//   of these — we just check the path ends with the canonical route.
//
// Canonical routes:
//   /livez                always 200 OK (process is alive)
//   /readyz               200 if platform connected, else 503
//   /healthz              JSON diagnostics + status (503 if unhealthy)
//   /admin/logs           ring buffer (?level=&limit=)
//   /admin/metrics        Prometheus exposition (if metrics passed)
//   /admin/sessions       active session list
//   /admin/manifest       serialised GameManifest
//   /admin/modes          mode catalog
//   /admin/autoclose POST external autoclose trigger
//   /__echo               debug — returns the raw pathname the pod saw
//
// Suffix matching means /api/admin/manifest, /admin/manifest,
// /api/example-game/admin/manifest, /something/else/admin/manifest all
// resolve to the same handler. Acceptable because we never serve
// uploaded paths; every request comes from operators or from the
// platform ingress, both trusted.

import type { GameManifest, PlatformAdapter, OrchestratorAPI, AutocloseRequest } from "@open-rgs/contract";
import * as sessions from "./session.js";
import { log } from "./log.js";
import { CORE_VERSION } from "./version.js";
import type { RgsMetrics } from "./metrics-rgs.js";

export interface AdminConfig {
  manifest: GameManifest;
  platform: PlatformAdapter;
  /** Orchestrator handle so admin can drive operator-initiated autocloses. */
  orchestrator: OrchestratorAPI;
  /** Optional metrics registry — exposed at /admin/metrics if provided. */
  metrics?: RgsMetrics;
  /** Version of the game/service hosting this admin handler. Surfaced
   *  as game_version in /healthz. Default "unknown" — callers should
   *  pass their package.json version through createServer({ version }). */
  gameVersion?: string;
}

export interface StartAdminConfig extends AdminConfig {
  port: number;
}

export interface AdminHandler {
  /** Returns a Response when the path is an admin route, or undefined
   *  to indicate "not handled — fall through to your own 404". */
  fetch: (req: Request) => Promise<Response | undefined> | Response | undefined;
}

export function createAdminHandler(cfg: AdminConfig): AdminHandler {
  const startedAt = Date.now();

  return {
    fetch: async (req): Promise<Response | undefined> => {
      const url  = new URL(req.url);
      const path = url.pathname;

      // Suffix match: pod's path may be the canonical route,
      // /api/<route>, /api/<gameId>/<route>, or any other prefix the
      // ingress hands us. We just check the trailing segment(s) match
      // a known canonical route. No assumptions about rewrite rules.
      const endsWith = (route: string): boolean =>
        path === route || path.endsWith(route);

      if (req.method === "OPTIONS") return cors(new Response(null));

      // ── K8s probes ───────────────────────────────────────────────

      if (endsWith("/livez")) {
        return new Response("OK");
      }
      if (endsWith("/readyz")) {
        return cfg.platform.isHealthy
          ? new Response("OK")
          : new Response("Platform not connected", { status: 503 });
      }
      if (endsWith("/healthz")) {
        return cors(json(health(), cfg.platform.isHealthy ? 200 : 503));
      }

      // ── Admin (canonical /admin/*) ───────────────────────────────

      if (endsWith("/admin/logs")) {
        return cors(json(logs(url)));
      }
      if (endsWith("/admin/metrics") && cfg.metrics) {
        return cors(new Response(cfg.metrics.registry.expose(), {
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        }));
      }
      if (endsWith("/admin/sessions")) {
        return cors(json(sessions.all()));
      }
      if (endsWith("/admin/manifest")) {
        return cors(json(serializeManifest()));
      }
      if (endsWith("/admin/modes")) {
        return cors(json(modeCatalog()));
      }
      if (endsWith("/admin/autoclose") && req.method === "POST") {
        return cors(await handleAutoclose(req));
      }

      // Not an admin route — let the caller (transport / outer server)
      // decide what to do (typically: 404 or upgrade-to-WS).
      return undefined;
    },
  };

  async function handleAutoclose(req: Request): Promise<Response> {
    let body: AutocloseRequest;
    try {
      body = await req.json() as AutocloseRequest;
    } catch {
      return json({ closed: false, reason: "invalid-json" }, 400);
    }
    if (!body.sessionId || !body.reason) {
      return json({ closed: false, reason: "missing-sessionId-or-reason" }, 400);
    }
    log.info("Admin autoclose requested", {
      "event.category": "admin",
      "event.action":   "autoclose_request",
      "session.id":     body.sessionId,
      "round.id":       body.roundId ?? "(any)",
      "autoclose.reason": body.reason,
    });
    const result = await cfg.orchestrator.autocloseRound(body);
    return json(result, result.closed ? 200 : 409);
  }

  function health() {
    // Math identity per mode (version + sha-256 prefix). Lets operators
    // confirm exactly which math source is live without grepping logs.
    const math: Record<string, { name: string; version: string; hash?: string }> = {};
    for (const [id, m] of Object.entries(cfg.manifest.modes)) {
      const entry: { name: string; version: string; hash?: string } = {
        name:    m.math.name,
        version: m.math.version,
      };
      if (m.math.contentHash) entry.hash = m.math.contentHash.slice(0, 16);
      math[id] = entry;
    }
    return {
      status:               cfg.platform.isHealthy ? "healthy" : "reconnecting",
      core_version:         CORE_VERSION,
      game_version:         cfg.gameVersion ?? "unknown",
      game:                 cfg.manifest.id,
      declared_rtp:         cfg.manifest.declaredRtp,
      uptime_sec:           Math.floor((Date.now() - startedAt) / 1000),
      platform_connected:   cfg.platform.isHealthy,
      platform_diagnostics: cfg.platform.diagnostics,
      active_sessions:      sessions.size(),
      math,
    };
  }

  function logs(url: URL) {
    const level = url.searchParams.get("level") as "debug" | "info" | "warn" | "error" | "fatal" | null;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
    return log.getRecent(level ?? undefined, limit);
  }

  function modeCatalog() {
    const out: Record<string, unknown> = {};
    for (const [id, m] of Object.entries(cfg.manifest.modes)) {
      out[id] = {
        stake_multiplier: m.stakeMultiplier,
        label:            m.label,
        internal:         m.internal ?? false,
        declared_rtp:     m.declaredRtp ?? m.math.rtp,
        math_name:        m.math.name,
        math_version:     m.math.version,
        math_hash:        m.math.contentHash,
        kind:             m.math.kind,
      };
    }
    return out;
  }

  function serializeManifest() {
    return {
      id:           cfg.manifest.id,
      declared_rtp: cfg.manifest.declaredRtp,
      default_mode: cfg.manifest.defaultMode,
      modes:        modeCatalog(),
      autoclose:    cfg.manifest.autoclose,
      recovery:     cfg.manifest.recovery,
    };
  }
}

// ── Legacy separate-port mode ────────────────────────────────────────

export function startAdmin(cfg: StartAdminConfig): { stop: () => void } {
  const handler = createAdminHandler(cfg);
  const server = Bun.serve({
    port: cfg.port,
    fetch: async (req): Promise<Response> => {
      const res = await handler.fetch(req);
      return res ?? new Response("Not found", { status: 404 });
    },
  });
  log.info("Admin listening", {
    "event.category": "admin",
    "event.action":   "listen",
    "server.port":    cfg.port,
  });
  return { stop: () => server.stop() };
}

// ── Helpers ──────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cors(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

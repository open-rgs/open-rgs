// Admin / health HTTP routes.
//
// Exports two shapes:
//
//   - createAdminHandler(cfg)  - returns a fetch handler + stop fn. The
//     handler returns Response when the request matched an admin route,
//     or undefined when it didn't. Designed to be composed inside
//     another Bun.serve (e.g. mounted on the binary transport's port).
//
//   - startAdmin(cfg)  - legacy path: spins up its own Bun.serve on
//     cfg.port. Kept for tests + the rare deployment that genuinely
//     wants a separate admin port. createServer prefers single-port.
//
// Path matching:
//   Routes match EXACTLY against `routeBasePath + canonicalRoute`
//   (routeBasePath defaults to ""). Suffix matching was a security hole:
//   any path *ending* in a route (e.g. `/wss/admin/autoclose`) resolved to
//   the handler, defeating prefix-based ingress allowlists. If your ingress
//   serves admin under a prefix (e.g. `/api`), declare it once via
//   `routeBasePath` so matching stays exact.
//
// Auth:
//   `/admin/*` and the detailed `/healthz` require `Authorization: Bearer
//   <authToken>` when a token is configured (constant-time compared). With
//   no token AND `requireAuth` (set in production), those routes fail closed
//   (403)  - the old "every request is from a trusted operator" assumption is
//   false when admin shares the public client port. The k8s probes
//   `/livez` and `/readyz` are always open (no secrets; kubelet needs them).
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
//
import type { GameManifest, PlatformAdapter, OrchestratorAPI, AutocloseRequest } from "@open-rgs/contract";
import { createHash, timingSafeEqual } from "node:crypto";
import * as sessions from "./session.js";
import { log } from "./log.js";
import { CORE_VERSION } from "./version.js";
import type { RgsMetrics } from "./metrics-rgs.js";

export interface AdminConfig {
  manifest: GameManifest;
  platform: PlatformAdapter;
  /** Orchestrator handle so admin can drive operator-initiated autocloses. */
  orchestrator: OrchestratorAPI;
  /** Optional metrics registry  - exposed at /admin/metrics if provided. */
  metrics?: RgsMetrics;
  /** Version of the game/service hosting this admin handler. Surfaced
   *  as game_version in /healthz. Default "unknown"  - callers should
   *  pass their package.json version through createServer({ version }). */
  gameVersion?: string;
  /** Bearer token required on /admin/* and the detailed /healthz. When set,
   *  requests must send `Authorization: Bearer <authToken>` (constant-time
   *  compared). createServer reads it from `adminToken` or the
   *  OPEN_RGS_ADMIN_TOKEN env var. */
  authToken?: string;
  /** When true and no authToken is configured, sensitive routes fail closed
   *  (403) instead of serving openly. createServer sets this in production. */
  requireAuth?: boolean;
  /** Exact base path prepended to every canonical route  - one declared
   *  ingress rewrite (e.g. "/api"). Default "" -> exact canonical paths. */
  routeBasePath?: string;
  /** CORS origin allowlist for browser-based operator dashboards. Default:
   *  none  - no CORS headers are sent (server-to-server / same-origin only).
   *  Never wildcard: these endpoints move money and expose balances. */
  allowedOrigins?: string[];
}

export interface StartAdminConfig extends AdminConfig {
  port: number;
}

export interface AdminHandler {
  /** Returns a Response when the path is an admin route, or undefined
   *  to indicate "not handled  - fall through to your own 404". */
  fetch: (req: Request) => Promise<Response | undefined> | Response | undefined;
}

export function createAdminHandler(cfg: AdminConfig): AdminHandler {
  const startedAt = Date.now();
  const base = cfg.routeBasePath ?? "";

  return {
    fetch: async (req): Promise<Response | undefined> => {
      const url  = new URL(req.url);
      const path = url.pathname;

      // Exact match against the (optionally prefixed) canonical route  - no
      // suffix matching, which let `/wss/admin/autoclose` reach the handler.
      const matches = (route: string): boolean => path === base + route;

      if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), req);

      // -- K8s probes  - always open (no secrets; kubelet needs them) -----
      if (matches("/livez")) {
        return new Response("OK");
      }
      if (matches("/readyz")) {
        return cfg.platform.isHealthy
          ? new Response("OK")
          : new Response("Platform not connected", { status: 503 });
      }

      // -- Auth gate for sensitive routes (detailed /healthz + /admin/*) --
      const sensitive = matches("/healthz") || path.startsWith(`${base}/admin/`);
      if (sensitive) {
        const denied = authGate(req);
        if (denied) return cors(denied, req);
      }

      if (matches("/healthz")) {
        return cors(json(health(), cfg.platform.isHealthy ? 200 : 503), req);
      }
      if (matches("/admin/logs")) {
        return cors(json(logs(url)), req);
      }
      if (matches("/admin/metrics") && cfg.metrics) {
        return cors(new Response(cfg.metrics.registry.expose(), {
          headers: { "Content-Type": "text/plain; version=0.0.4" },
        }), req);
      }
      if (matches("/admin/sessions")) {
        return cors(json(sessions.all()), req);
      }
      if (matches("/admin/manifest")) {
        return cors(json(serializeManifest()), req);
      }
      if (matches("/admin/modes")) {
        return cors(json(modeCatalog()), req);
      }
      if (matches("/admin/autoclose") && req.method === "POST") {
        return cors(await handleAutoclose(req), req);
      }

      // Not an admin route  - let the caller (transport / outer server)
      // decide what to do (typically: 404 or upgrade-to-WS).
      return undefined;
    },
  };

  /** Bearer-token gate. Returns a deny Response, or null when allowed.
   *  - token configured -> require a matching Bearer (constant-time);
   *  - no token + requireAuth (prod) -> fail closed (403);
   *  - no token + !requireAuth (dev) -> open. */
  function authGate(req: Request): Response | null {
    if (cfg.authToken) {
      const got = bearerToken(req);
      if (!got || !tokenMatches(got, cfg.authToken)) {
        return json({ error: "unauthorized" }, 401);
      }
      return null;
    }
    if (cfg.requireAuth) {
      return json({ error: "admin auth required  - set an admin token (OPEN_RGS_ADMIN_TOKEN)" }, 403);
    }
    return null;
  }

  function cors(res: Response, req: Request): Response {
    // Never wildcard  - these routes move money and expose balances. Echo the
    // request origin only when it's on the configured allowlist; otherwise
    // send no CORS headers (server-to-server / same-origin only).
    const origin = req.headers.get("origin");
    if (origin && cfg.allowedOrigins?.includes(origin)) {
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Vary", "Origin");
      res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    return res;
  }

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
      // Debited-but-unclosed rounds. A growing count / age is the signal that
      // abandoned rounds aren't being autoclosed (audit M6 / M7).
      ...sessions.openRoundStats(Date.now()),
      math,
    };
  }

  function logs(url: URL) {
    const level = url.searchParams.get("level") as "debug" | "info" | "warn" | "error" | "fatal" | null;
    // A non-numeric ?limit gives Number(...) === NaN -> getRecent(NaN). Clamp
    // to a sane default/range instead. (L5)
    const raw = Number(url.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 500) : 200;
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

// -- Legacy separate-port mode ----------------------------------------

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

// -- Helpers ----------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Extract a `Bearer <token>` value from the Authorization header. */
function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/** Constant-time token comparison (compares fixed-length SHA-256 digests so
 *  neither the result nor the token length leaks via timing). */
function tokenMatches(got: string, expected: string): boolean {
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

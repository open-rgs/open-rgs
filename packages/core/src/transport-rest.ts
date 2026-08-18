// REST transport: the same orchestrator, over plain HTTP and JSON.
//
// `binaryTransport` is the default because a slot is a long-lived session with
// a lot of small messages, and a WebSocket carrying msgpack is the right shape
// for that. REST is here for the cases where it is not: a back-office tool, a
// smoke test, a curl in a runbook, an integration that cannot hold a socket
// open, or a client behind something that will not proxy WebSockets.
//
// Three things REST cannot do, and it is better to say so than to pretend.
//
//   1. NO SERVER PUSH. A balance change from the wallet, or the "kick-old"
//      supersede frame, has nowhere to go. `closeConnection` is deliberately
//      not implemented, which downgrades the concurrency policy to "allow" and
//      makes `createServer` warn at boot. Every response carries the current
//      balance instead, so a client that only ever acts on its own responses
//      stays correct; one that expects to be told about someone else's action
//      does not.
//
//   2. NO CONNECTION IDENTITY. Each request stands alone, so there is no
//      socket to bind a session to. The `sid` in the body is the only
//      credential, exactly as it is for the operator's launch URL - which
//      means REST leans harder on that token being a secret than the WebSocket
//      transport does. Do not expose this transport to a context where the sid
//      is casually visible.
//
//   3. NO ORDERING. Two overlapping POSTs from one client can arrive in either
//      order. The orchestrator serialises per session, so this is safe rather
//      than merely unlikely - but a client that fires a spin and an end-round
//      concurrently gets a well-defined outcome it may not have intended.
//
// Routes are one per orchestrator call, POST + JSON throughout:
//
//   POST /session       init
//   POST /spin          simple round
//   POST /round/open    complex round: open
//   POST /round/step    complex round: step
//   POST /round/end     complex round: close  <- the explicit end
//   POST /promo/accept  accept or decline granted free rounds
//   GET  /healthz       liveness

import type {
  ClientTransport, ConnectionMeta, OrchestratorAPI, RGSErrorCode,
} from "@open-rgs/contract";
import { RGSError } from "@open-rgs/contract";
import { log } from "./log.js";
import { clientMessage } from "./error-policy.js";
import { validateRequest } from "./wire-validate.js";

export interface RestTransportOptions {
  port?: number;
  hostname?: string;
  /** Prefix every route, e.g. "/rgs" gives "/rgs/spin". */
  basePath?: string;
  /** Value for `Access-Control-Allow-Origin`. Omit to send no CORS headers at
   *  all, which is the right default for a server-to-server integration. */
  cors?: string;
  /** Max JSON body bytes. Bodies are client-controlled, and the orchestrator
   *  hands `params` straight to math, so this is a real bound rather than
   *  hygiene. Default 64 KiB. */
  maxBodyBytes?: number;
}

/** HTTP status for each error code. Everything the client can fix is a 4xx;
 *  everything it cannot is a 5xx, so a caller can retry on the right ones
 *  without parsing the body. */
const STATUS: Partial<Record<RGSErrorCode, number>> = {
  INVALID_FORMAT: 400,
  DECODE_ERROR: 400,
  MISSING_SESSION: 401,
  SESSION_NOT_FOUND: 404,
  SESSION_INVALID: 401,
  SESSION_IN_USE: 409,
  INSUFFICIENT_BALANCE: 402,
  INVALID_BET: 400,
  INVALID_MODE: 400,
  INVALID_ACTION: 400,
  INVALID_ROUND: 409,
  ROUND_ALREADY_OPEN: 409,
  NO_ROUND_OPEN: 409,
  PLATFORM_UNAVAILABLE: 503,
  MATH_TIMEOUT: 504,
};

function statusFor(code: RGSErrorCode): number {
  return STATUS[code] ?? 500;
}

export function restTransport(opts: RestTransportOptions = {}): ClientTransport {
  const base = (opts.basePath ?? "").replace(/\/$/, "");
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let inFlight = 0;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(opts.cors ? { "access-control-allow-origin": opts.cors } : {}),
  });

  const fail = (code: RGSErrorCode, message: string): Response =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status: statusFor(code),
      headers: headers(),
    });

  return {
    async start(api: OrchestratorAPI): Promise<{ port: number }> {
      // Connection identity over REST is the session id, and nothing else.
      //
      // A per-request id would make every call look like a new connection
      // arriving on a session still bound to the previous one, and nothing
      // ever detaches: REST has no socket to close, so `onDisconnect` never
      // runs. `concurrencyPolicy: "reject-new"` would then refuse every
      // request after the first, permanently, for the same player. Keying on
      // the sid makes a player's own repeat requests one connection, while a
      // genuine second connection (a WebSocket holding the session) is still a
      // different one and the policy still applies.
      let anon = 0;
      const metaFor = (sid: string | undefined): ConnectionMeta =>
        ({ connectionId: sid ? `rest:${sid}` : `rest-anon-${++anon}`, sessionId: sid }) as ConnectionMeta;

      const route = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
        const sid = typeof body["sid"] === "string" ? body["sid"] : undefined;
        const conn = metaFor(sid);
        // The body is client-controlled and reaches math (`params`), the
        // session store (`sid`) and the wallet adapter. Check its shape here
        // rather than casting and hoping.
        switch (path) {
          case "/session":      return api.init(validateRequest("init", body), conn);
          case "/spin":         return api.spin(validateRequest("spin", body), conn);
          case "/round/open":   return api.openRound(validateRequest("open", body), conn);
          case "/round/step":   return api.stepRound(validateRequest("step", body), conn);
          case "/round/end":    return api.closeRound(validateRequest("close", body), conn);
          case "/promo/accept": return api.promoAccept(validateRequest("promo", body), conn);
          default:              return undefined;
        }
      };

      server = Bun.serve({
        port: opts.port ?? 0,
        hostname: opts.hostname,
        fetch: async (req) => {
          const url = new URL(req.url);
          const path = base && url.pathname.startsWith(base)
            ? url.pathname.slice(base.length) || "/"
            : url.pathname;

          if (req.method === "OPTIONS" && opts.cors) {
            return new Response(null, {
              status: 204,
              headers: { ...headers(), "access-control-allow-headers": "content-type" },
            });
          }
          if (path === "/healthz") return new Response("ok", { status: 200 });
          if (req.method !== "POST") return fail("INVALID_FORMAT", "use POST");

          // Bound the body before reading it. `params` reaches the math, so an
          // unbounded body is a real cost rather than a theoretical one.
          const declared = Number(req.headers.get("content-length") ?? "0");
          if (declared > maxBody) {
            return fail("INVALID_FORMAT", `body exceeds ${maxBody} bytes`);
          }
          // Read as BYTES. `String.length` counts UTF-16 units, so a body of
          // multibyte characters passed a byte limit it was three times over -
          // and a chunked request carries no content-length to pre-check at
          // all, so this is the only bound that always runs.
          const bytes = new Uint8Array(await req.arrayBuffer());
          if (bytes.byteLength > maxBody) {
            return fail("INVALID_FORMAT", `body exceeds ${maxBody} bytes`);
          }
          const raw = new TextDecoder().decode(bytes);

          let body: Record<string, unknown>;
          try {
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            return fail("DECODE_ERROR", "body is not valid JSON");
          }
          if (typeof body !== "object" || body === null || Array.isArray(body)) {
            return fail("INVALID_FORMAT", "body must be a JSON object");
          }

          const ref = crypto.randomUUID();
          inFlight++;
          try {
            const result = await route(path, body);
            if (result === undefined) return fail("INVALID_FORMAT", `unknown route ${path}`);
            return new Response(JSON.stringify(result), { status: 200, headers: headers() });
          } catch (e) {
            if (e instanceof RGSError) {
              // Codes that wrap upstream detail are logged and genericized -
              // the same policy the binary transport applies, now shared
              // (error-policy.ts) so the two wires cannot drift apart again.
              const safe = clientMessage(e.code, e.message, ref);
              if (safe !== e.message) {
                log.exception("restTransport: opaque error", e, {
                  "event.category": "transport",
                  "event.action": "rest_opaque_error",
                  "http.path": path,
                  "error.code": e.code,
                  "correlation.id": ref,
                });
              }
              return fail(e.code, safe);
            }
            log.error("restTransport: unhandled error", {
              "event.category": "transport",
              "event.action": "rest_unhandled",
              "http.path": path,
              "error.message": e instanceof Error ? e.message : String(e),
              "correlation.id": ref,
            });
            // Never leak internal detail to a client - the message may wrap a
            // stack, a file path, or an upstream response body.
            return fail("INTERNAL_ERROR", `internal error (ref: ${ref})`);
          } finally {
            inFlight--;
          }
        },
      });

      const port = server.port ?? 0;
      log.info("REST transport listening", {
        "event.category": "transport",
        "event.action": "rest_start",
        "server.port": port,
        "url.path": base || "/",
      });
      return { port };
    },

    async stop(stopOpts?: { drainMs?: number }): Promise<void> {
      server?.stop();
      const drain = stopOpts?.drainMs ?? 0;
      if (drain > 0) {
        const deadline = Date.now() + drain;
        while (inFlight > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      server = undefined;
    },

    // closeConnection is deliberately absent. There is no socket to close, so
    // implementing it as a no-op would let "kick-old" silently do nothing.
    // Leaving it off makes createServer warn at boot instead.
  };
}

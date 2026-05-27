// HTTP JSON-RPC helper for adapters whose upstream is REST instead of WS.
//
// Keeps to fetch() so it runs in Bun, Node, browser, Cloudflare Workers.
// Auth header is set once at construction; retries are linear (no
// exponential backoff for HTTP — the server should give meaningful
// status codes, and we don't want to mask sticky outages).
//
// What you get:
//   • request(method, body) → Promise<result>
//   • Standard JSON content negotiation
//   • Per-call timeout via AbortSignal
//   • Diagnostics counters
//   • Optional retry on 5xx with caller-controlled backoff
//
// What you bring:
//   • baseUrl, headers, body shaping if non-trivial

import type { DiagnosticsHandle } from "./diagnostics.js";

export interface HttpClientOptions {
  /** Base URL — methods are appended as path segments unless `pathFor` overrides. */
  baseUrl: string;
  /** Static headers (auth tokens, X-Game-Id, etc). Merged with per-call headers. */
  headers?: Record<string, string>;
  /** Per-call deadline. Default 8s. */
  timeoutMs?: number;
  /** Retry budget for 5xx + network errors. Default 0 (off). */
  retries?: number;
  /** Backoff (ms) between retries; receives attempt (0-indexed). Default 200ms × attempt. */
  retryDelayMs?: (attempt: number) => number;
  /** Map a method name into a URL path. Default: append "/<method>" to baseUrl. */
  pathFor?: (method: string) => string;
  /** Diagnostics handle. Counters updated automatically. */
  diagnostics?: DiagnosticsHandle;
  /** Optional fetch override (test injection). Narrow type so test
   *  doubles don't need to implement the full Bun/Node fetch surface. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class HttpClient {
  private fetchImpl: FetchLike;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Issue a POST <baseUrl>/<method> with body=JSON. Throws on non-2xx
   *  after retries; returns the parsed JSON body otherwise. */
  async request<T = unknown>(method: string, body: unknown): Promise<T> {
    const path  = this.opts.pathFor ? this.opts.pathFor(method) : `/${method}`;
    const url   = this.opts.baseUrl.replace(/\/+$/, "") + path;
    const retries = this.opts.retries ?? 0;
    const delay   = this.opts.retryDelayMs ?? ((n: number) => (n + 1) * 200);
    const timeoutMs = this.opts.timeoutMs ?? 8_000;

    this.opts.diagnostics?.noteRpcStart();

    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);

      // Network-layer try: only fetch() can throw here. HTTP-status
      // errors are surfaced after we have a Response in hand, so they
      // don't get caught + retried as if they were network failures.
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.opts.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(t);
        if (isAbort(e)) {
          this.opts.diagnostics?.noteRpcDone(false);
          throw new Error(`HTTP ${method} timed out after ${timeoutMs}ms`);
        }
        lastErr = e;
        if (attempt < retries) {
          await sleep(delay(attempt));
          continue;
        }
        this.opts.diagnostics?.noteRpcDone(false);
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      }
      clearTimeout(t);

      if (res.status >= 500 && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status} from ${method} (will retry)`);
        await sleep(delay(attempt));
        continue;
      }
      if (!res.ok) {
        let detail = "";
        try { detail = await res.text(); } catch { /* swallow */ }
        this.opts.diagnostics?.noteRpcDone(false);
        throw new Error(`HTTP ${res.status} from ${method}: ${detail.slice(0, 200)}`);
      }
      const json = await res.json() as T;
      this.opts.diagnostics?.noteRpcDone(true);
      return json;
    }
    // Reached only if every attempt was a 5xx that triggered `continue`.
    this.opts.diagnostics?.noteRpcDone(false);
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
}

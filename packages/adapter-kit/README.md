# @open-rgs/adapter-kit

Toolkit for building PlatformAdapter implementations. Pluck the
boilerplate every adapter needs into a peer package; let each
adapter focus on what's actually different about its upstream.

## What's in it

| Module | Use it when |
|---|---|
| `WsClient`         | Upstream is a persistent WebSocket (most slot platforms). Handles reconnect-with-backoff, correlation-id RPC, event fanout, diagnostics. |
| `HttpClient`       | Upstream is REST. Per-call timeout, optional retries on 5xx, header injection. fetch-based; runs in Bun / Node / Workers. |
| `ErrorMap`         | Translate vendor error strings into the contract's `RGSErrorCode` set. First match wins; predicate or regex. |
| `createDiagnostics`| Normalised counters (connected, rpcs_in_flight, events_received, …) that drop straight into your adapter's `diagnostics` getter. |

## Use

```ts
import {
  WsClient, ErrorMap, createDiagnostics,
} from "@open-rgs/adapter-kit";
import type { PlatformAdapter } from "@open-rgs/contract";

const errors = new ErrorMap()
  .when(/balance.*low/i,  "INSUFFICIENT_BALANCE")
  .when(/session.*expir/i, "SESSION_INVALID")
  .when(/dedup.*key/i,     "INTERNAL_ERROR")
  .otherwise(             "INTERNAL_ERROR");

const diag = createDiagnostics({
  adapter:  "myplatform",
  version:  "0.1.0",
  gameId:   "lucky-digits",
  endpoint: process.env.MYPLATFORM_WS_URL!,
});

const handlers: ((e: PlatformEvent) => void)[] = [];

const ws = new WsClient({
  url: process.env.MYPLATFORM_WS_URL!,
  diagnostics: diag,
  encodeRequest: (corrId, method, params) =>
    JSON.stringify({ id: corrId, op: method, args: params }),
  decodeFrame: (raw) => {
    const f = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    if (f.kind === "response")   return { kind: "resp",  corrId: f.id, result: f.data, error: f.err };
    if (f.kind === "event")      return { kind: "event", event: toPlatformEvent(f) };
    return { kind: "ignore" };
  },
  onEvent: (e) => { for (const h of handlers) h(e as PlatformEvent); },
});

// Implement PlatformAdapter on top:
export class MyPlatformAdapter implements PlatformAdapter {
  async connect()    { await ws.connect(); }
  disconnect()       { ws.close(); }
  get isHealthy()    { return ws.isConnected; }
  get diagnostics()  { return diag.snapshot(); }
  onEvent(h)         { handlers.push(h); }

  async openSession(sid, conn) {
    try { return await ws.request("openSession", { sid, conn }) as SessionInfo; }
    catch (e) { throw errors.translate(e); }
  }
  async settleSimple(req)  { return await ws.request("settleSimple", req) as RoundReceipt; }
  async openComplex(req)   { return await ws.request("openComplex",  req) as RoundReceipt; }
  async closeComplex(req)  { return await ws.request("closeComplex", req) as RoundReceipt; }
}
```

That's an ~80-line adapter. The kit handles the rest.

## HTTP variant

```ts
import { HttpClient } from "@open-rgs/adapter-kit";

const http = new HttpClient({
  baseUrl: "https://platform.example/api/v1",
  headers: { "x-game-id": "g1", authorization: `Bearer ${token}` },
  retries: 2,
  diagnostics: diag,
});

// Inside settleSimple:
return await http.request<RoundReceipt>("settleSimple", req);
```

Events on HTTP platforms typically arrive via SSE, long-poll, or a
separate WS — the kit doesn't standardise that yet, but `WsClient` is
fine for the event channel even when RPC is HTTP.

## Tests

```bash
bun install
bun test    # 18 cases — ErrorMap, Diagnostics, HttpClient
```

`WsClient` is covered by the `@open-rgs/adapter-test-kit` conformance
suite (against a real fake-WS fixture) since unit-testing it
standalone requires a WS server.

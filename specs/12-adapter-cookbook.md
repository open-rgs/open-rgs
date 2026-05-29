# Spec 12 — Adapter cookbook

Patterns for writing a `PlatformAdapter` against a new upstream. The
contract is one interface (`PlatformAdapter` from `@open-rgs/contract`);
this doc maps real-world platform shapes to the patterns the kit
already provides.

Use it like this: when a new vendor spec lands, find the row whose
"upstream shape" matches → use the helper in the "use" column → drop
into the matching skeleton in the appendix.

---

## Quick-pick table

| Upstream shape                                | Use                            | Notes                                                                       |
|-----------------------------------------------|--------------------------------|------------------------------------------------------------------------------|
| Persistent WS, JSON frames, correlation-id RPC | `WsClient` (adapter-kit)       | The most common wallet shape; the kit's `WsClient` covers nearly all of it. |
| Persistent WS, binary frames (msgpack / proto) | `WsClient` + your `encodeRequest`/`decodeFrame` | Same as above; do the binary codec inside the callbacks. |
| REST endpoints (POST per call), polled events  | `HttpClient` + a small poller   | Most legacy operator APIs. See "REST + polled events" skeleton.            |
| REST endpoints + SSE event channel             | `HttpClient` + EventSource      | Common in newer aggregators. See "REST + SSE" skeleton.                    |
| REST endpoints + WS event channel              | `HttpClient` + `WsClient` (events only) | Two-channel design. Money over REST, events over WS.                    |
| Sequence-numbered upstream (must replay missed) | Wrap `WsClient`; track lastSeq | Don't fight it — accept a `lastSeq` extra in diagnostics and replay on reconnect. |
| No FRC                                         | Implement methods without FRC fields | Return `frc: undefined` on openSession; never set `frcCampaignId` on round calls. |
| No `updateComplex` (no audit checkpoint)       | Omit the method                | It's optional in the contract; orchestrator falls back silently.            |
| No carry / nextMode persistence                | Implement openSession to always return `carry: undefined` | Orchestrator handles the absence. Math files that need carry will see a fresh start each session. |
| Throttled / rate-limited platform              | `HttpClient` + add token-bucket wrapper | Adapter-kit doesn't ship a bucket yet — TODO.                          |
| Pay-per-action billing model                   | Same as standard but flag in `diagnostics.extras` | Use `diag.setExtra("billing.bytes_out", n)` so it surfaces on `/healthz`. |

---

## Standard checklist for any adapter

1. **Identify the call mapping.** What's the platform's name for
   `openSession` / `settleSimple` / `openComplex` / `closeComplex` /
   `updateComplex`? Write them in a comment at the top of `index.ts`.
2. **Identify the event mapping.** Which upstream events translate to
   `balanceChanged` / `sessionClosed` / `promoGranted` /
   `autocloseRequested`? (Use the exact `PlatformEvent.type` strings — an
   unknown type is dropped; `promoGranted`, not `campaignGranted`.)
3. **Identify the error vocabulary.** Build a single
   [`ErrorMap`](../packages/adapter-kit/src/error-map.ts) at construct
   time mapping vendor codes/messages to `RGSErrorCode`.
4. **Identify the transport.** WS? HTTP? Both? Pick the matching kit
   helper from the table above.
5. **Implement the 7-method `PlatformAdapter`.** Most adapters end up
   ~150 lines of code (kit handles the rest).
6. **Run conformance:**
   ```ts
   import { runConformance, mdConformanceReport } from "@open-rgs/adapter-test-kit";
   const r = await runConformance(new MyAdapter(...));
   console.log(mdConformanceReport(r));
   ```
   Fail your CI if `r.summary.fail > 0`.

---

## Skeleton: WS + correlation-id RPC

This is the most common wallet shape — the kit's `WsClient` does ~all of it.

```ts
import { WsClient, ErrorMap, createDiagnostics, type Decoded } from "@open-rgs/adapter-kit";
import type { PlatformAdapter, PlatformEvent, /* ... */ } from "@open-rgs/contract";

export class MyAdapter implements PlatformAdapter {
  private readonly ws: WsClient;
  private readonly errors = new ErrorMap()
    .when(/insufficient/i, "INSUFFICIENT_BALANCE")
    .otherwise("INTERNAL_ERROR");
  private readonly diag = createDiagnostics({ adapter: "vendor-x", version: "0.1.0" });
  private readonly handlers: ((e: PlatformEvent) => void)[] = [];

  constructor(opts: { wsUrl: string; gameId: string }) {
    this.ws = new WsClient({
      url: opts.wsUrl,
      diagnostics: this.diag,
      encodeRequest: (corrId, method, params) =>
        JSON.stringify({ id: corrId, op: method, args: params }),
      decodeFrame: (raw): Decoded => {
        const f = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        if (f.kind === "response") {
          return f.err
            ? { kind: "resp", corrId: f.id, error: { message: f.err } }
            : { kind: "resp", corrId: f.id, result: f.data };
        }
        if (f.kind === "push")     return { kind: "event", event: toPlatformEvent(f) };
        return { kind: "ignore" };
      },
      onEvent: (e) => { for (const h of this.handlers) h(e as PlatformEvent); },
    });
  }

  async connect()    { await this.ws.connect(); }
  disconnect()       { this.ws.close(); }
  get isHealthy()    { return this.ws.isConnected; }
  get diagnostics()  { return this.diag.snapshot(); }
  onEvent(h)         { this.handlers.push(h); }

  async openSession(sid, conn) {
    try { return await this.ws.request("session.open", { sid, conn }) as SessionInfo; }
    catch (e) { throw this.errors.translate(e); }
  }
  async settleSimple(req) { return await this.ws.request("round.simple", req); }
  async openComplex(req)  { return await this.ws.request("round.open",   req); }
  async closeComplex(req) { return await this.ws.request("round.close",  req); }
}
```

---

## Skeleton: REST + polled events

When the platform is HTTP-only and pushes events via long-poll or "GET
since=N" — common with older operators and most aggregators.

```ts
import { HttpClient, createDiagnostics } from "@open-rgs/adapter-kit";

export class MyAdapter implements PlatformAdapter {
  private readonly http: HttpClient;
  private readonly diag = createDiagnostics({ adapter: "rest-vendor", version: "0.1.0" });
  private readonly handlers: ((e: PlatformEvent) => void)[] = [];
  private pollerHandle: ReturnType<typeof setInterval> | undefined;
  private lastEventSeq = 0;

  constructor(opts: { baseUrl: string; token: string; pollIntervalMs?: number }) {
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      headers: { authorization: `Bearer ${opts.token}` },
      retries: 2,
      diagnostics: this.diag,
    });
    this.pollMs = opts.pollIntervalMs ?? 1_000;
  }

  async connect()    { this.diag.noteConnect(); this.startPolling(); }
  disconnect()       { this.stopPolling(); this.diag.noteDisconnect(); }
  get isHealthy()    { return this.pollerHandle != null; }
  get diagnostics()  { return this.diag.snapshot(); }
  onEvent(h)         { this.handlers.push(h); }

  async openSession(sid, conn)  { return await this.http.request("openSession", { sid, conn }); }
  async settleSimple(req)       { return await this.http.request("settleSimple", req); }
  async openComplex(req)        { return await this.http.request("openComplex",  req); }
  async closeComplex(req)       { return await this.http.request("closeComplex", req); }

  private startPolling() {
    this.pollerHandle = setInterval(async () => {
      try {
        const r = await this.http.request<{ events: { seq: number; event: PlatformEvent }[] }>(
          "events.since", { seq: this.lastEventSeq });
        for (const item of r.events) {
          this.lastEventSeq = Math.max(this.lastEventSeq, item.seq);
          this.diag.noteEvent();
          for (const h of this.handlers) h(item.event);
        }
        this.diag.setExtra("events.last_seq", this.lastEventSeq);
      } catch (e) {
        // Log but keep polling — single failures shouldn't tear us down.
      }
    }, this.pollMs);
  }
  private stopPolling() {
    if (this.pollerHandle) { clearInterval(this.pollerHandle); this.pollerHandle = undefined; }
  }
}
```

---

## Skeleton: REST + SSE events

Like the polled version but the events come from a Server-Sent Events
channel. Lower latency, no polling cost.

```ts
constructor(opts: { baseUrl: string; eventsUrl: string; token: string }) {
  // ...HttpClient as above...
  this.es = new EventSource(opts.eventsUrl, { withCredentials: true });
  this.es.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data) as PlatformEvent;
      this.diag.noteEvent();
      for (const h of this.handlers) h(parsed);
    } catch { /* malformed; ignore */ }
  };
  this.es.onerror = () => { /* EventSource auto-reconnects */ };
}
```

---

## Skeleton: REST RPC + WS events

Money over REST (clean idempotency, retry-friendly); events over WS
(low-latency push). Two adapter-kit helpers in one class.

```ts
constructor(opts) {
  this.http = new HttpClient({ baseUrl: opts.restUrl, diagnostics: this.diag });
  this.eventsWs = new WsClient({
    url: opts.wsUrl,
    diagnostics: this.diag,
    encodeRequest: () => "",   // never used; we don't RPC over WS
    decodeFrame: (raw) => {
      const f = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      return { kind: "event", event: f };
    },
    onEvent: (e) => { for (const h of this.handlers) h(e as PlatformEvent); },
  });
}
```

---

## Common adaptations

### Carry-less platforms

Some operators don't persist per-session math state. The adapter just
returns `carry: undefined` from `openSession` every time. The math
files that depend on carry will see a fresh start; if that matters for
their RTP, they should either not be deployed to that platform or
declare RTP under the no-carry assumption.

### FRC-less platforms

Similar: omit `promo` from `openSession` results, ignore `promoId`
on round calls, and don't emit `promoGranted` events. The
orchestrator handles the absence — free rounds just aren't offered to players.

### Sequence-numbered upstream

If the platform requires every outbound RPC to carry a monotonic
sequence number (and rejects out-of-order), wrap `WsClient.request`:

```ts
private seq = 0;
private async seqRequest(method: string, params: unknown) {
  this.seq += 1;
  return this.ws.request(method, { ...(params as object), seq: this.seq });
}
```

Persist `seq` to local file (or hold it in `diag.extras`) so reconnect
resumes from the right number.

### Rate-limited upstream

The kit doesn't yet ship a token-bucket. If the platform caps you at
e.g. 50 RPS, write a small queue in front of `http.request`:

```ts
private queue: Array<() => Promise<unknown>> = [];
private async throttle<T>(fn: () => Promise<T>): Promise<T> {
  // your bucket logic here
  return fn();
}
```

When you hit a platform that needs this, lift it into adapter-kit.

### Two-step settlement

Some platforms split settle into "reserve" then "commit". Map both
into a single `settleSimple` call — do the reserve, then the commit,
inside the same method. Idempotency keys cover the retry case.

---

## What the conformance suite does NOT check

These are real concerns that fall outside `runConformance(adapter)` —
add adapter-specific tests for them:

- Idempotency dedupe on the upstream side (kit-only assertion is "the
  key field is passed; upstream behaviour with it is the upstream's
  problem")
- Currency precision edge cases (kit assumes integer minor units)
- Concurrent open rounds for the same session (the kit's fixture is
  single-session, single-round)
- Bet ladder boundary enforcement (orchestrator enforces; kit doesn't
  exercise)
- Network resilience under specific failure modes (use chaos tests)

---

## Where this doc fits

Spec 05 (`platform-protocol`) defines WHAT the contract is. Spec 12
(this doc) explains HOW to satisfy it across the platform shapes that
actually exist. When a new vendor spec lands, add a short writeup
under `specs/adapters/<vendor>.md` analysing it; if a pattern recurs,
fold it into this cookbook.

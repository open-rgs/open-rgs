// Test fixture: a worker that spins a tight SYNCHRONOUS loop forever, bumping a
// shared counter so the main thread can observe whether it is still executing.
// This is the canonical "runaway" the math pool must be able to kill - a tight
// sync loop can't be interrupted any other way (JS can't preempt it in-thread).
declare const self: { onmessage: ((e: { data: SharedArrayBuffer }) => void) | null };

self.onmessage = (e: { data: SharedArrayBuffer }): void => {
  const counter = new Int32Array(e.data);
  for (;;) Atomics.add(counter, 0, 1); // never yields, never returns
};

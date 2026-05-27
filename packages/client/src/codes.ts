// Wire frame codes — must match packages/core/src/transport-binary.ts.
// Kept as a separate file so a future codegen tool can emit it from the
// spec.

export const FRAME = {
  INIT_REQUEST:      0x01,
  INIT_RESPONSE:     0x02,
  SPIN_REQUEST:      0x03,
  SPIN_RESPONSE:     0x04,
  OPEN_REQUEST:      0x05,
  OPEN_RESPONSE:     0x06,
  STEP_REQUEST:      0x07,
  STEP_RESPONSE:     0x08,
  CLOSE_REQUEST:     0x09,
  CLOSE_RESPONSE:    0x0a,
  PROMO_ACCEPT:      0x0b,
  PROMO_ACCEPT_RESP: 0x0c,
  PING:              0xfe,
  PONG:              0xfd,
  ERROR:             0xff,
} as const;

export type FrameCode = typeof FRAME[keyof typeof FRAME];

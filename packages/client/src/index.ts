// @open-rgs/client public surface.

export { RgsClient, RgsServerError, type RgsClientOptions } from "./client.js";
export { FRAME, type FrameCode } from "./codes.js";
export {
  UniversalClient, describeRound,
  type UniversalOptions, type RoundResult, type Step,
} from "./universal.js";

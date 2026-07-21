/**
 * Public barrel for the OEMS order system.
 *
 * Every BFF route + every future order-entry consumer should import from
 * `@/lib/orders`, never reach into the individual files. This keeps the
 * preflight + submit + force-correction contract in one place.
 */

export type {
  BulkViolation,
  CashAvailabilityLite,
  OrderSide,
  OrderSource,
  PreflightCode,
  PreflightInput,
  PreflightResult,
  PreflightVerdict,
  SellAvailabilityLite,
  SubmitInput,
  SubmitResult,
} from "@/lib/orders/types";

export { preflight } from "@/lib/orders/preflight";
export {
  openSupabaseClients,
  submitOrder,
  type SubmitOrderOptions,
} from "@/lib/orders/submit";

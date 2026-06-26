/**
 * Master switch for the IRESS price overlay (read by the web app / BFFs).
 *
 * During the UAT phase the IRESS endpoint returns TEST prices, not the live
 * market (e.g. EXX R145 vs the real R202). So `IRESS_PRICE_OVERLAY=0` tells the
 * app to ignore IRESS quotes everywhere and show the Yahoo price instead, which
 * is the accurate live source until production IRESS is contracted. At the prod
 * cutover, set it back to `1` (or unset) and IRESS becomes the live price source
 * automatically. Default ON so nothing changes unless explicitly disabled.
 *
 * This gates the READ side (the overlays in iress.ts, /api/equities, and
 * live-queries). The WRITE side is gated separately by `IRESS_RETAIL_DRY_RUN` on
 * the worker, so during UAT the worker also stops writing test prices.
 */
export function iressPriceOverlayEnabled(): boolean {
  return process.env.IRESS_PRICE_OVERLAY !== "0";
}

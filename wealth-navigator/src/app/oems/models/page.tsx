import { ModelsList } from "./models-list";

export const dynamic = "force-dynamic";

/**
 * /oems/models : quant-model registry.
 *
 * Models run in local Docker (Lumibot / DuckDB / Yahoo-fed paper-sim) and push
 * their registry, metrics, equity curve, predictions, positions and trades into
 * the INSTITUTIONAL model_*_c tables. This tab reads them alongside the app's
 * IRESS/Yahoo market data. Auth is enforced by the OEMS middleware + BFF.
 */
export default function Page() {
  return <ModelsList />;
}

import { publishEodReturns } from "../src/lib/returns/publish-eod-returns";

const asOfDate = process.env.EOD_RETURN_RECOVERY_DATE;
if (!asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
  throw new Error("EOD_RETURN_RECOVERY_DATE=YYYY-MM-DD is required");
}

const apply = process.env.APPLY_EOD_RETURN_RECOVERY === "1";
const result = await publishEodReturns({ asOfDate, apply });
console.log(JSON.stringify(result, null, 2));

if (!result.ok || result.summary.failed > 0) process.exitCode = 1;

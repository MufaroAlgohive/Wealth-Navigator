import { publishCanonicalLedgerDraft } from "../src/lib/returns/publish-canonical-ledger-draft";

const result = await publishCanonicalLedgerDraft({
  asOfDate: process.env.CANONICAL_LEDGER_AS_OF?.trim() || undefined,
  apply: process.env.APPLY_CANONICAL_LEDGER_DRAFT === "1",
  replaceExistingDraft: process.env.REPLACE_EXISTING_CANONICAL_DRAFT === "1",
});

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

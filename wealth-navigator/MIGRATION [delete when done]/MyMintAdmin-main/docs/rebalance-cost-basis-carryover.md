# Rebalance Cost Basis — Carryover vs No-Carryover

A note on how MyMint records the cost basis of new positions created by a rebalance, and the trade-off between two valid approaches.

---

## Background

When a rebalance sells one security and buys another for a user, the new position has to be recorded somewhere. The question is: **what avg_fill (cost basis) do we write on the new holding row?**

Two valid models — both arithmetically correct, both report the same total wealth change, but they distribute that wealth differently across the user's positions.

---

## Worked example

Take a user **MF** who originally bought **4 ABS shares at R220.75 each** (total cost: R883).

Today the market price of ABS is **R230.75**, so:

- Current value: 4 × R230.75 = R923
- Unrealized PnL: +R40 (or +R10 per share)

A rebalance triggers — sell 3 of those 4 ABS, use the proceeds to buy **2 ARI at R221.98** (the remaining 1 ABS stays put).

After fees:
- 3 ABS sold at R230.75 → R692.25 gross
- 2 ARI bought at R221.98 → R443.96
- Brokerage + custody fees consume R143.68
- Cash residual to wallet: **R104.61**

The user's total wealth changes by exactly the fees (−R143.68). The rebalance itself is otherwise neutral.

---

## Model 1: Cost basis carryover

**Idea:** The cost basis of the sold shares "follows" the user to the new asset. Their unrealized gain travels with them instead of being banked as cash.

**Formula:**
```
new_avg_fill_per_share = (sold_qty × old_avg_fill_per_share) / new_qty
```

For MF:
- Sold 3 ABS at original cost R220.75 → R662.25 of cost basis carried over
- Spread across 2 new ARI → R331.13 cost basis per ARI share

The 2 ARI are now recorded as if MF paid R331.13/share, even though the actual market trade was R221.98/share.

**What the user sees on their statement:**

| Position | Cost | Market | Unrealized PnL |
|---|---|---|---|
| 1 ABS | R220.75 | R230.75 | +R10 |
| 2 ARI | R331.13 | R221.98 | **−R218.29** |
| Cash residual | — | — | R104.61 |
| **Total change** | | | **−R103.68** (= fees only) |

The −R103.68 total reflects the fees exactly — the rebalance preserved the user's wealth otherwise.

### Pros

- **Gain follows the user across the swap.** The +R30 unrealized gain MF had on the sold portion of ABS isn't lost — it lives on inside ARI's cost basis.
- **Mathematically clean for full reinvestment.** When `sold_qty == bought_qty` and prices are similar, the carried basis works beautifully — gains transfer 1:1 between assets.
- **Common in fund accounting.** Pooled fund vehicles where the investor's stake is rebalanced internally typically carry basis to preserve a continuous PnL view.

### Cons

- **"Phantom loss" when share count drops.** Selling 3 of 4 ABS but only buying 2 ARI means R662.25 of cost gets crammed onto 2 shares — inflating per-share cost from R220.75 to R331.13. The ARI position then *looks* like a −R218 loser even though MF just bought it at market.
- **The phantom loss is offset by cash in the wallet.** When the user reads their *total* (positions + wallet), the numbers reconcile. But a user looking at the individual ARI row sees a confusing red number.
- **Doesn't match real-world purchase price.** The "cost basis" recorded is a synthetic accounting number, not what MF actually paid. This complicates tax reporting and any external audit.

---

## Model 2: No carryover (clean buy)

**Idea:** Each side of the rebalance is treated as a separate event. Selling realizes the gain into cash. Buying records the new asset at the actual market price paid.

**Formula:**
```
new_avg_fill_per_share = market_buy_price
```

For MF, the 2 ARI are recorded at R221.98/share (what he actually paid).

**What the user sees on their statement:**

| Position | Cost | Market | Unrealized PnL |
|---|---|---|---|
| 1 ABS | R220.75 | R230.75 | +R10 |
| 2 ARI | R221.98 | R221.98 | R0 (just bought) |
| Cash residual | — | — | R104.61 |
| Realized PnL on the rebalance | | | +R30 from ABS sale |
| **Total change** | | | **−R103.68** (= fees only) |

Same total. The R30 realized gain from selling 3 ABS at +R10/share lives in the cash residual (R104.61 includes that gain plus the principal returned minus buy cost minus fees).

### Pros

- **Honest cost basis.** ARI is recorded at exactly the price paid. Easy to explain, easy to audit.
- **No phantom losses.** Each position row shows what the user would expect — newly-bought assets sit at zero unrealized PnL on day one.
- **Standard retail brokerage behavior.** Most platforms an investor has used before (EasyEquities, Standard Bank Online Share Trading, etc.) work this way.
- **Cleaner for tax reporting.** Realized gains are clearly tied to the trade event and don't bleed into future unrealized PnL calculations.

### Cons

- **Realized gains move to "cash" instead of "unrealized."** A user used to seeing a constant unrealized gain on a position might be confused that the gain "disappeared" after a rebalance (it's actually in their wallet now).
- **Doesn't continuously preserve a unified PnL view.** If you want the user to feel like their strategy is a single ongoing investment with one PnL number, the gain getting realized into cash on every rebalance is a step in the wrong direction.

---

## Side-by-side summary

|   | Carryover (Model 1) | No carryover (Model 2) |
|---|---|---|
| New asset's avg_fill | (sold_qty × old_avg_fill) / new_qty | market buy price |
| Total wealth change | identical | identical |
| Unrealized PnL on new asset | Can be misleading (phantom loss) | Honest (starts at 0) |
| Realized PnL on the rebalance | Hidden inside cost basis | Visible in cash residual |
| Tax/audit clarity | Synthetic basis is harder to explain | One-to-one with actual trades |
| Retail user familiarity | Unusual | Standard |
| Fund accounting clarity | Continuous PnL view preserved | PnL "resets" on each rebalance |

---

## Current MyMint decision

**MyMint uses Model 2 — no carryover.**

Rationale:
1. Our investors are retail clients used to seeing each buy as a fresh position
2. Phantom losses (when share count drops in a swap) create more support tickets than the elegant PnL preservation is worth
3. Realized gains landing in `wallets.rebalance_residual` is a feature, not a bug — users can see and use that cash
4. Easier to reconcile against custodial statements (the avg_fill we record matches the actual trade price)

The codebase originally implemented Model 1 (commit `6232f5b`) but reverted to Model 2 after walking through this scenario with leadership.

---

## When we'd reconsider

Model 1 (carryover) would be the right call if:

- We launch a fund-style product where investor experience is "one ongoing investment" rather than discrete positions
- Tax reporting moves to a continuous-cost basis system
- We get explicit user feedback that they want their gains preserved across rebalances on the per-position view (rather than going to cash)

If any of those become true, the code change is small — see `applyBuySettlement` in `public/orderbook.html` and `executeFillAndSettle`'s `carriedAvgFillByUser` logic.

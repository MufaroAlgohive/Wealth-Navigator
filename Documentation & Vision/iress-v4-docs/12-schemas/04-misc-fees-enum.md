# MiscFees Enum (Typed)

> Source for these values: the source PDF's "Explanation of XML fields in `<MiscFees>` tags" section, which lists the FeeType codes and SWIFT qualifiers.

## TypeScript

```ts
export enum MiscFeeType {
  Unknown = 0,
  Regulatory = 1,
  GST = 2,             // named "Tax" in FIX protocol
  LocalCommission = 3,
  ExchangeFees = 4,
  Stamp = 5,
  Levy = 6,
  Other = 7,
  Markup = 8,
  ConsumptionTax = 9,
  PerTransaction = 10,
  Conversion = 11,
  Agent = 12,
  TransferFee = 13,
  SecurityLending = 14,
  Research = 15,
}

export enum MiscFeeBasis {
  Absolute = 0,
  PerUnit = 1,
  Percentage = 2,
}

export enum MiscFeePercentageOf {
  /** Only valid when FeeBasis = Percentage */
  Commission = 0,
  OrderValue = 1,
}

export interface MiscFee {
  Set: 0 | 1;
  FeeType: MiscFeeType;
  FeeBasis: MiscFeeBasis;
  /** Only relevant when FeeBasis = Percentage */
  Properties?: MiscFeePercentageOf;
  /** Calculated fee amount in the booking's currency. */
  FeeAmount: number;
  /** Used by client allocation only. */
  Currency: string;
  /** Configurable via IOS+ Administration. */
  Display: 0 | 1;
  /** SWIFT qualifier (e.g. "REGF", "VATA", "LOCO", "STAM", "LEVY", "OTHR", "COAX"). */
  SWIFTQualifier: string;
}

/** Default SWIFT qualifier map (production defaults; configurable in IOS+ Admin). */
export const MiscFeeSwiftDefault: Record<MiscFeeType, string> = {
  [MiscFeeType.Unknown]: 'OTHR',
  [MiscFeeType.Regulatory]: 'REGF',
  [MiscFeeType.GST]: 'VATA',
  [MiscFeeType.LocalCommission]: 'LOCO',
  [MiscFeeType.ExchangeFees]: 'REGF',
  [MiscFeeType.Stamp]: 'STAM',
  [MiscFeeType.Levy]: 'LEVY',
  [MiscFeeType.Other]: 'OTHR',
  [MiscFeeType.Markup]: 'OTHR',
  [MiscFeeType.ConsumptionTax]: 'COAX',
  [MiscFeeType.PerTransaction]: 'OTHR',
  [MiscFeeType.Conversion]: 'OTHR',
  [MiscFeeType.Agent]: 'OTHR',
  [MiscFeeType.TransferFee]: 'OTHR',
  [MiscFeeType.SecurityLending]: 'OTHR',
  [MiscFeeType.Research]: 'OTHR',
};

/** Calculate the fee amount per the FeeType / FeeBasis / Properties rules. */
export function calcMiscFeeAmount(
  rate: number,
  basis: MiscFeeBasis,
  properties: MiscFeePercentageOf | undefined,
  volume: number,
  price: number,
  commissionValue: number,
): number {
  switch (basis) {
    case MiscFeeBasis.Absolute:
      return rate;
    case MiscFeeBasis.PerUnit:
      return rate * volume;
    case MiscFeeBasis.Percentage:
      if (properties === MiscFeePercentageOf.Commission) return 0.10 * rate * commissionValue;
      if (properties === MiscFeePercentageOf.OrderValue) return 0.10 * rate * (price * volume);
      return 0;
  }
}
```

## See also

- [`../05-services/iosplus/03-bookings.md`](../05-services/iosplus/03-bookings.md) — narrative.
- [`../05-services/iosplus/05-misc-fees-reference.md`](../05-services/iosplus/05-misc-fees-reference.md) — quick reference.

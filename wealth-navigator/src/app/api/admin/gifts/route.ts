import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

const ACTIVE_CLAIM_STATES = new Set(["pending_claim", "pending_registration"]);

const text = (value: unknown): string | null => {
  const result = String(value ?? "").trim();
  return result || null;
};

const number = (value: unknown): number | null => {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

const unique = (values: Array<unknown>): string[] => [
  ...new Set(values.map(text).filter((value): value is string => Boolean(value))),
];

function byId(rows: Row[]): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const id = text(row.id);
    if (id) result.set(id, row);
  }
  return result;
}

function centsToRands(value: unknown): number | null {
  const cents = number(value);
  return cents == null ? null : cents / 100;
}

function profileName(profile: Row | undefined, fallback?: unknown): string | null {
  const full = [text(profile?.first_name), text(profile?.last_name)].filter(Boolean).join(" ");
  return full || text(profile?.full_name) || text(profile?.email) || text(fallback);
}

function publicEvent(row: Row) {
  return {
    id: text(row.id),
    fromStatus: text(row.from_status),
    toStatus: text(row.to_status),
    actor: text(row.actor),
    reason: text(row.reason),
    payload: row.payload && typeof row.payload === "object" ? row.payload : null,
    createdAt: text(row.created_at),
  };
}

function moneyFromClaim(row: Row): number | null {
  const cents = number(row.amount);
  return cents == null ? null : cents / 100;
}

function claimState(status: string | null, expiresAt: string | null) {
  const raw = (status || "unknown").toLowerCase();
  const elapsed = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
  if ((raw === "pending_claim" || raw === "pending_registration") && elapsed) return "expired";
  return raw;
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !isAdminRole(auth.ctx)) {
    return NextResponse.json({ ok: false, error: "Admins only" }, { status: 403 });
  }

  let db: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    db = createRetailServiceRoleClient();
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: (error as Error).message, gifts: [], notices: [] },
      { status: 503 },
    );
  }

  const notices: string[] = [];
  const safeTable = async (table: string, orderColumn = "created_at") => {
    const result = await db.from(table).select("*").order(orderColumn, { ascending: false }).limit(750);
    if (result.error) {
      notices.push(`${table}: ${result.error.message}`);
      return [] as Row[];
    }
    return (result.data ?? []) as Row[];
  };

  const [authorizationRows, claimRows, itemRows, registryRows, contributionRows] = await Promise.all([
    safeTable("gift_authorizations"),
    safeTable("gift_claims"),
    safeTable("gift_registry_items"),
    safeTable("gift_events"),
    safeTable("gift_contributions"),
  ]);
  const itemById = byId(itemRows);
  const registryById = byId(registryRows);

  const authIds = unique(authorizationRows.map((row) => row.id));
  let eventRows: Row[] = [];
  if (authIds.length) {
    const result = await db
      .from("gift_authorization_events")
      .select("*")
      .in("authorization_id", authIds)
      .order("created_at", { ascending: true });
    if (result.error) notices.push(`gift_authorization_events: ${result.error.message}`);
    else eventRows = (result.data ?? []) as Row[];
  }
  const eventsByAuth = new Map<string, ReturnType<typeof publicEvent>[]>();
  for (const row of eventRows) {
    const id = text(row.authorization_id);
    if (!id) continue;
    eventsByAuth.set(id, [...(eventsByAuth.get(id) ?? []), publicEvent(row)]);
  }

  const userIds = unique([
    ...authorizationRows.flatMap((row) => [row.gifter_user_id, row.recipient_user_id]),
    ...claimRows.flatMap((row) => [row.sender_user_id, row.recipient_user_id]),
    ...registryRows.map((row) => row.creator_user_id),
    ...contributionRows.map((row) => row.gifter_user_id),
    ...registryRows
      .filter((row) => text(row.beneficiary_type)?.toUpperCase() === "OTHER")
      .map((row) => row.beneficiary_ref),
  ]);
  let profileRows: Row[] = [];
  if (userIds.length) {
    const result = await db
      .from("profiles")
      .select("id,email,first_name,last_name,mint_number,is_test")
      .in("id", userIds);
    if (result.error) {
      const fallback = await db.from("profiles").select("id,email,first_name,last_name").in("id", userIds);
      if (fallback.error) notices.push(`profiles: ${fallback.error.message}`);
      else profileRows = (fallback.data ?? []) as Row[];
    } else profileRows = (result.data ?? []) as Row[];
  }
  const profileById = byId(profileRows);

  let testWalletRows: Row[] = [];
  if (userIds.length) {
    const result = await db.from("wallets").select("user_id,status").in("user_id", userIds).eq("status", "test");
    if (result.error) notices.push(`wallets test scope: ${result.error.message}`);
    else testWalletRows = (result.data ?? []) as Row[];
  }
  const testWalletUsers = new Set(unique(testWalletRows.map((row) => row.user_id)));
  const isTestUser = (id: unknown) => {
    const userId = text(id);
    return Boolean(userId && (profileById.get(userId)?.is_test === true || testWalletUsers.has(userId)));
  };
  const environmentFor = (...ids: unknown[]) => (ids.some(isTestUser) ? "uat" : "live");

  const familyIds = unique([
    ...authorizationRows.map((row) => row.recipient_family_member_id),
    ...registryRows
      .filter((row) => text(row.beneficiary_type)?.toUpperCase() === "CHILD")
      .map((row) => row.beneficiary_ref),
  ]);
  let familyRows: Row[] = [];
  if (familyIds.length) {
    const result = await db.from("family_members").select("id,first_name,last_name").in("id", familyIds);
    if (result.error) notices.push(`family_members: ${result.error.message}`);
    else familyRows = (result.data ?? []) as Row[];
  }
  const familyById = byId(familyRows);

  const assetKeys = unique([
    ...itemRows.map((row) => row.isin),
    ...claimRows.flatMap((row) => [row.strategy_id, row.security_id, row.security_symbol]),
  ]);
  let strategyRows: Row[] = [];
  const securityRows: Row[] = [];
  if (assetKeys.length) {
    const [strategies, securitiesById, securitiesByIsin, securitiesBySymbol] = await Promise.all([
      db.from("strategies_c").select("id,name,short_name,holdings").in("id", assetKeys),
      db.from("securities_c").select("id,isin,symbol,name,logo_url").in("id", assetKeys),
      db.from("securities_c").select("id,isin,symbol,name,logo_url").in("isin", assetKeys),
      db.from("securities_c").select("id,isin,symbol,name,logo_url").in("symbol", assetKeys),
    ]);
    if (!strategies.error) strategyRows = (strategies.data ?? []) as Row[];
    if (!securitiesById.error) securityRows.push(...((securitiesById.data ?? []) as Row[]));
    if (!securitiesByIsin.error) securityRows.push(...((securitiesByIsin.data ?? []) as Row[]));
    if (!securitiesBySymbol.error) securityRows.push(...((securitiesBySymbol.data ?? []) as Row[]));
  }
  const strategyById = byId(strategyRows);
  const securityByKey = new Map<string, Row>();
  for (const row of securityRows) {
    for (const key of [row.id, row.isin, row.symbol]) {
      const normalized = text(key);
      if (normalized) securityByKey.set(normalized, row);
    }
  }

  const matchedClaimIds = new Set<string>();
  const findClaimForAuthorization = (authorization: Row, item: Row | undefined): Row | undefined => {
    const senderId = text(authorization.gifter_user_id);
    const recipientId = text(authorization.recipient_user_id);
    const assetKey = (text(item?.isin) || "").toLowerCase();
    const createdAt = new Date(text(authorization.created_at) || 0).getTime();
    return claimRows.find((claim) => {
      const claimId = text(claim.id);
      if (!claimId || matchedClaimIds.has(claimId)) return false;
      if (text(claim.sender_user_id) !== senderId) return false;
      if (recipientId && text(claim.recipient_user_id) !== recipientId) return false;
      const claimKeys = [claim.strategy_id, claim.security_id, claim.security_symbol, claim.asset_name]
        .map((value) => (text(value) || "").toLowerCase())
        .filter(Boolean);
      if (
        assetKey &&
        !claimKeys.some((value) => value === assetKey || value.includes(assetKey) || assetKey.includes(value))
      )
        return false;
      const claimCreatedAt = new Date(text(claim.created_at) || 0).getTime();
      return Number.isFinite(createdAt) && Number.isFinite(claimCreatedAt)
        ? Math.abs(claimCreatedAt - createdAt) <= 15 * 60_000
        : true;
    });
  };

  const modernGifts = authorizationRows.map((row) => {
    const id = text(row.id) || crypto.randomUUID();
    const item = itemById.get(text(row.registry_item_id) || "");
    const registry = registryById.get(text(item?.gift_event_id) || "");
    const assetKey = text(item?.isin);
    const strategy = strategyById.get(assetKey || "");
    const security = securityByKey.get(assetKey || "");
    const linkedClaim = findClaimForAuthorization(row, item);
    const linkedClaimId = text(linkedClaim?.id);
    if (linkedClaimId) matchedClaimIds.add(linkedClaimId);
    const recipientProfile = profileById.get(text(row.recipient_user_id) || "");
    const family = familyById.get(text(row.recipient_family_member_id) || "");
    const status = text(row.status)?.toLowerCase() || "unknown";
    const linkedClaimExpiresAt = text(linkedClaim?.expires_at);
    const linkedClaimState = linkedClaim
      ? claimState(text(linkedClaim.status), linkedClaimExpiresAt)
      : status === "filled"
        ? "delivered"
        : status;
    const holdings = Array.isArray(strategy?.holdings) ? strategy.holdings : [];
    return {
      id: `authorization:${id}`,
      recordId: id,
      source: "authorization" as const,
      status,
      claimState: linkedClaimState,
      gifter: {
        id: text(row.gifter_user_id),
        name: profileName(profileById.get(text(row.gifter_user_id) || ""), row.gifter_email),
        email: text(row.gifter_email) || text(profileById.get(text(row.gifter_user_id) || "")?.email),
      },
      recipient: {
        id: text(row.recipient_user_id) || text(row.recipient_family_member_id),
        name: profileName(recipientProfile, row.recipient_display_name) || profileName(family),
        email: text(recipientProfile?.email),
        kind: row.recipient_family_member_id ? "child" : "client",
      },
      asset: {
        type: text(item?.instrument_type)?.toLowerCase() || (strategy ? "basket" : "security"),
        key: assetKey,
        symbol: text(security?.symbol) || (strategy ? text(strategy.short_name) : assetKey),
        name: text(strategy?.name) || text(security?.name) || assetKey || "Unknown asset",
        logoUrl: text(security?.logo_url),
        constituents: holdings,
      },
      registry: registry
        ? {
            id: text(registry.id),
            title: text(registry.title),
            occasion: text(registry.occasion),
            beneficiaryType: text(registry.beneficiary_type),
            status: text(registry.status),
            eventDate: text(registry.event_date),
            expiresAt: text(registry.expiry_at),
          }
        : null,
      quantity: number(row.quantity),
      amountRands: centsToRands(row.paid_amount_cents) ?? centsToRands(row.reserved_amount_cents),
      reservedRands: centsToRands(row.reserved_amount_cents),
      paidRands: centsToRands(row.paid_amount_cents),
      livePriceRands: centsToRands(row.live_price_cents),
      fillPriceRands: centsToRands(row.fill_price_cents),
      priceSource: text(row.price_source),
      driftBps: number(row.drift_bps),
      paymentMethod: text(row.payment_method),
      expiresAt:
        status === "filled" && ACTIVE_CLAIM_STATES.has(linkedClaimState)
          ? linkedClaimExpiresAt
          : text(row.pending_decision_deadline) || text(row.expires_at),
      timestamps: {
        created: text(row.created_at),
        updated: text(row.updated_at),
        authorized: text(row.authorized_at),
        parked: text(row.parked_at),
        working: text(row.working_at),
        filled: text(row.filled_at),
        claimed: text(linkedClaim?.claimed_at),
        cancelled: text(row.cancelled_at),
      },
      references: {
        oemsOrderId: text(row.oems_order_id),
        oemsAuditId: text(row.oems_order_audit_id),
        fillReference: text(row.fill_reference),
        recipientHoldingId: text(row.recipient_holding_id),
        claimId: linkedClaimId,
      },
      environment: environmentFor(row.gifter_user_id, row.recipient_user_id),
      execution: {
        reachedOrderBook: Boolean(row.oems_order_audit_id || row.oems_order_id),
        state: row.oems_order_audit_id || row.oems_order_id ? status : status === "authorized" ? "awaiting_forward" : "not_routed",
        reason:
          row.oems_order_audit_id || row.oems_order_id
            ? "OEM order reference recorded"
            : status === "authorized"
              ? "Authorized, but no OEM order reference was recorded"
              : "No OEM order-book evidence is attached to this authorization",
      },
      events: eventsByAuth.get(id) ?? [],
    };
  });

  const directGifts = claimRows
    .filter((row) => !matchedClaimIds.has(text(row.id) || ""))
    .map((row) => {
      const id = text(row.id) || crypto.randomUUID();
      const sender = profileById.get(text(row.sender_user_id) || "");
      const recipient = profileById.get(text(row.recipient_user_id) || "");
      const assetKey = text(row.strategy_id) || text(row.security_id) || text(row.security_symbol);
      const strategy = strategyById.get(text(row.strategy_id) || "");
      const security =
        securityByKey.get(text(row.security_id) || "") || securityByKey.get(text(row.security_symbol) || "");
      const expiresAt = text(row.expires_at);
      const status = claimState(text(row.status), expiresAt);
      let message: string | null = text(row.message);
      try {
        const parsed = JSON.parse(message || "{}");
        message = text(parsed.msg) || message;
      } catch {
        // Direct gifts store plain text; registry bridges may store JSON.
      }
      return {
        id: `claim:${id}`,
        recordId: id,
        source: "claim" as const,
        status,
        claimState: status,
        gifter: {
          id: text(row.sender_user_id),
          name: profileName(sender),
          email: text(sender?.email),
        },
        recipient: {
          id: text(row.recipient_user_id),
          name: profileName(recipient, row.recipient_identifier),
          email:
            text(recipient?.email) ||
            (String(row.recipient_identifier || "").includes("@") ? text(row.recipient_identifier) : null),
          kind: "client",
        },
        asset: {
          type: text(row.asset_type)?.toLowerCase() || "unknown",
          key: assetKey,
          symbol: text(row.security_symbol) || text(security?.symbol) || text(strategy?.short_name),
          name: text(row.asset_name) || text(strategy?.name) || text(security?.name) || "Unknown asset",
          logoUrl: text(security?.logo_url),
          constituents: Array.isArray(strategy?.holdings) ? strategy.holdings : [],
        },
        registry: null,
        quantity: number(row.quantity),
        amountRands: moneyFromClaim(row),
        reservedRands: moneyFromClaim(row),
        paidRands: status === "claimed" ? moneyFromClaim(row) : null,
        livePriceRands: null,
        fillPriceRands: null,
        priceSource: null,
        driftBps: null,
        paymentMethod: null,
        message,
        expiresAt,
        timestamps: {
          created: text(row.created_at),
          updated: text(row.updated_at),
          authorized: text(row.reserved_at),
          parked: null,
          working: null,
          filled: text(row.claimed_at),
          cancelled: text(row.cancelled_at),
          refunded: text(row.refunded_at),
        },
        references: {
          oemsOrderId: null,
          oemsAuditId: null,
          fillReference: null,
          recipientHoldingId: text(row.holding_id),
        },
        environment: environmentFor(row.sender_user_id, row.recipient_user_id),
        execution: {
          reachedOrderBook: false,
          state: "direct_allocation",
          reason: "Direct gift claims currently allocate holdings without creating an OEM order",
        },
        events: [],
      };
    });

  const gifts = [...modernGifts, ...directGifts].sort((a, b) =>
    String(b.timestamps.created || "").localeCompare(String(a.timestamps.created || "")),
  );

  const contributionsByItem = new Map<string, Row[]>();
  for (const row of contributionRows) {
    const itemId = text(row.registry_item_id);
    if (itemId) contributionsByItem.set(itemId, [...(contributionsByItem.get(itemId) ?? []), row]);
  }
  const wishlists = registryRows.map((registry) => {
    const id = text(registry.id) || crypto.randomUUID();
    const creatorId = text(registry.creator_user_id);
    const beneficiaryType = text(registry.beneficiary_type)?.toUpperCase() || "SELF";
    const beneficiaryId = text(registry.beneficiary_ref);
    const beneficiary =
      beneficiaryType === "CHILD"
        ? familyById.get(beneficiaryId || "")
        : beneficiaryType === "SELF"
          ? profileById.get(creatorId || "")
          : profileById.get(beneficiaryId || "");
    const items = itemRows
      .filter((item) => text(item.gift_event_id) === id)
      .map((item) => {
        const itemId = text(item.id) || crypto.randomUUID();
        const assetKey = text(item.isin);
        const strategy = strategyById.get(assetKey || "");
        const security = securityByKey.get(assetKey || "");
        const contributions = contributionsByItem.get(itemId) ?? [];
        return {
          id: itemId,
          type: text(item.instrument_type)?.toLowerCase() || (strategy ? "basket" : "security"),
          symbol: text(security?.symbol) || text(strategy?.short_name) || assetKey,
          name: text(strategy?.name) || text(security?.name) || assetKey || "Unknown asset",
          targetQuantity: number(item.target_quantity) ?? 0,
          filledQuantity: number(item.filled_quantity) ?? 0,
          reservedQuantity: number(item.reserved_quantity) ?? 0,
          status: text(item.status)?.toLowerCase() || "unknown",
          contributionCount: contributions.length,
          contributedRands: contributions.reduce(
            (sum, contribution) =>
              sum + (centsToRands(contribution.executed_amount_cents ?? contribution.quoted_amount_cents) ?? 0),
            0,
          ),
        };
      });
    const relatedUserIds = [creatorId, beneficiaryType === "OTHER" ? beneficiaryId : null];
    return {
      id,
      title: text(registry.title) || "Untitled wishlist",
      occasion: text(registry.custom_occasion) || text(registry.occasion),
      status: text(registry.status)?.toLowerCase() || "unknown",
      beneficiaryType,
      creator: {
        id: creatorId,
        name: profileName(profileById.get(creatorId || "")),
        email: text(profileById.get(creatorId || "")?.email),
      },
      beneficiary: {
        id: beneficiaryId || creatorId,
        name: profileName(beneficiary, registry.beneficiary_display_name),
        email: text(beneficiary?.email),
      },
      eventDate: text(registry.event_date),
      expiresAt: text(registry.expiry_at),
      createdAt: text(registry.created_at),
      environment: environmentFor(...relatedUserIds),
      itemCount: items.length,
      contributionCount: items.reduce((sum, item) => sum + item.contributionCount, 0),
      contributedRands: items.reduce((sum, item) => sum + item.contributedRands, 0),
      targetQuantity: items.reduce((sum, item) => sum + item.targetQuantity, 0),
      filledQuantity: items.reduce((sum, item) => sum + item.filledQuantity, 0),
      items,
    };
  });

  return NextResponse.json({
    ok: true,
    source: "retail-supabase",
    generatedAt: new Date().toISOString(),
    gifts,
    wishlists,
    notices,
    lineage: [
      { table: "gift_claims", purpose: "Direct gift identity, recipient claim and expiry state" },
      { table: "gift_events / gift_registry_items", purpose: "Wishlist, beneficiary and requested asset" },
      { table: "gift_reservations / gift_contributions", purpose: "Price lock, checkout and payment trail" },
      { table: "gift_authorizations", purpose: "Wallet reservation and OEMS/IRESS order lifecycle" },
      { table: "gift_authorization_events", purpose: "Append-only transition audit with actors and reasons" },
      {
        table: "wallets / transactions",
        purpose: "Reserve funds, debit on fill, refund or release on failure",
      },
      { table: "stock_holdings_c / user_strategies", purpose: "Deliver the filled or claimed investment" },
      { table: "notifications / gift_email_outbox", purpose: "Tell gifters and recipients what happened" },
    ],
  });
}

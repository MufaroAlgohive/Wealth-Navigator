import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { getApplicantByExternalId, sumsubConfigured, sumsubFetch } from "@/lib/admin/sumsub";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type DocumentItem = {
  id: string;
  name: string;
  fileType: string;
  addedDate: string | null;
  url: string;
  source: "experian" | "sumsub" | "signed";
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function firstString(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, keys);
      if (found) return found;
    }
    return "";
  }
  const item = value as Record<string, unknown>;
  for (const key of keys) {
    const found = item[key];
    if (typeof found === "string" && found) return found;
  }
  for (const nested of Object.values(item)) {
    const found = firstString(nested, keys);
    if (found) return found;
  }
  return "";
}

function metadataItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
  const root = record(value);
  for (const candidate of [root.resources, root.items, root.images, record(root.data).resources]) {
    if (Array.isArray(candidate)) return candidate.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
  }
  return Object.keys(root).length ? [root] : [];
}

function pretty(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function requireAdmin() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  return null;
}

export async function GET(req: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const url = new URL(req.url);

  if (url.searchParams.get("source") === "sumsub-live") {
    const inspectionId = url.searchParams.get("inspection_id") || "";
    const imageId = url.searchParams.get("image_id") || "";
    if (!inspectionId || !imageId) return NextResponse.json({ ok: false, error: "inspection_id and image_id required" }, { status: 400 });
    const path = `/resources/inspections/${encodeURIComponent(inspectionId)}/resources/${encodeURIComponent(imageId)}`;
    const response = await sumsubFetch("GET", path);
    if (!response) return NextResponse.json({ ok: false, error: "SumSub is not configured" }, { status: 503 });
    if (!response.ok) return NextResponse.json({ ok: false, error: `SumSub document request failed (${response.status})` }, { status: response.status });
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/octet-stream",
        "Content-Disposition": `inline; filename="sumsub-${imageId.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  const profileId = url.searchParams.get("profile_id") || "";
  if (!profileId) return NextResponse.json({ ok: false, error: "profile_id required" }, { status: 400 });
  let db: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const [{ data: archived }, { data: onboarding }, { data: signedFiles }] = await Promise.all([
    db.from("sumsub_document_archive").select("image_id,file_name,file_type,mime_type,storage_bucket,storage_path,resource_metadata,archived_at").eq("profile_id", profileId).order("archived_at", { ascending: false }),
    db.from("user_onboarding").select("sumsub_external_user_id,user_id").eq("user_id", profileId).maybeSingle(),
    db.storage.from("signed-agreements").list(profileId, { limit: 100, sortBy: { column: "name", order: "desc" } }),
  ]);

  const groups: Record<"experian" | "sumsub" | "signed", DocumentItem[]> = { experian: [], sumsub: [], signed: [] };
  for (const row of archived ?? []) {
    if (!row.storage_bucket || !row.storage_path) continue;
    const { data: signed } = await db.storage.from(row.storage_bucket).createSignedUrl(row.storage_path, 3600);
    if (!signed?.signedUrl) continue;
    const metadata = record(row.resource_metadata);
    const provider = String(metadata.provider || metadata.source || "").toLowerCase();
    const source = provider.includes("experian") ? "experian" : "sumsub";
    const kind = String(metadata.kind || row.image_id || "document");
    groups[source].push({
      id: String(row.image_id || row.storage_path),
      name: String(row.file_name || pretty(kind)),
      fileType: String(row.file_type || row.mime_type || "Archived document"),
      addedDate: row.archived_at ?? null,
      url: signed.signedUrl,
      source,
    });
  }

  const externalUserId = String(onboarding?.sumsub_external_user_id || onboarding?.user_id || "");
  if (externalUserId && sumsubConfigured()) {
    const applicantResult = await getApplicantByExternalId(externalUserId);
    const applicant = record(applicantResult.data);
    const applicantId = String(applicant.id || applicant.applicantId || applicant.applicant_id || "");
    const inspectionId = String(applicant.inspectionId || record(applicant.review).inspectionId || firstString(applicant, ["inspectionId"]));
    if (applicantId && inspectionId) {
      const metaPath = `/resources/applicants/${encodeURIComponent(applicantId)}/metadata/resources`;
      const metadataResponse = await sumsubFetch("GET", metaPath);
      const metadata = metadataResponse?.ok ? await metadataResponse.json().catch(() => ({})) : {};
      metadataItems(metadata).forEach((item, index) => {
        const imageId = String(item.id || item.imageId || item.image_id || item.resourceId || "");
        if (!imageId) return;
        const type = String(item.type || item.fileType || item.mimeType || "SumSub document");
        groups.sumsub.push({
          id: `live-${imageId}`,
          name: String(item.fileName || item.name || pretty(String(item.kind || item.type || `Document ${index + 1}`))),
          fileType: type,
          addedDate: String(item.addedDate || item.createdAt || "") || null,
          url: `/api/admin/clients/documents?source=sumsub-live&inspection_id=${encodeURIComponent(inspectionId)}&image_id=${encodeURIComponent(imageId)}`,
          source: "sumsub",
        });
      });
    }
  }

  for (const file of signedFiles ?? []) {
    if (!file.name || !(file.id || file.metadata)) continue;
    const path = `${profileId}/${file.name}`;
    const { data: signed } = await db.storage.from("signed-agreements").createSignedUrl(path, 3600);
    if (!signed?.signedUrl) continue;
    const base = file.name.replace(/\.[^.]+$/, "");
    groups.signed.push({
      id: `signed-${file.name}`,
      name: /^agreement/i.test(file.name) ? "Account agreement" : /^bank-confirmation/i.test(file.name) ? "Bank confirmation" : pretty(base),
      fileType: String(file.metadata?.mimetype || "Signed document"),
      addedDate: file.updated_at || file.created_at || null,
      url: signed.signedUrl,
      source: "signed",
    });
  }

  return NextResponse.json({ ok: true, profile_id: profileId, groups });
}

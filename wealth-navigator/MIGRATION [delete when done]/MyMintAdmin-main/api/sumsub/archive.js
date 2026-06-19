const { sendJson, fetchSupabaseJson, requestSupabaseJson } = require('../_orderbook');
const { getSumsubAuthHeaders } = require('../_sumsub');

const ARCHIVE_BUCKET = 'sumsub-archive';

const normalizeReviewText = (value) => String(value || '').trim().toLowerCase();

const isApplicantCompleted = (applicant) => {
  const reviewStatus = normalizeReviewText(applicant?.review?.reviewStatus || applicant?.reviewStatus || applicant?.status);
  const reviewAnswer = String(applicant?.review?.result?.reviewAnswer || applicant?.review?.reviewAnswer || applicant?.reviewAnswer || '').trim().toUpperCase();

  if (reviewAnswer === 'GREEN' || reviewAnswer === 'APPROVED') return true;
  return reviewStatus.includes('completed') || reviewStatus.includes('approved') || reviewStatus.includes('verified');
};

const resolveMetadataItems = (metadata) => {
  const items = Array.isArray(metadata)
    ? metadata
    : (metadata?.resources || metadata?.items || metadata?.images || metadata?.data?.resources || [metadata]);
  return Array.isArray(items) ? items.filter(Boolean) : [];
};

const resolveImageId = (item) => item?.id || item?.previewId || item?.imageId || item?.resourceId;

const sanitizeFileName = (value = '') => String(value || '')
  .trim()
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/\s+/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '');

const resolveDocumentFileName = (item, index) => {
  const metadataName = item?.fileMetadata?.fileName;
  const fallbackName = item?.label || item?.name || `document-${index + 1}`;
  const rawName = metadataName || fallbackName;
  const safeName = sanitizeFileName(rawName) || `document-${index + 1}`;
  return safeName.includes('.') ? safeName : `${safeName}.bin`;
};

const splitName = (fileName, index) => {
  const safe = sanitizeFileName(fileName) || `document-${index + 1}.bin`;
  const dotIndex = safe.lastIndexOf('.');
  if (dotIndex < 0) {
    return { name: safe, ext: '' };
  }
  return {
    name: safe.slice(0, dotIndex),
    ext: safe.slice(dotIndex)
  };
};

const supabaseStorageRequest = async (path, options = {}) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase server credentials are not configured');
  }

  const response = await fetch(`${supabaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'apikey': supabaseServiceRoleKey,
      'Authorization': `Bearer ${supabaseServiceRoleKey}`,
      ...(options.contentType ? { 'Content-Type': options.contentType } : {}),
      ...(options.headers || {})
    },
    ...(options.body !== undefined ? { body: options.body } : {})
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { response, payload };
};

const ensureArchiveBucket = async () => {
  const getBucket = await supabaseStorageRequest(`/storage/v1/bucket/${encodeURIComponent(ARCHIVE_BUCKET)}`);
  if (getBucket.response.ok) return;

  if (getBucket.response.status !== 404) {
    const reason = getBucket.payload?.message || getBucket.payload?.error || `Storage bucket check failed (${getBucket.response.status})`;
    throw new Error(reason);
  }

  const createBucket = await supabaseStorageRequest('/storage/v1/bucket', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({
      id: ARCHIVE_BUCKET,
      name: ARCHIVE_BUCKET,
      public: false,
      file_size_limit: 15728640
    })
  });

  if (!createBucket.response.ok && createBucket.response.status !== 409) {
    const reason = createBucket.payload?.message || createBucket.payload?.error || `Storage bucket create failed (${createBucket.response.status})`;
    throw new Error(reason);
  }
};

const fetchSumsubJson = async (pathWithQuery) => {
  const headers = getSumsubAuthHeaders('GET', pathWithQuery);
  if (!headers) {
    throw new Error('Sumsub credentials are not configured');
  }

  const response = await fetch(`https://api.sumsub.com${pathWithQuery}`, {
    method: 'GET',
    headers
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.description || payload?.message || payload?.error || `Sumsub request failed (${response.status})`;
    throw new Error(message);
  }

  return payload;
};

const fetchSumsubBinary = async (pathWithQuery) => {
  const headers = getSumsubAuthHeaders('GET', pathWithQuery);
  if (!headers) {
    throw new Error('Sumsub credentials are not configured');
  }

  const response = await fetch(`https://api.sumsub.com${pathWithQuery}`, {
    method: 'GET',
    headers
  });

  if (!response.ok) {
    throw new Error(`Sumsub binary request failed (${response.status})`);
  }

  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  const arrayBuffer = await response.arrayBuffer();
  return {
    mimeType,
    buffer: Buffer.from(arrayBuffer)
  };
};

const uploadArchivedObject = async ({ storagePath, mimeType, binary }) => {
  const encodedPath = storagePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const upload = await supabaseStorageRequest(`/storage/v1/object/${ARCHIVE_BUCKET}/${encodedPath}`, {
    method: 'POST',
    headers: {
      'x-upsert': 'true'
    },
    contentType: mimeType || 'application/octet-stream',
    body: binary
  });

  if (!upload.response.ok) {
    const reason = upload.payload?.message || upload.payload?.error || `Storage upload failed (${upload.response.status})`;
    throw new Error(reason);
  }
};

const createSignedUrl = async (storagePath, expiresInSeconds = 3600) => {
  const encodedPath = storagePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const signResponse = await supabaseStorageRequest(`/storage/v1/object/sign/${ARCHIVE_BUCKET}/${encodedPath}`, {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ expiresIn: expiresInSeconds })
  });

  if (!signResponse.response.ok) {
    return null;
  }

  const signedRelative = signResponse.payload?.signedURL || signResponse.payload?.signedUrl;
  if (!signedRelative) return null;

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) return null;
  return `${supabaseUrl}/storage/v1${signedRelative}`;
};

const archiveCompletedUser = async ({ profileId, externalUserId }) => {
  let applicant;
  try {
    applicant = await fetchSumsubJson(`/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`);
  } catch (err) {
    if (err.message.toLowerCase().includes('not found') || err.message.includes('404')) {
      return { skipped: true, reason: 'Applicant not found', archivedCount: 0, applicantId: null };
    }
    throw err;
  }

  if (!isApplicantCompleted(applicant)) {
    return {
      skipped: true,
      reason: 'Applicant not completed yet',
      archivedCount: 0,
      applicantId: applicant?.id || applicant?.applicantId || applicant?.applicant_id || null
    };
  }

  const applicantId = applicant?.id || applicant?.applicantId || applicant?.applicant_id;
  if (!applicantId) {
    throw new Error('No applicantId found in Sumsub response');
  }

  const inspectionId = applicant?.inspectionId || applicant?.review?.inspectionId;
  if (!inspectionId) {
    return {
      skipped: true,
      reason: 'No inspectionId in completed applicant',
      archivedCount: 0,
      applicantId
    };
  }

  const metadata = await fetchSumsubJson(`/resources/applicants/${encodeURIComponent(applicantId)}/metadata/resources`);
  const items = resolveMetadataItems(metadata);
  if (!items.length) {
    return {
      skipped: false,
      reason: 'No metadata resources found',
      archivedCount: 0,
      applicantId
    };
  }

  await ensureArchiveBucket();

  const upsertRows = [];
  let archivedCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const imageId = String(resolveImageId(item) || '').trim();
    if (!imageId) continue;

    const { mimeType, buffer } = await fetchSumsubBinary(`/resources/inspections/${encodeURIComponent(inspectionId)}/resources/${encodeURIComponent(imageId)}`);
    const fileName = resolveDocumentFileName(item, index);
    const split = splitName(fileName, index);
    const storagePath = [
      String(profileId),
      String(applicantId),
      String(inspectionId),
      `${imageId}-${split.name}${split.ext}`
    ].join('/');

    await uploadArchivedObject({
      storagePath,
      mimeType,
      binary: buffer
    });

    upsertRows.push({
      profile_id: profileId,
      external_user_id: externalUserId,
      applicant_id: String(applicantId),
      inspection_id: String(inspectionId),
      image_id: imageId,
      file_name: fileName,
      file_type: item?.fileMetadata?.fileType || mimeType,
      mime_type: mimeType,
      content_size_bytes: buffer.length,
      storage_bucket: ARCHIVE_BUCKET,
      storage_path: storagePath,
      resource_metadata: item,
      review_status: applicant?.review?.reviewStatus || applicant?.reviewStatus || applicant?.status || null,
      review_answer: applicant?.review?.result?.reviewAnswer || applicant?.review?.reviewAnswer || applicant?.reviewAnswer || null,
      archived_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    archivedCount += 1;
  }

  if (upsertRows.length) {
    await requestSupabaseJson('/rest/v1/sumsub_document_archive?on_conflict=profile_id,image_id', {
      method: 'POST',
      body: upsertRows,
      extraHeaders: {
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }
    });
  }

  return {
    skipped: false,
    archivedCount,
    applicantId,
    inspectionId
  };
};

module.exports = async (req, res) => {
  const method = req.method || 'GET';

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return sendJson(res, 401, { error: 'Missing Authorization bearer token' });
  }

  try {
    await fetchSupabaseJson('/auth/v1/user', token, false);

    if (method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const profileId = String(body.profileId || '').trim();
      const externalUserId = String(body.externalUserId || '').trim();

      if (!profileId || !externalUserId) {
        return sendJson(res, 400, { error: 'profileId and externalUserId are required' });
      }

      const result = await archiveCompletedUser({ profileId, externalUserId });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (method === 'GET') {
      const profileId = String(req.query?.profileId || '').trim();
      if (!profileId) {
        return sendJson(res, 400, { error: 'profileId is required' });
      }

      const rows = await requestSupabaseJson(
        `/rest/v1/sumsub_document_archive?select=profile_id,external_user_id,applicant_id,inspection_id,image_id,file_name,file_type,mime_type,content_size_bytes,storage_bucket,storage_path,resource_metadata,review_status,review_answer,archived_at,updated_at&profile_id=eq.${encodeURIComponent(profileId)}&order=archived_at.desc`,
        { method: 'GET' }
      );

      const enrichedRows = [];
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const signedUrl = row?.storage_path ? await createSignedUrl(row.storage_path, 3600) : null;
        enrichedRows.push({
          ...row,
          signed_url: signedUrl
        });
      }

      return sendJson(res, 200, {
        ok: true,
        items: enrichedRows
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Could not archive Sumsub resources',
      details: error?.message || 'Unknown error'
    });
  }
};

const https = require('https');
const { getSumsubAuthHeaders, jsonError } = require('../_sumsub');

const handleApplicant = (req, res) => {
  const externalUserId = req.query.externalUserId;
  if (!externalUserId) return jsonError(res, 400, 'externalUserId is required');
  const method = 'GET';
  const pathWithQuery = `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`;
  const headers = getSumsubAuthHeaders(method, pathWithQuery);
  if (!headers) return jsonError(res, 500, 'Sumsub credentials are not configured');
  const sumsubReq = https.request({ hostname: 'api.sumsub.com', path: pathWithQuery, method, headers }, (sumsubRes) => {
    let data = '';
    sumsubRes.on('data', (chunk) => { data += chunk; });
    sumsubRes.on('end', () => { res.statusCode = sumsubRes.statusCode || 500; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(data); });
  });
  sumsubReq.on('error', (err) => jsonError(res, 500, `Sumsub request failed: ${err.message}`));
  sumsubReq.end();
};

const handleImage = (req, res) => {
  const inspectionId = req.query.inspectionId;
  const imageId = req.query.imageId;
  if (!inspectionId || !imageId) return jsonError(res, 400, 'inspectionId and imageId are required');
  const method = 'GET';
  const pathWithQuery = `/resources/inspections/${encodeURIComponent(inspectionId)}/resources/${encodeURIComponent(imageId)}`;
  const headers = getSumsubAuthHeaders(method, pathWithQuery);
  if (!headers) return jsonError(res, 500, 'Sumsub credentials are not configured');
  const sumsubReq = https.request({ hostname: 'api.sumsub.com', path: pathWithQuery, method, headers }, (sumsubRes) => {
    res.statusCode = sumsubRes.statusCode || 500;
    res.setHeader('Content-Type', sumsubRes.headers['content-type'] || 'application/octet-stream');
    sumsubRes.pipe(res);
  });
  sumsubReq.on('error', (err) => jsonError(res, 500, `Sumsub request failed: ${err.message}`));
  sumsubReq.end();
};

const handleMetadata = (req, res) => {
  const applicantId = req.query.applicantId;
  if (!applicantId) return jsonError(res, 400, 'applicantId is required');
  const method = 'GET';
  const pathWithQuery = `/resources/applicants/${encodeURIComponent(applicantId)}/metadata/resources`;
  const headers = getSumsubAuthHeaders(method, pathWithQuery);
  if (!headers) return jsonError(res, 500, 'Sumsub credentials are not configured');
  const sumsubReq = https.request({ hostname: 'api.sumsub.com', path: pathWithQuery, method, headers }, (sumsubRes) => {
    let data = '';
    sumsubRes.on('data', (chunk) => { data += chunk; });
    sumsubRes.on('end', () => { res.statusCode = sumsubRes.statusCode || 500; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(data); });
  });
  sumsubReq.on('error', (err) => jsonError(res, 500, `Sumsub request failed: ${err.message}`));
  sumsubReq.end();
};

module.exports = (req, res) => {
  const url = req.url || '';
  if (url.includes('/sumsub/image') || req.query._route === 'image') return handleImage(req, res);
  if (url.includes('/sumsub/metadata') || req.query._route === 'metadata') return handleMetadata(req, res);
  return handleApplicant(req, res);
};

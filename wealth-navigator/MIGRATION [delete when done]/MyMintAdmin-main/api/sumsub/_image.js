const https = require('https');
const { getSumsubAuthHeaders, jsonError } = require('../_sumsub');

module.exports = (req, res) => {
  const inspectionId = req.query.inspectionId;
  const imageId = req.query.imageId;
  if (!inspectionId || !imageId) {
    return jsonError(res, 400, 'inspectionId and imageId are required');
  }

  const method = 'GET';
  const pathWithQuery = `/resources/inspections/${encodeURIComponent(inspectionId)}/resources/${encodeURIComponent(imageId)}`;
  const headers = getSumsubAuthHeaders(method, pathWithQuery);
  if (!headers) {
    return jsonError(res, 500, 'Sumsub credentials are not configured');
  }

  const options = {
    hostname: 'api.sumsub.com',
    path: pathWithQuery,
    method,
    headers
  };

  const sumsubReq = https.request(options, (sumsubRes) => {
    res.statusCode = sumsubRes.statusCode || 500;
    res.setHeader('Content-Type', sumsubRes.headers['content-type'] || 'application/octet-stream');
    sumsubRes.pipe(res);
  });

  sumsubReq.on('error', (err) => {
    jsonError(res, 500, `Sumsub request failed: ${err.message}`);
  });

  sumsubReq.end();
};

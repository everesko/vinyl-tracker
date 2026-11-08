const handleRequest = require('../server.js');
const url = require('url');

module.exports = async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.query && parsed.query.__path) {
    const rawPath = parsed.query.__path;
    const cleanQuery = { ...parsed.query };
    delete cleanQuery.__path;
    const qs = new URLSearchParams(cleanQuery).toString();
    req.url = '/api/' + String(rawPath).replace(/^\//, '') + (qs ? '?' + qs : '');
  } else if (req.headers['x-forwarded-url']) {
    req.url = req.headers['x-forwarded-url'];
  } else if (req.headers['x-matched-path'] && !req.headers['x-matched-path'].startsWith('/api/index')) {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = req.headers['x-matched-path'] + qs;
  }

  return handleRequest(req, res);
};

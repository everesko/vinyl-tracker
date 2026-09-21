/**
 * Vinyl Hunter — Node.js Backend Server
 * 
 * Features:
 * - Two search modes: Vinyl Releases (with prices) & Master Albums (with edition counts)
 * - Master releases API (/api/discogs/master/:id and /api/discogs/master/:id/versions)
 * - Smart Caching (TTL) for Search, Price stats, Releases, and Masters
 * - Rate Limiter & Request Queue (prevents Discogs 429)
 * - Real Discogs OAuth 1.0a Login & Authorization flow
 * - Separate storage for Releases and Albums
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const RELEASES_FILE = path.join(DATA_DIR, 'records.json');
const ALBUMS_FILE = path.join(DATA_DIR, 'albums.json');
const SPOTIFY_FILE = path.join(DATA_DIR, 'spotify_tracks.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(RELEASES_FILE)) {
  fs.writeFileSync(RELEASES_FILE, JSON.stringify([], null, 2), 'utf8');
}
if (!fs.existsSync(ALBUMS_FILE)) {
  fs.writeFileSync(ALBUMS_FILE, JSON.stringify([], null, 2), 'utf8');
}
if (!fs.existsSync(SPOTIFY_FILE)) {
  fs.writeFileSync(SPOTIFY_FILE, JSON.stringify([], null, 2), 'utf8');
}

const SPOTIFY_CONFIG_FILE = path.join(DATA_DIR, 'spotify-credentials.json');

function loadSpotifyCredentials() {
  try {
    if (fs.existsSync(SPOTIFY_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(SPOTIFY_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || ''
  };
}

function saveSpotifyCredentials(clientId, clientSecret) {
  try {
    const creds = { clientId: clientId || '', clientSecret: clientSecret || '' };
    fs.writeFileSync(SPOTIFY_CONFIG_FILE, JSON.stringify(creds, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save spotify credentials file:', e);
    return false;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const oauthSessions = new Map();
const spotifyOAuthSessions = new Map();

// ----------------------------------------------------
// SMART CACHE (Prevents Discogs Rate Limits)
// ----------------------------------------------------
const apiCache = new Map();

function getCached(key) {
  const item = apiCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    apiCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data, ttlMs = 15 * 60 * 1000) {
  if (apiCache.size > 2000) {
    const oldestKey = apiCache.keys().next().value;
    apiCache.delete(oldestKey);
  }
  apiCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs
  });
}

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.substring(0, idx).trim();
        const val = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

const USER_AGENT = 'VinylHunterApp/1.0 (+http://localhost:3000)';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function fetchDeezerArtistImage(name) {
  if (!name) return Promise.resolve('');
  const clean = name.replace(/\s*\(\d+\)$/, '').trim();
  const cacheKey = `deezer_artist_img:${clean.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached !== null && cached !== undefined) return Promise.resolve(cached);

  return new Promise(resolve => {
    https.get('https://api.deezer.com/search/artist?q=' + encodeURIComponent(clean), res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const img = json.data?.[0]?.picture_medium || json.data?.[0]?.picture || '';
          setCached(cacheKey, img, 7 * 24 * 60 * 60 * 1000);
          resolve(img);
        } catch (e) {
          resolve('');
        }
      });
    }).on('error', () => resolve(''));
  });
}

// ----------------------------------------------------
// SMART PRIORITY RATE-LIMITED DISCOGS QUEUE
// ----------------------------------------------------
class SmartPriorityDiscogsQueue {
  constructor() {
    this.highQueue = [];
    this.lowQueue = [];
    this.activeCount = 0;
    this.maxConcurrent = 5;
    this.remainingLimit = 60;
    this.pauseUntil = 0;
  }

  enqueue(taskFn, isPriority = true, isUrgent = false) {
    return new Promise((resolve, reject) => {
      const task = { fn: taskFn, resolve, reject, isPriority, isUrgent, createdAt: Date.now() };
      if (isUrgent) {
        this.highQueue.unshift(task); // Instant top-priority execution for user clicks!
      } else if (isPriority) {
        this.highQueue.push(task);
      } else {
        this.lowQueue.push(task);
      }
      this.dispatch();
    });
  }

  pause(ms) {
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms);
    setTimeout(() => this.dispatch(), ms + 50);
  }

  async dispatch() {
    const now = Date.now();
    if (now < this.pauseUntil) {
      setTimeout(() => this.dispatch(), this.pauseUntil - now + 50);
      return;
    }

    if (this.activeCount >= this.maxConcurrent) return;

    // High priority tasks (search, tracklists, previews) always execute first!
    const task = this.highQueue.shift() || this.lowQueue.shift();
    if (!task) return;

    this.activeCount++;

    // If remaining rate limit is critically low (<= 3), throttle slightly
    if (this.remainingLimit <= 3) {
      await sleep(1000);
    }

    (async () => {
      try {
        const result = await task.fn();
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      } finally {
        this.activeCount--;
        this.dispatch();
      }
    })();

    // Fill remaining concurrency slots if queue is non-empty
    if (this.activeCount < this.maxConcurrent && (this.highQueue.length > 0 || this.lowQueue.length > 0)) {
      this.dispatch();
    }
  }
}

const discogsQueue = new SmartPriorityDiscogsQueue();

function executeDiscogsHttp(apiPath, method = 'GET', postData = null, authHeader = null, userToken = null, isPriority = true, isUrgent = false) {
  return discogsQueue.enqueue(() => {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json'
      };

      if (authHeader) {
        headers['Authorization'] = authHeader;
      } else {
        const token = userToken || process.env.DISCOGS_API_TOKEN || '';
        if (token) {
          headers['Authorization'] = `Discogs token=${token}`;
        }
      }

      if (postData) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(JSON.stringify(postData));
      }

      const options = {
        hostname: 'api.discogs.com',
        port: 443,
        path: apiPath,
        method: method,
        headers: headers
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const rem = parseInt(res.headers['x-discogs-ratelimit-remaining'], 10);
          if (!isNaN(rem)) {
            discogsQueue.remainingLimit = rem;
          }

          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            if (data.includes('=') && (data.includes('oauth_token') || data.includes('oauth_verifier'))) {
              parsed = Object.fromEntries(new URLSearchParams(data));
            } else {
              parsed = { raw: data };
            }
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            data: parsed
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (postData) {
        req.write(JSON.stringify(postData));
      }
      req.end();
    });
  }, isPriority, isUrgent);
}

async function discogsRequest(apiPath, method = 'GET', postData = null, authHeader = null, userToken = null, retries = 2, isPriority = true, isUrgent = false) {
  let response;
  try {
    response = await executeDiscogsHttp(apiPath, method, postData, authHeader, userToken, isPriority, isUrgent);
  } catch (err) {
    console.warn(`[Discogs request error on ${apiPath}]:`, err.message);
    return { statusCode: 503, headers: {}, data: { error: err.message } };
  }

  if (response.statusCode === 429) {
    const retryAfterSec = parseInt(response.headers['retry-after'] || '2', 10);
    const waitMs = Math.max(retryAfterSec * 1000, 2000);
    discogsQueue.pause(waitMs);
    if (retries > 0) {
      await sleep(waitMs);
      return discogsRequest(apiPath, method, postData, authHeader, userToken, retries - 1, isPriority, isUrgent);
    } else {
      console.warn(`[Discogs 429 limit reached on ${apiPath}]. Returning safe fallback.`);
      return {
        statusCode: 200,
        headers: response.headers,
        data: { results: [], pagination: {}, num_for_sale: 0, versions: [] }
      };
    }
  }

  return response;
}

function parseRequestBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function cleanTrackMeta(artist, title) {
  let a = (artist || '').trim().replace(/\s*\(\d+\)$/, '');
  let t = (title || '').trim();

  // Remove track index/position like "A1. ", "B2 - ", "01 ", "12. "
  t = t.replace(/^([A-Z]\d*|\d+)[\.\s\-:]+\s*/i, '');

  // Remove common parenthetical noise like "(2011 Remaster)", "[Remastered]", "(Live At...)", "(Bonus Track)"
  let cleanT = t.replace(/\s*[\(\[](remaster(ed)?|live|mono|stereo|bonus|deluxe|version|edit|anniversary|single|mix|original|album version)[^\)\]]*[\)\]]/gi, '').trim();
  if (!cleanT) cleanT = t;

  // Handle slash multi-tracks: "Speak to Me / Breathe" -> "Speak to Me"
  let firstPart = cleanT;
  if (cleanT.includes(' / ')) {
    firstPart = cleanT.split(' / ')[0].trim();
  }

  return { artist: a, title: cleanT, rawTitle: t, firstPart };
}

function executeDeezerTrackSearch(q, limit = 10) {
  return new Promise((resolve) => {
    const deezerUrl = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`;
    const req = https.get(deezerUrl, { headers: { 'User-Agent': 'VinylHunterApp/1.0' }, timeout: 4500 }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = (parsed.data || []).map(item => {
            const mins = Math.floor((item.duration || 0) / 60);
            const secs = (item.duration || 0) % 60;
            const durStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
            return {
              id: 'deezer_' + item.id,
              title: item.title || item.title_short || 'Unknown Title',
              artist: item.artist?.name || 'Unknown Artist',
              album: item.album?.title || '',
              durationMs: (item.duration || 0) * 1000,
              durationStr: durStr,
              previewUrl: item.preview || null,
              coverImage: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || '',
              link: item.link || ''
            };
          });
          resolve(results);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-discogs-token');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const userToken = req.headers['x-discogs-token'] || 
                    (req.headers['authorization'] ? req.headers['authorization'].replace(/^Discogs token=|^Bearer /i, '') : null) || 
                    query.token || 
                    null;

  // ----------------------------------------------------
  // DISCOGS OAUTH 1.0a FLOW
  // ----------------------------------------------------
  if (pathname === '/api/discogs/auth/login' && req.method === 'GET') {
    const consumerKey = query.consumer_key || process.env.DISCOGS_CONSUMER_KEY;
    const consumerSecret = query.consumer_secret || process.env.DISCOGS_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Consumer Key and Consumer Secret required',
        message: 'Укажите Consumer Key и Secret из https://www.discogs.com/settings/developers'
      }));
      return;
    }

    const host = req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
    const callbackUrl = `${protocol}://${host}/api/discogs/auth/callback`;

    try {
      const nonce = crypto.randomBytes(16).toString('hex');
      const timestamp = Math.floor(Date.now() / 1000);

      const authHeader = `OAuth oauth_consumer_key="${encodeURIComponent(consumerKey)}", ` +
                         `oauth_nonce="${nonce}", ` +
                         `oauth_signature="${encodeURIComponent(consumerSecret)}&", ` +
                         `oauth_signature_method="PLAINTEXT", ` +
                         `oauth_timestamp="${timestamp}", ` +
                         `oauth_callback="${encodeURIComponent(callbackUrl)}"`;

      const response = await discogsRequest('/oauth/request_token', 'POST', null, authHeader);

      if (response.data && response.data.oauth_token && response.data.oauth_token_secret) {
        const oauthToken = response.data.oauth_token;
        const oauthTokenSecret = response.data.oauth_token_secret;

        oauthSessions.set(oauthToken, {
          consumerKey,
          consumerSecret,
          oauthTokenSecret,
          createdAt: Date.now()
        });

        const authorizeUrl = `https://discogs.com/oauth/authorize?oauth_token=${encodeURIComponent(oauthToken)}`;
        res.writeHead(302, { Location: authorizeUrl });
        res.end();
      } else {
        res.writeHead(response.statusCode || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to obtain request token', details: response.data }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OAuth initiation failed', details: err.message }));
    }
    return;
  }

  if (pathname === '/api/discogs/auth/callback' && req.method === 'GET') {
    const oauthToken = query.oauth_token;
    const oauthVerifier = query.oauth_verifier;

    if (!oauthToken || !oauthVerifier) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Ошибка авторизации Discogs: отсутствуют параметры</h3><a href="/">Вернуться</a>');
      return;
    }

    const session = oauthSessions.get(oauthToken);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Сессия авторизации истекла. Попробуйте снова.</h3><a href="/">Вернуться</a>');
      return;
    }

    oauthSessions.delete(oauthToken);

    try {
      const nonce = crypto.randomBytes(16).toString('hex');
      const timestamp = Math.floor(Date.now() / 1000);

      const authHeader = `OAuth oauth_consumer_key="${encodeURIComponent(session.consumerKey)}", ` +
                         `oauth_nonce="${nonce}", ` +
                         `oauth_token="${encodeURIComponent(oauthToken)}", ` +
                         `oauth_signature="${encodeURIComponent(session.consumerSecret)}&${encodeURIComponent(session.oauthTokenSecret)}", ` +
                         `oauth_signature_method="PLAINTEXT", ` +
                         `oauth_timestamp="${timestamp}", ` +
                         `oauth_verifier="${encodeURIComponent(oauthVerifier)}"`;

      const response = await discogsRequest('/oauth/access_token', 'POST', null, authHeader);

      if (response.data && response.data.oauth_token && response.data.oauth_token_secret) {
        const accessToken = response.data.oauth_token;
        const accessTokenSecret = response.data.oauth_token_secret;

        const userResp = await discogsRequest('/oauth/identity', 'GET', null, null, accessToken);
        const username = userResp.data ? userResp.data.username : '';

        const redirectParams = new URLSearchParams({
          discogs_auth: 'success',
          discogs_token: accessToken,
          discogs_token_secret: accessTokenSecret,
          discogs_username: username || ''
        });

        res.writeHead(302, { Location: `/?${redirectParams.toString()}` });
        res.end();
      } else {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h3>Ошибка обмена токена Discogs</h3><p>${JSON.stringify(response.data)}</p><a href="/">Вернуться</a>`);
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h3>Ошибка сервера: ${err.message}</h3><a href="/">Вернуться</a>`);
    }
    return;
  }

  // ----------------------------------------------------
  // API ROUTES
  // ----------------------------------------------------

  // Health check
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      version: '1.5.0',
      timestamp: new Date().toISOString(),
      cacheSize: apiCache.size,
      discogsOAuthReady: Boolean(process.env.DISCOGS_CONSUMER_KEY && process.env.DISCOGS_CONSUMER_SECRET)
    }));
    return;
  }

  // Search Endpoint (Supports both type=release and type=master)
  if (pathname === '/api/discogs/search' && req.method === 'GET') {
    try {
      const q = (query.q || '').trim();
      const type = query.type === 'master' ? 'master' : (query.type === 'artist' ? 'artist' : 'release');
      const page = query.page || 1;
      const per_page = Math.min(query.per_page || 25, 50);
      const artist = query.artist || '';
      const release_title = query.release_title || '';
      const track = query.track || '';

      if (!q && !artist && !release_title && !track) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [], pagination: {} }));
        return;
      }

      const searchParams = new URLSearchParams();
      if (q) searchParams.append('q', q);
      if (artist) searchParams.append('artist', artist);
      if (release_title) searchParams.append('release_title', release_title);
      if (track) searchParams.append('track', track);
      
      searchParams.append('type', type);
      if (query.format) {
        searchParams.append('format', query.format);
      } else if (type === 'release') {
        searchParams.append('format', 'Vinyl');
      }
      searchParams.append('page', page);
      searchParams.append('per_page', per_page);

      if (query.sort) {
        searchParams.append('sort', query.sort);
        if (query.sort_order) {
          searchParams.append('sort_order', query.sort_order);
        }
      }

      const cacheKey = `search:${searchParams.toString()}:${userToken ? 'auth' : 'anon'}`;
      const cached = getCached(cacheKey);
      if (cached) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
        res.end(JSON.stringify(cached));
        return;
      }

      const apiPath = `/database/search?${searchParams.toString()}`;
      const response = await discogsRequest(apiPath, 'GET', null, null, userToken);

      if (response.statusCode === 200 && response.data) {
        if (Array.isArray(response.data.results)) {
          for (const item of response.data.results) {
            // Strictly check vinyl-specific stats, never all-format total
            const mvKey = `master_vinyl_stats:${item.id || item.master_id}:${userToken ? 'auth' : 'anon'}`;
            const cachedMV = getCached(mvKey);
            if (cachedMV && typeof cachedMV.num_for_sale === 'number') {
              item.num_for_sale = cachedMV.num_for_sale;
              if (typeof cachedMV.versions_count === 'number') {
                item.versionsCount = cachedMV.versions_count;
              }
            }
            const pKeyAuth = `price:${item.id}:auth`;
            const pKeyAnon = `price:${item.id}:anon`;
            const cachedP = getCached(pKeyAuth) || getCached(pKeyAnon);
            if (cachedP && typeof cachedP.num_for_sale === 'number') {
              item.num_for_sale = cachedP.num_for_sale;
            }
          }

          if (type === 'artist' && response.data.results.length > 0) {
            await Promise.all(response.data.results.slice(0, 3).map(async it => {
              if (!it.thumb && !it.cover_image) {
                const img = await fetchDeezerArtistImage(it.title);
                if (img) {
                  it.thumb = img;
                  it.cover_image = img;
                }
              }
            }));
          }
        }
        setCached(cacheKey, response.data, 15 * 60 * 1000);
      }

      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Search failed', details: err.message }));
    }
    return;
  }

  // Master Release Details
  // GET /api/discogs/master/:id
  if (pathname.startsWith('/api/discogs/master/') && !pathname.includes('/versions') && req.method === 'GET') {
    const masterId = pathname.replace('/api/discogs/master/', '');
    const cacheKey = `master:${masterId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      const response = await discogsRequest(`/masters/${masterId}`, 'GET', null, null, userToken);
      if (response.statusCode === 200 && response.data) {
        setCached(cacheKey, response.data, 30 * 60 * 1000);
      }
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch master', details: err.message }));
    }
    return;
  }

  // Master Release Versions (All vinyl pressings of this album!)
  // GET /api/discogs/master/:id/versions?format=Vinyl&page=1&per_page=50
  if (pathname.startsWith('/api/discogs/master/') && pathname.endsWith('/versions') && req.method === 'GET') {
    const parts = pathname.split('/');
    const masterId = parts[parts.length - 2];
    const page = query.page || 1;
    const perPage = Math.min(query.per_page || 50, 100);
    const format = query.format || 'Vinyl';

    const cacheKey = `master_versions:${masterId}:${format}:${page}:${perPage}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      const apiPath = `/masters/${masterId}/versions?format=${encodeURIComponent(format)}&page=${page}&per_page=${perPage}`;
      const response = await discogsRequest(apiPath, 'GET', null, null, userToken);

      if (response.statusCode === 200 && response.data) {
        setCached(cacheKey, response.data, 30 * 60 * 1000);
      }

      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch master versions', details: err.message }));
    }
    return;
  }

  // Artist Releases Endpoint (All canonical albums/releases of an artist)
  // GET /api/discogs/artist/:id/releases?page=1&per_page=100&sort=year&sort_order=desc
  if (pathname.startsWith('/api/discogs/artist/') && pathname.endsWith('/releases') && req.method === 'GET') {
    const parts = pathname.split('/');
    const artistId = parts[parts.length - 2];
    const page = query.page || 1;
    const perPage = Math.min(query.per_page || 100, 100);
    const sort = query.sort || 'year';
    const sortOrder = query.sort_order || 'desc';

    const cacheKey = `artist_releases:${artistId}:${page}:${perPage}:${sort}:${sortOrder}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      const apiPath = `/artists/${artistId}/releases?page=${page}&per_page=${perPage}&sort=${sort}&sort_order=${sortOrder}`;
      const response = await discogsRequest(apiPath, 'GET', null, null, userToken);
      if (response.statusCode === 200 && response.data) {
        setCached(cacheKey, response.data, 2 * 60 * 60 * 1000);
      }
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch artist releases', details: err.message }));
    }
    return;
  }

  // Batch Master Vinyl Editions Count Endpoint
  // GET /api/discogs/masters/versions-counts?ids=13814,5863,6414
  if (pathname === '/api/discogs/masters/versions-counts' && req.method === 'GET') {
    const rawIds = (query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (rawIds.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ counts: {} }));
      return;
    }

    const uniqueIds = Array.from(new Set(rawIds)).slice(0, 50);
    const counts = {};
    const toFetch = [];

    for (const id of uniqueIds) {
      const cacheKey = `master_versions_count:${id}`;
      const cached = getCached(cacheKey);
      if (cached && typeof cached.versions_count === 'number') {
        counts[id] = cached.versions_count;
      } else {
        toFetch.push(id);
      }
    }

    if (toFetch.length > 0) {
      await Promise.all(toFetch.map(async id => {
        try {
          const versResp = await discogsRequest(`/masters/${id}/versions?format=Vinyl&page=1&per_page=1`, 'GET', null, null, userToken, 2, false);
          const versData = versResp.statusCode === 200 && versResp.data ? versResp.data : null;
          let count = versData && versData.pagination && typeof versData.pagination.items === 'number'
            ? versData.pagination.items
            : ((versData && Array.isArray(versData.versions)) ? versData.versions.length : 0);
          if (count > 10000) count = 0;
          counts[id] = count;
          setCached(`master_versions_count:${id}`, { master_id: Number(id), versions_count: count, num_for_sale: count }, 24 * 60 * 60 * 1000);
        } catch (e) {
          counts[id] = 1;
        }
      }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ counts }));
    return;
  }

  // Master Vinyl Editions Count Endpoint
  // GET /api/discogs/master/:id/versions-count OR /api/discogs/master/:id/vinyl-stats
  if (pathname.startsWith('/api/discogs/master/') && (pathname.endsWith('/versions-count') || pathname.endsWith('/vinyl-stats')) && req.method === 'GET') {
    const parts = pathname.split('/');
    const masterId = parts[parts.length - 2];
    const cacheKey = `master_versions_count:${masterId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      // Single fast call with low priority (does not block search or tracklists)
      const versResp = await discogsRequest(`/masters/${masterId}/versions?format=Vinyl&page=1&per_page=1`, 'GET', null, null, userToken, 2, false);
      const versData = versResp.statusCode === 200 && versResp.data ? versResp.data : null;
      let versionsCount = versData && versData.pagination && typeof versData.pagination.items === 'number'
        ? versData.pagination.items
        : ((versData && Array.isArray(versData.versions)) ? versData.versions.length : 0);

      // If Discogs returned global DB count (> 10000) for missing master, clamp to 0
      if (versionsCount > 10000) versionsCount = 0;

      const result = {
        master_id: Number(masterId),
        versions_count: versionsCount,
        num_for_sale: versionsCount
      };

      setCached(cacheKey, result, 24 * 60 * 60 * 1000); // 24 hours cache
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ master_id: Number(masterId), versions_count: 0, num_for_sale: 0 }));
    }
    return;
  }

  // Price stats (Real Discogs Marketplace Stats & Suggestions - No fake numbers)
  if (pathname === '/api/discogs/price-stats' && req.method === 'GET') {
    const releaseId = query.release_id;
    if (!releaseId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'release_id parameter is required' }));
      return;
    }

    const cacheKey = `price:${releaseId}:${userToken ? 'auth' : 'anon'}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      let lowestForSale = null;
      let numForSale = 0;
      let currency = 'USD';

      // 1. Fetch live marketplace stats from Discogs (/marketplace/stats/{releaseId})
      try {
        const statsResp = await discogsRequest(`/marketplace/stats/${releaseId}`, 'GET', null, null, userToken);
        if (statsResp.statusCode === 200 && statsResp.data) {
          numForSale = statsResp.data.num_for_sale || 0;
          if (statsResp.data.lowest_price && typeof statsResp.data.lowest_price.value === 'number') {
            lowestForSale = statsResp.data.lowest_price.value;
            currency = statsResp.data.lowest_price.currency || 'USD';
          }
        }
      } catch (statsErr) {}

      // Fallback to /releases/{releaseId} for lowest_price if stats was empty
      if (lowestForSale === null) {
        try {
          const releaseResp = await discogsRequest(`/releases/${releaseId}`, 'GET', null, null, userToken);
          const releaseData = releaseResp.data || {};
          if (typeof releaseData.lowest_price === 'number') {
            lowestForSale = releaseData.lowest_price;
          }
          if (releaseData.num_for_sale) numForSale = releaseData.num_for_sale;
        } catch (rErr) {}
      }

      // 2. Fetch real price suggestions if token or OAuth available
      let suggestions = null;
      let minPrice = null;
      let medianPrice = null;
      let maxPrice = null;

      try {
        const suggResp = await discogsRequest(`/marketplace/price_suggestions/${releaseId}`, 'GET', null, null, userToken);
        if (suggResp.statusCode === 200 && suggResp.data && !suggResp.data.message) {
          suggestions = suggResp.data;
          const values = [];
          for (const [cond, item] of Object.entries(suggestions)) {
            if (item && typeof item.value === 'number' && item.value > 0) {
              values.push(item.value);
              if (item.currency) currency = item.currency;
            }
          }
          if (values.length > 0) {
            values.sort((a, b) => a - b);
            minPrice = values[0];
            maxPrice = values[values.length - 1];
            if (suggestions['Very Good Plus (VG+)'] && suggestions['Very Good Plus (VG+)'].value) {
              medianPrice = suggestions['Very Good Plus (VG+)'].value;
            } else if (suggestions['Near Mint (NM or M-)'] && suggestions['Near Mint (NM or M-)'].value) {
              medianPrice = suggestions['Near Mint (NM or M-)'].value;
            } else {
              const mid = Math.floor(values.length / 2);
              medianPrice = values.length % 2 !== 0 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
            }
          }
        }
      } catch (suggErr) {}

      // If no price suggestions from Discogs, use real lowest price and DO NOT invent fake multipliers!
      if (minPrice === null && lowestForSale !== null) {
        minPrice = lowestForSale;
      }

      const resultPayload = {
        release_id: releaseId,
        min: minPrice !== null ? parseFloat(Number(minPrice).toFixed(2)) : null,
        median: medianPrice !== null ? parseFloat(Number(medianPrice).toFixed(2)) : null,
        max: maxPrice !== null ? parseFloat(Number(maxPrice).toFixed(2)) : null,
        min_sold: minPrice !== null ? parseFloat(Number(minPrice).toFixed(2)) : null,
        median_sold: medianPrice !== null ? parseFloat(Number(medianPrice).toFixed(2)) : null,
        max_sold: maxPrice !== null ? parseFloat(Number(maxPrice).toFixed(2)) : null,
        has_sold_stats: Boolean(suggestions && Object.keys(suggestions).length > 0),
        currency: currency,
        lowest_price: lowestForSale,
        num_for_sale: numForSale,
        is_estimated: false,
        conditions: suggestions || null
      };

      setCached(cacheKey, resultPayload, 30 * 60 * 1000);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resultPayload));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch price stats', details: err.message }));
    }
    return;
  }

  // Release details
  if (pathname.startsWith('/api/discogs/release/') && req.method === 'GET') {
    const releaseId = pathname.replace('/api/discogs/release/', '');
    const cacheKey = `release:${releaseId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      const response = await discogsRequest(`/releases/${releaseId}`, 'GET', null, null, userToken);
      if (response.statusCode === 200 && response.data) {
        setCached(cacheKey, response.data, 60 * 60 * 1000);
      }
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch release', details: err.message }));
    }
    return;
  }

  // Release or Master Tracklist for Album Tracklist Modal
  if (pathname === '/api/discogs/tracklist' && req.method === 'GET') {
    const id = (query.id || '').trim();
    const type = query.type || 'release'; // 'release' or 'master'
    const qArtist = (query.artist || '').trim();
    const qAlbum = (query.album || query.title || '').trim();

    if (!id && !qAlbum) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'id or album parameter is required' }));
      return;
    }

    const cacheKey = `tracklist:${type}:${id}:${qArtist}:${qAlbum}`;
    const cached = getCached(cacheKey) || (id ? getCached(`tracklist:${type}:${id}`) : null);
    if (cached && Array.isArray(cached.tracklist) && cached.tracklist.length > 0) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      let data = null;
      let resp = null;

      if (id) {
        const apiPath = type === 'master' ? `/masters/${id}` : `/releases/${id}`;
        resp = await discogsRequest(apiPath, 'GET', null, null, userToken, 1, true, true);
        if (resp && resp.statusCode === 200 && resp.data) {
          data = resp.data;
        }

        // Fast auto-fallback if master returned 404/not found: try release, and vice versa!
        if (!data) {
          const altPath = type === 'master' ? `/releases/${id}` : `/masters/${id}`;
          const altResp = await discogsRequest(altPath, 'GET', null, null, userToken, 1, true, true);
          if (altResp && altResp.statusCode === 200 && altResp.data) {
            data = altResp.data;
          }
        }
      }

      let tracklist = [];
      if (data && Array.isArray(data.tracklist)) {
        tracklist = data.tracklist.map((t, idx) => ({
          position: t.position || `${idx + 1}`,
          title: t.title || 'Без названия',
          duration: t.duration || '',
          type_: t.type_ || 'track'
        })).filter(t => t.type_ === 'track' || !t.type_);
      }

      let artistName = (data && data.artists && data.artists[0] && data.artists[0].name) || (data && data.artists_sort) || qArtist || '';
      let albumTitle = (data && data.title) || qAlbum || '';
      let coverUrl = (data && data.images && data.images[0] && data.images[0].resource_url) || (data && data.thumb) || '';
      let albumYear = (data && data.year) || '';

      // If Discogs tracklist is empty, immediately fallback to Spotify / Deezer album tracks!
      let tracklistSource = 'Discogs';
      let discogsNotFound = false;

      if (tracklist.length === 0 && (artistName || albumTitle)) {
        try {
          const spToken = await getSpotifyClientCredentialsToken();
          if (spToken) {
            const cleanArt = artistName.replace(/\s*\(\d+\)$/, '').trim();
            const spQuery = cleanArt ? `album:${albumTitle} artist:${cleanArt}` : albumTitle;
            const spSearchResp = await executeSpotifyHttp(`/v1/search?q=${encodeURIComponent(spQuery)}&type=album&limit=1`, 'GET', null, spToken);
            const spAlbum = spSearchResp.statusCode === 200 && spSearchResp.data?.albums?.items?.[0];
            if (spAlbum && spAlbum.id) {
              if (!coverUrl && spAlbum.images && spAlbum.images[0]) coverUrl = spAlbum.images[0].url;
              if (!albumYear && spAlbum.release_date) albumYear = spAlbum.release_date.substring(0, 4);
              const spTracksResp = await executeSpotifyHttp(`/v1/albums/${spAlbum.id}/tracks?limit=50`, 'GET', null, spToken);
              if (spTracksResp.statusCode === 200 && Array.isArray(spTracksResp.data?.items)) {
                tracklist = spTracksResp.data.items.map((t, idx) => ({
                  position: `${t.track_number || idx + 1}`,
                  title: t.name || 'Без названия',
                  duration: t.duration_ms ? `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, '0')}` : '',
                  previewUrl: t.preview_url || null,
                  artist: t.artists ? t.artists.map(a => a.name).join(', ') : cleanArt,
                  type_: 'track'
                }));
                if (tracklist.length > 0) {
                  tracklistSource = 'Spotify';
                  discogsNotFound = true;
                }
              }
            }
          }
        } catch (spErr) {}

        // Deezer fallback if Spotify didn't find album tracks
        if (tracklist.length === 0) {
          try {
            const cleanArt = artistName.replace(/\s*\(\d+\)$/, '').trim();
            const dzQuery = cleanArt ? `${cleanArt} ${albumTitle}` : albumTitle;
            const dzSearch = await new Promise(resolve => {
              https.get(`https://api.deezer.com/search/album?q=${encodeURIComponent(dzQuery)}&limit=1`, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, resp => {
                let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
              }).on('error', () => resolve(null));
            });
            if (dzSearch && dzSearch.data && dzSearch.data[0] && dzSearch.data[0].id) {
              const foundDzId = dzSearch.data[0].id;
              const dzDetail = await new Promise(resolve => {
                https.get(`https://api.deezer.com/album/${foundDzId}`, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, resp => {
                  let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
                }).on('error', () => resolve(null));
              });
              if (dzDetail && dzDetail.tracks && Array.isArray(dzDetail.tracks.data)) {
                if (!coverUrl) coverUrl = dzDetail.cover_xl || dzDetail.cover_medium || '';
                if (!albumYear && dzDetail.release_date) albumYear = dzDetail.release_date.substring(0, 4);
                tracklist = dzDetail.tracks.data.map((t, idx) => ({
                  position: `${t.track_position || idx + 1}`,
                  title: t.title || 'Без названия',
                  duration: `${Math.floor((t.duration || 0) / 60)}:${String((t.duration || 0) % 60).padStart(2, '0')}`,
                  previewUrl: t.preview || null,
                  artist: t.artist ? t.artist.name : cleanArt,
                  type_: 'track'
                }));
                if (tracklist.length > 0) {
                  tracklistSource = 'Deezer';
                  discogsNotFound = true;
                }
              }
            }
          } catch (dzErr) {}
        }
      }

      const result = {
        id: id || (data && data.id),
        type,
        title: albumTitle,
        artist: artistName.replace(/\s*\(\d+\)$/, ''),
        year: albumYear,
        cover: coverUrl,
        tracklist,
        source: tracklistSource,
        discogsNotFound,
        notice: discogsNotFound ? 'В Discogs треклист не найден — загружен оригинальный треклист Spotify/Deezer' : null
      };

      if (tracklist.length > 0) {
        setCached(cacheKey, result, 30 * 24 * 60 * 60 * 1000); // 30 days cache for static tracklists
        if (id) setCached(`tracklist:${type}:${id}`, result, 30 * 24 * 60 * 60 * 1000);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch tracklist', details: err.message }));
    }
    return;
  }

  // Audio Preview Search (finds playable audio for track via Deezer, Spotify, iTunes)
  if (pathname === '/api/track/preview' && req.method === 'GET') {
    const rawTrack = (query.track || '').trim();
    const rawArtist = (query.artist || '').trim();
    if (!rawTrack) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'track parameter is required' }));
      return;
    }

    const { artist, title, rawTitle, firstPart } = cleanTrackMeta(rawArtist, rawTrack);
    const cacheKey = `preview:${artist.toLowerCase()}:${title.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached && cached.found) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'HIT' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      let foundItem = null;

      const normT = (title || '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
      const normA = (artist || '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');

      function isAccurateMatch(item) {
        if (!item || !item.previewUrl) return false;
        const iT = (item.title || '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
        const iA = (item.artist || '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
        const titleMatches = iT.includes(normT) || normT.includes(iT);
        const artistMatches = !normA || iA.includes(normA) || normA.includes(iA);
        return titleMatches && artistMatches;
      }

      let previewSource = 'Spotify';

      // Tier 1 (HIGHEST PRIORITY): Spotify API search for official track preview
      if (!foundItem && (artist || title)) {
        try {
          const spToken = await getSpotifyClientCredentialsToken();
          if (spToken) {
            const spQuery = artist ? `track:${title} artist:${artist}` : title;
            const spResp = await executeSpotifyHttp(`/v1/search?q=${encodeURIComponent(spQuery)}&type=track&limit=5`, 'GET', null, spToken);
            if (spResp.statusCode === 200 && spResp.data?.tracks?.items) {
              const spTracks = mapSpotifyTracks(spResp.data.tracks.items);
              const matchedSp = spTracks.find(isAccurateMatch) || spTracks.find(t => t.previewUrl);
              if (matchedSp && matchedSp.previewUrl) {
                foundItem = matchedSp;
                previewSource = 'Spotify';
              }
            }
          }
        } catch (spErr) {
          console.warn('Spotify preview search error:', spErr.message);
        }
      }

      // Tier 2: Deezer search with clean artist + clean title
      if (!foundItem && artist && title) {
        const d1 = await executeDeezerTrackSearch(`${artist} ${title}`, 8);
        const m1 = d1.find(isAccurateMatch) || null;
        if (m1) {
          foundItem = m1;
          previewSource = 'Deezer';
        }
      }

      // Tier 3: Deezer with clean artist + firstPart (if multi-track slash)
      if (!foundItem && artist && firstPart && firstPart !== title) {
        const d2 = await executeDeezerTrackSearch(`${artist} ${firstPart}`, 6);
        const m2 = d2.find(isAccurateMatch) || null;
        if (m2) {
          foundItem = m2;
          previewSource = 'Deezer';
        }
      }

      // Tier 4: iTunes / Apple Music search
      if (!foundItem && artist && title) {
        try {
          const it1 = await executeItunesTrackSearch(`${artist} ${title}`, 6);
          const m3 = it1.find(isAccurateMatch) || null;
          if (m3) {
            foundItem = m3;
            previewSource = 'Apple Music';
          }
        } catch (itErr) {}
      }

      // Tier 5: Deezer with title only, requiring artist match
      if (!foundItem && title) {
        const d3 = await executeDeezerTrackSearch(title, 8);
        const m4 = d3.find(isAccurateMatch) || null;
        if (m4) {
          foundItem = m4;
          previewSource = 'Deezer';
        }
      }

      // Tier 6: YouTube fallback (if no 30s preview found in streaming services)
      if (!foundItem && (artist || title)) {
        try {
          const ytRes = await fetchYouTubeVideoInfo(artist, title);
          if (ytRes && ytRes.videoId) {
            foundItem = {
              previewUrl: null,
              youtubeId: ytRes.videoId,
              embedUrl: ytRes.embedUrl,
              title: ytRes.title || title,
              artist: artist,
              isYouTubeFallback: true
            };
            previewSource = 'YouTube (Фрагмент припева)';
          }
        } catch (ytE) {}
      }

      const result = foundItem ? {
        found: true,
        previewUrl: foundItem.previewUrl || null,
        youtubeId: foundItem.youtubeId || null,
        embedUrl: foundItem.embedUrl || null,
        source: previewSource,
        title: foundItem.title,
        artist: foundItem.artist,
        album: foundItem.album,
        coverImage: foundItem.coverImage,
        durationStr: foundItem.durationStr || '0:30'
      } : { found: false };

      if (result.found) {
        setCached(cacheKey, result, 24 * 60 * 60 * 1000); // 24 hours for successful previews
      } else {
        setCached(cacheKey, result, 30 * 1000); // 30s for failures to allow quick recovery
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false, error: err.message }));
    }
    return;
  }
  if (pathname === '/api/discogs/user/identity' && req.method === 'GET') {
    if (!userToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Discogs token required' }));
      return;
    }

    const cacheKey = `identity:${userToken.substring(0, 10)}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }

    try {
      const response = await discogsRequest('/oauth/identity', 'GET', null, null, userToken);
      if (response.statusCode === 200 && response.data) {
        let avatarUrl = null;
        let numCollection = null;
        let numWantlist = null;

        if (response.data.username) {
          try {
            const userProfile = await discogsRequest(`/users/${response.data.username}`, 'GET', null, null, userToken);
            if (userProfile.statusCode === 200 && userProfile.data) {
              avatarUrl = userProfile.data.avatar_url;
              numCollection = userProfile.data.num_collection;
              numWantlist = userProfile.data.num_wantlist;
            }
          } catch (e) {}
        }

        const identityData = {
          valid: true,
          id: response.data.id,
          username: response.data.username,
          resource_url: response.data.resource_url,
          avatar_url: avatarUrl,
          num_collection: numCollection,
          num_wantlist: numWantlist
        };

        setCached(cacheKey, identityData, 30 * 60 * 1000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(identityData));
      } else {
        res.writeHead(response.statusCode || 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: response.data ? response.data.message : 'Invalid token' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Identity check failed', details: err.message }));
    }
    return;
  }

  // Collection Folders
  if (pathname === '/api/discogs/user/folders' && req.method === 'GET') {
    const username = query.username;
    if (!username || !userToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'username and token are required' }));
      return;
    }

    try {
      const response = await discogsRequest(`/users/${username}/collection/folders`, 'GET', null, null, userToken);
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch folders', details: err.message }));
    }
    return;
  }

  // Get User Releases in a Collection Folder (Import from Discogs)
  // GET /api/discogs/user/collection/releases?username=...&folder_id=...&page=1&per_page=50
  if (pathname === '/api/discogs/user/collection/releases' && req.method === 'GET') {
    const username = query.username;
    const folderId = query.folder_id || 0; // 0 is All
    const page = query.page || 1;
    const perPage = Math.min(query.per_page || 50, 100);

    if (!username || !userToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'username and token are required' }));
      return;
    }

    try {
      const apiPath = `/users/${username}/collection/folders/${folderId}/releases?page=${page}&per_page=${perPage}&sort=added&sort_order=desc`;
      const response = await discogsRequest(apiPath, 'GET', null, null, userToken);
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch collection releases', details: err.message }));
    }
    return;
  }

  // Get User Wantlist (Import Wants from Discogs)
  // GET /api/discogs/user/wants?username=...&page=1&per_page=50
  if (pathname === '/api/discogs/user/wants' && req.method === 'GET') {
    const username = query.username;
    const page = query.page || 1;
    const perPage = Math.min(query.per_page || 50, 100);

    if (!username || !userToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'username and token are required' }));
      return;
    }

    try {
      const apiPath = `/users/${username}/wants?page=${page}&per_page=${perPage}&sort=added&sort_order=desc`;
      const response = await discogsRequest(apiPath, 'GET', null, null, userToken);
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch wants', details: err.message }));
    }
    return;
  }

  // Create Collection Folder
  if (pathname === '/api/discogs/user/folders' && req.method === 'POST') {
    const body = await parseRequestBody(req);
    const username = body.username || query.username;
    const folderName = body.folderName;

    if (!username || !folderName || !userToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'username, folderName, and token are required' }));
      return;
    }

    try {
      const response = await discogsRequest(
        `/users/${username}/collection/folders`,
        'POST',
        { name: folderName },
        null,
        userToken
      );
      res.writeHead(response.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response.data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create folder', details: err.message }));
    }
    return;
  }

  // Batch Sync Records
  if (pathname === '/api/discogs/user/sync' && req.method === 'POST') {
    const body = await parseRequestBody(req);
    const username = body.username || query.username;
    const folderId = body.folderId;
    const mode = body.mode || 'collection';
    const releases = body.releases || [];

    if (!username || !userToken || releases.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'username, token, and releases array required' }));
      return;
    }

    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (const item of releases) {
      const releaseId = item.id || item.discogsId;
      if (!releaseId) continue;

      try {
        let resp;
        if (mode === 'wantlist') {
          resp = await discogsRequest(
            `/users/${username}/wants/${releaseId}`,
            'PUT',
            item.notes ? { notes: item.notes } : null,
            null,
            userToken
          );
        } else {
          const targetFolder = folderId || 1;
          resp = await discogsRequest(
            `/users/${username}/collection/folders/${targetFolder}/releases/${releaseId}`,
            'POST',
            null,
            null,
            userToken
          );
        }

        if (resp.statusCode >= 200 && resp.statusCode < 300) {
          successCount++;
          results.push({ id: releaseId, status: 'ok', data: resp.data });
        } else {
          failCount++;
          results.push({ id: releaseId, status: 'failed', statusCode: resp.statusCode, error: resp.data ? resp.data.message : 'Error' });
        }
      } catch (itemErr) {
        failCount++;
        results.push({ id: releaseId, status: 'error', error: itemErr.message });
      }

      if (releases.indexOf(item) < releases.length - 1) {
        await sleep(1100);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total: releases.length,
      successCount,
      failCount,
      results
    }));
    return;
  }

  // Local Storage Records API (Supports type=release, type=album, type=spotify)
  if (pathname === '/api/storage/records' && req.method === 'GET') {
    let targetFile = RELEASES_FILE;
    if (query.type === 'album') targetFile = ALBUMS_FILE;
    else if (query.type === 'spotify') targetFile = SPOTIFY_FILE;

    try {
      const fileData = fs.readFileSync(targetFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fileData || '[]');
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  if (pathname === '/api/storage/records' && req.method === 'POST') {
    let targetFile = RELEASES_FILE;
    let storeType = 'release';
    if (query.type === 'album') { targetFile = ALBUMS_FILE; storeType = 'album'; }
    else if (query.type === 'spotify') { targetFile = SPOTIFY_FILE; storeType = 'spotify'; }

    try {
      const records = await parseRequestBody(req);
      if (Array.isArray(records) || (records && typeof records === 'object')) {
        fs.writeFileSync(targetFile, JSON.stringify(records, null, 2), 'utf8');
        const count = Array.isArray(records) ? records.length : (records.tables ? records.tables.reduce((acc, t) => acc + (t.items?.length || 0), 0) : 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', count, type: storeType }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected JSON array or table object' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ----------------------------------------------------
  // SPOTIFY API INTEGRATION (Mode 3: Songs & Playlists)
  // ----------------------------------------------------
  let spotifyClientToken = null;
  let spotifyClientTokenExpires = 0;

  function getSpotifyClientCredentialsToken(clientId, clientSecret) {
    return new Promise((resolve) => {
      if (spotifyClientToken && Date.now() < spotifyClientTokenExpires) {
        return resolve(spotifyClientToken);
      }
      const stored = loadSpotifyCredentials();
      const cId = (clientId || stored.clientId || process.env.SPOTIFY_CLIENT_ID || '').trim();
      const cSec = (clientSecret || stored.clientSecret || process.env.SPOTIFY_CLIENT_SECRET || '').trim();
      if (!cId || !cSec) return resolve(null);

      const authStr = Buffer.from(`${cId}:${cSec}`).toString('base64');
      const postData = 'grant_type=client_credentials';

      const req = https.request({
        hostname: 'accounts.spotify.com',
        port: 443,
        path: '/api/token',
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authStr}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (resp) => {
        let data = '';
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) {
              spotifyClientToken = json.access_token;
              spotifyClientTokenExpires = Date.now() + (json.expires_in - 60) * 1000;
              resolve(spotifyClientToken);
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.write(postData);
      req.end();
    });
  }

  function executeSpotifyHttp(apiPath, method = 'GET', postData = null, token = null) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'VinylHunterApp/1.0',
        'Accept': 'application/json'
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      if (postData) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(JSON.stringify(postData));
      }

      const options = {
        hostname: 'api.spotify.com',
        port: 443,
        path: apiPath,
        method: method,
        headers: headers
      };

      const req = https.request(options, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            parsed = { raw: data };
          }
          resolve({
            statusCode: resp.statusCode,
            headers: resp.headers,
            data: parsed
          });
        });
      });

      req.on('error', (err) => reject(err));
      if (postData) {
        req.write(JSON.stringify(postData));
      }
      req.end();
    });
  }

  function executeItunesTrackSearch(q, limit = 20) {
    return new Promise((resolve) => {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=${limit}`;
      https.get(itunesUrl, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, (resp) => {
        let data = '';
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const results = (parsed.results || []).map(item => {
              const mins = Math.floor((item.trackTimeMillis || 0) / 60000);
              const secs = Math.floor(((item.trackTimeMillis || 0) % 60000) / 1000);
              const durStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
              const cover = item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '600x600bb') : '';
              return {
                id: 'track_' + item.trackId,
                spotifyId: 'itunes_' + item.trackId,
                title: item.trackName || 'Unknown Title',
                artist: item.artistName || 'Unknown Artist',
                album: item.collectionName || '',
                durationMs: item.trackTimeMillis || 0,
                durationStr: durStr,
                previewUrl: item.previewUrl || null,
                spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent((item.artistName || '') + ' ' + (item.trackName || ''))}`,
                uri: `spotify:search:${encodeURIComponent((item.artistName || '') + ' ' + (item.trackName || ''))}`,
                coverImage: cover,
                releaseDate: item.releaseDate ? item.releaseDate.substring(0, 10) : ''
              };
            });
            resolve(results);
          } catch (e) {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  }

  function mapSpotifyTracks(spotifyItems) {
    return (spotifyItems || []).map(track => {
      const mins = Math.floor((track.duration_ms || 0) / 60000);
      const secs = Math.floor(((track.duration_ms || 0) % 60000) / 1000);
      const durStr = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      const cover = track.album && track.album.images && track.album.images.length > 0
        ? track.album.images[0].url
        : '';
      const artist = track.artists ? track.artists.map(a => a.name).join(', ') : 'Unknown Artist';
      return {
        id: track.id,
        spotifyId: track.id,
        title: track.name,
        artist: artist,
        album: track.album ? track.album.name : '',
        durationMs: track.duration_ms || 0,
        durationStr: durStr,
        previewUrl: track.preview_url || null,
        spotifyUrl: track.external_urls ? track.external_urls.spotify : `https://open.spotify.com/track/${track.id}`,
        uri: track.uri || `spotify:track:${track.id}`,
        coverImage: cover,
        releaseDate: track.album ? track.album.release_date : '',
        type: 'track'
      };
    });
  }

  function mapSpotifyAlbums(spotifyItems) {
    return (spotifyItems || []).map(album => {
      const cover = album.images && album.images.length > 0 ? album.images[0].url : '';
      const artist = album.artists ? album.artists.map(a => a.name).join(', ') : 'Unknown Artist';
      const year = album.release_date ? album.release_date.substring(0, 4) : '';
      return {
        id: album.id,
        spotifyId: album.id,
        title: album.name,
        artist: artist,
        year: year,
        releaseDate: album.release_date || '',
        totalTracks: album.total_tracks || 0,
        coverImage: cover,
        spotifyUrl: album.external_urls ? album.external_urls.spotify : `https://open.spotify.com/album/${album.id}`,
        type: 'album'
      };
    });
  }

  function executeDeezerAlbumSearch(q, limit = 20) {
    return new Promise((resolve) => {
      const deezerUrl = `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&order=RANKING&limit=${limit}`;
      https.get(deezerUrl, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, (resp) => {
        let data = '';
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const results = (parsed.data || []).map(item => {
              const cover = item.cover_xl || item.cover_big || item.cover_medium || item.cover || '';
              const artistName = item.artist ? item.artist.name : 'Unknown Artist';
              return {
                id: 'sp_alb_' + item.id,
                spotifyId: String(item.id),
                title: item.title || '',
                artist: artistName,
                year: item.release_date ? item.release_date.substring(0, 4) : '',
                releaseDate: item.release_date || '',
                totalTracks: item.nb_tracks || 0,
                coverImage: cover,
                spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(artistName + ' ' + (item.title || ''))}`,
                type: 'album'
              };
            });
            resolve(results);
          } catch (e) {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  }

  function executeItunesAlbumSearch(q, limit = 20) {
    return new Promise((resolve) => {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=album&limit=${limit}`;
      https.get(itunesUrl, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, (resp) => {
        let data = '';
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const results = (parsed.results || []).map(item => {
              const cover = item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '600x600bb') : '';
              return {
                id: 'itunes_alb_' + item.collectionId,
                spotifyId: String(item.collectionId),
                title: item.collectionName || '',
                artist: item.artistName || 'Unknown Artist',
                year: item.releaseDate ? item.releaseDate.substring(0, 4) : '',
                releaseDate: item.releaseDate ? item.releaseDate.substring(0, 10) : '',
                totalTracks: item.trackCount || 0,
                coverImage: cover,
                spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent((item.artistName || '') + ' ' + (item.collectionName || ''))}`,
                type: 'album'
              };
            });
            resolve(results);
          } catch (e) {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    });
  }

  // GET /api/spotify/search?q=...&limit=20&type=album|track
  if (pathname === '/api/spotify/search' && req.method === 'GET') {
    const q = query.q || '';
    const searchType = query.type === 'album' ? 'album' : 'track';
    const limit = Math.min(Number(query.limit) || 20, 50);

    if (!q || q.trim().length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [], source: 'empty' }));
      return;
    }

    const cacheKey = `spotify_search_${searchType}_${q.toLowerCase().trim()}_${limit}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }

    const userToken = req.headers['x-spotify-token'] || query.token;
    let effectiveToken = userToken;

    if (!effectiveToken) {
      effectiveToken = await getSpotifyClientCredentialsToken();
    }

    if (effectiveToken) {
      try {
        const resp = await executeSpotifyHttp(
          `/v1/search?q=${encodeURIComponent(q)}&type=${searchType}&limit=${limit}`,
          'GET',
          null,
          effectiveToken
        );

        if (searchType === 'album') {
          if (resp.statusCode === 200 && resp.data && resp.data.albums && resp.data.albums.items) {
            const results = mapSpotifyAlbums(resp.data.albums.items);
            const responsePayload = { source: 'spotify_album', results };
            setCached(cacheKey, responsePayload, 15 * 60 * 1000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
            return;
          }
        } else {
          if (resp.statusCode === 200 && resp.data && resp.data.tracks && resp.data.tracks.items) {
            const results = mapSpotifyTracks(resp.data.tracks.items);
            const responsePayload = { source: 'spotify_track', results };
            setCached(cacheKey, responsePayload, 15 * 60 * 1000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
            return;
          }
        }
      } catch (err) {
        console.warn(`Spotify ${searchType} search failed, falling back to public search:`, err.message);
      }
    }

    // Fallback search to provide real album/song metadata
    if (searchType === 'album') {
      let albumResults = await executeDeezerAlbumSearch(q, limit);
      if (!albumResults || albumResults.length === 0) {
        albumResults = await executeItunesAlbumSearch(q, limit);
      }
      const fallbackPayload = { source: 'fallback_albums', results: albumResults };
      setCached(cacheKey, fallbackPayload, 15 * 60 * 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallbackPayload));
      return;
    } else {
      const itunesResults = await executeItunesTrackSearch(q, limit);
      const fallbackPayload = { source: 'preview_itunes', results: itunesResults };
      setCached(cacheKey, fallbackPayload, 15 * 60 * 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallbackPayload));
      return;
    }
  }

  // GET /api/spotify/album/tracks?id=...&artist=...&album=...
  if (pathname === '/api/spotify/album/tracks' && req.method === 'GET') {
    const rawId = query.id || '';
    const artist = (query.artist || '').trim();
    const album = (query.album || '').trim();

    const cacheKey = `album_tracks_${rawId}_${artist}_${album}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }

    let tracks = [];
    let albumTitle = album;
    let albumArtist = artist;
    let albumCover = '';
    let albumYear = '';

    // 1. If Deezer album ID
    if (rawId.startsWith('sp_alb_')) {
      const dzId = rawId.replace('sp_alb_', '');
      try {
        const dzRes = await new Promise(resolve => {
          https.get(`https://api.deezer.com/album/${dzId}`, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, resp => {
            let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
          }).on('error', () => resolve(null));
        });
        if (dzRes && dzRes.tracks && dzRes.tracks.data) {
          albumTitle = dzRes.title || album;
          albumArtist = dzRes.artist ? dzRes.artist.name : artist;
          albumCover = dzRes.cover_xl || dzRes.cover_medium || '';
          albumYear = dzRes.release_date ? dzRes.release_date.substring(0, 4) : '';
          tracks = dzRes.tracks.data.map((t, idx) => {
            const m = Math.floor((t.duration || 0) / 60);
            const s = (t.duration || 0) % 60;
            return {
              position: `${t.track_position || idx + 1}`,
              title: t.title || 'Без названия',
              duration: `${m}:${s < 10 ? '0' : ''}${s}`,
              previewUrl: t.preview || null,
              artist: t.artist ? t.artist.name : albumArtist
            };
          });
        }
      } catch (e) {}
    }

    // 2. If iTunes album ID
    if (tracks.length === 0 && rawId.startsWith('itunes_alb_')) {
      const itId = rawId.replace('itunes_alb_', '');
      try {
        const itRes = await new Promise(resolve => {
          https.get(`https://itunes.apple.com/lookup?id=${itId}&entity=song`, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, resp => {
            let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
          }).on('error', () => resolve(null));
        });
        if (itRes && itRes.results && itRes.results.length > 1) {
          const albMeta = itRes.results[0];
          albumTitle = albMeta.collectionName || album;
          albumArtist = albMeta.artistName || artist;
          albumCover = albMeta.artworkUrl100 ? albMeta.artworkUrl100.replace('100x100bb', '600x600bb') : '';
          albumYear = albMeta.releaseDate ? albMeta.releaseDate.substring(0, 4) : '';
          tracks = itRes.results.slice(1).map((t, idx) => {
            const ms = t.trackTimeMillis || 0;
            const m = Math.floor(ms / 60000);
            const s = Math.floor((ms % 60000) / 1000);
            return {
              position: `${t.trackNumber || idx + 1}`,
              title: t.trackName || 'Без названия',
              duration: `${m}:${s < 10 ? '0' : ''}${s}`,
              previewUrl: t.previewUrl || null,
              artist: t.artistName || albumArtist
            };
          });
        }
      } catch (e) {}
    }

    // 3. If Spotify native album ID
    if (tracks.length === 0 && rawId && !rawId.startsWith('sp_alb_') && !rawId.startsWith('itunes_alb_') && !rawId.startsWith('master-') && !rawId.startsWith('discogs-')) {
      const cleanSpId = rawId.replace(/^sp-/, '');
      let token = req.headers['x-spotify-token'] || await getSpotifyClientCredentialsToken();
      if (token) {
        try {
          const spResp = await executeSpotifyHttp(`/v1/albums/${cleanSpId}`, 'GET', null, token);
          if (spResp.statusCode === 200 && spResp.data && spResp.data.tracks && spResp.data.tracks.items) {
            albumTitle = spResp.data.name || album;
            albumArtist = spResp.data.artists ? spResp.data.artists.map(a => a.name).join(', ') : artist;
            albumCover = spResp.data.images && spResp.data.images[0] ? spResp.data.images[0].url : '';
            albumYear = spResp.data.release_date ? spResp.data.release_date.substring(0, 4) : '';
            tracks = spResp.data.tracks.items.map((t, idx) => {
              const ms = t.duration_ms || 0;
              const m = Math.floor(ms / 60000);
              const s = Math.floor((ms % 60000) / 1000);
              return {
                position: `${t.track_number || idx + 1}`,
                title: t.name || 'Без названия',
                duration: `${m}:${s < 10 ? '0' : ''}${s}`,
                previewUrl: t.preview_url || null,
                artist: t.artists ? t.artists.map(a => a.name).join(', ') : albumArtist
              };
            });
          }
        } catch (e) {}
      }
    }

    // 4. If still empty, search Deezer by artist + album
    if (tracks.length === 0 && (artist || album)) {
      try {
        const queryTerm = artist && album ? `${artist} ${album}` : (album || artist);
        const dzSearch = await new Promise(resolve => {
          https.get(`https://api.deezer.com/search/album?q=${encodeURIComponent(queryTerm)}&limit=1`, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, resp => {
            let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
          }).on('error', () => resolve(null));
        });
        if (dzSearch && dzSearch.data && dzSearch.data[0] && dzSearch.data[0].id) {
          const foundDzId = dzSearch.data[0].id;
          const dzDetail = await new Promise(resolve => {
            https.get(`https://api.deezer.com/album/${foundDzId}`, { headers: { 'User-Agent': 'VinylHunterApp/1.0' } }, resp => {
              let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
            }).on('error', () => resolve(null));
          });
          if (dzDetail && dzDetail.tracks && dzDetail.tracks.data) {
            albumTitle = dzDetail.title || album;
            albumArtist = dzDetail.artist ? dzDetail.artist.name : artist;
            albumCover = dzDetail.cover_xl || dzDetail.cover_medium || '';
            albumYear = dzDetail.release_date ? dzDetail.release_date.substring(0, 4) : '';
            tracks = dzDetail.tracks.data.map((t, idx) => {
              const m = Math.floor((t.duration || 0) / 60);
              const s = (t.duration || 0) % 60;
              return {
                position: `${t.track_position || idx + 1}`,
                title: t.title || 'Без названия',
                duration: `${m}:${s < 10 ? '0' : ''}${s}`,
                previewUrl: t.preview || null,
                artist: t.artist ? t.artist.name : albumArtist
              };
            });
          }
        }
      } catch (e) {}
    }

    const payload = {
      found: tracks.length > 0,
      title: albumTitle,
      artist: albumArtist,
      cover: albumCover,
      year: albumYear,
      tracklist: tracks
    };

    setCached(cacheKey, payload, 60 * 60 * 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

async function fetchYouTubeVideoInfo(artist, title) {
  const cleanA = (artist || '').replace(/\s*\(\d+\)$/, '').trim();
  let cleanT = (title || '').replace(/^([A-Z]\d*|\d+)[\.\s\-:]+\s*/i, '').trim();
  cleanT = cleanT.replace(/\s*[\(\[](remaster(ed)?|mono|stereo|bonus|deluxe|version|edit|anniversary|single|mix|original|album version)[^\)\]]*[\)\]]/gi, '').trim();

  const queryStr = `${cleanA} ${cleanT} official video`.trim();
  const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(queryStr)}`;

  try {
    const ytHtml = await new Promise(resolve => {
      https.get(ytUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8'
        },
        timeout: 6000
      }, resp => {
        let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d));
      }).on('error', () => resolve(''));
    });

    const videoBlocks = ytHtml.split('"videoRenderer":');
    const candidates = [];

    for (let i = 1; i < Math.min(videoBlocks.length, 8); i++) {
      const b = videoBlocks[i];
      const idM = b.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
      const titleM = b.match(/"title":\{"runs":\[\{"text":"([^"]+)"/);
      if (idM && titleM) {
        candidates.push({
          id: idM[1],
          title: titleM[1].replace(/\\u0026/g, '&')
        });
      }
    }

    if (candidates.length > 0) {
      const normTitle = cleanT.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
      const normArtist = cleanA.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');

      let best = candidates[0];
      let bestScore = -1;

      for (const c of candidates) {
        const cTitleNorm = c.title.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
        let score = 0;
        if (normTitle && cTitleNorm.includes(normTitle)) score += 50;
        if (normArtist && cTitleNorm.includes(normArtist)) score += 30;
        if (c.title.toLowerCase().includes('official')) score += 15;
        if (c.title.toLowerCase().includes('video') || c.title.toLowerCase().includes('clip')) score += 10;
        if (c.title.toLowerCase().includes('audio')) score += 5;

        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }

      return {
        videoId: best.id,
        title: best.title,
        start: 50,
        end: 80,
        embedUrl: `https://www.youtube-nocookie.com/embed/${best.id}?autoplay=1&enablejsapi=1&start=50&end=80`
      };
    }
  } catch (err) {
    console.warn('YouTube search error:', err.message);
  }
  return null;
}

  // GET /api/video/search?artist=...&title=...
  if (pathname === '/api/video/search' && req.method === 'GET') {
    const artist = (query.artist || '').trim();
    const title = (query.title || '').trim();
    const q = `${artist} ${title}`.trim();

    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ found: false }));
      return;
    }

    const cacheKey = `video_search_scored_${q.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cached));
      return;
    }

    let result = { found: false, artist, title };

    try {
      const ytInfo = await fetchYouTubeVideoInfo(artist, title);
      if (ytInfo) {
        result = {
          found: true,
          type: 'youtube',
          source: 'youtube',
          videoId: ytInfo.videoId,
          start: ytInfo.start || 50,
          end: ytInfo.end || 80,
          embedUrl: ytInfo.embedUrl,
          videoTitle: ytInfo.title,
          trackName: title,
          artistName: artist
        };
      }
    } catch (ytErr) {
      console.warn('YouTube video search handler error:', ytErr.message);
    }

    setCached(cacheKey, result, 24 * 60 * 60 * 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/spotify/me
  if (pathname === '/api/spotify/me' && req.method === 'GET') {
    const userToken = req.headers['x-spotify-token'] || query.token;
    if (!userToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Spotify token required' }));
      return;
    }

    try {
      const resp = await executeSpotifyHttp('/v1/me', 'GET', null, userToken);
      res.writeHead(resp.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp.data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // POST /api/spotify/user/playlist (Transfer tracks to a Spotify playlist)
  if (pathname === '/api/spotify/user/playlist' && req.method === 'POST') {
    const userToken = req.headers['x-spotify-token'];
    if (!userToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Spotify authorization token is required to create playlists' }));
      return;
    }

    try {
      const body = await parseRequestBody(req);
      const playlistName = body.name || 'Vinyl Hunter Tracks';
      const trackUris = Array.isArray(body.trackUris) ? body.trackUris : [];

      // 1. Get current user id
      const meResp = await executeSpotifyHttp('/v1/me', 'GET', null, userToken);
      if (meResp.statusCode !== 200 || !meResp.data || !meResp.data.id) {
        res.writeHead(meResp.statusCode || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to verify Spotify user profile', details: meResp.data }));
        return;
      }
      const userId = meResp.data.id;

      // 2. Create playlist
      const createResp = await executeSpotifyHttp(
        `/v1/users/${encodeURIComponent(userId)}/playlists`,
        'POST',
        {
          name: playlistName,
          public: body.isPublic !== false,
          description: 'Экспортировано из трекера винила Vinyl Hunter'
        },
        userToken
      );

      if (createResp.statusCode < 200 || createResp.statusCode >= 300 || !createResp.data || !createResp.data.id) {
        res.writeHead(createResp.statusCode || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create playlist on Spotify', details: createResp.data }));
        return;
      }

      const playlistId = createResp.data.id;
      const playlistUrl = createResp.data.external_urls ? createResp.data.external_urls.spotify : `https://open.spotify.com/playlist/${playlistId}`;

      // 3. Prepare valid spotify:track: URIs (resolving fallback/search URIs if needed)
      const validUris = [];
      for (const rawUri of trackUris) {
        if (typeof rawUri === 'string' && rawUri.startsWith('spotify:track:')) {
          validUris.push(rawUri);
        } else if (typeof rawUri === 'string' && rawUri.trim()) {
          try {
            const cleanQuery = decodeURIComponent(rawUri.replace(/^spotify:search:/, '').replace(/\+/g, ' '));
            const searchResp = await executeSpotifyHttp(
              `/v1/search?q=${encodeURIComponent(cleanQuery)}&type=track&limit=1`,
              'GET',
              null,
              userToken
            );
            if (searchResp.statusCode === 200 && searchResp.data?.tracks?.items?.[0]?.uri) {
              validUris.push(searchResp.data.tracks.items[0].uri);
            }
          } catch (resolveErr) {
            console.warn('Could not resolve track URI on Spotify:', rawUri);
          }
        }
      }

      let addedCount = 0;
      for (let i = 0; i < validUris.length; i += 100) {
        const batch = validUris.slice(i, i + 100);
        const addResp = await executeSpotifyHttp(
          `/v1/playlists/${playlistId}/tracks`,
          'POST',
          { uris: batch },
          userToken
        );
        if (addResp.statusCode >= 200 && addResp.statusCode < 300) {
          addedCount += batch.length;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        playlistId,
        playlistUrl,
        playlistName,
        totalRequested: trackUris.length,
        addedCount
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error during playlist transfer', details: err.message }));
    }
    return;
  }

  // POST /api/spotify/credentials (Save and test Spotify developer keys)
  if (pathname === '/api/spotify/credentials' && req.method === 'POST') {
    try {
      const body = await parseRequestBody(req);
      const clientId = (body.clientId || '').trim();
      const clientSecret = (body.clientSecret || '').trim();

      if (!clientId || !clientSecret) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Укажите оба ключа: Spotify Client ID и Spotify Client Secret' }));
        return;
      }

      // Test credentials with Spotify accounts API
      const authStr = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const postData = 'grant_type=client_credentials';

      const testResult = await new Promise((resolve) => {
        const testReq = https.request({
          hostname: 'accounts.spotify.com',
          port: 443,
          path: '/api/token',
          method: 'POST',
          headers: {
            'Authorization': `Basic ${authStr}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (testRes) => {
          let buf = '';
          testRes.on('data', c => buf += c);
          testRes.on('end', () => {
            try {
              const parsed = JSON.parse(buf);
              resolve({ statusCode: testRes.statusCode, data: parsed });
            } catch (e) {
              resolve({ statusCode: testRes.statusCode, error: buf });
            }
          });
        });
        testReq.on('error', (err) => resolve({ statusCode: 500, error: err.message }));
        testReq.write(postData);
        testReq.end();
      });

      if (testResult.statusCode !== 200 || !testResult.data?.access_token) {
        const msg = testResult.data?.error_description || testResult.data?.error || testResult.error || 'Spotify отклонил ключи (неверный Client ID или Client Secret)';
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Ошибка проверки в Spotify: ${msg}`
        }));
        return;
      }

      // Valid credentials! Save to local JSON config
      saveSpotifyCredentials(clientId, clientSecret);
      spotifyClientToken = testResult.data.access_token;
      spotifyClientTokenExpires = Date.now() + (testResult.data.expires_in - 60) * 1000;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Ключи Spotify Client ID и Secret проверены и успешно сохранены!'
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/spotify/credentials
  if (pathname === '/api/spotify/credentials' && req.method === 'GET') {
    const creds = loadSpotifyCredentials();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      clientId: creds.clientId || '',
      hasSecret: Boolean(creds.clientSecret)
    }));
    return;
  }

  // GET /api/spotify/auth/login
  if (pathname === '/api/spotify/auth/login' && req.method === 'GET') {
    const stored = loadSpotifyCredentials();
    const clientId = (query.client_id || stored.clientId || process.env.SPOTIFY_CLIENT_ID || '').trim();
    const clientSecret = (query.client_secret || stored.clientSecret || process.env.SPOTIFY_CLIENT_SECRET || '').trim();

    if (!clientId) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Ошибка: Client ID не указан. Введите Spotify Client ID в настройках приложения.</h3><a href="/">Назад</a>');
      return;
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
    const defaultCallback = `${protocol}://${host}/api/spotify/auth/callback`;
    const redirectUri = query.redirect_uri || defaultCallback;

    const state = crypto.randomBytes(16).toString('hex');
    spotifyOAuthSessions.set(state, {
      clientId,
      clientSecret,
      redirectUri,
      createdAt: Date.now()
    });

    // Cleanup old sessions (> 30 mins)
    for (const [k, v] of spotifyOAuthSessions.entries()) {
      if (Date.now() - v.createdAt > 30 * 60 * 1000) {
        spotifyOAuthSessions.delete(k);
      }
    }

    const scope = encodeURIComponent('playlist-modify-public playlist-modify-private user-read-private');
    const authUrl = `https://accounts.spotify.com/authorize?client_id=${encodeURIComponent(clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${encodeURIComponent(state)}&show_dialog=true`;
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }

  // GET /api/spotify/auth/callback
  if (pathname === '/api/spotify/auth/callback' && req.method === 'GET') {
    const code = query.code;
    const state = query.state;
    const error = query.error;

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h3>Ошибка авторизации Spotify: ${escapeHtml(error)}</h3><p><a href="/">Вернуться в приложение</a></p>`);
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Ошибка: отсутствует параметр code или state</h3><p><a href="/">Вернуться в приложение</a></p>');
      return;
    }

    const session = spotifyOAuthSessions.get(state);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Сессия авторизации не найдена или устарела. Попробуйте войти снова.</h3><p><a href="/">Вернуться</a></p>');
      return;
    }

    spotifyOAuthSessions.delete(state);

    const stored = loadSpotifyCredentials();
    const clientId = session.clientId || stored.clientId;
    const clientSecret = session.clientSecret || stored.clientSecret;
    const redirectUri = session.redirectUri;

    if (!clientSecret) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Ошибка: отсутствует Spotify Client Secret для обмена токена. Укажите Client Secret в настройках.</h3><p><a href="/">Вернуться</a></p>');
      return;
    }

    try {
      const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const postBody = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

      const tokenResp = await new Promise((resolve, reject) => {
        const reqPost = https.request({
          hostname: 'accounts.spotify.com',
          port: 443,
          path: '/api/token',
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postBody)
          }
        }, (resToken) => {
          let buf = '';
          resToken.on('data', d => buf += d);
          resToken.on('end', () => {
            try {
              const parsed = JSON.parse(buf);
              resolve({ statusCode: resToken.statusCode, data: parsed });
            } catch (e) {
              reject(new Error('Invalid JSON from Spotify token: ' + buf));
            }
          });
        });
        reqPost.on('error', reject);
        reqPost.write(postBody);
        reqPost.end();
      });

      if (tokenResp.statusCode !== 200 || !tokenResp.data?.access_token) {
        const errMsg = tokenResp.data?.error_description || tokenResp.data?.error || 'Не удалось получить токен доступа';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h3>Ошибка обмена токена Spotify:</h3><p>${escapeHtml(errMsg)}</p><p><a href="/">Вернуться</a></p>`);
        return;
      }

      const accessToken = tokenResp.data.access_token;
      const refreshToken = tokenResp.data.refresh_token || '';

      // Prefetch user profile
      let userData = null;
      try {
        const meResp = await executeSpotifyHttp('/v1/me', 'GET', null, accessToken);
        if (meResp.statusCode === 200) {
          userData = meResp.data;
        }
      } catch (errProfile) {
        console.warn('Could not prefetch Spotify user profile:', errProfile.message);
      }

      const safeToken = JSON.stringify(accessToken);
      const safeRefreshToken = JSON.stringify(refreshToken);
      const safeUser = JSON.stringify(userData || {});

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Авторизация в Spotify успешна</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121212; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e1e1e; padding: 32px; border-radius: 12px; text-align: center; max-width: 440px; border: 1px solid #1ed760; box-shadow: 0 8px 30px rgba(30,215,96,0.25); }
    .btn { background: #1ed760; color: #000; font-weight: 700; border: none; padding: 12px 28px; border-radius: 24px; text-decoration: none; cursor: pointer; display: inline-block; margin-top: 16px; font-size: 15px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 44px; margin-bottom: 8px;">🟢</div>
    <h2 style="color:#1ed760; margin-top:0;">Spotify успешно подключен!</h2>
    <p style="color:#b3b3b3; line-height: 1.5;">Авторизация пройдена успешно. Возвращаем вас в приложение...</p>
    <a href="/" class="btn" id="btnContinue">Продолжить работу</a>
  </div>
  <script>
    try {
      localStorage.setItem('spotify_user_token', ${safeToken});
      if (${safeRefreshToken}) {
        localStorage.setItem('spotify_refresh_token', ${safeRefreshToken});
      }
      if (${safeUser} && ${safeUser}.id) {
        localStorage.setItem('spotify_user_data', JSON.stringify(${safeUser}));
      }
    } catch (e) {
      console.error(e);
    }
    setTimeout(function() {
      window.location.href = '/?spotify_auth_success=1#access_token=' + encodeURIComponent(${safeToken});
    }, 1200);
  </script>
</body>
</html>`);
      return;
    } catch (errEx) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h3>Ошибка сервера при обмене токена Spotify:</h3><p>${escapeHtml(errEx.message)}</p><p><a href="/">Вернуться</a></p>`);
      return;
    }
  }

  // ----------------------------------------------------
  // STATIC FILE SERVING
  // ----------------------------------------------------
  let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexPath = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(indexPath, (indexErr, content) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404 Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Internal Server Error');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Vinyl Hunter Server is running on http://localhost:${PORT}`);
});

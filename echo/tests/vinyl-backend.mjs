import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

class ApiError extends Error { constructor(status, code, message, extra) { super(message); Object.assign(this, { status, code, extra }); } }
function load(file, imports, globals = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; }, Date, Math, JSON, Set, Map, Uint8Array, TextEncoder, TextDecoder, URL, URLSearchParams, Request, Response, Headers, AbortSignal, crypto: webcrypto, btoa, atob, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout, ...globals });
  return module.exports;
}
function request(owner, path, payload, method = payload ? 'POST' : 'GET') { return new Request(`https://echo.test/api/vinyl/legacy/${path}`, { method, headers: { 'x-owner': owner, origin: 'https://echo.test', 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) }); }
function harness(handler = async () => new Response('{}')) {
  const db = new DatabaseSync(':memory:');
  for (const migration of fs.readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), 'utf8'));
  const database = { prepare(sql) { return { bind(...args) { return { async first() { return db.prepare(sql).get(...args) || null; }, async run() { return db.prepare(sql).run(...args); } }; } }; } };
  const http = { ApiError, database: () => database, runtime: () => ({ SESSION_ENCRYPTION_KEY: 'A secure encryption key for integration tests 123' }), identity: request => { const id = request.headers.get('x-owner'); if (!id) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in'); return { id }; }, csrf: async request => { if (request.headers.get('origin') !== new URL(request.url).origin) throw new ApiError(403, 'ORIGIN_MISMATCH', 'Blocked'); }, body: async request => request.json(), json: (value, status = 200, headers) => Response.json(value, { status, headers }) };
  const secrets = load('lib/server/secrets.ts', { './http': http });
  const calls = [];
  const api = load('lib/server/vinyl.ts', { './http': http, './secrets': secrets }, { fetch: async (url, options = {}) => { calls.push({ url: String(url), options }); return handler(String(url), options); } });
  return { db, api, secrets, calls, dispatch: (owner, path, payload, method) => api.legacyVinylRequest(request(owner, path, payload, method), path.split('?')[0].split('/')) };
}
function table(items = []) { return [{ id: 'albums-one', name: 'Favorites', items }]; }
const album = { id: 'master-123', masterId: 123, artist: 'Queen', title: 'A Night at the Opera', coverImage: 'https://e-cdns-images.dzcdn.net/images/cover/a.jpg' };

test('vinyl storage is owner isolated and release/album/spotify modes remain independent', async () => {
  const h = harness(); try {
    const initial = await h.api.readVinylTables('alice', 'albums'); assert.equal(initial.version, 0);
    await h.api.saveVinylTables('alice', 'albums', { tables: table([album]), version: 0, userAction: true });
    assert.equal((await h.api.readVinylTables('alice', 'albums')).tables[0].items.length, 1);
    assert.equal((await h.api.readVinylTables('bob', 'albums')).tables.length, 0);
    assert.equal((await h.api.readVinylTables('alice', 'releases')).tables.length, 0);
    assert.equal((await h.api.readVinylTables('alice', 'spotify')).tables.length, 0);
  } finally { h.db.close(); }
});
test('stale saves cannot delete an album added while the tracker was open', async () => {
  const h = harness(); try {
    const old = await h.api.readVinylTables('alice', 'albums');
    await h.api.addVinylAlbum('alice', album);
    await assert.rejects(h.api.saveVinylTables('alice', 'albums', { tables: [], version: old.version, userAction: true, forceSave: true }), error => error.code === 'VINYL_CONFLICT');
    const current = await h.api.readVinylTables('alice', 'albums'); assert.equal(current.tables[0].items.length, 1);
    await h.api.saveVinylTables('alice', 'albums', { tables: [], version: current.version, userAction: true });
    assert.equal((await h.api.readVinylTables('alice', 'albums')).tables.length, 0);
  } finally { h.db.close(); }
});
test('concurrent album additions use CAS retries and create exactly one record', async () => {
  const h = harness(); try {
    const results = await Promise.all(Array.from({ length: 5 }, () => h.api.addVinylAlbum('alice', album)));
    assert.equal(results.filter(result => result.added).length, 1);
    assert.equal((await h.api.readVinylTables('alice', 'albums')).tables[0].items.length, 1);
    const duplicate = await h.api.addVinylAlbum('alice', { ...album, id: 'discogs-789', masterId: undefined, discogsId: 789, artist: 'QUEEN', title: 'A Night At The Opera' });
    assert.equal(duplicate.added, false);
    await h.api.addVinylAlbum('bob', album); assert.equal((await h.api.readVinylTables('bob', 'albums')).tables[0].items.length, 1);
  } finally { h.db.close(); }
});
test('a missing requested table never silently routes an album to another table', async () => {
  const h = harness(); try { await assert.rejects(h.api.addVinylAlbum('alice', album, 'deleted-table'), error => error.code === 'VINYL_TABLE_NOT_FOUND'); assert.equal((await h.api.readVinylTables('alice', 'albums')).tables.length, 0); } finally { h.db.close(); }
});
test('Discogs token is tested and encrypted with owner AAD; responses never expose it', async () => {
  const token = 'secret_personal_token_1234567890';
  const h = harness(async url => { assert.equal(url, 'https://api.discogs.com/oauth/identity'); return Response.json({ id: 11, username: 'collector' }); });
  try {
    const result = await h.dispatch('alice', 'discogs/connection', { token }); assert.equal((await result.json()).connected, true);
    const row = h.db.prepare('SELECT encrypted_connection FROM echo_vinyl_connections WHERE user_id = ?').get('alice'); assert.ok(!row.encrypted_connection.includes(token));
    await assert.rejects(h.secrets.decryptSecret(row.encrypted_connection, 'vinyl:discogs:bob'));
    const status = await (await h.dispatch('alice', 'discogs/connection')).json(); assert.equal(status.user.username, 'collector'); assert.ok(!JSON.stringify(status).includes(token));
    assert.equal((await (await h.dispatch('bob', 'discogs/connection')).json()).connected, false);
    await assert.rejects(h.api.discogsJson(request('bob', 'status'), '/database/search?q=Queen'), error => error.code === 'DISCOGS_NOT_CONNECTED');
  } finally { h.db.close(); }
});
test('Discogs search uses a fixed host and cannot proxy another URL', async () => {
  const h = harness(async url => url.endsWith('/oauth/identity') ? Response.json({ username: 'collector' }) : Response.json({ results: [{ id: 123 }] }));
  try {
    await h.dispatch('alice', 'discogs/connection', { token: 'secret_personal_token_1234567890' });
    const result = await (await h.dispatch('alice', 'discogs/search?q=Queen&type=release&page=2&per_page=25')).json(); assert.equal(result.results[0].id, 123);
    assert.match(h.calls.at(-1).url, /^https:\/\/api\.discogs\.com\/database\/search\?/); assert.match(h.calls.at(-1).url, /format=Vinyl/);
    await assert.rejects(h.api.discogsJson(request('alice', 'status'), 'https://evil.test/'), error => error.code === 'INVALID_DISCOGS_PATH');
    await assert.rejects(h.api.discogsJson(request('alice', 'status'), '/users/a/../../admin'), error => error.code === 'INVALID_DISCOGS_PATH');
  } finally { h.db.close(); }
});
test('collection and wantlist sync always target the connected Discogs identity', async () => {
  const h = harness(async url => url.endsWith('/oauth/identity') ? Response.json({ username: 'collector' }) : Response.json({ id: 456 }));
  try {
    await h.dispatch('alice', 'discogs/connection', { token: 'secret_personal_token_1234567890' });
    const result = await (await h.dispatch('alice', 'discogs/user/sync', { username: 'someone-else', mode: 'wantlist', releases: [{ id: 456, notes: 'Near mint' }] })).json(); assert.equal(result.successCount, 1);
    assert.equal(h.calls.at(-1).url, 'https://api.discogs.com/users/collector/wants/456'); assert.equal(h.calls.at(-1).options.method, 'PUT');
  } finally { h.db.close(); }
});
test('missing Discogs prices and vinyl statistics are never invented', async () => {
  const h = harness(async url => {
    if (url.endsWith('/oauth/identity')) return Response.json({ username: 'collector' });
    if (url.includes('/marketplace/stats/')) return Response.json({ num_for_sale: 3, lowest_price: { value: 12, currency: 'EUR' } });
    if (url.includes('/price_suggestions/')) return Response.json({ message: 'No suggestions' }, { status: 404 });
    return Response.json({ pagination: { items: 100 }, versions: [{ id: 1, format: 'Vinyl, LP' }, { id: 2, format: 'CD, Album' }] });
  });
  try {
    await h.dispatch('alice', 'discogs/connection', { token: 'secret_personal_token_1234567890' });
    const price = await (await h.dispatch('alice', 'discogs/price-stats?release_id=456')).json(); assert.equal(price.min, 12); assert.equal(price.median, null); assert.equal(price.max, null); assert.equal(price.min_sold, null); assert.equal(price.has_sold_stats, false);
    const stats = await (await h.dispatch('alice', 'discogs/master/123/vinyl-stats')).json(); assert.equal(stats.versions_count, 1); assert.equal(stats.count_complete, false); assert.equal(stats.num_for_sale, null);
    const versions = await (await h.dispatch('alice', 'discogs/master/123/versions')).json(); assert.equal(versions.versions.length, 1);
  } finally { h.db.close(); }
});
test('media proxy rejects private hosts, deceptive hosts, credentials and unsafe redirects', async () => {
  const h = harness(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
  try {
    for (const url of ['http://127.0.0.1/a', 'https://localhost/a', 'https://discogs.com.evil.test/a', 'https://evil-discogs.com/a', 'https://u:p@i.discogs.com/a', 'https://i.discogs.com:8443/a']) assert.throws(() => h.api.approvedVinylMedia(url, 'image'), error => error.code === 'MEDIA_HOST_NOT_ALLOWED');
    const response = h.dispatch('alice', `image-proxy?url=${encodeURIComponent('https://i.discogs.com/a.jpg')}`); await assert.rejects(response, error => error.code === 'MEDIA_HOST_NOT_ALLOWED'); assert.equal(h.calls.length, 1);
    assert.ok(!new Headers(h.calls[0].options.headers).has('authorization'));
  } finally { h.db.close(); }
});
test('status exposes only authenticated owner ID and rejected origins cannot save', async () => {
  const h = harness(); try {
    const status = await (await h.dispatch('alice', 'status')).json(); assert.equal(status.userId, 'alice');
    const bad = new Request('https://echo.test/api/vinyl/legacy/storage/records', { method: 'POST', headers: { 'x-owner': 'alice', origin: 'https://evil.test', 'content-type': 'application/json' }, body: '{}' });
    await assert.rejects(h.api.legacyVinylRequest(bad, ['storage', 'records']), error => error.code === 'ORIGIN_MISMATCH');
    await assert.rejects(h.api.legacyVinylRequest(new Request('https://echo.test/api/vinyl/legacy/status'), ['status']), error => error.code === 'AUTH_REQUIRED');
  } finally { h.db.close(); }
});
test('public metadata fallback requires the same album and artist, never arbitrary first result', async () => {
  const h = harness(async url => {
    if (url.includes('/search/album')) return Response.json({ data: [{ id: 1, title: 'Wrong Album', artist: { name: 'Other Artist' } }, { id: 2, title: 'Correct Album', artist: { name: 'Queen' } }] });
    if (url.includes('itunes.apple.com/search')) return Response.json({ results: [] });
    if (url.endsWith('/album/2')) return Response.json({ title: 'Correct Album', artist: { name: 'Queen' }, tracks: { data: [{ title: 'Correct Song', artist: { name: 'Queen' }, preview: 'https://cdns-preview.dzcdn.net/a.mp3', duration: 60 }] } });
    throw new Error(`Unexpected URL ${url}`);
  });
  try {
    const result = await (await h.dispatch('alice', 'spotify/album/tracks?artist=Queen&album=Correct%20Album')).json(); assert.equal(result.title, 'Correct Album'); assert.equal(result.tracklist[0].title, 'Correct Song'); assert.equal(h.calls.some(call => call.url.endsWith('/album/1')), false);
  } finally { h.db.close(); }
});
test('OAuth signatures follow the RFC sample rather than exposing consumer secrets', async () => {
  const h = harness(); try {
    const header = await h.api.discogsOAuthHeader('http://photos.example.net/photos?file=vacation.jpg&size=original', 'GET', { consumerKey: 'dpf43f3p2l4k3l03', consumerSecret: 'kd94hf93k423kf44', oauthToken: 'nnch734d00sl2jdk', oauthTokenSecret: 'pfkkdhi9sl3r4s00' }, { oauth_timestamp: '1191242096', oauth_nonce: 'kllo9940pd9333jh' });
    assert.ok(header.includes('oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"')); assert.ok(!header.includes('kd94hf93k423kf44')); assert.ok(!header.includes('pfkkdhi9sl3r4s00'));
  } finally { h.db.close(); }
});
test('Discogs OAuth cookies bind callback to owner and saved consumer, no URL secrets', async () => {
  const h = harness(async url => {
    if (url.endsWith('/oauth/request_token')) return new Response('oauth_token=request_token_123&oauth_token_secret=request_secret_456&oauth_callback_confirmed=true');
    if (url.endsWith('/oauth/access_token')) return new Response('oauth_token=access_token_789&oauth_token_secret=access_secret_456');
    if (url.endsWith('/oauth/identity')) return Response.json({ username: 'collector', id: 42 });
    throw new Error(url);
  });
  try {
    const consumerKey = 'test_consumer_123', consumerSecret = 'test_consumer_secret_456';
    const configured = await (await h.dispatch('alice', 'discogs/connection', { consumerKey, consumerSecret })).json(); assert.equal(configured.oauthConfigured, true); assert.equal(configured.connected, false);
    const login = await h.dispatch('alice', 'discogs/auth/login'); assert.equal(login.status, 302); assert.ok(login.headers.get('location').includes('oauth_token=request_token_123')); assert.ok(!login.headers.get('location').includes(consumerSecret));
    const cookie = login.headers.get('set-cookie').split(';')[0], cipher = cookie.slice(cookie.indexOf('=') + 1), session = await h.secrets.decryptSecret(cipher, 'vinyl:discogs-oauth:alice');
    const url = `https://echo.test/api/vinyl/legacy/discogs/auth/callback?state=${session.state}&oauth_token=request_token_123&oauth_verifier=verified`;
    await assert.rejects(h.api.legacyVinylRequest(new Request(url, { headers: { 'x-owner': 'bob', cookie } }), ['discogs', 'auth', 'callback']), error => ['DISCOGS_OAUTH_NOT_CONFIGURED', 'OAUTH_STATE_INVALID'].includes(error.code));
    const finished = await h.api.legacyVinylRequest(new Request(url, { headers: { 'x-owner': 'alice', cookie } }), ['discogs', 'auth', 'callback']); assert.match(await finished.text(), /echo-vinyl-discogs-connected/);
    const connected = await (await h.dispatch('alice', 'discogs/connection')).json(); assert.equal(connected.connected, true); assert.equal(connected.user.username, 'collector'); assert.ok(!JSON.stringify(connected).includes('access_token_789'));
    const ciphertext = h.db.prepare('SELECT encrypted_connection FROM echo_vinyl_connections WHERE user_id = ? AND provider = ?').get('alice', 'discogs').encrypted_connection; assert.ok(!ciphertext.includes(consumerSecret)); assert.ok(!ciphertext.includes('access_secret_456'));
  } finally { h.db.close(); }
});
test('Spotify manual token stays encrypted and protected by owner identity', async () => {
  const token = 'spotify_private_token_1234567890';
  const h = harness(async url => { assert.equal(url, 'https://api.spotify.com/v1/me'); return Response.json({ id: 'collector', display_name: 'Collector' }); });
  try {
    const connected = await (await h.dispatch('alice', 'spotify/connection', { token })).json(); assert.equal(connected.connected, true);
    const status = await (await h.dispatch('alice', 'spotify/connection')).json(); assert.equal(status.user.id, 'collector'); assert.ok(!JSON.stringify(status).includes(token));
    const me = await (await h.dispatch('alice', 'spotify/me')).json(); assert.equal(me.id, 'collector');
    await assert.rejects(h.dispatch('bob', 'spotify/me'), error => error.code === 'SPOTIFY_LOGIN_REQUIRED');
    const ciphertext = h.db.prepare('SELECT encrypted_connection FROM echo_vinyl_connections WHERE user_id = ? AND provider = ?').get('alice', 'spotify').encrypted_connection; assert.ok(!ciphertext.includes(token));
  } finally { h.db.close(); }
});
test('public Discogs details need no key, while database search and account mutations still require one', async () => {
  const h = harness(async (_url, options) => { assert.ok(!new Headers(options.headers).has('authorization')); return Response.json({ id: 123, title: 'A Night at the Opera', formats: [{ name: 'Vinyl' }] }); });
  try {
    const detail = await h.api.discogsJson(request('alice', 'status'), '/releases/123'); assert.equal(detail.id, 123);
    for (const [path, options] of [['/database/search?q=Queen', {}], ['/oauth/identity', {}], ['/marketplace/stats/123', {}], ['/users/collector/wants/123', { method: 'PUT' }], ['/releases/123', { method: 'POST' }]]) await assert.rejects(h.api.discogsJson(request('alice', 'status'), path, options), error => error.code === 'DISCOGS_NOT_CONNECTED');
    assert.equal(h.calls.length, 1);
  } finally { h.db.close(); }
});
test('missing imported cover resolves the correct remastered album, redirects to an approved real CDN and caches public metadata', async () => {
  const h = harness(async url => {
    if (url.includes('/search/album')) return Response.json({data:[{id:123,title:'The Miracle (Deluxe Edition)',artist:{name:'Queen'},cover_big:'https://cdn-images.dzcdn.net/images/cover/real.jpg'},{id:999,title:'The Miracle',artist:{name:'Other'},cover_big:'https://cdn-images.dzcdn.net/images/cover/wrong.jpg'}]});
    if (url.includes('itunes.apple.com/search')) return Response.json({results:[]});
    throw new Error('Cover endpoint must not download the image server-side');
  });
  try {
    const response=await h.dispatch('alice','cover-image?artist=Queen&album=The%20Miracle');
    assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://cdn-images.dzcdn.net/images/cover/real.jpg');
    assert.equal(h.calls.length,2);const second=await h.dispatch('alice','cover-image?artist=Queen&album=The%20Miracle');assert.equal(second.status,302);assert.equal(h.calls.length,2);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM echo_media_collections WHERE id LIKE 'vinyl-albums-v2:%'").get().n,1);
  }finally{h.db.close();}
});
test('quiz album listens directly by its Deezer album ID, includes album previews and never confuses the ID with a Discogs master', async () => {
  const h=harness(async url=>{
    assert.equal(url,'https://api.deezer.com/album/456');
    return Response.json({id:456,title:'A Night At The Opera',artist:{name:'Queen'},cover_big:'https://cdn-images.dzcdn.net/cover.jpg',tracks:{data:[{id:123,title:'Bohemian Rhapsody',duration:354,preview:'https://cdns-preview.dzcdn.net/actual.mp3'}]}});
  });
  try{const data=await(await h.dispatch('alice','discogs/tracklist?id=999&type=master&deezerAlbumId=456&artist=Queen&album=A%20Night%20At%20The%20Opera')).json();assert.equal(data.source,'Deezer');assert.equal(data.tracklist[0].title,'Bohemian Rhapsody');assert.equal(data.tracklist[0].artist,'Queen');assert.equal(data.tracklist[0].previewUrl,'https://cdns-preview.dzcdn.net/actual.mp3');assert.equal(h.calls.length,1);}finally{h.db.close();}
});
test('album matching does not substitute a live recording or an arbitrary album with an overlapping title', async () => {
  const h=harness(async url=>url.includes('/search/album')?Response.json({data:[{id:1,title:'The Dark Side of the Moon (Live at Wembley)',artist:{name:'Pink Floyd'},cover_big:'https://cdn-images.dzcdn.net/wrong.jpg'},{id:2,title:'The Dark Side of the Moon Tribute',artist:{name:'Pink Floyd'},cover_big:'https://cdn-images.dzcdn.net/wrong2.jpg'}]}):Response.json({results:[]}));
  try{const response=await h.dispatch('alice','cover-image?artist=Pink%20Floyd&album=The%20Dark%20Side%20of%20the%20Moon');assert.equal(response.status,404);assert.equal(response.headers.get('location'),null);}finally{h.db.close();}
});
test('an imported pressing outside digital catalogs loads its actual Discogs primary image by stored master ID', async () => {
  const h=harness(async url=>{
    if(url.includes('/search/album'))return Response.json({data:[]});
    if(url.includes('itunes.apple.com/search'))return Response.json({results:[]});
    assert.equal(url,'https://api.discogs.com/masters/999');return Response.json({id:999,title:'Rare Album',artists:[{name:'Known Artist'}],images:[{type:'secondary',uri:'https://i.discogs.com/secondary.jpg'},{type:'primary',uri:'https://i.discogs.com/primary.jpg',resource_url:'https://api.discogs.com/images/metadata'}]});
  });
  try{const response=await h.dispatch('alice','cover-image?artist=Known%20Artist&album=Rare%20Album&masterId=999');assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://i.discogs.com/primary.jpg');}finally{h.db.close();}
});
test('album playback follows every trusted album track page, upgrading Deezer legacy HTTP pagination to HTTPS', async () => {
  const h=harness(async url=>{
    if(url==='https://api.deezer.com/album/456')return Response.json({id:456,title:'Large Album',artist:{name:'Queen'},tracks:{data:[{id:1,title:'First',preview:'https://cdns-preview.dzcdn.net/1.mp3'}],next:'http://api.deezer.com/album/456/tracks?index=1'}});
    assert.equal(url,'https://api.deezer.com/album/456/tracks?index=1');return Response.json({data:[{id:2,title:'Second',preview:'https://cdns-preview.dzcdn.net/2.mp3'}]});
  });
  try{const data=await(await h.dispatch('alice','discogs/tracklist?deezerAlbumId=456')).json();assert.deepEqual(data.tracklist.map(track=>track.title),['First','Second']);assert.equal(h.calls.length,2);}finally{h.db.close();}
});

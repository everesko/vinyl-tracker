import { ApiError, body, csrf, database, identity, json } from './http';
import { decryptSecret, encryptSecret, encryptionAvailable } from './secrets';

type JsonRecord = Record<string, any>;
export type VinylMode = 'albums' | 'releases' | 'spotify';
export type VinylTable = { id: string; name: string; isCollapsed: boolean; items: JsonRecord[]; [key: string]: unknown };
export type VinylTables = { tables: VinylTable[]; updatedAt: number; version: number };
const names: Record<VinylMode, string> = { albums: 'Каталог альбомів', releases: 'Моя колекція', spotify: 'Мої пісні' };
const MAX_STORAGE = 2 * 1024 * 1024;
const cache = new Map<string, { expires: number; data: any }>();
const pending = new Map<string, Promise<any>>();
const ownerNextRequest = new Map<string, number>();
const userAgent = 'EchoVinyl/1.0 (+https://schallplatten.pp.ua)';
function cached(key: string) { const value = cache.get(key); if (value && value.expires > Date.now()) return value.data; cache.delete(key); }
function remember(key: string, data: any, ttl = 900000) { if (cache.size >= 500) cache.delete(cache.keys().next().value!); cache.set(key, { data, expires: Date.now() + ttl }); return data; }
function text(value: unknown, max = 300) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function number(value: unknown, fallback = 1, max = 100) { const n = Number(value); return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback; }
function id(value: unknown) { const s = String(value ?? ''); if (!/^[1-9][0-9]{0,11}$/.test(s)) throw new ApiError(400, 'INVALID_DISCOGS_ID', 'Неправильний ідентифікатор Discogs.'); return s; }
function normal(value: unknown) { return text(value, 1000).normalize('NFKD').toLocaleLowerCase().replace(/\p{M}/gu, '').replace(/\s*\(\d+\)$/, '').replace(/[^\p{L}\p{N}]/gu, ''); }
function query(params: URLSearchParams, allowed: string[]) { const output = new URLSearchParams(); for (const name of allowed) { const value = params.get(name); if (value) output.set(name, value.slice(0, 500)); } return output; }
function mode(value: string | null): VinylMode { return value === 'album' || value === 'albums' ? 'albums' : value === 'spotify' ? 'spotify' : 'releases'; }

export function validateVinylTables(value: unknown, targetMode: VinylMode): VinylTable[] {
  let source: unknown = value;
  if (source && typeof source === 'object' && !Array.isArray(source)) source = (source as JsonRecord).tables;
  if (!Array.isArray(source)) throw new ApiError(400, 'INVALID_VINYL_TABLES', 'Очікуються таблиці з альбомами.');
  // Older tracker exports were a flat array of records.
  if (source.length && source[0] && typeof source[0] === 'object' && !Array.isArray(source[0]) && !('items' in source[0])) source = [{ id: `tbl_${targetMode}_default`, name: names[targetMode], items: source }];
  const tables = source as JsonRecord[];
  if (tables.length > 200) throw new ApiError(413, 'VINYL_STORAGE_TOO_LARGE', 'Забагато таблиць.');
  let count = 0; const ids = new Set<string>();
  const output = tables.map((table, index) => {
    if (!table || typeof table !== 'object' || !Array.isArray(table.items)) throw new ApiError(400, 'INVALID_VINYL_TABLES', 'Неправильний формат таблиці.');
    const tableId = text(table.id, 200) || `tbl_${targetMode}_${index}`;
    if (ids.has(tableId)) throw new ApiError(400, 'DUPLICATE_VINYL_TABLE', 'Ідентифікатори таблиць мають відрізнятися.');
    ids.add(tableId); count += table.items.length;
    if (count > 10000) throw new ApiError(413, 'VINYL_STORAGE_TOO_LARGE', 'Забагато записів для одного збереження.');
    for (const item of table.items) if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ApiError(400, 'INVALID_VINYL_ITEM', 'Неправильний формат альбому.');
    return { ...table, id: tableId, name: text(table.name, 150) || names[targetMode], isCollapsed: !!table.isCollapsed, items: table.items } as VinylTable;
  });
  if (new TextEncoder().encode(JSON.stringify(output)).length > MAX_STORAGE) throw new ApiError(413, 'VINYL_STORAGE_TOO_LARGE', 'Колекція завелика для одного збереження.');
  return output;
}

export async function readVinylTables(userId: string, targetMode: VinylMode): Promise<VinylTables> {
  const row = await database().prepare('SELECT tables_json, updated_at, version FROM echo_vinyl_tables WHERE user_id = ? AND mode = ?').bind(userId, targetMode).first<{ tables_json: string; updated_at: number; version: number }>();
  if (!row) return { tables: [], updatedAt: 0, version: 0 };
  try { return { tables: validateVinylTables(JSON.parse(row.tables_json), targetMode), updatedAt: row.updated_at, version: row.version }; }
  catch { throw new ApiError(500, 'VINYL_STORAGE_UNREADABLE', 'Не вдалося прочитати колекцію. Експорт і зміни тимчасово недоступні.'); }
}
async function compareSave(userId: string, targetMode: VinylMode, tables: VinylTable[], version: number) {
  const updatedAt = Date.now(), encoded = JSON.stringify(tables);
  if (version === 0) {
    const inserted = await database().prepare('INSERT INTO echo_vinyl_tables (user_id, mode, tables_json, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(user_id, mode) DO NOTHING RETURNING version').bind(userId, targetMode, encoded, updatedAt).first();
    if (inserted) return { version: 1, updatedAt };
  }
  const changed = await database().prepare('UPDATE echo_vinyl_tables SET tables_json = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND mode = ? AND version = ? RETURNING version').bind(encoded, updatedAt, userId, targetMode, version).first<{ version: number }>();
  return changed ? { version: changed.version, updatedAt } : null;
}
export async function saveVinylTables(userId: string, targetMode: VinylMode, payload: JsonRecord) {
  const tables = validateVinylTables(payload, targetMode);
  if (!Number.isInteger(payload.version) || payload.version < 0) throw new ApiError(409, 'VINYL_VERSION_REQUIRED', 'Оновіть колекцію перед збереженням.');
  const current = await readVinylTables(userId, targetMode);
  if (current.version !== payload.version) throw new ApiError(409, 'VINYL_CONFLICT', 'Колекцію змінено в іншій вкладці. Оновіть її перед збереженням.', { version: current.version });
  const itemCount = tables.reduce((sum, table) => sum + table.items.length, 0);
  if (!itemCount && !payload.userAction && !payload.forceSave && current.tables.some(table => table.items.length)) return { status: 'ok', protected: true, version: current.version, updatedAt: current.updatedAt };
  const saved = await compareSave(userId, targetMode, tables, current.version);
  if (!saved) throw new ApiError(409, 'VINYL_CONFLICT', 'Колекцію змінено в іншій вкладці. Оновіть її перед збереженням.');
  return { status: 'ok', count: itemCount, type: targetMode === 'albums' ? 'album' : targetMode === 'releases' ? 'release' : 'spotify', ...saved };
}
export function sameVinylAlbum(left: JsonRecord, right: JsonRecord) {
  if (left.deezerAlbumId && String(left.deezerAlbumId) === String(right.deezerAlbumId)) return true;
  const master = (item: JsonRecord) => String(item.masterId || (/^master-\d+$/.test(String(item.id)) ? String(item.id).slice(7) : ''));
  const release = (item: JsonRecord) => String(item.discogsId || (/^discogs-\d+$/.test(String(item.id)) ? String(item.id).slice(8) : ''));
  if (master(left) && master(left) === master(right)) return true;
  if (release(left) && release(left) === release(right)) return true;
  if (left.id && String(left.id) === String(right.id)) return true;
  const a = normal(left.artist), b = normalAlbum(left.title || left.album);
  return !!a && !!b && a === normal(right.artist) && b === normalAlbum(right.title || right.album);
}
export async function addVinylAlbum(userId: string, album: Record<string, unknown>, tableId?: string): Promise<{ added: boolean; tableName: string; item: JsonRecord }> {
  if (!text(album.artist) || !text(album.title || album.album)) throw new ApiError(400, 'INVALID_VINYL_ALBUM', 'Потрібні виконавець і назва альбому.');
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readVinylTables(userId, 'albums');
    for (const table of current.tables) { const item = table.items.find(item => sameVinylAlbum(item, album)); if (item) return { added: false, tableName: table.name, item }; }
    let table = tableId ? current.tables.find(table => table.id === tableId) : current.tables[0];
    if (tableId && !table) throw new ApiError(404, 'VINYL_TABLE_NOT_FOUND', 'Таблицю видалено. Виберіть іншу.');
    if (!table) { table = { id: 'tbl_albums_default', name: names.albums, isCollapsed: false, items: [] }; current.tables.push(table); }
    const item = { status: 'buy', rating: 0, addedAt: Date.now(), ...album, id: text(album.id, 200) || `manual-album-${crypto.randomUUID()}` };
    table.items.push(item); validateVinylTables(current.tables, 'albums');
    if (await compareSave(userId, 'albums', current.tables, current.version)) return { added: true, tableName: table.name, item };
  }
  throw new ApiError(409, 'VINYL_CONFLICT', 'Колекція змінюється в іншій вкладці. Повторіть додавання.');
}

async function connection(userId: string, provider: string): Promise<JsonRecord | null> {
  const row = await database().prepare('SELECT encrypted_connection FROM echo_vinyl_connections WHERE user_id = ? AND provider = ?').bind(userId, provider).first<{ encrypted_connection: string }>();
  if (!row) return null;
  try { return await decryptSecret<JsonRecord>(row.encrypted_connection, `vinyl:${provider}:${userId}`); }
  catch { throw new ApiError(503, 'VINYL_CONNECTION_UNREADABLE', 'Не вдалося прочитати підключення. Перевірте серверний ключ шифрування.'); }
}
async function saveConnection(userId: string, provider: string, value: JsonRecord) {
  await database().prepare('INSERT INTO echo_vinyl_connections (user_id, provider, encrypted_connection, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, provider) DO UPDATE SET encrypted_connection = excluded.encrypted_connection, updated_at = excluded.updated_at').bind(userId, provider, await encryptSecret({ ...value, revision: crypto.randomUUID() }, `vinyl:${provider}:${userId}`), Date.now()).run();
  for (const key of cache.keys()) if (key.startsWith(`${provider}:${userId}:`)) cache.delete(key);
}
async function readNetworkJson(response: Response) {
  const encoded = await response.text();
  if (encoded.length > 8 * 1024 * 1024) throw new ApiError(502, 'PROVIDER_RESPONSE_TOO_LARGE', 'Музичний сервіс повернув завелику відповідь.');
  try { return JSON.parse(encoded); } catch { throw new ApiError(502, 'PROVIDER_BAD_RESPONSE', 'Музичний сервіс повернув некоректну відповідь.'); }
}
async function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new ApiError(499, 'REQUEST_CANCELLED', 'Запит скасовано.');
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(new ApiError(499, 'REQUEST_CANCELLED', 'Запит скасовано.')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function oauthEncode(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
export async function discogsOAuthHeader(url: string, method: string, credentials: JsonRecord, extra: Record<string, string> = {}) {
  const fields: Record<string, string> = { oauth_consumer_key: credentials.consumerKey, oauth_nonce: crypto.randomUUID().replace(/-/g, ''), oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_version: '1.0', ...extra };
  if (credentials.oauthToken) fields.oauth_token = credentials.oauthToken;
  const parsed = new URL(url), compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const entries = [...parsed.searchParams.entries(), ...Object.entries(fields)].map(([key, value]) => [oauthEncode(key), oauthEncode(value)]).sort(([a, av], [b, bv]) => compare(a, b) || compare(av, bv));
  const normalized = entries.map(([key, value]) => `${key}=${value}`).join('&'), signatureBase = `${method.toUpperCase()}&${oauthEncode(`${parsed.origin}${parsed.pathname}`)}&${oauthEncode(normalized)}`;
  const signingKey = `${oauthEncode(credentials.consumerSecret)}&${oauthEncode(credentials.oauthTokenSecret || '')}`, key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  fields.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signatureBase)))));
  return `OAuth ${Object.entries(fields).map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`).join(', ')}`;
}
async function discogsFetch(request: Request, path: string, credentials: string | JsonRecord | null, options: { method?: string; body?: unknown } = {}) {
  if (!/^\/(?:database\/search|oauth\/identity|masters\/\d+(?:\/versions)?|releases\/\d+|artists\/\d+(?:\/releases)?|marketplace\/(?:stats|price_suggestions)\/\d+|users\/[^/?]+(?:\/(?:collection\/folders(?:\/\d+(?:\/releases(?:\/\d+)?)?)?|wants(?:\/\d+)?))?)(?:\?[^#]*)?$/.test(path)) throw new ApiError(400, 'INVALID_DISCOGS_PATH', 'Неправильний запит Discogs.');
  const owner = identity(request).id;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = Math.max(0, (ownerNextRequest.get(owner) || 0) - Date.now());
    ownerNextRequest.set(owner, Date.now() + wait + (credentials ? 1100 : 2500));
    if (ownerNextRequest.size > 500) ownerNextRequest.delete(ownerNextRequest.keys().next().value!);
    await delay(wait, request.signal);
    let response: Response;
    const authorization = credentials ? typeof credentials === 'string' ? `Discogs token=${credentials}` : await discogsOAuthHeader(`https://api.discogs.com${path}`, options.method || 'GET', credentials) : null;
    try { response = await fetch(`https://api.discogs.com${path}`, { method: options.method || 'GET', headers: { 'User-Agent': userAgent, ...(authorization ? { Authorization: authorization } : {}), 'Content-Type': 'application/json', Accept: 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.any([request.signal, AbortSignal.timeout(18000)]), redirect: 'error' }); }
    catch { throw new ApiError(502, 'DISCOGS_UNAVAILABLE', 'Discogs тимчасово недоступний. Повторіть спробу.'); }
    if (response.status === 429 && attempt === 0) { await response.body?.cancel(); await delay(Math.min(15000, Math.max(1500, Number(response.headers.get('retry-after')) * 1000 || 3000)), request.signal); continue; }
    const data = response.status === 204 ? {} : await readNetworkJson(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ApiError(response.status, 'DISCOGS_TOKEN_INVALID', 'Discogs не підтвердив доступ. Оновіть особистий токен у вкладці вінілу.');
      if (response.status === 429) throw new ApiError(429, 'DISCOGS_RATE_LIMIT', 'Discogs обмежив частоту запитів. Зачекайте і повторіть.');
      throw new ApiError(response.status === 404 ? 404 : 502, 'DISCOGS_REQUEST_FAILED', text(data.message) || 'Не вдалося отримати дані Discogs.');
    }
    return data;
  }
}
export async function discogsJson(request: Request, path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const userId = identity(request).id, saved = await connection(userId, 'discogs');
  const hasConnection = !!(saved?.token || saved?.oauthToken);
  const publicRead = (!options.method || options.method === 'GET') && /^\/(?:masters\/\d+(?:\/versions)?|releases\/\d+|artists\/\d+(?:\/releases)?)(?:\?[^#]*)?$/.test(path);
  if (!hasConnection && !publicRead) throw new ApiError(400, 'DISCOGS_NOT_CONNECTED', 'Підключіть Discogs у вкладці вінілу для пошуку та роботи зі своїм профілем.');
  const key = `discogs:${userId}:${hasConnection ? saved!.revision || '' : 'public'}:${path}`;
  if (!options.method || options.method === 'GET') {
    const hit = cached(key); if (hit !== undefined) return hit;
    const existing = pending.get(key); if (existing) return existing;
    const task = discogsFetch(request, path, hasConnection ? saved!.token || saved! : null).then(data => remember(key, data)).finally(() => pending.delete(key));
    pending.set(key, task); return task;
  }
  return discogsFetch(request, path, hasConnection ? saved!.token || saved! : null, options);
}
async function discogsConnection(request: Request) {
  const userId = identity(request).id;
  if (request.method === 'DELETE') { await database().prepare('DELETE FROM echo_vinyl_connections WHERE user_id = ? AND provider = ?').bind(userId, 'discogs').run(); for (const key of cache.keys()) if (key.startsWith(`discogs:${userId}:`)) cache.delete(key); return json({ connected: false }); }
  if (request.method === 'POST') {
    const payload = await body(request);
    if ('consumerKey' in payload || 'consumerSecret' in payload) {
      const consumerKey = text(payload.consumerKey, 200), consumerSecret = text(payload.consumerSecret, 500), saved = await connection(userId, 'discogs');
      if (!/^[a-zA-Z0-9_-]{8,200}$/.test(consumerKey) || !/^[a-zA-Z0-9_-]{8,500}$/.test(consumerSecret)) throw new ApiError(400, 'INVALID_DISCOGS_CREDENTIALS', 'Введіть Consumer Key та Consumer Secret Discogs.');
      const same = saved?.consumerKey === consumerKey && saved?.consumerSecret === consumerSecret;
      await saveConnection(userId, 'discogs', { ...(same ? saved : {}), consumerKey, consumerSecret });
      return json({ connected: same && !!(saved?.token || saved?.oauthToken), configured: true, oauthConfigured: true, user: same ? saved?.user || null : null });
    }
    const token = text(payload.token, 2048);
    if (!/^[a-zA-Z0-9_-]{16,2048}$/.test(token)) throw new ApiError(400, 'INVALID_DISCOGS_TOKEN', 'Введіть особистий токен Discogs.');
    if (!encryptionAvailable()) throw new ApiError(503, 'ENCRYPTION_NOT_CONFIGURED', 'Захищене збереження підключень ще не налаштовано.');
    const user = await discogsFetch(request, '/oauth/identity', token);
    await saveConnection(userId, 'discogs', { token, user });
    return json({ connected: true, configured: true, username: user.username, user });
  }
  const saved = await connection(userId, 'discogs');
  return json({ connected: !!(saved?.token || saved?.oauthToken), configured: !!(saved?.token || saved?.consumerKey), oauthConfigured: !!saved?.consumerKey, username: saved?.user?.username || null, user: saved?.user || null, storageAvailable: encryptionAvailable() });
}

const discogsCookie = 'echo_vinyl_discogs';
function discogsSessionCookie(value: string, age: number) { return `${discogsCookie}=${value}; Path=/api/vinyl/legacy/discogs; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`; }
async function discogsAuth(request: Request, callback = false) {
  const userId = identity(request).id, saved = await connection(userId, 'discogs'), origin = new URL(request.url).origin;
  if (!saved?.consumerKey || !saved?.consumerSecret) throw new ApiError(400, 'DISCOGS_OAUTH_NOT_CONFIGURED', 'Збережіть Consumer Key і Consumer Secret або використайте особистий токен Discogs.');
  if (!callback) {
    const state = crypto.randomUUID(), callbackUrl = `${origin}/api/vinyl/legacy/discogs/auth/callback?state=${state}`, endpoint = 'https://api.discogs.com/oauth/request_token';
    const response = await fetch(endpoint, { headers: { 'User-Agent': userAgent, Authorization: await discogsOAuthHeader(endpoint, 'GET', saved, { oauth_callback: callbackUrl }) }, signal: AbortSignal.timeout(15000), redirect: 'error' }), data = new URLSearchParams(await response.text());
    if (!response.ok || !data.get('oauth_token') || !data.get('oauth_token_secret')) throw new ApiError(401, 'DISCOGS_CREDENTIALS_INVALID', 'Discogs не підтвердив ці ключі додатку.');
    const encrypted = await encryptSecret({ state, oauthToken: data.get('oauth_token'), oauthTokenSecret: data.get('oauth_token_secret'), consumerKey: saved.consumerKey, expires: Date.now() + 600000 }, `vinyl:discogs-oauth:${userId}`);
    return new Response(null, { status: 302, headers: { Location: `https://www.discogs.com/oauth/authorize?oauth_token=${encodeURIComponent(data.get('oauth_token')!)}`, 'Set-Cookie': discogsSessionCookie(encrypted, 600), 'Cache-Control': 'no-store' } });
  }
  const params = new URL(request.url).searchParams, value = request.headers.get('cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(`${discogsCookie}=`))?.slice(discogsCookie.length + 1);
  let session: JsonRecord;
  try { session = await decryptSecret(value || '', `vinyl:discogs-oauth:${userId}`); } catch { throw new ApiError(400, 'OAUTH_STATE_INVALID', 'Сесія підключення завершилася. Почніть заново.'); }
  if (session.state !== params.get('state') || session.expires < Date.now() || session.oauthToken !== params.get('oauth_token') || session.consumerKey !== saved.consumerKey || !params.get('oauth_verifier')) throw new ApiError(400, 'OAUTH_STATE_INVALID', 'Не вдалося перевірити підключення Discogs.');
  const endpoint = 'https://api.discogs.com/oauth/access_token', credentials = { ...saved, oauthToken: session.oauthToken, oauthTokenSecret: session.oauthTokenSecret };
  const response = await fetch(endpoint, { headers: { 'User-Agent': userAgent, Authorization: await discogsOAuthHeader(endpoint, 'GET', credentials, { oauth_verifier: params.get('oauth_verifier')! }) }, signal: AbortSignal.timeout(15000), redirect: 'error' }), tokens = new URLSearchParams(await response.text());
  if (!response.ok || !tokens.get('oauth_token') || !tokens.get('oauth_token_secret')) throw new ApiError(502, 'DISCOGS_OAUTH_FAILED', 'Discogs не підтвердив підключення.');
  const connected = { ...saved, token: undefined, oauthToken: tokens.get('oauth_token'), oauthTokenSecret: tokens.get('oauth_token_secret') }, user = await discogsFetch(request, '/oauth/identity', connected);
  await saveConnection(userId, 'discogs', { ...connected, user });
  const markup = '<!doctype html><html><meta charset="utf-8"><title>Discogs connected</title><body><p>Discogs підключено. Можна закрити це вікно.</p><script>if(window.opener){window.opener.postMessage({type:"echo-vinyl-discogs-connected"},location.origin);window.close();}</script></body></html>';
  return new Response(markup, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': discogsSessionCookie('', 0), 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'self'" } });
}

function vinylFormat(version: JsonRecord) { const formats = Array.isArray(version.format) ? version.format.join(' ') : String(version.format || ''); return /\bvinyl\b/i.test(formats); }
async function versionStats(request: Request, masterId: string) {
  const data = await discogsJson(request, `/masters/${id(masterId)}/versions?format=Vinyl&page=1&per_page=100`);
  const versions = (data.versions || []).filter(vinylFormat);
  // Counts are only accepted when the API respected the requested format. A CD
  // fallback is never presented as a vinyl edition or a marketplace listing.
  const allVinyl = versions.length === (data.versions || []).length;
  const count = allVinyl ? Number(data.pagination?.items ?? versions.length) : versions.length;
  return { master_id: Number(masterId), versions_count: count, num_for_sale: null, count_complete: allVinyl, vinyl_available: versions.length > 0 };
}
async function priceStats(request: Request, releaseId: string) {
  id(releaseId);
  const [statsResult, suggestionsResult] = await Promise.allSettled([discogsJson(request, `/marketplace/stats/${releaseId}`), discogsJson(request, `/marketplace/price_suggestions/${releaseId}`)]);
  if (statsResult.status === 'rejected' && suggestionsResult.status === 'rejected') throw statsResult.reason;
  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null, suggestions = suggestionsResult.status === 'fulfilled' ? suggestionsResult.value : null;
  const prices = Object.values(suggestions || {}).filter((entry: any) => typeof entry?.value === 'number' && entry.value > 0) as { value: number; currency?: string }[];
  const values = prices.map(entry => entry.value).sort((a, b) => a - b), middle = Math.floor(values.length / 2);
  const lowest = typeof stats?.lowest_price?.value === 'number' ? stats.lowest_price.value : null;
  const min = values[0] ?? lowest, max = values.at(-1) ?? null;
  const median = values.length ? values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2 : null;
  return { release_id: releaseId, min, median, max, min_sold: null, median_sold: null, max_sold: null, has_sold_stats: false, conditions: suggestions, currency: stats?.lowest_price?.currency || prices[0]?.currency || 'USD', lowest_price: lowest, num_for_sale: typeof stats?.num_for_sale === 'number' ? stats.num_for_sale : null, is_estimated: false, price_source: prices.length ? 'Discogs condition suggestions' : 'Discogs current marketplace' };
}

async function publicJson(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.deezer.com', 'itunes.apple.com'].includes(parsed.hostname) || parsed.username || parsed.password) throw new ApiError(400, 'INVALID_PROVIDER_URL', 'Неправильний музичний сервіс.');
  const key = `public:${url}`, hit = cached(key); if (hit !== undefined) return hit;
  const existing = pending.get(key); if (existing) return existing;
  const task = (async () => {
  let response: Response;
  try { response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(12000), redirect: 'error' }); }
  catch { throw new ApiError(502, 'MUSIC_PROVIDER_UNAVAILABLE', 'Музичний каталог тимчасово недоступний.'); }
  if (!response.ok) throw new ApiError(502, 'MUSIC_PROVIDER_UNAVAILABLE', 'Музичний каталог тимчасово недоступний.');
  const data = await readNetworkJson(response);
  if (data.error) throw new ApiError(502, 'MUSIC_PROVIDER_UNAVAILABLE', 'Музичний каталог не зміг виконати запит.');
  return remember(key, data, 3600000);
  })().finally(() => pending.delete(key));
  pending.set(key, task); return task;
}
function duration(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
function appleCover(url: string) { return String(url || '').replace(/100x100bb/, '600x600bb'); }
function deezerTrack(item: JsonRecord): JsonRecord { const artist = item.artist?.name || ''; return { id: `deezer_${item.id}`, spotifyId: `deezer_${item.id}`, title: item.title || '', artist, album: item.album?.title || '', coverImage: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || '', durationMs: (item.duration || 0) * 1000, durationStr: duration(item.duration || 0), previewUrl: item.preview || null, releaseDate: item.release_date || '', uri: `spotify:search:${encodeURIComponent(`${artist} ${item.title}`)}`, spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(`${artist} ${item.title}`)}`, type: 'track' }; }
function appleTrack(item: JsonRecord): JsonRecord { return { id: `track_${item.trackId}`, spotifyId: `itunes_${item.trackId}`, title: item.trackName || '', artist: item.artistName || '', album: item.collectionName || '', coverImage: appleCover(item.artworkUrl100), durationMs: item.trackTimeMillis || 0, durationStr: duration((item.trackTimeMillis || 0) / 1000), previewUrl: item.previewUrl || null, releaseDate: item.releaseDate?.slice(0, 10) || '', uri: `spotify:search:${encodeURIComponent(`${item.artistName} ${item.trackName}`)}`, spotifyUrl: `https://open.spotify.com/search/${encodeURIComponent(`${item.artistName} ${item.trackName}`)}`, type: 'track' }; }
function spotifyTrack(item: JsonRecord): JsonRecord { return { id: item.id, spotifyId: item.id, title: item.name, artist: item.artists?.map((a: JsonRecord) => a.name).join(', ') || '', album: item.album?.name || '', coverImage: item.album?.images?.[0]?.url || '', durationMs: item.duration_ms || 0, durationStr: duration((item.duration_ms || 0) / 1000), previewUrl: item.preview_url || null, uri: item.uri, spotifyUrl: item.external_urls?.spotify, type: 'track' }; }
async function findAlbums(artist: string, title: string, limit = 10): Promise<JsonRecord[]> {
  const term = `${artist} ${title}`.trim();
  const key = `vinyl-albums-v2:${normal(artist)}:${normalAlbum(title)}:${limit}`, hit = cached(key); if (hit) return hit;
  const existing = pending.get(key); if (existing) return existing;
  const task = (async () => {
  try {
    const stored = await database().prepare('SELECT track_data, updated_at FROM echo_media_collections WHERE id = ?').bind(key).first<{track_data:string;updated_at:number}>();
    if (stored && stored.updated_at > Date.now() - 7 * 86400000) { const parsed = JSON.parse(stored.track_data); if (Array.isArray(parsed)) return remember(key, parsed, 3600000); }
  } catch { /* Album playback also works when the optional public cache is unavailable. */ }
  const results = await Promise.allSettled([publicJson(`https://api.deezer.com/search/album?q=${encodeURIComponent(term)}&limit=${limit}`), publicJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=${limit}`)]);
  const output: JsonRecord[] = [];
  if (results[0].status === 'fulfilled') for (const item of results[0].value.data || []) output.push({ id: `sp_alb_${item.id}`, spotifyId: String(item.id), title: item.title, artist: item.artist?.name || '', coverImage: item.cover_xl || item.cover_big || item.cover_medium, releaseDate: item.release_date || '', year: item.release_date?.slice(0, 4) || '', totalTracks: item.nb_tracks || null, type: 'album', source: 'Deezer' });
  if (results[1].status === 'fulfilled') for (const item of results[1].value.results || []) if (item.collectionId) output.push({ id: `itunes_alb_${item.collectionId}`, spotifyId: String(item.collectionId), title: item.collectionName, artist: item.artistName, coverImage: appleCover(item.artworkUrl100), releaseDate: item.releaseDate?.slice(0, 10) || '', year: item.releaseDate?.slice(0, 4) || '', totalTracks: item.trackCount, type: 'album', source: 'Apple Music' });
  if (output.length) { try { await database().prepare('INSERT INTO echo_media_collections (id, track_data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET track_data = excluded.track_data, updated_at = excluded.updated_at').bind(key, JSON.stringify(output), Date.now()).run(); } catch { /* Cache failure must never hide available albums. */ } }
  return remember(key, output, output.length ? 3600000 : 60000);
  })().finally(() => pending.delete(key));
  pending.set(key, task); return task;
}
function normalAlbum(value: unknown) {
  return normal(text(value, 1000).replace(/\s*[([][^\])]*(?:remaster(?:ed)?|deluxe|anniversary|collector(?:'s)?|expanded|special edition|\d{4} master)[^\])]*[\])]/gi, '').replace(/\s*[-–:]\s*(?:remaster(?:ed)?|deluxe|expanded|special edition).*$/i, ''));
}
function albumMatch(items: JsonRecord[], artist: string, title: string) {
  const a = normal(artist), t = normal(title), album = normalAlbum(title);
  return items.find(item => (!a || normal(item.artist) === a) && (!t || normal(item.title) === t)) || items.find(item => (!a || normal(item.artist) === a) && !!album && normalAlbum(item.title) === album);
}
async function publicAlbumTracks(rawId: string, artist: string, title: string) {
  let album: JsonRecord | undefined;
  if (!/^sp_alb_\d+$|^itunes_alb_\d+$/.test(rawId)) album = albumMatch(await findAlbums(artist, title), artist, title);
  const effectiveId = album?.id || rawId;
  if (/^sp_alb_\d+$/.test(effectiveId)) {
    const data = await publicJson(`https://api.deezer.com/album/${effectiveId.slice(7)}`);
    const tracks:JsonRecord[] = Array.isArray(data.tracks?.data) ? [...data.tracks.data] : [], visited = new Set<string>();
    let next = data.tracks?.next;
    while (typeof next === 'string' && next && !visited.has(next)) {
      const link = new URL(next); if (!['https:','http:'].includes(link.protocol) || link.username || link.password || link.hostname !== 'api.deezer.com' || link.pathname !== `/album/${effectiveId.slice(7)}/tracks`) break;
      link.protocol='https:';
      visited.add(next); const page = await publicJson(link.href); if (!Array.isArray(page.data) || !page.data.length) break; tracks.push(...page.data); next = page.next;
    }
    return { found: !!tracks.length, title: data.title, artist: data.artist?.name, cover: data.cover_xl || data.cover_big, year: data.release_date?.slice(0, 4), source: 'Deezer', discogsNotFound: true, tracklist: tracks.map((item: JsonRecord, index: number) => ({ position: String(item.track_position || index + 1), title: item.title, artist: item.artist?.name || data.artist?.name, duration: duration(item.duration || 0), previewUrl: item.preview || null, type_: 'track' })) };
  }
  if (/^itunes_alb_\d+$/.test(effectiveId)) {
    const data = await publicJson(`https://itunes.apple.com/lookup?id=${effectiveId.slice(11)}&entity=song&limit=200`), meta = data.results?.find((item: JsonRecord) => item.wrapperType === 'collection') || {};
    const tracks = (data.results || []).filter((item: JsonRecord) => item.wrapperType === 'track');
    return { found: !!tracks.length, title: meta.collectionName || title, artist: meta.artistName || artist, cover: appleCover(meta.artworkUrl100), year: meta.releaseDate?.slice(0, 4), source: 'Apple Music', discogsNotFound: true, tracklist: tracks.map((item: JsonRecord, index: number) => ({ position: String(item.trackNumber || index + 1), title: item.trackName, artist: item.artistName, duration: duration((item.trackTimeMillis || 0) / 1000), previewUrl: item.previewUrl || null, type_: 'track' })) };
  }
  return { found: false, title, artist, cover: album?.coverImage || '', tracklist: [], source: null };
}
async function tracklist(request: Request, params: URLSearchParams) {
  const rawId = text(params.get('id')), type = params.get('type') === 'master' ? 'master' : 'release';
  let artist = text(params.get('artist')), title = text(params.get('album') || params.get('title') || params.get('q'));
  if (!artist && title.includes(' - ')) { const parts = title.split(' - '); artist = parts.shift()!.trim(); title = parts.join(' - ').trim(); }
  const deezerAlbumId = params.get('deezerAlbumId');
  if (deezerAlbumId && /^[1-9][0-9]{0,14}$/.test(deezerAlbumId)) return publicAlbumTracks(`sp_alb_${deezerAlbumId}`, artist, title);
  // Listening needs playable recordings. Digital album metadata normally includes every preview.
  if (artist && title) { try { const playable = await publicAlbumTracks(rawId, artist, title); if (playable.tracklist.length) return playable; } catch { /* The exact pressing below can still provide its tracklist. */ } }
  if (/^\d+$/.test(rawId)) {
    try {
      const data = await discogsJson(request, `/${type === 'master' ? 'masters' : 'releases'}/${id(rawId)}`);
      if (data.tracklist?.length) return { id: data.id, type, title: data.title, artist: data.artists?.map((item: JsonRecord) => item.name).join(', ') || artist, year: data.year || '', cover: data.images?.[0]?.uri || data.thumb || '', tracklist: data.tracklist.filter((item: JsonRecord) => item.type_ !== 'heading').map((item: JsonRecord, index: number) => ({ position: item.position || String(index + 1), title: item.title, artist:item.artists?.map((artist:JsonRecord)=>artist.name).join(', ') || data.artists?.map((artist:JsonRecord)=>artist.name).join(', ') || artist, duration: item.duration || '', type_: item.type_ || 'track' })), source: 'Discogs', discogsNotFound: false };
    } catch (error) { if (!artist && !title) throw error; }
  }
  return publicAlbumTracks(rawId, artist, title);
}
async function preview(artist: string, title: string) {
  if (!title) throw new ApiError(400, 'TRACK_REQUIRED', 'Вкажіть назву пісні.');
  title = title.replace(/^([A-Z]\d*|\d+)[.\s\-:]+\s*/i, '').replace(/\s*[([](?:remaster(?:ed)?|mono|stereo|bonus|deluxe|anniversary|album version)[^\])]*[\])]/gi, '').trim();
  const term = `${artist} ${title}`.trim(), responses = await Promise.allSettled([publicJson(`https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=12`), publicJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=12`)]);
  const entries: JsonRecord[] = [];
  if (responses[0].status === 'fulfilled') entries.push(...(responses[0].value.data || []).map(deezerTrack).map((item: JsonRecord) => ({ ...item, source: 'Deezer' })));
  if (responses[1].status === 'fulfilled') entries.push(...(responses[1].value.results || []).filter((item: JsonRecord) => item.trackId).map(appleTrack).map((item: JsonRecord) => ({ ...item, source: 'Apple Music' })));
  const a = normal(artist), t = normal(title);
  const match = entries.find(item => item.previewUrl && (!a || normal(item.artist) === a) && (normal(item.title) === t || normal(item.title).startsWith(t) && /remaster|version|edit/i.test(item.title)));
  return match ? { found: true, ...match } : { found: false };
}
async function video(artist: string, title: string) {
  if (!title) return { found: false };
  const key = `video:${normal(artist)}:${normal(title)}`, hit = cached(key); if (hit !== undefined) return hit;
  try {
    const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(`${artist} ${title} official video`)}`, { headers: { 'User-Agent': userAgent, 'Accept-Language': 'en-US,en;q=0.8' }, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!response.ok) return { found: false };
    const content = await response.text(); if (content.length > 6 * 1024 * 1024) return { found: false };
    const a = normal(artist), t = normal(title), candidates: { id: string; title: string; score: number }[] = [];
    for (const block of content.split('"videoRenderer":').slice(1, 20)) {
      const foundId = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/), foundTitle = block.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
      if (!foundId || !foundTitle) continue;
      let name: string; try { name = JSON.parse(`"${foundTitle[1]}"`); } catch { continue; }
      const normalized = normal(name);
      if (!normalized.includes(t) || a && !normalized.includes(a) || /tribute|karaoke|reaction|tutorial|cover version/i.test(name)) continue;
      candidates.push({ id: foundId[1], title: name, score: /official/i.test(name) ? 2 : 1 });
    }
    const match = candidates.sort((left, right) => right.score - left.score)[0];
    return match ? remember(key, { found: true, type: 'youtube', source: 'youtube', videoId: match.id, videoTitle: match.title, trackName: title, artistName: artist, start: 0, end: 30, embedUrl: `https://www.youtube-nocookie.com/embed/${match.id}?autoplay=1&enablejsapi=1&end=30` }, 3600000) : { found: false };
  } catch { return { found: false }; }
}

export function approvedVinylMedia(value: string, kind: 'image' | 'audio') {
  let url: URL; try { url = new URL(value); } catch { throw new ApiError(400, 'INVALID_MEDIA_URL', 'Неправильна адреса медіа.'); }
  const imageHosts = ['discogs.com', 'discogsusercontent.com', 'dzcdn.net', 'mzstatic.com', 'scdn.co', 'spotifycdn.com'];
  const audioHosts = ['dzcdn.net', 'deezer.com', 'itunes.apple.com', 'mzstatic.com', 'scdn.co', 'spotifycdn.com'];
  const allowed = kind === 'image' ? imageHosts : audioHosts;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new ApiError(400, 'MEDIA_HOST_NOT_ALLOWED', 'Медіа має надходити з перевіреного музичного сервісу.');
  return url;
}
async function mediaProxy(request: Request, value: string, kind: 'image' | 'audio') {
  let url = approvedVinylMedia(value, kind), response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = new Headers({ 'User-Agent': userAgent });
    if (kind === 'audio' && /^bytes=\d*-\d*$/.test(request.headers.get('range') || '')) headers.set('Range', request.headers.get('range')!);
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { const redirected = new URL(response.headers.get('location')!, url).toString(); await response.body?.cancel(); url = approvedVinylMedia(redirected, kind); continue; }
    break;
  }
  if (!response || !response.ok) { await response?.body?.cancel(); throw new ApiError(502, 'MEDIA_UNAVAILABLE', 'Медіа тимчасово недоступне.'); }
  const contentType = response.headers.get('content-type') || '';
  if (!(kind === 'image' ? /^image\/(jpeg|png|webp|gif|avif)/i : /^audio\//i).test(contentType)) { await response.body?.cancel(); throw new ApiError(502, 'INVALID_MEDIA_TYPE', 'Музичний сервіс повернув інший тип файлу.'); }
  const output = new Headers({ 'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  for (const header of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(header)) output.set(header, response.headers.get(header)!);
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: output });
}

async function spotifyToken(userId: string, userRequired = false) {
  const saved = await connection(userId, 'spotify');
  if (saved?.userToken?.access_token && saved.userToken.expiresAt > Date.now() + 30000) return saved.userToken.access_token as string;
  if (!saved?.clientId || !saved?.clientSecret) throw new ApiError(userRequired ? 401 : 400, userRequired ? 'SPOTIFY_LOGIN_REQUIRED' : 'SPOTIFY_NOT_CONNECTED', userRequired ? 'Підключіться до Spotify заново: термін дії токена завершився.' : 'Додайте ключі Spotify у налаштуваннях вінілу.');
  const form = new URLSearchParams(userRequired && saved.userToken?.refresh_token ? { grant_type: 'refresh_token', refresh_token: saved.userToken.refresh_token } : { grant_type: 'client_credentials' });
  if (userRequired && !saved.userToken?.refresh_token) throw new ApiError(401, 'SPOTIFY_LOGIN_REQUIRED', 'Увійдіть у Spotify для роботи зі своїм профілем.');
  const cacheKey = `spotify:${userId}:${saved.revision || ''}:client-token`;
  if (!userRequired) { const token = cached(cacheKey); if (token) return token as string; }
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${saved.clientId}:${saved.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(15000), redirect: 'error' });
  const data = await readNetworkJson(response);
  if (!response.ok || !data.access_token) throw new ApiError(401, 'SPOTIFY_CREDENTIALS_INVALID', 'Spotify не підтвердив доступ. Перевірте ключі або підключіться заново.');
  if (userRequired) { saved.userToken = { ...saved.userToken, ...data, expiresAt: Date.now() + data.expires_in * 1000 }; await saveConnection(userId, 'spotify', saved); }
  else remember(cacheKey, data.access_token, Math.max(30000, (data.expires_in || 3600) * 1000 - 60000));
  return data.access_token as string;
}
async function spotifyConnection(request: Request) {
  const userId = identity(request).id, saved = await connection(userId, 'spotify');
  if (request.method === 'DELETE') { if (saved?.clientId) await saveConnection(userId, 'spotify', { clientId: saved.clientId, clientSecret: saved.clientSecret }); else await database().prepare('DELETE FROM echo_vinyl_connections WHERE user_id = ? AND provider = ?').bind(userId, 'spotify').run(); return json({ connected: false, user: null }); }
  if (request.method === 'POST') {
    const payload = await body(request), token = text(payload.token, 2048);
    if (!token || /\s/.test(token) || token.length < 16) throw new ApiError(400, 'INVALID_SPOTIFY_TOKEN', 'Введіть токен Spotify.');
    const response = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: 'error' }), user = await readNetworkJson(response);
    if (!response.ok || !user.id) throw new ApiError(401, 'SPOTIFY_TOKEN_INVALID', 'Spotify не підтвердив цей токен.');
    await saveConnection(userId, 'spotify', { ...(saved || {}), userToken: { access_token: token, expiresAt: Date.now() + 3600000 }, user });
    return json({ connected: true, user });
  }
  return json({ connected: !!saved?.userToken && (saved.userToken.expiresAt > Date.now() || !!saved.userToken.refresh_token), user: saved?.user || null });
}
async function spotifyJson(request: Request, path: string, options: { method?: string; body?: unknown; userRequired?: boolean } = {}) {
  if (!/^\/v1\/(?:search|me|albums\/[a-zA-Z0-9]+|users\/[a-zA-Z0-9_-]+\/playlists|playlists\/[a-zA-Z0-9]+\/tracks)(?:\?[^#]*)?$/.test(path)) throw new ApiError(400, 'INVALID_SPOTIFY_PATH', 'Неправильний запит Spotify.');
  const token = await spotifyToken(identity(request).id, options.userRequired);
  const response = await fetch(`https://api.spotify.com${path}`, { method: options.method || 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]), redirect: 'error' });
  const data = response.status === 204 ? {} : await readNetworkJson(response);
  if (!response.ok) throw new ApiError(response.status === 401 ? 401 : response.status === 429 ? 429 : 502, 'SPOTIFY_REQUEST_FAILED', 'Spotify не зміг виконати запит. Перевірте підключення і доступ додатку.');
  return data;
}
async function spotifyCredentials(request: Request) {
  const userId = identity(request).id, saved = await connection(userId, 'spotify');
  if (request.method === 'DELETE') { await database().prepare('DELETE FROM echo_vinyl_connections WHERE user_id = ? AND provider = ?').bind(userId, 'spotify').run(); return json({ configured: false, clientId: '', hasSecret: false }); }
  if (request.method === 'POST') {
    const payload = await body(request), clientId = text(payload.clientId, 200), clientSecret = text(payload.clientSecret, 500) || saved?.clientSecret;
    if (!/^[a-zA-Z0-9]{16,100}$/.test(clientId) || !/^[a-zA-Z0-9_-]{16,500}$/.test(clientSecret || '')) throw new ApiError(400, 'INVALID_SPOTIFY_CREDENTIALS', 'Введіть Client ID та Client Secret Spotify.');
    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials' }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok || !(await readNetworkJson(response)).access_token) throw new ApiError(401, 'SPOTIFY_CREDENTIALS_INVALID', 'Spotify не підтвердив ці ключі.');
    await saveConnection(userId, 'spotify', { clientId, clientSecret, ...(saved?.clientId === clientId ? { userToken: saved.userToken } : {}) });
    return json({ success: true, configured: true, clientId, hasSecret: true });
  }
  return json({ configured: !!saved?.clientSecret, clientId: saved?.clientId || '', hasSecret: !!saved?.clientSecret, userConnected: !!saved?.userToken });
}
const spotifyCookie = 'echo_vinyl_spotify';
function sessionCookie(value: string, age: number) { return `${spotifyCookie}=${value}; Path=/api/vinyl/legacy/spotify; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`; }
async function spotifyAuth(request: Request, callback = false) {
  const userId = identity(request).id, origin = new URL(request.url).origin, saved = await connection(userId, 'spotify');
  if (!saved?.clientId || !saved?.clientSecret) throw new ApiError(400, 'SPOTIFY_NOT_CONNECTED', 'Спочатку збережіть ключі Spotify.');
  const redirectUri = `${origin}/api/vinyl/legacy/spotify/auth/callback`;
  if (!callback) {
    const state = crypto.randomUUID(), verifier = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const encrypted = await encryptSecret({ state, verifier, expires: Date.now() + 600000 }, `vinyl:spotify-oauth:${userId}`);
    const url = new URL('https://accounts.spotify.com/authorize'); url.search = new URLSearchParams({ client_id: saved.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'playlist-modify-public playlist-modify-private user-read-private', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return new Response(null, { status: 302, headers: { Location: url.toString(), 'Set-Cookie': sessionCookie(encrypted, 600), 'Cache-Control': 'no-store' } });
  }
  const value = request.headers.get('cookie')?.split(';').map(item => item.trim()).find(item => item.startsWith(`${spotifyCookie}=`))?.slice(spotifyCookie.length + 1), params = new URL(request.url).searchParams;
  let state: JsonRecord; try { state = await decryptSecret(value || '', `vinyl:spotify-oauth:${userId}`); } catch { throw new ApiError(400, 'OAUTH_STATE_INVALID', 'Сесія підключення завершилася. Почніть заново.'); }
  if (state.state !== params.get('state') || state.expires < Date.now() || !params.get('code')) throw new ApiError(400, 'OAUTH_STATE_INVALID', 'Не вдалося перевірити підключення Spotify.');
  const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${saved.clientId}:${saved.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code')!, redirect_uri: redirectUri, code_verifier: state.verifier }), signal: AbortSignal.timeout(15000), redirect: 'error' }), tokens = await readNetworkJson(response);
  if (!response.ok || !tokens.access_token) throw new ApiError(502, 'SPOTIFY_OAUTH_FAILED', 'Spotify не підтвердив підключення.');
  await saveConnection(userId, 'spotify', { ...saved, userToken: { ...tokens, expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000 } });
  const markup = '<!doctype html><html><meta charset="utf-8"><title>Spotify connected</title><body><p>Spotify підключено. Можна закрити це вікно.</p><script>if(window.opener){window.opener.postMessage({type:"echo-vinyl-spotify-connected"},location.origin);window.close();}</script></body></html>';
  return new Response(markup, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie('', 0), 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'self'" } });
}

export async function legacyVinylRequest(request: Request, segments: string[]) {
  const user = identity(request), path = segments.join('/'), params = new URL(request.url).searchParams, method = request.method;
  if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Цей метод недоступний.');
  if (method === 'POST' || method === 'DELETE') await csrf(request);
  if (path === 'discogs/connection') return discogsConnection(request);
  if (path === 'storage/records') {
    const target = mode(params.get('type'));
    if (method === 'GET') return json(await readVinylTables(user.id, target));
    if (method === 'POST') return json(await saveVinylTables(user.id, target, await body(request, MAX_STORAGE)));
  }
  if (path === 'status' && method === 'GET') { const saved = await connection(user.id, 'discogs'); return json({ status: 'online', userId: user.id, version: 'echo-vinyl-1', timestamp: new Date().toISOString(), discogsOAuthReady: !!saved?.consumerKey, secureStorage: encryptionAvailable() }); }
  if (path === 'discogs/auth/login' && method === 'GET') return discogsAuth(request);
  if (path === 'discogs/auth/callback' && method === 'GET') return discogsAuth(request, true);
  if (path === 'discogs/search' && method === 'GET') {
    const search = query(params, ['q', 'artist', 'release_title', 'track', 'format', 'sort', 'sort_order', 'year', 'genre', 'style', 'country', 'label', 'barcode', 'catno']);
    if (!['q', 'artist', 'release_title', 'track'].some(key => search.has(key))) return json({ results: [], pagination: {} });
    const type = ['master', 'artist'].includes(params.get('type') || '') ? params.get('type')! : 'release'; search.set('type', type); if (type === 'release' && !search.has('format')) search.set('format', 'Vinyl');
    search.set('page', String(number(params.get('page'), 1, 10000))); search.set('per_page', String(number(params.get('per_page'), 25, 100)));
    return json(await discogsJson(request, `/database/search?${search}`));
  }
  let match: RegExpMatchArray | null;
  if (method === 'GET' && (match = path.match(/^discogs\/(master|release)\/(\d+)$/))) return json(await discogsJson(request, `/${match[1] === 'master' ? 'masters' : 'releases'}/${id(match[2])}`));
  if (method === 'GET' && (match = path.match(/^discogs\/master\/(\d+)\/versions$/))) {
    const search = query(params, ['format', 'sort', 'sort_order', 'country', 'label', 'released']); search.set('format', params.get('format') || 'Vinyl'); search.set('page', String(number(params.get('page'), 1, 10000))); search.set('per_page', String(number(params.get('per_page'), 50, 100)));
    const data = await discogsJson(request, `/masters/${id(match[1])}/versions?${search}`);
    const versions = (data.versions || []).filter((version: JsonRecord) => search.get('format') !== 'Vinyl' || vinylFormat(version)).map((version: JsonRecord) => ({ ...version, year: String(parseInt(version.released || version.year, 10) || '') }));
    const years = versions.map((version: JsonRecord) => Number(version.year)).filter((year: number) => year > 1900 && year <= new Date().getFullYear());
    return json({ ...data, versions, firstPressYear: years.length ? Math.min(...years) : null });
  }
  if (method === 'GET' && (match = path.match(/^discogs\/artist\/(\d+)\/releases$/))) {
    const search = query(params, ['sort', 'sort_order']); search.set('page', String(number(params.get('page'), 1, 10000))); search.set('per_page', String(number(params.get('per_page'), 100, 100)));
    return json(await discogsJson(request, `/artists/${id(match[1])}/releases?${search}`));
  }
  if (method === 'GET' && (match = path.match(/^discogs\/master\/(\d+)\/(versions-count|vinyl-stats)$/))) return json(await versionStats(request, match[1]));
  if (path === 'discogs/masters/versions-counts' && method === 'GET') {
    const ids = Array.from(new Set((params.get('ids') || '').split(',').filter(Boolean))).slice(0, 50), counts: JsonRecord = {}, errors: JsonRecord = {};
    for (const masterId of ids) { try { counts[masterId] = (await versionStats(request, id(masterId))).versions_count; } catch (error) { counts[masterId] = null; errors[masterId] = error instanceof ApiError ? error.code : 'DISCOGS_UNAVAILABLE'; } }
    return json({ counts, errors });
  }
  if (path === 'discogs/price-stats' && method === 'GET') return json(await priceStats(request, id(params.get('release_id'))));
  if (path === 'discogs/tracklist' && method === 'GET') return json(await tracklist(request, params));
  if (path === 'track/preview' && method === 'GET') return json(await preview(text(params.get('artist')), text(params.get('track'))));
  if (path === 'video/search' && method === 'GET') return json(await video(text(params.get('artist')), text(params.get('title'))));
  if ((path === 'image-proxy' || path === 'audio-proxy') && (method === 'GET' || method === 'HEAD')) return mediaProxy(request, params.get('url') || '', path === 'image-proxy' ? 'image' : 'audio');
  if ((path === 'cover-lookup' || path === 'cover-image') && (method === 'GET' || method === 'HEAD')) {
    const artist = text(params.get('artist')), title = text(params.get('album') || params.get('title'));
    const deezerId=params.get('deezerAlbumId'),masterId=params.get('masterId'),releaseId=params.get('releaseId');
    if (!artist && !title && !deezerId && !masterId && !releaseId) throw new ApiError(400, 'ALBUM_REQUIRED', 'Вкажіть виконавця або альбом.');
    let coverUrl:string|null=null, source:string|null=null;
    if (deezerId && /^[1-9][0-9]{0,14}$/.test(deezerId)) { try { const album=await publicJson(`https://api.deezer.com/album/${deezerId}`); coverUrl=album.cover_xl||album.cover_big||album.cover_medium||null; source='Deezer'; } catch { /* Search by known album name below. */ } }
    if (!coverUrl && (artist || title)) { const album=albumMatch(await findAlbums(artist, title), artist, title); coverUrl=album?.coverImage||null; source=album?.source||null; }
    if (!coverUrl && (masterId || releaseId)) { try { const album=await discogsJson(request,masterId?`/masters/${id(masterId)}`:`/releases/${id(releaseId)}`); const primary=album.images?.find((image:JsonRecord)=>image.type==='primary')||album.images?.[0]; coverUrl=primary?.uri||album.thumb||null; source='Discogs'; } catch { /* Missing artwork is an explicit 404, never a wrong album's cover. */ } }
    if (path === 'cover-image' && coverUrl) return new Response(null, { status:302, headers:{ Location:approvedVinylMedia(coverUrl, 'image').href, 'Cache-Control':'private, max-age=86400' } });
    if (path === 'cover-image') return new Response(null, { status: 404 });
    return json({ coverUrl, source });
  }
  if (path === 'discovery/feed' && method === 'GET') {
    const exclude = new Set((params.get('exclude') || '').toLowerCase().split(',').map(value => value.trim())), genre = text(params.get('genre'));
    const data = await publicJson(genre ? `https://api.deezer.com/search?q=${encodeURIComponent(genre)}&order=RANKING&limit=50` : 'https://api.deezer.com/chart/0/tracks?limit=50');
    const tracks = (data.data || []).map(deezerTrack).filter((item: JsonRecord) => ![item.title, `${item.artist} - ${item.title}`, `${item.artist} - ${item.album}`].some(value => exclude.has(String(value).toLowerCase())));
    return json({ tracks });
  }
  if (path.startsWith('discogs/user/')) {
    const who = await discogsJson(request, '/oauth/identity'), username = encodeURIComponent(who.username || '');
    if (!username) throw new ApiError(401, 'DISCOGS_TOKEN_INVALID', 'Discogs не підтвердив профіль.');
    if (path === 'discogs/user/identity' && method === 'GET') { let profile: JsonRecord = {}; try { profile = await discogsJson(request, `/users/${username}`); } catch { /* identity still verified */ } return json({ valid: true, ...who, avatar_url: profile.avatar_url || null, num_collection: profile.num_collection ?? null, num_wantlist: profile.num_wantlist ?? null }); }
    if (path === 'discogs/user/folders' && method === 'GET') return json(await discogsJson(request, `/users/${username}/collection/folders`));
    if (path === 'discogs/user/folders' && method === 'POST') { const payload = await body(request), name = text(payload.folderName, 100); if (!name) throw new ApiError(400, 'FOLDER_NAME_REQUIRED', 'Вкажіть назву папки.'); return json(await discogsJson(request, `/users/${username}/collection/folders`, { method: 'POST', body: { name } })); }
    if (path === 'discogs/user/collection/releases' && method === 'GET') { const folder = /^\d+$/.test(params.get('folder_id') || '') ? params.get('folder_id')! : '0'; return json(await discogsJson(request, `/users/${username}/collection/folders/${folder}/releases?page=${number(params.get('page'), 1, 10000)}&per_page=${number(params.get('per_page'), 50, 100)}&sort=added&sort_order=desc`)); }
    if (path === 'discogs/user/wants' && method === 'GET') return json(await discogsJson(request, `/users/${username}/wants?page=${number(params.get('page'), 1, 10000)}&per_page=${number(params.get('per_page'), 50, 100)}`));
    if (path === 'discogs/user/sync' && method === 'POST') {
      const payload = await body(request, 512000), releases = payload.releases;
      if (!Array.isArray(releases) || !releases.length || releases.length > 200) throw new ApiError(400, 'INVALID_SYNC_ITEMS', 'Передайте від 1 до 200 видань.');
      const folder = /^\d+$/.test(String(payload.folderId || '')) ? String(payload.folderId) : '1', results: JsonRecord[] = [];
      for (const item of releases) { const releaseId = id(item.id || item.discogsId); try { const data = await discogsJson(request, payload.mode === 'wantlist' ? `/users/${username}/wants/${releaseId}` : `/users/${username}/collection/folders/${folder}/releases/${releaseId}`, { method: payload.mode === 'wantlist' ? 'PUT' : 'POST', ...(payload.mode === 'wantlist' && item.notes ? { body: { notes: text(item.notes, 1000) } } : {}) }); results.push({ id: releaseId, status: 'ok', data }); } catch (error) { results.push({ id: releaseId, status: 'failed', error: error instanceof Error ? error.message : 'Discogs error' }); } }
      const successCount = results.filter(item => item.status === 'ok').length;
      return json({ total: releases.length, successCount, failCount: releases.length - successCount, results });
    }
  }
  if (path === 'spotify/credentials') return spotifyCredentials(request);
  if (path === 'spotify/connection') return spotifyConnection(request);
  if (path === 'spotify/auth/login' && method === 'GET') return spotifyAuth(request);
  if (path === 'spotify/auth/callback' && method === 'GET') return spotifyAuth(request, true);
  if (path === 'spotify/me' && method === 'GET') return json(await spotifyJson(request, '/v1/me', { userRequired: true }));
  if (path === 'spotify/search' && method === 'GET') {
    const term = text(params.get('q')), type = params.get('type') === 'album' ? 'album' : 'track', limit = number(params.get('limit'), 20, 50);
    if (!term) return json({ results: [], source: 'empty' });
    try {
      const data = await spotifyJson(request, `/v1/search?q=${encodeURIComponent(term)}&type=${type}&limit=${limit}`);
      const results = type === 'track' ? (data.tracks?.items || []).map(spotifyTrack) : (data.albums?.items || []).map((item: JsonRecord) => ({ id: item.id, spotifyId: item.id, title: item.name, artist: item.artists?.map((a: JsonRecord) => a.name).join(', '), year: item.release_date?.slice(0, 4), releaseDate: item.release_date, totalTracks: item.total_tracks, coverImage: item.images?.[0]?.url, spotifyUrl: item.external_urls?.spotify, type: 'album' }));
      return json({ results, source: `spotify_${type}` });
    } catch { /* Public catalogs preserve the tracker without Spotify credentials. */ }
    if (type === 'album') return json({ results: (await findAlbums('', term, limit)).slice(0, limit), source: 'fallback_albums' });
    const data = await publicJson(`https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=${limit}`); return json({ results: (data.data || []).map(deezerTrack), source: 'deezer' });
  }
  if (path === 'spotify/album/tracks' && method === 'GET') {
    const rawId = text(params.get('id')), artist = text(params.get('artist')), title = text(params.get('album'));
    if (/^(?:sp-)?[a-zA-Z0-9]{22}$/.test(rawId)) {
      try { const data = await spotifyJson(request, `/v1/albums/${rawId.replace(/^sp-/, '')}`); return json({ found: !!data.tracks?.items?.length, title: data.name, artist: data.artists?.map((a: JsonRecord) => a.name).join(', '), cover: data.images?.[0]?.url, year: data.release_date?.slice(0, 4), source: 'Spotify', tracklist: (data.tracks?.items || []).map((item: JsonRecord, index: number) => ({ position: String(item.track_number || index + 1), title: item.name, artist: item.artists?.map((a: JsonRecord) => a.name).join(', '), duration: duration((item.duration_ms || 0) / 1000), previewUrl: item.preview_url })) }); } catch { /* exact album fallback below */ }
    }
    return json(await publicAlbumTracks(rawId, artist, title));
  }
  if (path === 'spotify/user/playlist' && method === 'POST') {
    const payload = await body(request, 512000), raw = payload.trackUris;
    if (!Array.isArray(raw) || !raw.length || raw.length > 1000) throw new ApiError(400, 'INVALID_SPOTIFY_TRACKS', 'Передайте від 1 до 1000 пісень.');
    const uris: string[] = [];
    for (const value of raw) {
      if (typeof value !== 'string') continue;
      if (/^spotify:track:[a-zA-Z0-9]{22}$/.test(value)) { uris.push(value); continue; }
      if (value.startsWith('spotify:search:')) { let q: string; try { q = decodeURIComponent(value.slice(15)); } catch { continue; } const found = await spotifyJson(request, `/v1/search?q=${encodeURIComponent(q.slice(0, 300))}&type=track&limit=1`, { userRequired: true }); if (found.tracks?.items?.[0]?.uri) uris.push(found.tracks.items[0].uri); }
    }
    if (!uris.length) throw new ApiError(400, 'SPOTIFY_TRACKS_NOT_FOUND', 'Spotify не знайшов цих пісень. Список не створено.');
    const me = await spotifyJson(request, '/v1/me', { userRequired: true }), name = text(payload.name, 100) || 'ECHO Vinyl';
    const playlist = await spotifyJson(request, `/v1/users/${encodeURIComponent(me.id)}/playlists`, { method: 'POST', body: { name, public: payload.isPublic === true, description: 'ECHO Vinyl collection' }, userRequired: true });
    let addedCount = 0;
    for (let index = 0; index < uris.length; index += 100) { const batch = uris.slice(index, index + 100); await spotifyJson(request, `/v1/playlists/${playlist.id}/tracks`, { method: 'POST', body: { uris: batch }, userRequired: true }); addedCount += batch.length; }
    return json({ success: true, playlistId: playlist.id, playlistUrl: playlist.external_urls?.spotify, playlistName: name, totalRequested: raw.length, addedCount });
  }
  throw new ApiError(404, 'VINYL_ENDPOINT_NOT_FOUND', 'Функцію не знайдено.');
}

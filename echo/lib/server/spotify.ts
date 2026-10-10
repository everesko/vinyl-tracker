import { ApiError, database, identity, json, runtime } from "./http";

const COOKIE = "echo_spotify_oauth";
export function spotifyAvailability() {
  const e = runtime();
  const reason = e.SPOTIFY_APPROVED_FOR_QUIZ !== "true"
    ? "Spotify запрещает музыкальные викторины без отдельного разрешения. Подключение недоступно."
    : !e.SPOTIFY_CLIENT_ID || !e.SPOTIFY_CLIENT_SECRET || !e.SESSION_ENCRYPTION_KEY || e.SESSION_ENCRYPTION_KEY.length < 32 || !e.SITE_ORIGIN
      ? "Для подключения нужны ключи Spotify, защищённая сессия и адрес сайта."
      : "";
  let validOrigin = false;
  try { const url = new URL(e.SITE_ORIGIN || ""); validOrigin = url.protocol === "https:" && url.origin === e.SITE_ORIGIN; } catch { /* unconfigured */ }
  const detail = reason || (!validOrigin ? "Нужен корректный HTTPS-адрес сайта для OAuth." : "");
  return { available: !detail, reason: detail || undefined };
}
function configured(request: Request) {
  const status = spotifyAvailability();
  if (!status.available) throw new ApiError(503, "SPOTIFY_DISABLED", status.reason!);
  const origin = runtime().SITE_ORIGIN!;
  let url: URL;
  try { url = new URL(origin); } catch { throw new ApiError(503, "SPOTIFY_DISABLED", "Адрес сайта настроен неверно."); }
  if (url.protocol !== "https:" || url.origin !== new URL(request.url).origin || origin !== url.origin) throw new ApiError(503, "SPOTIFY_DISABLED", "OAuth доступен только на настроенном HTTPS-адресе сайта.");
  return origin;
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function unbase64(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
}
async function key() {
  const secret = runtime().SESSION_ENCRYPTION_KEY!;
  if (secret.length < 32) throw new ApiError(503, "SPOTIFY_DISABLED", "Ключ шифрования сессии должен содержать не менее 32 символов.");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), new TextEncoder().encode(JSON.stringify(value)));
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
async function decrypt(value: string) {
  const [iv, ciphertext] = value.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv) }, await key(), unbase64(ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}
function cookie(value: string, maxAge: number) { return `${COOKIE}=${value}; Path=/api/spotify; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
export async function connectSpotify(request: Request) {
  const origin = configured(request), user = identity(request);
  const state = base64(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = base64(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const session = await encrypt({ state, verifier, userId: user.id, expires: Date.now() + 600000 });
  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({ response_type: "code", client_id: runtime().SPOTIFY_CLIENT_ID!, redirect_uri: `${origin}/api/spotify/callback`, state, code_challenge_method: "S256", code_challenge: challenge }).toString();
  return json({ url: url.toString() }, 200, { "Set-Cookie": cookie(session, 600) });
}
export async function callbackSpotify(request: Request) {
  const origin = configured(request), user = identity(request), params = new URL(request.url).searchParams;
  const value = request.headers.get("cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  let session;
  try { session = await decrypt(value || ""); } catch { throw new ApiError(400, "OAUTH_STATE_INVALID", "Сессия подключения истекла. Начните заново."); }
  if (!session || session.userId !== user.id || session.state !== params.get("state") || session.expires < Date.now() || !params.get("code")) throw new ApiError(400, "OAUTH_STATE_INVALID", "Не удалось проверить подключение Spotify.");
  const response = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${runtime().SPOTIFY_CLIENT_ID}:${runtime().SPOTIFY_CLIENT_SECRET}`)}` }, body: new URLSearchParams({ grant_type: "authorization_code", code: params.get("code")!, redirect_uri: `${origin}/api/spotify/callback`, code_verifier: session.verifier }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new ApiError(502, "SPOTIFY_OAUTH_FAILED", "Spotify не подтвердил подключение. Повторите попытку.");
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tokens.access_token) throw new ApiError(502, "SPOTIFY_OAUTH_FAILED", "Spotify не вернул ключ доступа.");
  await database().prepare("INSERT INTO echo_spotify_connections (user_id, encrypted_tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET encrypted_tokens = excluded.encrypted_tokens, updated_at = excluded.updated_at").bind(user.id, await encrypt({ ...tokens, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 }), Date.now()).run();
  return new Response(null, { status: 303, headers: { Location: `${origin}/?spotify=connected`, "Set-Cookie": cookie("", 0), "Cache-Control": "no-store" } });
}
export async function spotifyStatus(userId: string) {
  const connection = await database().prepare("SELECT user_id FROM echo_spotify_connections WHERE user_id = ?").bind(userId).first();
  return { connected: !!connection, ...spotifyAvailability() };
}

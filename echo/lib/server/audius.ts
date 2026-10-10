import type { Collection, Track } from "@/lib/quiz";
import { ApiError, database } from "./http";
import { credentials } from "./settings";

const API = "https://api.audius.co/v1";
const genres = [
  ["electronic", "Электроника", "Electronic"], ["hiphop", "Хип-хоп", "Hip-Hop/Rap"], ["rock", "Рок", "Rock"],
  ["pop", "Поп", "Pop"], ["alternative", "Альтернатива", "Alternative"], ["metal", "Метал", "Metal"],
  ["punk", "Панк", "Punk"], ["folk", "Фолк", "Folk"], ["jazz", "Джаз", "Jazz"],
  ["acoustic", "Акустика", "Acoustic"], ["funk", "Фанк", "Funk"], ["soul", "R&B / Соул", "R&B/Soul"],
  ["classical", "Классика", "Classical"], ["reggae", "Регги", "Reggae"], ["country", "Кантри", "Country"],
  ["blues", "Блюз", "Blues"], ["latin", "Латино", "Latin"], ["lofi", "Лоу-фай", "Lo-Fi"],
  ["house", "Хаус", "House"], ["techno", "Техно", "Techno"], ["trap", "Трэп", "Trap"],
  ["dubstep", "Дабстеп", "Dubstep"], ["drum-bass", "Драм-н-бейс", "Drum & Bass"], ["ambient", "Эмбиент", "Ambient"],
] as const;
const colors = ["#a7a3f6", "#e6a585", "#a5c9ba", "#f5a7bd", "#95b7df", "#d0bded"];
export const audiusCollections = genres.map(([slug, title, genre], index) => ({
  id: `audius-${slug}`, title, subtitle: "50 реальных треков · Audius", color: colors[index % colors.length], tag: genre.toUpperCase(),
  image: `/art/${["rock", "metal", "punk", "alternative"].includes(slug) ? "rock" : ["pop", "soul", "folk", "acoustic"].includes(slug) ? "pop" : "disco"}.png`,
  count: 50, playable: true, source: "audius" as const, genre, live: true,
}));
type ApiTrack = {
  id: string; title: string; genre?: string; duration: number; release_date?: string; permalink?: string;
  is_available?: boolean; is_streamable?: boolean; is_stream_gated?: boolean; is_unlisted?: boolean; is_delete?: boolean;
  allowed_api_keys?: string[] | null; access?: { stream?: boolean }; artwork?: { "480x480"?: string };
  user?: { name?: string; handle?: string; is_available?: boolean; is_deactivated?: boolean };
};
export function isEligibleTrack(track: ApiTrack) {
  return !!track && /^[a-zA-Z0-9]+$/.test(track.id) && !!track.title?.trim() && track.title.length <= 160 &&
    !!track.user?.name?.trim() && track.user.name.length <= 160 && track.is_available === true && track.is_streamable === true &&
    track.access?.stream === true && !track.is_stream_gated && !track.is_unlisted && !track.is_delete &&
    !track.allowed_api_keys?.length && track.user.is_available === true && !track.user.is_deactivated &&
    Number.isFinite(track.duration) && track.duration >= 45 && track.duration <= 600 &&
    !/radio|podcast|episode|budilnik|full mix|dj set/i.test(`${track.title} ${track.user.name}`);
}
export function canonicalTrack(track: ApiTrack): Track {
  const title = track.title.trim(), artist = track.user!.name!.trim();
  const year = Number(track.release_date?.slice(0, 4));
  const prefix = title.match(/^(.{2,60}?)\s[-–—]\s(.+)$/);
  const verseStart = Math.min(25, Math.floor(track.duration * .18));
  return {
    id: `audius-${track.id}`, provider: "audius", providerId: track.id, title, artist,
    artistAliases: [...new Set([track.user!.handle || "", ...(prefix ? [prefix[1]] : [])].filter(Boolean))],
    titleAliases: prefix ? [prefix[2]] : undefined, genres: [track.genre || "Music"], year: Number.isFinite(year) && year >= 1900 ? year : 0,
    audioUrl: `${API}/tracks/${encodeURIComponent(track.id)}/stream?app_name=ECHO`, duration: track.duration,
    verseStart, verseEnd: verseStart + 7, encoreStart: Math.min(track.duration - 12, Math.floor(track.duration * .45)),
    artworkUrl: track.artwork?.["480x480"]?.startsWith("https://") ? track.artwork["480x480"] : undefined,
    sourceUrl: track.permalink?.startsWith("/") ? `https://audius.co${track.permalink}` : undefined,
    rights: "Audius API / Open Music License. Публичный незаблокированный аудиопоток; права и настройки автора сохраняются.",
  };
}
export async function audiusRequest(path: string, params: URLSearchParams, apiKey?: string) {
  const url = new URL(`${API}${path}`); params.set("app_name", "ECHO");
  if (apiKey) params.set("api_key", apiKey);
  url.search = params.toString();
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: "application/json" } }); }
  catch { throw new ApiError(504, "MUSIC_TIMEOUT", "Музыкальный каталог не ответил вовремя. Попробуйте ещё раз."); }
  if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, "MUSIC_PROVIDER_ERROR", response.status === 429 ? "Audius ограничил число запросов. Подождите немного." : "Не удалось получить треки Audius. Повторите попытку.");
  const payload = await response.json() as { data?: unknown };
  return payload.data;
}
async function trending(genre: string | undefined, apiKey?: string): Promise<Track[]> {
  const params = new URLSearchParams({ limit: "100", time: "allTime" }); if (genre) params.set("genre", genre);
  const result = await audiusRequest("/tracks/trending", params, apiKey);
  if (!Array.isArray(result)) throw new ApiError(502, "MUSIC_INVALID_RESPONSE", "Музыкальный каталог вернул неверный ответ.");
  return result.filter(isEligibleTrack).map(canonicalTrack);
}
export function selectFifty(candidates: Track[]) {
  const seen = new Set<string>(), counts = new Map<string, number>(), selected: Track[] = [];
  for (const artistLimit of [3, Infinity]) for (const track of candidates) {
    if (selected.length === 50) return selected;
    if (seen.has(track.id) || (counts.get(track.artist) ?? 0) >= artistLimit) continue;
    seen.add(track.id); counts.set(track.artist, (counts.get(track.artist) ?? 0) + 1); selected.push(track);
  }
  throw new ApiError(409, "NOT_ENOUGH_TRACKS", "В этом жанре сейчас нет 50 доступных записей. Выберите другой жанр.");
}
export async function getCanonicalTracks(userId: string, ids: string[]) {
  if (ids.some(id => !/^audius-[a-zA-Z0-9]+$/.test(id)) || ids.length > 100) throw new ApiError(400, "INVALID_TRACK_IDS", "Ожидаются известные идентификаторы Audius.");
  const { audiusKey } = await credentials(userId), params = new URLSearchParams();
  ids.forEach(id => params.append("id", id.slice(7)));
  const raw = await audiusRequest("/tracks", params, audiusKey);
  if (!Array.isArray(raw)) throw new ApiError(502, "MUSIC_INVALID_RESPONSE", "Не удалось проверить выбранные треки.");
  const found = new Map(raw.filter(isEligibleTrack).map(canonicalTrack).map(track => [track.id, track]));
  const ordered = ids.map(id => found.get(id));
  if (ordered.some(track => !track)) throw new ApiError(409, "TRACKS_NO_LONGER_AVAILABLE", "Некоторые песни больше недоступны. Создайте подборку заново.");
  return ordered as Track[];
}
export async function audiusDeck(userId: string, id: string) {
  const card = audiusCollections.find(collection => collection.id === id);
  if (!card) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Подборка не найдена.");
  const cached = await database().prepare("SELECT track_data, updated_at FROM echo_media_collections WHERE id = ?").bind(id).first<{ track_data: string; updated_at: number }>();
  let deck: Track[];
  if (cached && cached.updated_at > Date.now() - 600000) deck = await getCanonicalTracks(userId, (JSON.parse(cached.track_data) as Track[]).map(track => track.id));
  else {
    const { audiusKey } = await credentials(userId); deck = selectFifty(await trending(card.genre, audiusKey));
    await database().prepare("INSERT INTO echo_media_collections (id, track_data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET track_data = excluded.track_data, updated_at = excluded.updated_at").bind(id, JSON.stringify(deck), Date.now()).run();
  }
  const collection: Collection = { ...card, trackIds: deck.map(track => track.id) };
  return { collection, deck };
}
export function inferGenre(prompt: string) {
  const text = prompt.toLowerCase();
  const patterns: [string, RegExp][] = [["drum-bass", /drum|драм|dnb/], ["dubstep", /dubstep|дабстеп/], ["hiphop", /hip.?hop|rap|рэп|хип.?хоп/], ["lofi", /lo.?fi|лоу.?фай/], ["punk", /punk|панк|green day|blink/], ["alternative", /alternative|альтернатив|linkin|линкин|muse|radiohead|гранж/], ["metal", /metal|метал/], ["rock", /rock|рок|queen|куин|nirvana/], ["pop", /pop|поп|gaga|taylor|rihanna/], ["classical", /classical|классик/], ["soul", /soul|соул|r&b/], ["electronic", /electronic|электрон/]];
  const found = patterns.find(([, regex]) => regex.test(text));
  return found ? audiusCollections.find(card => card.id === `audius-${found[0]}`)?.genre : audiusCollections.find(card => text.includes(card.genre.toLowerCase()) || text.includes(card.title.toLowerCase()))?.genre;
}
export async function candidatePool(userId: string, prompt: string) {
  const { audiusKey } = await credentials(userId), genre = inferGenre(prompt);
  const requests: Promise<Track[]>[] = [trending(genre, audiusKey), trending(genre === "Electronic" ? "Hip-Hop/Rap" : "Electronic", audiusKey), trending(genre === "Pop" ? "Rock" : "Pop", audiusKey)];
  if (prompt.trim().length > 2) requests.push(audiusRequest("/tracks/search", new URLSearchParams({ query: prompt.trim().slice(0, 180), limit: "100" }), audiusKey).then(result => Array.isArray(result) ? result.filter(isEligibleTrack).map(canonicalTrack) : []));
  const results = await Promise.allSettled(requests), candidates = new Map<string, Track>();
  for (const result of results) if (result.status === "fulfilled") for (const track of result.value) candidates.set(track.id, track);
  if (candidates.size < 50) throw new ApiError(502, "NOT_ENOUGH_CANDIDATES", "Не удалось найти 50 доступных записей. Попробуйте другой запрос или повторите позже.");
  return [...candidates.values()].slice(0, 220);
}
export async function streamAudius(track: Track, userId: string, request: Request) {
  if (track.provider !== "audius" || !track.providerId || !/^[a-zA-Z0-9]+$/.test(track.providerId)) throw new ApiError(404, "AUDIO_NOT_FOUND", "Аудиофрагмент не найден.");
  const { audiusKey } = await credentials(userId), url = new URL(`${API}/tracks/${track.providerId}/stream`);
  url.searchParams.set("app_name", "ECHO"); if (audiusKey) url.searchParams.set("api_key", audiusKey);
  const headers = new Headers(), range = request.headers.get("range");
  if (range && !/^bytes=\d*-\d*$/.test(range)) throw new ApiError(416, "INVALID_RANGE", "Неверный диапазон аудио.");
  if (range) headers.set("Range", range);
  let upstream: Response;
  try { upstream = await fetch(url, { headers, signal: AbortSignal.timeout(25000) }); }
  catch { throw new ApiError(504, "AUDIO_TIMEOUT", "Аудиофрагмент не загрузился. Повторите воспроизведение."); }
  if (!upstream.ok || !upstream.headers.get("content-type")?.startsWith("audio/")) {
    await upstream.body?.cancel(); throw new ApiError(502, "AUDIO_UNAVAILABLE", "Запись временно недоступна. Повторите воспроизведение.");
  }
  const output = new Headers({ "Content-Type": upstream.headers.get("content-type")!, "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
  for (const name of ["content-length", "content-range"]) { const value = upstream.headers.get(name); if (value) output.set(name, value); }
  return new Response(upstream.body, { status: upstream.status, headers: output });
}

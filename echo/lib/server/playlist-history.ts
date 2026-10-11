import type { Track } from '@/lib/quiz';
import { ApiError, database } from './http';
import { readJson } from './stored-json';

export type PlayedSong = { artist: string; title: string };
const PAGE_SIZE = 128;

export function normalizePlaylistPrompt(prompt: string) {
  return prompt.normalize('NFKC').trim().toLocaleLowerCase('uk-UA').replace(/\s+/gu, ' ');
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new ApiError(499, 'CANCELLED', 'Створення підбірки скасовано.');
}
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function scope(userId: string, prompt: string) {
  return `played-playlist:v1:${await digest(JSON.stringify([userId, normalizePlaylistPrompt(prompt)]))}:`;
}
function songKey(song: PlayedSong) {
  return JSON.stringify([normalizePlaylistPrompt(song.artist), normalizePlaylistPrompt(song.title)]);
}
function song(value: unknown): PlayedSong | undefined {
  const candidate = value as PlayedSong | undefined;
  if (!candidate || typeof candidate.artist !== 'string' || typeof candidate.title !== 'string') return;
  const artist = candidate.artist.trim(), title = candidate.title.trim();
  if (!artist || !title || artist.length > 300 || title.length > 500) return;
  return { artist, title };
}
export async function playlistPromptForCollection(userId: string, collectionId: string) {
  if (!collectionId.startsWith('custom-')) return undefined;
  const row = await database().prepare('SELECT recipe FROM echo_collections WHERE id = ? AND user_id = ?').bind(collectionId, userId).first<{ recipe: string | null }>();
  if (!row?.recipe) return undefined;
  try {
    const recipe = JSON.parse(row.recipe);
    return recipe.ai === true && typeof recipe.prompt === 'string' && recipe.prompt.trim() ? normalizePlaylistPrompt(recipe.prompt) : undefined;
  } catch { return undefined; }
}
export async function recordPlayedSong(userId: string, prompt: string, value: PlayedSong | Track) {
  const played = song(value);
  if (!played || !prompt.trim()) return;
  const id = `${await scope(userId, prompt)}song:${await digest(songKey(played))}`;
  await database().prepare('INSERT INTO echo_media_collections (id,track_data,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at')
    .bind(id, JSON.stringify(played), Date.now()).run();
}

// Older sessions did not have a played-song ledger. Only evidenced playback is
// imported; an untouched portion of a generated deck is never played history.
export function playedSongsFromState(state: Record<string, any>): PlayedSong[] {
  if (Array.isArray(state.playedSongs)) return state.playedSongs.map(song).filter((item): item is PlayedSong => !!item);
  if (!Array.isArray(state.deck)) return [];
  const played: PlayedSong[] = [];
  for (let index = 0; index < (Array.isArray(state.results) ? state.results.length : 0); index++) {
    if (state.results[index]) { const item = song(state.deck[index]); if (item) played.push(item); }
  }
  if (['playing', 'paused', 'reveal'].includes(state.phase)) {
    const item = song(state.deck[state.index]); if (item) played.push(item);
  }
  return played;
}
async function hydrate(text: string) {
  const state = JSON.parse(text);
  return state.$externalState ? readJson<Record<string, any>>(JSON.stringify({ $echoChunks: state.$externalState })) : state;
}
async function rememberState(userId: string, prompt: string, text: string, signal?: AbortSignal) {
  const state = await hydrate(text);
  for (const played of playedSongsFromState(state)) {
    check(signal); await recordPlayedSong(userId, prompt, played);
  }
}
async function backfillLegacy(userId: string, prompt: string, prefix: string, signal?: AbortSignal) {
  const id = `${prefix}migration`, db = database();
  const marker = await db.prepare('SELECT track_data FROM echo_media_collections WHERE id = ?').bind(id).first<{ track_data: string }>();
  let cursor = ''; let done = false;
  if (marker) try { ({ cursor, done } = JSON.parse(marker.track_data)); } catch { /* A damaged marker can safely be rebuilt. */ }
  if (done) return;
  const started = Date.now();
  do {
    check(signal);
    const page = await db.prepare('SELECT g.id,g.state,g.collection_title,c.recipe FROM echo_games g LEFT JOIN echo_collections c ON c.id=g.collection_id AND c.user_id=g.user_id WHERE g.user_id = ? AND g.collection_id LIKE \'custom-%\' AND g.id > ? ORDER BY g.id LIMIT 32')
      .bind(userId, cursor).all<{ id: string; state: string; collection_title: string; recipe?: string | null }>();
    for (const row of page.results) {
      check(signal);
      let query: string | undefined;
      try { const recipe = JSON.parse(row.recipe ?? 'null'); if (recipe?.ai && typeof recipe.prompt === 'string') query = normalizePlaylistPrompt(recipe.prompt); } catch { /* Preserve the rest of the history. */ }
      // Deleted legacy recipes can only be identified when their displayed title was the original prompt.
      if (query === prompt || (!query && normalizePlaylistPrompt(row.collection_title) === prompt)) {
        try { await rememberState(userId, prompt, row.state, signal); } catch (error) { if (signal?.aborted) throw error; }
      }
      cursor = row.id;
    }
    done = page.results.length < 32;
  } while (!done && Date.now() - started < 1500);
  check(signal);
  await db.prepare('INSERT INTO echo_media_collections (id,track_data,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at')
    .bind(id, JSON.stringify({ cursor, done }), Date.now()).run();
}
export async function getPlayedSongs(userId: string, rawPrompt: string, signal?: AbortSignal): Promise<PlayedSong[]> {
  check(signal);
  const prompt = normalizePlaylistPrompt(rawPrompt), prefix = await scope(userId, prompt);
  await backfillLegacy(userId, prompt, prefix, signal);
  // The ledger in a game survives a failed secondary write and collection deletion.
  const fallback: PlayedSong[] = [];
  let gameCursor = '';
  while (true) {
    check(signal);
    // Extract just the small ledger for ordinary games instead of loading their whole decks.
    const page = await database().prepare('SELECT id,json_extract(state,\'$.playedSongs\') AS played,json_extract(state,\'$.$externalState\') AS external FROM echo_games WHERE user_id = ? AND json_extract(state,\'$.playlistPrompt\') = ? AND id > ? ORDER BY id LIMIT ?')
      .bind(userId, prompt, gameCursor, PAGE_SIZE).all<{ id: string; played: string | null; external: string | null }>();
    for (const row of page.results) {
      check(signal); gameCursor = row.id;
      try {
        if (row.played) fallback.push(...playedSongsFromState({ playedSongs: JSON.parse(row.played) }));
        else if (row.external) fallback.push(...playedSongsFromState(await readJson<Record<string, any>>(JSON.stringify({ $echoChunks: JSON.parse(row.external) }))));
      } catch (error) { if (signal?.aborted) throw error; }
    }
    if (page.results.length < PAGE_SIZE) break;
  }
  const start = `${prefix}song:`, end = `${prefix}song;`, found = new Map<string, PlayedSong>();
  for (const item of fallback) found.set(songKey(item), item);
  let cursor = start;
  while (true) {
    check(signal);
    const page = await database().prepare('SELECT id,track_data FROM echo_media_collections WHERE id > ? AND id < ? ORDER BY id LIMIT ?')
      .bind(cursor, end, PAGE_SIZE).all<{ id: string; track_data: string }>();
    check(signal);
    for (const row of page.results) {
      cursor = row.id;
      try { const item = song(JSON.parse(row.track_data)); if (item) found.set(songKey(item), item); } catch { /* Skip a damaged secondary record without dropping other history. */ }
    }
    if (page.results.length < PAGE_SIZE) break;
  }
  return [...found.values()];
}

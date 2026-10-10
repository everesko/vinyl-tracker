/** Live free-provider integration. LOCAL Worker only; isolated ledgers are removed afterwards.
 * node tests/real-e2e.mjs [http://127.0.0.1:8787]
 * Uses genuine Deezer preview bytes and respects every server clip deadline.
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.argv[2] || 'http://127.0.0.1:8787';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const users = ['a', 'b'].map(name => ({ id: `echo-real-test-${name}-${nonce}`, email: `echo-real-test-${name}-${nonce}@example.test` }));
const verified = new Set();
const settings = { duration: 3, timer: false };
let assertions = 0;
const same = (actual, expected, message) => { assertions++; assert.equal(actual, expected, message); };
const check = (value, message) => { assertions++; assert.ok(value, message); };
function headers(user, method = 'GET') {
  return { Connection: 'close', 'oai-authenticated-user-id': user.id, 'oai-authenticated-user-email': user.email,
    ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }) };
}
async function request(user, path, method = 'GET', payload) {
  const response = await fetch(origin + path, { method, headers: headers(user, method),
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(90000) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${path}: non-JSON response (${response.status}): ${text.slice(0, 500)}`); }
  return { status: response.status, data };
}
async function ok(user, path, method = 'GET', payload) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const result = await request(user, path, method, payload);
    if (result.status === 503 && result.data.error === 'CATALOG_PREPARING' && result.data.canRetry === true && attempt < 15) {
      if (attempt === 0 || attempt === 7) console.log(`Catalog preparation: retrying ${method} ${path} (${attempt + 1}/16).`);
      await delay(2000); continue;
    }
    check(result.status >= 200 && result.status < 300, `${path}: ${result.status} ${JSON.stringify(result.data)}`);
    return result.data;
  }
  throw new Error('Catalog retry bound exhausted.');
}
async function playAnswer(user, game, answer) {
  const started = await ok(user, `/api/games/${game.id}/play`, 'POST', { round: game.index });
  await delay(Math.max(0, started.clipEndsAt - Date.now()) + 80);
  return ok(user, `/api/games/${game.id}/answer`, 'POST', { round: game.index, ...answer });
}
function hiddenAnswers(game) {
  for (const field of ['artist', 'title', 'providerId', 'artworkUrl', 'sourceUrl', 'popularityRank']) check(!(field in game.track), `Pre-answer track must hide ${field}.`);
  same(game.track.id, `${game.id}:${game.index}`);
  same(game.track.audioUrl, `/api/games/${game.id}/audio?round=${game.index}`);
  check(!game.reveal);
}

try {
  for (const user of users) {
    const profile = await ok(user, '/api/profile');
    same(profile.profile.displayName, user.email.split('@')[0]); same(profile.profile.xp, 0); same(profile.profile.games, 0);
    verified.add(user.id);
  }
  console.log('Checking 23 popular Deezer collections and free private playlist creation…');
  const catalog = await ok(users[0], '/api/catalog');
  const popular = catalog.collections.filter(card => card.source === 'deezer' && !card.id.startsWith('custom-'));
  same(popular.length, 23);
  check(popular.every(card => card.count >= 10 && card.playable && !card.trackIds));
  check(popular.some(card => card.category === 'genre') && popular.some(card => card.category === 'era') && popular.some(card => card.category === 'artist'));
  check(popular.every(card => card.popularity?.provider === 'Deezer' && card.popularity?.minimum >= 100000));
  const invalidPrompt = await request(users[0], '/api/collections', 'POST', { prompt: '' });
  same(invalidPrompt.status, 400); same(invalidPrompt.data.error, 'INVALID_PROMPT');
  const ownCollection = await ok(users[0], '/api/collections', 'POST', { prompt: 'Queen' });
  const otherCollection = await ok(users[1], '/api/collections', 'POST', { prompt: 'ABBA' });
  for (const created of [ownCollection, otherCollection]) {
    same(created.source, 'catalog'); check(created.collection.count >= 50); same(created.collection.playable, true);
    check(created.collection.id.startsWith('custom-')); same(created.collection.source, 'deezer'); check(!created.collection.trackIds);
    check(created.collection.popularity.minimum >= 100000);
  }
  const own = await ok(users[0], '/api/catalog'), foreign = await ok(users[1], '/api/catalog');
  same(own.collections.filter(card => card.id === ownCollection.collection.id).length, 1);
  same(foreign.collections.filter(card => card.id === ownCollection.collection.id).length, 0);
  same(foreign.collections.filter(card => card.id === otherCollection.collection.id).length, 1);
  same(own.collections.filter(card => card.id === otherCollection.collection.id).length, 0);
  const foreignCustom = await request(users[1], '/api/games', 'POST', { collectionId: ownCollection.collection.id, settings });
  same(foreignCustom.status, 404); same(foreignCustom.data.error, 'COLLECTION_NOT_FOUND');

  console.log('Verifying real preview bytes, forced song mode, alternate hints and deferred settlement…');
  let game = await ok(users[0], '/api/games', 'POST', { collectionId: ownCollection.collection.id, settings: { ...settings, difficulty: 'easy' } });
  const gameId = game.id; same(game.total, 50); same(game.phase, 'ready'); same(game.settings.difficulty, 'easy'); same(game.maxScore, 750); same(game.songOnly, true); same(game.settings.mode, 'song');
  hiddenAnswers(game);
  same((await request(users[1], `/api/games/${gameId}`)).status, 404);
  same((await request(users[1], `/api/games/${gameId}/cancel`, 'POST', {})).status, 404);
  const audioPath = game.track.audioUrl;
  const audio = await fetch(origin + audioPath, { headers: { ...headers(users[0]), Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(60000) });
  same(audio.status, 206); check(audio.headers.get('content-type')?.startsWith('audio/'));
  check(/^bytes 0-4095\/\d+$/.test(audio.headers.get('content-range') || '')); same(audio.headers.get('cache-control'), 'private, no-store');
  same((await audio.arrayBuffer()).byteLength, 4096);
  same((await request(users[1], audioPath)).status, 404);
  game = await playAnswer(users[0], game, { mode: 'artist', artist: 'Queen' });
  same(game.score, -7.5); same(game.reveal.result.mode, 'song'); same(game.reveal.result.artistCorrect, false); same(game.reveal.result.multiplier, 1.5);
  same(game.reveal.artist, 'Queen'); same(game.reveal.provider, 'deezer'); check(!!game.reveal.title && !!game.reveal.artworkUrl);
  check(new URL(game.reveal.sourceUrl).hostname.endsWith('deezer.com')); same(game.reveal.encoreStart, 15); same(game.reveal.videoAvailable, false);
  same((await ok(users[0], '/api/profile')).profile.xp, 0, 'Uncompleted positive rewards cannot enter the balance.');
  const replayAnswer = await ok(users[0], `/api/games/${gameId}/answer`, 'POST', { round: 0, mode: 'both', artist: '', song: '' });
  same(replayAnswer.score, -7.5); same(replayAnswer.reveal.result.mode, 'song');
  game = await ok(users[0], `/api/games/${gameId}/next`, 'POST', { round: 0 }); hiddenAnswers(game);
  game = await ok(users[0], `/api/games/${gameId}/play`, 'POST', { round: 1 });
  const clipEnd = game.clipEndsAt, deadline = game.deadline;
  await delay(Math.max(0, clipEnd - Date.now()) + 80);
  game = await ok(users[0], `/api/games/${gameId}/hint`, 'POST', { round: 1 });
  hiddenAnswers(game); same(game.hintUsed, true); same(game.hintStart, 12); same(game.hint.duration, 3); same(game.hint.available, false);
  same(game.clipEndsAt, clipEnd); same(game.deadline, deadline); check(game.hintStart + game.hint.duration <= game.track.duration);
  const hintRepeat = await ok(users[0], `/api/games/${gameId}/hint`, 'POST', { round: 1 }); same(hintRepeat.hintStart, 12); same(hintRepeat.hintUsed, true);
  const alternateBytes = await fetch(origin + game.hint.audioUrl, { headers: { ...headers(users[0]), Range: 'bytes=16384-20479' }, signal: AbortSignal.timeout(60000) });
  same(alternateBytes.status, 206); check(/^bytes 16384-20479\/\d+$/.test(alternateBytes.headers.get('content-range') || '')); same((await alternateBytes.arrayBuffer()).byteLength, 4096);
  game = await ok(users[0], `/api/games/${gameId}/answer`, 'POST', { round: 1, mode: 'both', artist: 'Queen', song: '' });
  same(game.score, -15); same(game.reveal.result.hintUsed, true); same(game.reveal.result.hintMultiplier, 1); same(game.xpPenalty, 0); same((await ok(users[0], '/api/profile')).profile.xp, 0);
  const closed = await Promise.all([ok(users[0], `/api/games/${gameId}/cancel`, 'POST', {}), ok(users[0], `/api/games/${gameId}/cancel`, 'POST', {})]);
  for (const cancelled of closed) {
    same(cancelled.phase, 'cancelled'); same(cancelled.summary.score, -15); same(cancelled.summary.xpAwarded, -15);
    same(cancelled.summary.xpCredited, 0); same(cancelled.summary.xpPenalty, -15); check(!cancelled.track);
  }
  same((await ok(users[0], `/api/games/${gameId}/next`, 'POST', { round: 1 })).phase, 'cancelled');
  const closedAudio = await request(users[0], audioPath); same(closedAudio.status, 409); same(closedAudio.data.error, 'GAME_CANCELLED');
  const cancelledProfile = await ok(users[0], '/api/profile'); same(cancelledProfile.profile.xp, -15); same(cancelledProfile.profile.games, 0);
  same(cancelledProfile.history.filter(item => item.id === gameId).length, 1); same(cancelledProfile.sessions.length, 0);

  console.log('Checking all four difficulties through popular artist decks and terminal balance debits…');
  let expectedBalance = -15;
  for (const [difficulty, factor] of [['easy', .75], ['medium', 1], ['advanced', 1.5], ['hard', 2]]) {
    let chosen = await ok(users[0], '/api/games', 'POST', { collectionId: 'popular-queen', settings: { ...settings, difficulty } });
    same(chosen.settings.difficulty, difficulty); same(chosen.total, 50); same(chosen.maxScore, 1000 * factor); same(chosen.songOnly, true); hiddenAnswers(chosen);
    chosen = await playAnswer(users[0], chosen, { mode: 'song', artist: '', song: '' });
    same(chosen.score, -10 * factor); same(chosen.reveal.result.mode, 'song'); same(chosen.reveal.result.multiplier, 2 * factor);
    same((await ok(users[0], '/api/profile')).profile.xp, expectedBalance);
    const cancelled = await ok(users[0], `/api/games/${chosen.id}/cancel`, 'POST', {}); same(cancelled.summary.xpPenalty, -10 * factor);
    expectedBalance = Math.round((expectedBalance - 10 * factor) * 10) / 10;
    same((await ok(users[0], '/api/profile')).profile.xp, expectedBalance);
  }
  const untouched = await ok(users[1], '/api/profile'); same(untouched.profile.xp, 0); same(untouched.profile.games, 0); same(untouched.sessions.length, 0);
  console.log('Checking requested deck sizes and strict artist non-repetition…');
  for (const count of [10, 20, 100]) {
    const sized = await ok(users[1], '/api/games', 'POST', { collectionId: 'popular-rock', settings: { ...settings, count } });
    same(sized.total, count); same(sized.settings.count, count); same(sized.songOnly, false);
    await ok(users[1], `/api/games/${sized.id}/cancel`, 'POST', {});
  }
  const uniqueArtists = await ok(users[1], '/api/games', 'POST', { collectionId: 'popular-rock', settings: { ...settings, count: 10, allowArtistRepeats: false } });
  same(uniqueArtists.total, 10); same(uniqueArtists.settings.allowArtistRepeats, false);
  await ok(users[1], `/api/games/${uniqueArtists.id}/cancel`, 'POST', {});
  const impossible = await request(users[1], '/api/games', 'POST', { collectionId: 'popular-queen', settings: { ...settings, count: 10, allowArtistRepeats: false } });
  same(impossible.status, 409, 'An artist preset cannot invent ten different performers.');
  same((await ok(users[1], '/api/profile')).profile.xp, 0);
  console.log(`PASS: ${assertions} HTTP assertions; 23 popular cards, free private playlists, genuine Range bytes, song-only enforcement, hints, four difficulties and settlement idempotency.`);
} finally {
  const cleanupErrors = [];
  for (const user of users) {
    if (!verified.has(user.id)) continue;
    try {
      const profile = await ok(user, '/api/profile'); same(profile.profile.displayName, user.email.split('@')[0]);
      const result = await ok(user, '/api/profile', 'DELETE'); same(result.deleted, true);
      console.log(`Cleaned dedicated local identity ${user.id}.`);
    } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Dedicated provider-test cleanup failed.');
}

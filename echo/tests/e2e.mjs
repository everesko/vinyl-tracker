/** Repeatable HTTP integration verification. Creates and deletes ONLY two isolated test identities.
 * Requires local migrated Worker: node tests/e2e.mjs [http://127.0.0.1:8787]
 * Full run takes about three minutes because real clip/timer deadlines are respected.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const origin = process.argv[2] || 'http://127.0.0.1:8787';
const url = new URL(origin);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'This integration test only targets a local server.');
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const users = ['a', 'b'].map(letter => ({ id: `echo-e2e-${letter}-${suffix}`, email: `echo-e2e-${letter}-${suffix}@example.test` }));
const verified = new Set();
let assertionCount = 0;
function check(value, message) { assertionCount++; assert.ok(value, message); }
function same(value, expected, message) { assertionCount++; assert.equal(value, expected, message); }
async function request(user, path, method = 'GET', payload, extraHeaders) {
  const headers = { Connection: 'close', 'oai-authenticated-user-id': user.id, 'oai-authenticated-user-email': user.email, ...(method !== 'GET' ? { Origin: origin } : {}), ...extraHeaders };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const preparingPath = ['/api/games', '/api/collections', '/api/catalog'].includes(path);
  const response = await fetch(`${origin}${path}`, { method, headers, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(preparingPath ? 90000 : 15000) });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); } catch { throw new Error(`${method} ${path}: non-JSON response (${response.status}): ${responseText.slice(0, 600)}`); }
  return { status: response.status, data };
}
async function ok(user, path, method = 'GET', payload) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const result = await request(user, path, method, payload);
    if (result.status === 503 && result.data.error === 'CATALOG_PREPARING' && result.data.canRetry === true && attempt < 15) {
      if (attempt === 0 || attempt === 7) console.log(`Catalog preparation: retrying ${method} ${path} (${attempt + 1}/16).`);
      await delay(2000); continue;
    }
    check(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${JSON.stringify(result.data)}`);
    return result.data;
  }
  throw new Error('Catalog retry bound exhausted.');
}
function loadModule(relativePath, imports) {
  const source = fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const testModule = { exports: {} };
  vm.runInNewContext(compiled, { module: testModule, exports: testModule.exports, require: name => { if (!(name in imports)) throw new Error(`Unexpected import: ${name}`); return imports[name]; }, Map, Set, Math }, { filename: relativePath });
  return testModule.exports;
}
const quiz = loadModule('../lib/quiz.ts', {});
const catalog = loadModule('../lib/catalog.ts', { './quiz': quiz });
const demoByNotes = new Map(catalog.demoTracks.map(track => [track.demoNotes.join(','), track]));
const settings = { duration: 3, timer: false, mode: 'both' };
const expectedScore = 20 - 10 + 49 + 47 * 50;
const expectedCredit = expectedScore;

try {
  console.log('Checking dedicated test identity isolation and baseline profiles…');
  for (const user of users) {
    const profile = await ok(user, '/api/profile');
    same(profile.profile.displayName, user.email.split('@')[0], 'Server must honor this dedicated test identity before cleanup can be authorized.');
    same(profile.profile.games, 0); same(profile.profile.xp, 0); same(profile.sessions.length, 0);
    verified.add(user.id);
    console.log(`Verified dedicated identity ${user.id}.`);
  }
  // Wrangler's built preview may settle its module loader after the initial GETs.
  await delay(1000);
  const invalidOrigin = await request(users[0], '/api/games', 'POST', { collectionId: 'demo', settings }, { Origin: 'https://foreign.example' });
  same(invalidOrigin.status, 403); same(invalidOrigin.data.error, 'ORIGIN_MISMATCH');
  const invalidDifficulty = await request(users[0], '/api/games', 'POST', { collectionId: 'demo', settings: { ...settings, difficulty: 'impossible' } });
  same(invalidDifficulty.status, 400); same(invalidDifficulty.data.error, 'INVALID_SETTINGS');
  const safeCatalog = await ok(users[0], '/api/catalog');
  same(safeCatalog.demo.count, 50); check(safeCatalog.demo.playable);
  const popular = safeCatalog.collections.filter(collection => collection.source === 'deezer' && !collection.id.startsWith('custom-'));
  same(popular.length, 23); check(popular.every(collection => collection.count >= 10 && collection.playable));
  check(safeCatalog.collections.every(collection => !('trackIds' in collection)), 'Catalog must never disclose answer IDs.');
  for (const count of [10, 20, 50]) {
    const sized = await ok(users[1], '/api/games', 'POST', { collectionId: 'demo', settings: { ...settings, count } });
    same(sized.total, count); same(sized.settings.count, count); same(sized.settings.allowArtistRepeats, true);
    await ok(users[1], `/api/games/${sized.id}/cancel`, 'POST', {});
  }
  same((await request(users[1], '/api/games', 'POST', { collectionId: 'demo', settings: { ...settings, count: 100 } })).status, 409, 'Demo contains only 50 distinct recordings.');
  same((await request(users[1], '/api/games', 'POST', { collectionId: 'demo', settings: { ...settings, count: 10, allowArtistRepeats: false } })).status, 409, 'One demo artist cannot satisfy a no-repeats deck.');
  for (const [difficulty, factor] of [['easy', .75], ['medium', 1], ['advanced', 1.5], ['hard', 2]]) {
    const chosen = await ok(users[1], '/api/games', 'POST', { collectionId: 'demo', settings: { ...settings, difficulty } });
    same(chosen.settings.difficulty, difficulty); same(chosen.maxScore, 2500 * factor);
    const cancelled = await ok(users[1], `/api/games/${chosen.id}/cancel`, 'POST', {});
    same(cancelled.phase, 'cancelled'); same(cancelled.summary.xpCredited, 0); same(cancelled.summary.xpPenalty, 0);
  }
  let game = await ok(users[0], '/api/games', 'POST', { collectionId: 'demo', settings });
  const gameId = game.id;
  same(game.total, 50); same(game.phase, 'ready'); same(game.maxScore, 2500);
  same(game.settings.difficulty, 'medium', 'Legacy omitted difficulty must default to medium.');
  const foreignGame = await request(users[1], `/api/games/${gameId}`);
  same(foreignGame.status, 404); same(foreignGame.data.error, 'GAME_NOT_FOUND');
  const foreignPlay = await request(users[1], `/api/games/${gameId}/play`, 'POST', { round: 0 });
  same(foreignPlay.status, 404);
  same((await request(users[1], `/api/games/${gameId}/cancel`, 'POST', {})).status, 404);
  const beforePlay = await request(users[0], `/api/games/${gameId}/answer`, 'POST', { round: 0, artist: 'anything', song: 'anything' });
  same(beforePlay.status, 409); same(beforePlay.data.error, 'CLIP_NOT_PLAYED');
  console.log('Playing the full 50-round demo against durable HTTP endpoints…');
  let expectedRunning = 0;
  for (let round = 0; round < 50; round++) {
    same(game.index, round); same(game.phase, 'ready');
    check(!('title' in game.track) && !('artist' in game.track), 'Ready track must hide answers.');
    check(game.track.id.startsWith(`${gameId}:`) && !game.track.id.includes('demo-'), 'Round handle must be opaque.');
    check(!game.reveal, 'Ready JSON must not disclose a reveal.');
    const answer = demoByNotes.get(game.track.demoNotes.join(','));
    check(!!answer, 'Synthetic clip must match a known demo fixture.');
    check(!JSON.stringify(game).includes(answer.title) && !JSON.stringify(game).includes(answer.artist), 'Ready JSON must not contain either answer value.');
    game = await ok(users[0], `/api/games/${gameId}/play`, 'POST', { round });
    same(game.phase, 'playing'); check(game.clipEndsAt > Date.now());
    check(!('title' in game.track) && !('artist' in game.track));
    const repeatPlay = await ok(users[0], `/api/games/${gameId}/play`, 'POST', { round });
    same(repeatPlay.clipEndsAt, game.clipEndsAt, 'Playback retry must not restart its clock.');
    await delay(Math.max(0, game.clipEndsAt - Date.now()) + 65);
    const payload = { round, mode: 'both', artist: round === 1 ? 'wrong answer' : round === 2 ? 'Echa Lab' : answer.artist, song: round < 2 ? '' : answer.title };
    expectedRunning += round === 0 ? 20 : round === 1 ? -10 : round === 2 ? 49 : 50;
    const answers = round < 3
      ? await Promise.all([ok(users[0], `/api/games/${gameId}/answer`, 'POST', payload), ok(users[0], `/api/games/${gameId}/answer`, 'POST', payload)])
      : [await ok(users[0], `/api/games/${gameId}/answer`, 'POST', payload)];
    game = answers[0]; same(game.phase, 'reveal'); same(game.score, expectedRunning);
    same(game.reveal.result.mode, 'both'); same(game.xpPenalty, 0); same(game.xpCredited, 0); same(game.xpAwarded, 0);
    same(game.reveal.title, answer.title); same(game.reveal.artist, answer.artist);
    same(game.reveal.result.canonical.artist, answer.artist); same(game.reveal.result.canonical.song, answer.title);
    same(game.reveal.result.correctionCount, round === 2 ? 1 : 0);
    if (round === 2) { same(game.reveal.result.corrections.artist.canonical, 'Echo Lab'); check(game.reveal.result.artistConfidence >= .6); }
    for (const duplicate of answers) same(duplicate.score, expectedRunning);
    const refreshed = await ok(users[0], `/api/games/${gameId}`);
    same(refreshed.phase, 'reveal'); same(refreshed.reveal.title, answer.title); same(refreshed.score, expectedRunning);
    const retryWrong = await ok(users[0], `/api/games/${gameId}/answer`, 'POST', { round, artist: 'wrong', song: 'wrong' });
    same(retryWrong.score, expectedRunning); same(retryWrong.reveal.result.points, game.reveal.result.points);
    if ([0, 1, 10, 25, 49].includes(round)) {
      const activeProfile = await ok(users[0], '/api/profile');
      same(activeProfile.profile.xp, 0, 'The ledger stays unchanged until terminal settlement.');
      same(activeProfile.profile.games, 0); same(activeProfile.profile.total, 0);
    }
    const nextPayload = { round };
    const nexts = round < 3
      ? await Promise.all([ok(users[0], `/api/games/${gameId}/next`, 'POST', nextPayload), ok(users[0], `/api/games/${gameId}/next`, 'POST', nextPayload)])
      : [await ok(users[0], `/api/games/${gameId}/next`, 'POST', nextPayload)];
    game = nexts[0];
    if (round < 49) {
      for (const next of nexts) same(next.index, round + 1, 'Duplicate next cannot skip a round.');
      const stalePlay = await ok(users[0], `/api/games/${gameId}/play`, 'POST', { round });
      same(stalePlay.index, round + 1); same(stalePlay.phase, 'ready');
      if (!round) {
        const oldResult = await ok(users[0], `/api/games/${gameId}/answer`, 'POST', payload);
        same(oldResult.index, 0); same(oldResult.reveal.result.points, 20);
        const current = await ok(users[0], `/api/games/${gameId}`); same(current.index, 1); same(current.phase, 'ready');
      }
    }
    if ((round + 1) % 10 === 0) console.log(`Completed ${round + 1}/50 rounds; authoritative score ${expectedRunning}.`);
  }
  same(game.phase, 'finished'); same(game.summary.correct, 49); same(game.summary.total, 50); same(game.summary.score, expectedScore); same(game.summary.xpAwarded, expectedScore);
  same(game.summary.xpPenalty, 0); same(game.summary.xpCredited, expectedCredit);
  const finalRetry = await ok(users[0], `/api/games/${gameId}/next`, 'POST', { round: 49 });
  same(finalRetry.summary.xpAwarded, expectedScore);
  const profile = await ok(users[0], '/api/profile');
  same(profile.profile.xp, expectedScore); same(profile.profile.games, 1); same(profile.profile.correct, 49); same(profile.profile.total, 50); same(profile.profile.bestScore, expectedScore);
  same(profile.history.filter(row => row.id === gameId).length, 1); same(profile.sessions.length, 0);
  const foreignProfile = await ok(users[1], '/api/profile'); same(foreignProfile.profile.xp, 0); same(foreignProfile.profile.games, 0); same(foreignProfile.sessions.length, 0);
  console.log('Checking cancellation with positive net score, half settlement and duplicate cancel…');
  let abandoned = await ok(users[1], '/api/games', 'POST', { collectionId: 'demo', settings });
  const abandonedId = abandoned.id;
  for (let round = 0; round < 2; round++) {
    const fixture = demoByNotes.get(abandoned.track.demoNotes.join(',')); check(!!fixture);
    abandoned = await ok(users[1], `/api/games/${abandonedId}/play`, 'POST', { round });
    await delay(Math.max(0, abandoned.clipEndsAt - Date.now()) + 65);
    abandoned = await ok(users[1], `/api/games/${abandonedId}/answer`, 'POST', { round, mode: 'both', artist: round ? fixture.artist : '', song: round ? fixture.title : '' });
    same(abandoned.score, round ? 40 : -10); same(abandoned.xpPenalty, 0);
    same((await ok(users[1], '/api/profile')).profile.xp, 0);
    if (!round) abandoned = await ok(users[1], `/api/games/${abandonedId}/next`, 'POST', { round });
  }
  const cancellations = await Promise.all([ok(users[1], `/api/games/${abandonedId}/cancel`, 'POST', {}), ok(users[1], `/api/games/${abandonedId}/cancel`, 'POST', {})]);
  for (const closed of cancellations) { same(closed.phase, 'cancelled'); same(closed.summary.score, 40); same(closed.summary.xpAwarded, 20); same(closed.summary.xpCredited, 20); same(closed.summary.xpPenalty, 0); check(!closed.track); }
  same((await ok(users[1], `/api/games/${abandonedId}/play`, 'POST', { round: 1 })).phase, 'cancelled');
  const cancelledProfile = await ok(users[1], '/api/profile');
  same(cancelledProfile.profile.xp, 20); same(cancelledProfile.profile.games, 0); same(cancelledProfile.sessions.length, 0);
  same(cancelledProfile.history.filter(item => item.id === abandonedId).length, 1);
  console.log('Checking a real 13-second timer expiry and duplicate timeout answer…');
  let timed = await ok(users[1], '/api/games', 'POST', { collectionId: 'demo', settings: { ...settings, timer: true, difficulty: 'advanced' } });
  timed = await ok(users[1], `/api/games/${timed.id}/play`, 'POST', { round: 0 });
  const timedId = timed.id;
  await delay(Math.max(0, timed.deadline - Date.now()) + 65);
  const timedProfile = await ok(users[1], '/api/profile'); same(timedProfile.profile.xp, 20); same(timedProfile.profile.games, 0);
  timed = await ok(users[1], `/api/games/${timedId}`);
  same(timed.phase, 'reveal'); same(timed.score, -19.5); same(timed.reveal.result.correct, false);
  const timedAnswer = await ok(users[1], `/api/games/${timedId}/answer`, 'POST', { round: 0, artist: timed.reveal.artist, song: timed.reveal.title });
  same(timedAnswer.score, -19.5); same(timedAnswer.reveal.result.correct, false);
  const timedCancelled = await ok(users[1], `/api/games/${timedId}/cancel`, 'POST', {});
  same(timedCancelled.summary.xpPenalty, -19.5); same((await ok(users[1], '/api/profile')).profile.xp, .5);
  console.log('Checking queued settings, preserved clocks and multiplier history…');
  let changing = await ok(users[1], '/api/games', 'POST', { collectionId: 'demo', settings: { ...settings, count: 10, difficulty: 'easy' } });
  const changingId = changing.id, firstFixture = demoByNotes.get(changing.track.demoNotes.join(','));
  changing = await ok(users[1], `/api/games/${changingId}/play`, 'POST', { round: 0 });
  const ends = changing.clipEndsAt;
  changing = await ok(users[1], `/api/games/${changingId}/settings`, 'POST', { round: 0, difficulty: 'hard', timer: true, duration: 5 });
  same(changing.settings.difficulty, 'easy'); same(changing.clipEndsAt, ends); check(!changing.deadline); same(changing.pendingSettings.duration, 5);
  same((await request(users[1], `/api/games/${changingId}/settings`, 'POST', { round: 0, difficulty: 'medium' })).status, 409);
  same((await request(users[1], `/api/games/${changingId}/settings`, 'POST', { round: 0, timer: false })).status, 409);
  await delay(Math.max(0, ends - Date.now()) + 65);
  changing = await ok(users[1], `/api/games/${changingId}/answer`, 'POST', { round: 0, mode: 'artist', artist: firstFixture.artist });
  same(changing.score, 15); same(changing.reveal.result.multiplier, 1.5); same((await ok(users[1], '/api/profile')).profile.xp, .5);
  changing = await ok(users[1], `/api/games/${changingId}/next`, 'POST', { round: 0 });
  same(changing.settings.difficulty, 'hard'); same(changing.settings.timer, true); same(changing.settings.duration, 5); check(!changing.pendingSettings);
  const secondFixture = demoByNotes.get(changing.track.demoNotes.join(','));
  changing = await ok(users[1], `/api/games/${changingId}/play`, 'POST', { round: 1 });
  same(changing.deadline - changing.clipEndsAt, 10000);
  await delay(Math.max(0, changing.clipEndsAt - Date.now()) + 65);
  changing = await ok(users[1], `/api/games/${changingId}/answer`, 'POST', { round: 1, mode: 'both', artist: secondFixture.artist, song: secondFixture.title });
  same(changing.score, 112.5); same(changing.reveal.result.multiplier, 3.9);
  const changedClosed = await ok(users[1], `/api/games/${changingId}/cancel`, 'POST', {});
  same(changedClosed.summary.xpAwarded, 56.3); same((await ok(users[1], '/api/profile')).profile.xp, 56.8);
  console.log(`PASS: ${assertionCount} live HTTP assertions; 23 popular collections, 50-round settlement ${expectedScore}, deferred XP, cancellation, four difficulties, timer penalty -19.5.`);
} finally {
  // Never delete a normal local profile or an identity whose dedicated headers were not verified.
  const cleanupErrors = [];
  for (const user of users) {
    if (!verified.has(user.id)) continue;
    try {
      const profile = await ok(user, '/api/profile');
      same(profile.profile.displayName, user.email.split('@')[0], 'Cleanup must still target the verified dedicated identity.');
      const result = await request(user, '/api/profile', 'DELETE');
      same(result.status, 200, 'Dedicated test ledger cleanup failed.');
      same(result.data.deleted, true);
      console.log(`Cleaned dedicated local test identity ${user.id}.`);
    } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Dedicated test cleanup failed; logged identity IDs allow safe retry.');
}

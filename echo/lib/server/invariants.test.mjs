import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

function evaluateFile(path, imports, globals = {}) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const testModule = { exports: {} };
  const context = { module: testModule, exports: testModule.exports, require: name => { if (!(name in imports)) throw new Error(`Unexpected import ${name}`); return imports[name]; }, console, crypto: webcrypto, Date, Math, Response, Request, Headers, Uint8Array, TextEncoder, TextDecoder, URL, URLSearchParams, AbortSignal, btoa, atob, process: { env: { NODE_ENV: 'development' } }, ...globals };
  vm.runInNewContext(compiled, context, { filename: path });
  return testModule.exports;
}
const quiz = evaluateFile('../quiz.ts', {});
const deck = [1, 2].map(id => ({ id: `artist-answer-${id}`, title: `Song ${id}`, artist: `Artist ${id}`, year: 2026, genres: ['demo'], demoNotes: [60, 64] }));
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function harness(customDeck = deck, songOnly = false, practice = false) {
  let now = 100000;
  const rows = new Map();
  const selections = [];
  const clone = row => row ? JSON.parse(JSON.stringify(row)) : null;
  const db = { prepare(sql) { return { bind(...args) { return {
    async run() {
      if (!sql.startsWith('INSERT INTO echo_games')) throw new Error(sql);
      const [id, user_id, collection_id, collection_title, state, total, created_at, updated_at] = args;
      rows.set(id, { id, user_id, collection_id, collection_title, state, total, created_at, updated_at, version: 0, finished: 0, score_tenths: 0, correct: 0, xp: 0 });
    },
    async first() {
      if (sql.startsWith('SELECT')) { const row = rows.get(args[0]); return row?.user_id === args[1] ? clone(row) : null; }
      if (sql.startsWith('UPDATE')) {
        const [state, finished, score_tenths, correct, xp, updated_at, id, userId, version] = args;
        const row = rows.get(id);
        if (!row || row.user_id !== userId || row.version !== version) return null;
        Object.assign(row, { state, finished, score_tenths, correct, xp, updated_at, version: row.version + 1 });
        return clone(row);
      }
      throw new Error(sql);
    },
  }; } }; } };
  class Clock extends Date { static now() { return now; } }
  const order=evaluateFile('../track-order.ts',{});
  const games = evaluateFile('./games.ts', { './stored-json':{readJson:async text=>JSON.parse(text),storeJson:async(key,value)=>JSON.stringify(value)},'./playlist-history':{playlistPromptForCollection:async()=>undefined,recordPlayedSong:async()=>{},playedSongsFromState:()=>[]},'@/lib/track-order':order, '@/lib/quiz': quiz, './http': { ApiError, database: () => db },'./progression':{ensureSettings:async()=>({practice})}, './catalog': { gameCollection: async (userId, collectionId, configured) => { selections.push({ userId, collectionId, configured }); return { collection: { title: 'Demo' }, deck: customDeck, songOnly }; } } }, { Date: Clock });
  return { games, rows, selections, tick: ms => { now += ms; } };
}
const settings = { duration: 3, timer: true, mode: 'both',difficulty:'medium' };
const hasCode = code => error => error.code === code;

test('users cannot read another user game; answer before playback is rejected', async () => {
  const { games } = harness(); const view = await games.createGame('alice', 'demo', settings);
  await assert.rejects(games.changeGame('bob', view.id, { type: 'get' }), hasCode('GAME_NOT_FOUND'));
  await assert.rejects(games.changeGame('alice', view.id, { type: 'answer', round: 0, artist: '', song: '' }), hasCode('CLIP_NOT_PLAYED'));
  assert.equal(view.track.id.includes('answer'), false);
  assert.equal('title' in view.track, false);
});

test('server clock settles suspended tabs and answer retries cannot alter points', async () => {
  const { games, tick } = harness(); const view = await games.createGame('alice', 'demo', settings);
  await games.changeGame('alice', view.id, { type: 'play', round: 0 }); tick(13000);
  const timed = await games.changeGame('alice', view.id, { type: 'get' });
  assert.equal(timed.phase, 'reveal'); assert.equal(timed.score, -13);
  const retry = await games.changeGame('alice', view.id, { type: 'answer', round: 0, artist: timed.reveal.artist, song: timed.reveal.title });
  assert.equal(retry.score, -13); assert.equal(retry.reveal.result.correct, false);
});

test('concurrent duplicate answers and next calls award exactly once; stale play is harmless', async () => {
  const { games, tick, rows } = harness(); const view = await games.createGame('alice', 'demo', settings);
  const privateDeck = JSON.parse(rows.get(view.id).state).deck;
  for (let round = 0; round < 2; round++) {
    await games.changeGame('alice', view.id, { type: 'play', round }); tick(3001);
    const action = { type: 'answer', round, artist: privateDeck[round].artist, song: privateDeck[round].title };
    const answers = await Promise.all([games.changeGame('alice', view.id, action), games.changeGame('alice', view.id, action)]);
    assert.equal(answers[0].score, (round + 1) * 65); assert.equal(answers[1].score, answers[0].score);
    await Promise.all([games.changeGame('alice', view.id, { type: 'next', round }), games.changeGame('alice', view.id, { type: 'next', round })]);
    if (!round) {
      const stale = await games.changeGame('alice', view.id, { type: 'play', round: 0 }); assert.equal(stale.phase, 'ready');
      const old = await games.changeGame('alice', view.id, { ...action, artist: 'wrong', song: 'wrong' }); assert.equal(old.reveal.result.points, 65); assert.equal(old.index, 0);
    }
  }
  const final = await games.changeGame('alice', view.id, { type: 'get' });
  assert.equal(final.phase, 'finished'); assert.equal(final.summary.xpAwarded, 130); assert.equal(rows.get(view.id).xp, 130);
});

test('failed transport clears timer without points; delayed media error cannot cancel newer attempt', async () => {
  const { games, tick } = harness(); const view = await games.createGame('alice', 'demo', settings);
  const attempt = await games.changeGame('alice', view.id, { type: 'play', round: 0 }); tick(100);
  const reset = await games.changeGame('alice', view.id, { type: 'media-error', round: 0, clipEndsAt: attempt.clipEndsAt });
  assert.equal(reset.phase, 'ready'); assert.equal(reset.deadline, undefined); assert.equal(reset.score, 0);
  const newer = await games.changeGame('alice', view.id, { type: 'play', round: 0 });
  const delayed = await games.changeGame('alice', view.id, { type: 'media-error', round: 0, clipEndsAt: attempt.clipEndsAt });
  assert.equal(delayed.phase, 'playing'); assert.equal(delayed.clipEndsAt, newer.clipEndsAt);
});

async function submitRound(h, id, round, correct) {
  const track = JSON.parse(h.rows.get(id).state).deck[round];
  await h.games.changeGame('alice', id, { type: 'play', round }); h.tick(3001);
  return h.games.changeGame('alice', id, { type: 'answer', round, artist: correct ? track.artist : '', song: correct ? track.title : '' });
}

test('difficulty defaults legacy games to medium, validates choices and reaches music selection', async () => {
  const h = harness(); const legacy = h.games.settingsFrom({ duration: 3, timer: true });
  assert.equal(legacy.difficulty, 1);
  assert.throws(() => h.games.settingsFrom({ duration: 3, timer: true, difficulty: 'impossible' }), hasCode('INVALID_SETTINGS'));
  const view = await h.games.createGame('alice', 'demo', { ...settings, difficulty: 'hard' });
  assert.equal(view.settings.difficulty, 10);
  assert.equal(h.selections[0].configured.difficulty, 10);
  const result = await submitRound(h, view.id, 0, false);
  assert.equal(result.score, -26); assert.equal(h.rows.get(view.id).xp, 0);
});

test('spoken answers are evaluated server-side and durable retries cannot change credit', async () => {
  const h = harness(); const view = await h.games.createGame('alice', 'demo', settings);
  const track = JSON.parse(h.rows.get(view.id).state).deck[0];
  await h.games.changeGame('alice', view.id, { type: 'play', round: 0 }); h.tick(3001);
  const result = await h.games.changeGame('alice', view.id, { type: 'answer', round: 0, artist: '', song: '', spoken: `исполнитель ${track.artist} песня ${track.title}`, mode: 'both' });
  assert.equal(result.score, 65); assert.equal(result.reveal.result.perfect, true);
  const retry = await h.games.changeGame('alice', view.id, { type: 'answer', round: 0, artist: '', song: '', spoken: 'wrong', mode: 'artist' });
  assert.equal(retry.score, 65); assert.equal(retry.reveal.result.mode, 'both');
});

test('popular-provider answers and artwork stay hidden until reveal, with opaque media URLs', async () => {
  const privateTrack = { ...deck[0], provider: 'deezer', providerId: '123', artworkUrl: 'https://media.example.test/cover.png', sourceUrl: 'https://music.example.test/song/123', audioUrl: 'https://media.example.test/Artist-Song.mp3', popularityRank: 900000 };
  const h = harness([privateTrack]); const view = await h.games.createGame('alice', 'popular', settings);
  for (const field of ['title', 'artist', 'artworkUrl', 'sourceUrl', 'providerId', 'popularityRank']) assert.equal(field in view.track, false, field);
  assert.equal(view.track.audioUrl, `/api/games/${view.id}/audio?round=0`);
  const reveal = await submitRound(h, view.id, 0, true);
  assert.equal(reveal.reveal.artworkUrl, privateTrack.artworkUrl); assert.equal(reveal.reveal.sourceUrl, privateTrack.sourceUrl);
  assert.equal(reveal.reveal.title, privateTrack.title); assert.equal(reveal.reveal.artist, privateTrack.artist);
  assert.equal(reveal.reveal.provider, 'deezer');
});

test('answer route validates free spoken phrase length and forwards no client-supplied canonical metadata', async () => {
  let action;
  const route = evaluateFile('../../app/api/games/[id]/answer/route.ts', {
    '@/lib/server/games': { changeGame: async (_user, _id, supplied) => { action = supplied; return { phase: 'reveal' }; } },
    '@/lib/server/progression':{wallet:async()=>0,progressFor:async()=>({practice:false,unlocks:{},resetAvailableAt:0})},'@/lib/server/http': { ApiError, csrf: async () => {}, identity: () => ({ id: 'alice' }), body: request => request.json(), handle: fn => fn(), json: value => Response.json(value) },
  });
  const invoke = payload => route.POST(new Request('https://echo.test/api/games/id/answer', { method: 'POST', body: JSON.stringify(payload) }), { params: Promise.resolve({ id: 'id' }) });
  await assert.rejects(invoke({ round: 0, spoken: 'x'.repeat(401) }), hasCode('ANSWER_TOO_LONG'));
  await assert.rejects(invoke({ round: 0, spoken: 42 }), hasCode('INVALID_ANSWER'));
  await invoke({ round: 0, mode: 'both', spoken: 'Lipkim Pamk InTheEnd', canonicalTitle: 'cheat' });
  assert.equal(action.spoken, 'Lipkim Pamk InTheEnd'); assert.equal('canonicalTitle' in action, false);
});

test('cancelling settles half the positive net and closes all actions exactly once', async () => {
  const h = harness(); const view = await h.games.createGame('alice', 'demo', settings);
  await submitRound(h, view.id, 0, true);
  assert.equal(h.rows.get(view.id).xp, 0);
  const cancelled = await h.games.changeGame('alice', view.id, { type: 'cancel' });
  assert.equal(cancelled.phase, 'cancelled'); assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.score, 65); assert.equal(cancelled.summary.xpAwarded, 32.5); assert.equal(cancelled.summary.xpCredited, 32.5);
  assert.equal(cancelled.track, undefined); assert.equal(h.rows.get(view.id).finished, 1);
  const version = h.rows.get(view.id).version;
  await Promise.all([h.games.changeGame('alice', view.id, { type: 'cancel' }), h.games.changeGame('alice', view.id, { type: 'cancel' })]);
  assert.equal(h.rows.get(view.id).version, version);
  for (const action of [{ type: 'play', round: 0 }, { type: 'next', round: 0 }, { type: 'answer', round: 0, artist: '', song: '' }]) {
    assert.equal((await h.games.changeGame('alice', view.id, action)).phase, 'cancelled');
  }
  assert.equal(h.rows.get(view.id).xp, 32.5);
  assert.equal((await h.games.sessionView(h.rows.get(view.id))).active, false);
  assert.throws(() => h.games.audioTrack(h.rows.get(view.id), 0), hasCode('GAME_CANCELLED'));
  await assert.rejects(h.games.changeGame('bob', view.id, { type: 'cancel' }), hasCode('GAME_NOT_FOUND'));
});

test('active games leave XP untouched and cancellation settles half of a positive net', async () => {
  const h = harness(); const view = await h.games.createGame('alice', 'demo', settings);
  await submitRound(h, view.id, 0, false);
  assert.equal(h.rows.get(view.id).xp, 0);
  await h.games.changeGame('alice', view.id, { type: 'next', round: 0 });
  const positive = await submitRound(h, view.id, 1, true);
  assert.equal(positive.score, 52); assert.equal(h.rows.get(view.id).xp, 0);
  const views = await Promise.all([h.games.changeGame('alice', view.id, { type: 'cancel' }), h.games.changeGame('alice', view.id, { type: 'cancel' })]);
  for (const closed of views) {
    assert.equal(closed.summary.xpAwarded, 26); assert.equal(closed.summary.xpPenalty, 0); assert.equal(closed.summary.xpCredited, 26);
  }
  assert.equal(h.rows.get(view.id).xp, 26);
  assert.equal(JSON.parse(h.rows.get(view.id).state).results.length, 2);
});

test('completed games settle their signed net exactly once', async () => {
  for (const secondCorrect of [false, true]) {
    const h = harness(); const view = await h.games.createGame('alice', 'demo', settings);
    await submitRound(h, view.id, 0, false);
    await h.games.changeGame('alice', view.id, { type: 'next', round: 0 });
    await submitRound(h, view.id, 1, secondCorrect);
    const closed = await h.games.changeGame('alice', view.id, { type: 'next', round: 1 });
    assert.equal(closed.phase, 'finished'); assert.equal(closed.summary.xpAwarded, secondCorrect ? 52 : -26);
    assert.equal(closed.summary.xpPenalty, secondCorrect ? 0 : -26); assert.equal(closed.summary.xpCredited, secondCorrect ? 52 : 0);
    assert.equal(h.rows.get(view.id).xp, closed.summary.xpAwarded);
    const version = h.rows.get(view.id).version;
    assert.equal((await h.games.changeGame('alice', view.id, { type: 'cancel' })).phase, 'finished');
    assert.equal(h.rows.get(view.id).version, version);
  }
});

test('cancel settles an expired timer once while unexpired unanswered rounds incur no penalty', async () => {
  for (const elapsed of [1000, 13000]) {
    const h = harness(); const view = await h.games.createGame('alice', 'demo', settings);
    await h.games.changeGame('alice', view.id, { type: 'play', round: 0 }); h.tick(elapsed);
    const closed = await h.games.changeGame('alice', view.id, { type: 'cancel' });
    assert.equal(closed.summary.xpAwarded, elapsed === 13000 ? -13 : 0);
    assert.equal(closed.summary.answered, elapsed === 13000 ? 1 : 0);
    h.tick(20000);
    await h.games.changeGame('alice', view.id, { type: 'get' });
    await h.games.changeGame('alice', view.id, { type: 'cancel' });
    assert.equal(h.rows.get(view.id).xp, elapsed === 13000 ? -13 : 0);
    assert.equal(JSON.parse(h.rows.get(view.id).state).deadline, undefined);
  }
});

test('concurrent answer/cancel and finish/cancel keep a single terminal CAS outcome', async () => {
  for (const cancelFirst of [false, true]) {
    const h = harness(); const view = await h.games.createGame('alice', 'demo', settings);
    await h.games.changeGame('alice', view.id, { type: 'play', round: 0 }); h.tick(3001);
    const answer = { type: 'answer', round: 0, artist: '', song: '' }, cancel = { type: 'cancel' };
    await Promise.all((cancelFirst ? [cancel, answer] : [answer, cancel]).map(action => h.games.changeGame('alice', view.id, action)));
    const state = JSON.parse(h.rows.get(view.id).state);
    assert.equal(state.phase, 'cancelled'); assert.ok(state.results.length <= 1);
    assert.equal(h.rows.get(view.id).xp, state.results.length ? -13 : 0);
  }
  const h = harness(); const view = await h.games.createGame('alice', 'demo', settings);
  await submitRound(h, view.id, 0, false); await h.games.changeGame('alice', view.id, { type: 'next', round: 0 });
  await submitRound(h, view.id, 1, true);
  await Promise.all([h.games.changeGame('alice', view.id, { type: 'next', round: 1 }), h.games.changeGame('alice', view.id, { type: 'cancel' })]);
  const terminal = JSON.parse(h.rows.get(view.id).state).phase;
  assert.ok(['finished', 'cancelled'].includes(terminal));
  assert.equal(h.rows.get(view.id).xp, terminal === 'finished' ? 52 : 26);
});

test('Origin and streaming body limits apply; local identity never falls back in production', async () => {
  const http = evaluateFile('./http.ts', { 'cloudflare:workers': { env: {} } });
  const rejectedRequest = new Request('https://echo.test/api/games', { method: 'POST', headers: { Origin: 'https://attacker.test' }, body: '{"collectionId":"demo"}' });
  await assert.rejects(http.csrf(rejectedRequest), hasCode('ORIGIN_MISMATCH'));
  assert.equal(rejectedRequest.bodyUsed, true);
  const validRequest = new Request('https://echo.test/api/games', { method: 'POST', headers: { Origin: 'https://echo.test' }, body: '{}' });
  await http.csrf(validRequest); assert.equal(validRequest.bodyUsed, false);
  await assert.rejects(http.body(new Request('https://echo.test/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(11000) }) })), hasCode('PAYLOAD_TOO_LARGE'));
  const production = evaluateFile('./http.ts', { 'cloudflare:workers': { env: {} } }, { process: { env: { NODE_ENV: 'production' } } });
  assert.throws(() => production.identity(new Request('http://localhost/api/profile')), hasCode('AUTH_REQUIRED'));
  assert.equal(http.identity(new Request('http://localhost/api/profile')).id, 'local-dev');
});

test('Spotify approval gate, PKCE, encrypted tokens and user-bound callback state', async () => {
  const env = { SITE_ORIGIN: 'https://echo.test', SPOTIFY_CLIENT_ID: 'client', SPOTIFY_CLIENT_SECRET: 'secret', SESSION_ENCRYPTION_KEY: 's'.repeat(40) };
  let storedTokens, calls = 0;
  const http = { ApiError, runtime: () => env, identity: request => ({ id: request.headers.get('oai-authenticated-user-id') || 'alice' }), json: (value, status, headers) => Response.json(value, { status, headers }), database: () => ({ prepare: () => ({ bind: (_id, tokens) => ({ run: async () => { storedTokens = tokens; } }) }) }) };
  const spotify = evaluateFile('./spotify.ts', { './http': http }, { fetch: async () => { calls++; return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret' }); } });
  assert.equal(spotify.spotifyAvailability().available, false);
  await assert.rejects(spotify.connectSpotify(new Request('https://echo.test/api/spotify/connect')), hasCode('SPOTIFY_DISABLED'));
  env.SPOTIFY_APPROVED_FOR_QUIZ = 'true';
  const response = await spotify.connectSpotify(new Request('https://echo.test/api/spotify/connect'));
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly; Secure; SameSite=Lax')); assert.equal(cookie.includes('alice'), false);
  const authorization = new URL((await response.json()).url);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorization.searchParams.get('code_challenge').length, 43);
  const callbackUrl = `https://echo.test/api/spotify/callback?code=code&state=${authorization.searchParams.get('state')}`;
  await assert.rejects(spotify.callbackSpotify(new Request(callbackUrl, { headers: { Cookie: cookie, 'oai-authenticated-user-id': 'bob' } })), hasCode('OAUTH_STATE_INVALID'));
  assert.equal(calls, 0);
  const connected = await spotify.callbackSpotify(new Request(callbackUrl, { headers: { Cookie: cookie } }));
  assert.equal(connected.status, 303); assert.equal(calls, 1);
  assert.equal(storedTokens.includes('access-secret'), false); assert.equal(storedTokens.includes('refresh-secret'), false);
});

const preview = { ...deck[0], provider: 'deezer', audioUrl: 'https://media.example.test/preview.mp3', verseStart: 2, hintStart: 12, duration: 30 };

test('count and artist repetition settings are validated and forwarded to selection', async () => {
  const h = harness();
  const defaults = h.games.settingsFrom({ duration: 7, timer: false });
  assert.equal(defaults.count, 10); assert.equal(defaults.allowArtistRepeats, true);
  for (const count of [10, 20, 50, 100]) {
    await h.games.createGame('alice', 'demo', { duration: 7, timer: false, count, allowArtistRepeats: false });
    assert.equal(h.selections.at(-1).configured.count, count); assert.equal(h.selections.at(-1).configured.allowArtistRepeats, false);
  }
  for (const invalid of [{count:0}, { allowArtistRepeats: 'false' }]) assert.throws(() => h.games.settingsFrom({ duration: 7, timer: false, ...invalid }), hasCode('INVALID_SETTINGS'));
});

test('artist presets and all custom games force song mode despite a forged artist/both answer', async () => {
  for (const collection of ['popular-queen', 'custom-private']) {
    const h = harness(deck.map(track=>({...track,artist:'Artist'})), true); const initial = await h.games.createGame('alice', collection, settings);
    assert.equal(initial.songOnly, true); assert.equal(initial.dynamicMode, false); assert.equal(initial.settings.mode, 'song'); assert.equal(initial.maxScore, 52);
    const track = JSON.parse(h.rows.get(initial.id).state).deck[0];
    await h.games.changeGame('alice', initial.id, { type: 'play', round: 0 }); h.tick(3001);
    const reveal = await h.games.changeGame('alice', initial.id, { type: 'answer', round: 0, artist: track.artist, song: '', mode: 'both' });
    assert.equal(reveal.reveal.result.artistCorrect, false); assert.equal(reveal.reveal.result.mode, 'song'); assert.equal(reveal.score, -13);
  }
});

test('one alternate hint is durable, opaque, timer-preserving and discounts only positive awards', async () => {
  for (const correct of [false, true]) {
    const h = harness([preview]); const initial = await h.games.createGame('alice', 'popular-rock', settings);
    assert.equal(initial.hint.available, false);
    await assert.rejects(h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 }), hasCode('HINT_NOT_AVAILABLE'));
    const playing = await h.games.changeGame('alice', initial.id, { type: 'play', round: 0 });
    await assert.rejects(h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 }), hasCode('HINT_NOT_AVAILABLE'));
    h.tick(3001);
    const views = await Promise.all([h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 }), h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 })]);
    for (const hinted of views) {
      assert.equal(hinted.phase, 'answer'); assert.equal(hinted.hintStart, 12); assert.equal(hinted.hintUsed, true); assert.equal(hinted.hint.available, false);
      assert.equal(hinted.deadline, playing.deadline); assert.equal(hinted.clipEndsAt, playing.clipEndsAt);
      assert.equal(hinted.hint.audioUrl, `/api/games/${initial.id}/audio?round=0`); assert.equal('canonical' in hinted, false); assert.equal(hinted.reveal, undefined);
    }
    const version = h.rows.get(initial.id).version;
    await h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 }); assert.equal(h.rows.get(initial.id).version, version);
    const reveal = await h.games.changeGame('alice', initial.id, { type: 'answer', round: 0, artist: correct ? preview.artist : '', song: correct ? preview.title : '' });
    assert.equal(reveal.score, correct ? 48.8 : -13); assert.equal(reveal.reveal.result.hintMultiplier, correct ? .75 : 1);
    assert.equal(h.rows.get(initial.id).xp, 0);
  }
});

test('failed hint playback removes its reward discount without restarting the timer or allowing repeat hints', async () => {
  const h = harness([preview]); const initial = await h.games.createGame('alice', 'popular', settings);
  const playing = await h.games.changeGame('alice', initial.id, { type: 'play', round: 0 }); h.tick(3001);
  await h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 });
  const failed = await h.games.changeGame('alice', initial.id, { type: 'hint-error', round: 0 });
  assert.equal(failed.hintUsed, false); assert.equal(failed.hint.available, false); assert.equal(failed.deadline, playing.deadline);
  const repeat = await h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 }); assert.equal(repeat.hintUsed, false);
  const reveal = await h.games.changeGame('alice', initial.id, { type: 'answer', round: 0, artist: preview.artist, song: preview.title });
  assert.equal(reveal.score, 65);
  await h.games.changeGame('alice', initial.id, { type: 'hint-error', round: 0 });
  assert.equal(JSON.parse(h.rows.get(initial.id).state).results[0].points, 65);
});

test('hint cannot bypass expiry, replay the main passage or seek outside a preview', async () => {
  for (const track of [{ ...preview, hintStart: 2 }, { ...preview, duration: 13 }, deck[0]]) {
    const h = harness([track]); const initial = await h.games.createGame('alice', 'demo', settings);
    await h.games.changeGame('alice', initial.id, { type: 'play', round: 0 }); h.tick(3001);
    await assert.rejects(h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 }), hasCode('HINT_NOT_AVAILABLE'));
  }
  const h = harness([preview]); const initial = await h.games.createGame('alice', 'popular', settings);
  await h.games.changeGame('alice', initial.id, { type: 'play', round: 0 }); h.tick(13000);
  const expired = await h.games.changeGame('alice', initial.id, { type: 'hint', round: 0 });
  assert.equal(expired.phase, 'reveal'); assert.equal(expired.score, -13); assert.equal(expired.hintUsed, false);
  assert.equal(h.rows.get(initial.id).xp, 0);
});

test('settings changes affect the next round only and preserve existing clocks and multipliers', async () => {
  const h = harness(); const initial = await h.games.createGame('alice', 'demo', { duration: 7, timer: false, difficulty: 'easy' });
  const playing = await h.games.changeGame('alice', initial.id, { type: 'play', round: 0 });
  const changed = await h.games.changeGame('alice', initial.id, { type: 'settings', round: 0, settings: { difficulty: 'hard', timer: true, duration: 3 } });
  assert.equal(changed.settings.duration, 7); assert.equal(changed.settings.difficulty, 1); assert.equal(changed.settings.timer, false);
  assert.equal(changed.pendingSettings.duration, 3); assert.equal(changed.pendingSettings.difficulty, 10); assert.equal(changed.pendingSettings.timer, true);
  assert.equal(changed.clipEndsAt, playing.clipEndsAt); assert.equal(changed.deadline, undefined);
  await assert.rejects(h.games.changeGame('alice', initial.id, { type: 'settings', round: 0, settings: { difficulty: 'advanced' } }), hasCode('DIFFICULTY_DECREASE'));
  await assert.rejects(h.games.changeGame('alice', initial.id, { type: 'settings', round: 0, settings: { timer: false } }), hasCode('TIMER_DISABLE'));
  h.tick(7001);
  const first = JSON.parse(h.rows.get(initial.id).state).deck[0];
  const reveal = await h.games.changeGame('alice', initial.id, { type: 'answer', round: 0, artist: first.artist, song: first.title });
  assert.equal(reveal.score, 18.8); assert.equal(reveal.reveal.result.multiplier, .75);
  const next = await h.games.changeGame('alice', initial.id, { type: 'next', round: 0 });
  assert.equal(next.settings.difficulty, 10); assert.equal(next.settings.duration, 3); assert.equal(next.pendingSettings, undefined);
  assert.equal(next.maxScore, 148.8);
  const second = JSON.parse(h.rows.get(initial.id).state).deck[1];
  const start = await h.games.changeGame('alice', initial.id, { type: 'play', round: 1 }); assert.equal(start.deadline - start.clipEndsAt, 10000); h.tick(3001);
  const secondReveal = await h.games.changeGame('alice', initial.id, { type: 'answer', round: 1, artist: second.artist, song: second.title });
  assert.equal(secondReveal.score, 148.8); assert.equal(secondReveal.reveal.result.multiplier, 5.2);
  const old = await h.games.changeGame('alice', initial.id, { type: 'answer', round: 0, artist: '', song: '' }); assert.equal(old.reveal.result.points, 18.8);
});

test('old terminal ledgers are immutable even when their settlement differs from new rules', async () => {
  for (const phase of ['finished', 'cancelled']) {
    const h = harness(); const initial = await h.games.createGame('alice', 'demo', settings);
    const row = h.rows.get(initial.id), state = JSON.parse(row.state);
    state.phase = phase; state.score = 65;
    Object.assign(row, { state: JSON.stringify(state), finished: 1, xp: -13 });
    for (const action of [{ type: 'get' }, { type: 'cancel' }, { type: 'settings', round: 0, settings: { difficulty: 'hard' } }]) {
      const result = await h.games.changeGame('alice', initial.id, action); assert.equal(result.summary.xpAwarded, -13);
    }
    assert.equal(row.xp, -13); assert.equal(row.version, 0);
  }
});

test('profile resets only active legacy XP and never recomputes terminal ledger amounts', async () => {
  const queries = [];
  const route = evaluateFile('../../app/api/profile/route.ts', {
    '@/lib/server/games': { sessionView: row => row, changeGame: async () => {} },
    '@/lib/server/progression':{wallet:async()=>0,progressFor:async()=>({practice:false,unlocks:{},resetAvailableAt:0})},'@/lib/server/http': { csrf: async () => {}, identity: () => ({ id: 'alice', displayName: 'Alice' }), json: value => Response.json(value), handle: fn => fn(),
      database: () => ({ prepare: sql => { queries.push(sql); return { bind: () => ({ all: async () => ({ results: [] }), first: async () => ({ xp: 42 }), run: async () => {} }) }; } }) },
  });
  const response = await route.GET(new Request('https://echo.test/api/profile'));
  assert.equal((await response.json()).profile.xp, 42);
  const updates = queries.filter(sql => sql.startsWith('UPDATE'));
  assert.equal(updates.length, 1); assert.match(updates[0], /SET xp = 0 WHERE user_id = \? AND finished = 0/); assert.doesNotMatch(updates[0], /score_tenths|json_each/);
});

test('settings route accepts only mutable flat fields and hint routes require owner identity', async () => {
  let action;
  const imports = { '@/lib/quiz': quiz, '@/lib/server/games': { changeGame: async (owner, _id, value) => { assert.equal(owner, 'alice'); action = value; return { phase: 'answer' }; } },
    '@/lib/server/progression':{wallet:async()=>0,progressFor:async()=>({practice:false,unlocks:{},resetAvailableAt:0})},'@/lib/server/http': { ApiError, csrf: async () => {}, identity: () => ({ id: 'alice' }), body: request => request.json(), handle: fn => fn(), json: value => Response.json(value) } };
  const invoke = async (name, payload) => evaluateFile(`../../app/api/games/[id]/${name}/route.ts`, imports).POST(new Request(`https://echo.test/api/games/id/${name}`, { method: 'POST', body: JSON.stringify(payload) }), { params: Promise.resolve({ id: 'id' }) });
  await invoke('settings', { round: 0, difficulty: 'hard', duration: 5 }); assert.equal(action.settings.duration, 5); assert.equal(action.settings.difficulty, 'hard');
  await assert.rejects(invoke('settings', { round: 0, count: 100 }), hasCode('INVALID_SETTINGS'));
  await invoke('hint', { round: 0 }); assert.equal(action.type, 'hint');
  await invoke('hint-error', { round: 0 }); assert.equal(action.type, 'hint-error');
});

test('pause preserves remaining clip and resumes the timer after playback only',async()=>{
 const h=harness(),view=await h.games.createGame('alice','demo',settings);await h.games.changeGame('alice',view.id,{type:'play',round:0});h.tick(1000);
 const paused=await h.games.changeGame('alice',view.id,{type:'pause',round:0});assert.equal(paused.phase,'paused');assert.equal(paused.pauseRemaining,2000);assert.equal(paused.deadline,undefined);
 h.tick(100000);assert.equal((await h.games.changeGame('alice',view.id,{type:'get'})).phase,'paused');await assert.rejects(h.games.changeGame('alice',view.id,{type:'answer',round:0,artist:'',song:''}),hasCode('CLIP_PAUSED'));
 const resumed=await h.games.changeGame('alice',view.id,{type:'resume',round:0});assert.equal(resumed.deadline-resumed.clipEndsAt,10000);h.tick(2001);assert.equal((await h.games.changeGame('alice',view.id,{type:'get'})).phase,'answer');
});
test('incorrect fragment replacement resets clocks without points or a hint discount',async()=>{
 const h=harness([preview]),view=await h.games.createGame('alice','popular',settings);await h.games.changeGame('alice',view.id,{type:'play',round:0});h.tick(100);
 const replaced=await h.games.changeGame('alice',view.id,{type:'replace-fragment',round:0});assert.equal(replaced.phase,'ready');assert.notEqual(replaced.track.verseStart,2);assert.equal(replaced.score,0);assert.equal(replaced.deadline,undefined);assert.equal(replaced.hintUsed,false);
});
test('multiple artists in a custom collection do not force a song-only answer',async()=>{
 const h=harness(deck,false),view=await h.games.createGame('alice','custom-private',settings);assert.equal(view.songOnly,false);assert.equal(view.dynamicMode,true);
 const track=JSON.parse(h.rows.get(view.id).state).deck[0];await h.games.changeGame('alice',view.id,{type:'play',round:0});h.tick(3001);const reveal=await h.games.changeGame('alice',view.id,{type:'answer',round:0,artist:track.artist,song:track.title,mode:'both'});assert.equal(reveal.reveal.result.mode,'both');assert.equal(reveal.score,65);
});

test('practice records correctness but never creates points or settled XP',async()=>{
 const h=harness(deck,false,true),game=await h.games.createGame('alice','demo',settings);assert.equal(game.practice,true);assert.equal(game.maxScore,0);
 for(let round=0;round<2;round++){const reveal=await submitRound(h,game.id,round,true);assert.equal(reveal.reveal.result.correct,true);assert.equal(reveal.reveal.result.points,0);await h.games.changeGame('alice',game.id,{type:'next',round});}
 const final=await h.games.changeGame('alice',game.id,{type:'get'});assert.equal(final.summary.correct,2);assert.equal(final.summary.xpAwarded,0);assert.equal(h.rows.get(game.id).xp,0);
});

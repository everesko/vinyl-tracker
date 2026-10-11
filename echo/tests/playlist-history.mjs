import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function load(file, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; }, Date, Math, crypto: webcrypto, TextEncoder, Uint8Array, JSON, Set, Map, AbortController });
  return module.exports;
}
class ApiError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
const quiz = load('lib/quiz.ts'), order = load('lib/track-order.ts');
const settings = { duration: 7, timer: false, mode: 'both', difficulty: 1, count: 2, allowArtistRepeats: false };
function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../drizzle/0000_brave_dazzler.sql', import.meta.url), 'utf8'));
  db.exec('ALTER TABLE echo_collections ADD recipe TEXT; CREATE TABLE echo_media_collections(id TEXT PRIMARY KEY,track_data TEXT NOT NULL,updated_at INTEGER NOT NULL);');
  let queries = 0, failHistory = false;
  const database = { prepare(sql) { return { bind(...args) { return {
    async first() { queries++; return db.prepare(sql).get(...args) ?? null; },
    async all() { queries++; return { results: db.prepare(sql).all(...args) }; },
    async run() { queries++; if (failHistory && sql.startsWith('INSERT INTO echo_media_collections') && String(args[0]).includes(':song:')) throw new Error('Secondary history unavailable'); return db.prepare(sql).run(...args); },
  }; } }; } };
  const stored = { storeJson: async (_key, value) => JSON.stringify(value), readJson: async text => JSON.parse(text) };
  const history = load('lib/server/playlist-history.ts', { './http': { ApiError, database: () => database }, './stored-json': stored });
  const games = load('lib/server/games.ts', { '@/lib/quiz': quiz, '@/lib/track-order': order, './http': { ApiError, database: () => database }, './stored-json': stored,
    './playlist-history': history, './progression': { ensureSettings: async () => ({ practice: true }) }, './catalog': { gameCollection: async (_owner, id) => ({ collection: { title: id }, songOnly: false, deck: [{ id: 'one', artist: 'Artist 1', title: 'Song 1' }, { id: 'two', artist: 'Artist 2', title: 'Song 2' }] }) } });
  function collection(owner, id, prompt) { db.prepare('INSERT INTO echo_collections(id,user_id,title,subtitle,track_ids,created_at,recipe) VALUES(?,?,?,?,?,?,?)').run(id, owner, prompt, '', '[]', 0, JSON.stringify({ ai: true, prompt })); }
  function oldGame(owner, id, collectionId, state, title = 'Legacy playlist') { db.prepare('INSERT INTO echo_games(id,user_id,collection_id,collection_title,state,total,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, owner, collectionId, title, JSON.stringify(state), 4, 0, 0); }
  return { db, history, games, collection, oldGame, get queries() { return queries; }, set failHistory(value) { failHistory = value; } };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
test('history scopes the owner and normalized query, independently from difficulty or spelling case', async () => {
  const h = harness(); try {
    await h.history.recordPlayedSong('alice', '  РОМАНТИЧНІ\n Балади ', { artist: 'Queen', title: 'Love Of My Life' });
    await h.history.recordPlayedSong('alice', 'романтичні балади', { artist: 'QUEEN', title: 'Love Of My Life' });
    await h.history.recordPlayedSong('bob', 'романтичні балади', { artist: 'Other Artist', title: 'Different Song' });
    assert.deepEqual(plain(await h.history.getPlayedSongs('alice', 'романтичні\tбалади')), [{ artist: 'QUEEN', title: 'Love Of My Life' }]);
    assert.deepEqual(plain(await h.history.getPlayedSongs('alice', 'рок')), []);
    assert.deepEqual(plain(await h.history.getPlayedSongs('bob', 'романтичні балади')), [{ artist: 'Other Artist', title: 'Different Song' }]);
  } finally { h.db.close(); }
});
test('newly generated and cancelled unplayed decks never enter history; only accepted playback does', async () => {
  const h = harness(); try {
    h.collection('alice', 'custom-ai', 'Українські хіти 00-х');
    const first = await h.games.createGame('alice', 'custom-ai', settings);
    assert.deepEqual(plain(await h.history.getPlayedSongs('alice', 'українські хіти 00-х')), []);
    await h.games.changeGame('alice', first.id, { type: 'cancel' });
    assert.deepEqual(plain(await h.history.getPlayedSongs('alice', 'українські хіти 00-х')), []);
    const game = await h.games.createGame('alice', 'custom-ai', settings);
    await assert.rejects(h.games.changeGame('alice', game.id, { type: 'play', round: 3 }), error => error.code === 'STALE_ROUND');
    assert.deepEqual(plain(await h.history.getPlayedSongs('alice', 'українські хіти 00-х')), []);
    await Promise.all([h.games.changeGame('alice', game.id, { type: 'play', round: 0 }), h.games.changeGame('alice', game.id, { type: 'play', round: 0 })]);
    const state = JSON.parse((await h.games.loadGame('alice', game.id)).state);
    const played = await h.history.getPlayedSongs('alice', 'УКРАЇНСЬКІ ХІТИ 00-Х');
    assert.deepEqual(plain(played), [{ artist: state.deck[0].artist, title: state.deck[0].title }]);
    assert.equal(state.playedSongs.length, 1);
  } finally { h.db.close(); }
});
test('playback ledger remains durable after secondary history failure and collection deletion', async () => {
  const h = harness(); try {
    h.collection('alice', 'custom-ai', 'romantic ballads');
    const game = await h.games.createGame('alice', 'custom-ai', settings);
    h.failHistory = true;
    const played = await h.games.changeGame('alice', game.id, { type: 'play', round: 0 });
    assert.equal(played.phase, 'playing');
    h.db.prepare('DELETE FROM echo_collections WHERE id = ?').run('custom-ai');
    const state = JSON.parse((await h.games.loadGame('alice', game.id)).state);
    assert.deepEqual(plain(await h.history.getPlayedSongs('alice', 'ROMANTIC BALLADS')), [{ artist: state.deck[0].artist, title: state.deck[0].title }]);
  } finally { h.db.close(); }
});
test('legacy backfill imports answered/current playing songs and excludes untouched songs', async () => {
  const h = harness(); try {
    h.collection('alice', 'custom-old', '80s hits');
    const deck = ['Answered', 'Playing', 'Untouched', 'Never Played'].map(title => ({ artist: title + ' Artist', title }));
    h.oldGame('alice', 'old-a', 'custom-old', { deck, results: [{ correct: true }], index: 1, phase: 'playing' });
    h.oldGame('alice', 'old-b', 'custom-old', { deck, results: [{ correct: true }], index: 1, phase: 'cancelled' });
    h.oldGame('bob', 'other-user', 'custom-old', { deck, results: [{}, {}, {}], index: 3, phase: 'playing' });
    const names = (await h.history.getPlayedSongs('alice', '80s hits')).map(song => song.title).sort();
    assert.deepEqual(plain(names), ['Answered', 'Playing']);
  } finally { h.db.close(); }
});
test('recorded history is paginated without dropping earlier songs at a fixed count cap', async () => {
  const h = harness(); try {
    for (let i = 0; i < 300; i++) await h.history.recordPlayedSong('alice', 'all songs', { artist: 'Artist ' + i, title: 'Song ' + i });
    const found = await h.history.getPlayedSongs('alice', 'all songs');
    assert.equal(found.length, 300); assert.equal(new Set(found.map(song => song.title)).size, 300);
  } finally { h.db.close(); }
});
test('an aborted search performs no history queries and does not alter any ledger', async () => {
  const h = harness(); try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.history.getPlayedSongs('alice', 'hits', controller.signal), error => error.code === 'CANCELLED');
    assert.equal(h.queries, 0);
  } finally { h.db.close(); }
});
test('a collection recipe is owner protected and only an AI prompt can scope history', async () => {
  const h = harness(); try {
    h.collection('alice', 'custom-ai', '  ROMANTIC BALLADS  ');
    assert.equal(await h.history.playlistPromptForCollection('alice', 'custom-ai'), 'romantic ballads');
    assert.equal(await h.history.playlistPromptForCollection('bob', 'custom-ai'), undefined);
    assert.equal(await h.history.playlistPromptForCollection('alice', 'popular-rock'), undefined);
  } finally { h.db.close(); }
});

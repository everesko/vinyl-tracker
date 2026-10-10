import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

function evaluate(path, imports, globals = {}) {
  const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected import: ${name}`);
    return imports[name];
  }, crypto: webcrypto, Date, Map, Set, Math, Response, Request, Headers, URL, URLSearchParams,
  Uint8Array, TextEncoder, TextDecoder, AbortSignal, btoa, atob, ...globals });
  return mod.exports;
}
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
function harness() {
  let clock = 100000;
  const rows = new Map(), collections = new Map();
  const db = { prepare(sql) { return { bind(...args) { return {
    async first() {
      if (sql.startsWith('SELECT encrypted_settings')) return rows.has(args[0]) ? { ...rows.get(args[0]) } : null;
      if (sql.startsWith('INSERT INTO echo_settings')) {
        if (rows.has(args[0])) return null;
        rows.set(args[0], { encrypted_settings: args[1], version: 0 }); return { user_id: args[0] };
      }
      if (sql.startsWith('UPDATE echo_settings')) {
        const row = rows.get(args[2]); if (!row || row.version !== args[3]) return null;
        rows.set(args[2], { encrypted_settings: args[0], version: row.version + 1 }); return { user_id: args[2] };
      }
      if (sql.startsWith('SELECT title')) {
        const row = collections.get(args[0]); return row?.user_id === args[1] ? row : null;
      }
      throw new Error(sql);
    },
    async run() {
      assert.ok(sql.startsWith('INSERT INTO echo_collections'));
      if (!collections.has(args[0])) collections.set(args[0], { user_id: args[1], title: args[2], subtitle: args[3], track_data: args[5] });
    },
  }; } }; } };
  const http = { ApiError, database: () => db, runtime: () => ({ SESSION_ENCRYPTION_KEY: 'test-only-encryption-key-32-characters-minimum' }) };
  const secrets = evaluate('./secrets.ts', { './http': http });
  const settings = evaluate('./settings.ts', { './http': http, './secrets': secrets });
  const raw = Array.from({ length: 260 }, (_, i) => ({ id: `real${i}`, title: `Recording ${i}`, duration: 180,
    genre: 'Rock', is_available: true, is_streamable: true, access: { stream: true },
    user: { name: `Artist ${i % 20}`, handle: `artist${i % 20}`, is_available: true } }));
  const audius = evaluate('./audius.ts', { './http': http, './settings': settings }, {
    fetch: async url => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/stream')) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 206,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '4', 'content-range': 'bytes 0-3/1000' } });
      const ids = parsed.searchParams.getAll('id');
      return Response.json({ data: ids.length ? raw.filter(t => ids.includes(t.id)) : raw });
    },
  });
  const collectionModule = evaluate('./collections.ts', { './http': http, './settings': settings, './secrets': secrets,
    './popular': { constructPopularCollection: () => { throw new Error('Use popular.test.mjs for Deezer construction'); } },
    './audius': audius, './catalog': { collectionSummary: c => ({ ...c, count: c.trackIds.length, playable: true }) } },
    { Date: class extends Date { static now() { return clock; } } });
  return { secrets, settings, audius, collectionModule, raw, rows, collections, tick: ms => { clock += ms; } };
}

test('Audius rejects restricted, unavailable and invalid recordings; decks contain exactly 50 unique tracks', () => {
  const { audius, raw } = harness(); const sample = raw[0];
  assert.equal(audius.audiusCollections.length, 24);
  assert.equal(audius.isEligibleTrack(sample), true);
  for (const patch of [{ is_available: false }, { is_streamable: false }, { is_stream_gated: true },
    { is_unlisted: true }, { is_delete: true }, { access: { stream: false } }, { allowed_api_keys: ['restricted'] },
    { duration: 10 }, { duration: 3600 }, { user: { ...sample.user, is_available: false } }, { title: 'DJ set' }]) {
    assert.equal(audius.isEligibleTrack({ ...sample, ...patch }), false, JSON.stringify(patch));
  }
  const deck = audius.selectFifty(raw.map(audius.canonicalTrack));
  assert.equal(deck.length, 50); assert.equal(new Set(deck.map(t => t.id)).size, 50);
  assert.equal(deck[0].artist, sample.user.name); assert.equal(deck[0].title, sample.title);
  assert.ok(deck.every(t => t.verseEnd - t.verseStart >= 7 && t.encoreStart + 10 <= t.duration));
  assert.throws(() => audius.selectFifty([...deck.slice(0, 49), deck[0]]), error => error.code === 'NOT_ENOUGH_TRACKS');
});

test('saved keys are encrypted, owner-bound, masked and concurrently merged; deletion removes a key', async () => {
  const { settings, secrets, rows } = harness();
  const key = 'sk-test-only-not-a-real-secret-1234';
  const view = await settings.saveSettings('alice', { openaiKey: key });
  assert.equal(view.openai.tail, '1234'); assert.equal(view.openai.configured, true);
  assert.equal(JSON.stringify(view).includes(key), false);
  assert.equal(rows.get('alice').encrypted_settings.includes(key), false);
  await assert.rejects(secrets.decryptSecret(rows.get('alice').encrypted_settings, 'settings:bob'));
  assert.equal((await settings.credentials('bob')).openaiKey, undefined);
  await Promise.all([settings.saveSettings('alice', { audiusKey: 'test-audius-key-5678' }), settings.saveSettings('alice', { model: 'gpt-4.1-mini' })]);
  const saved = await settings.credentials('alice');
  assert.equal(saved.openaiKey, key); assert.equal(saved.audiusKey, 'test-audius-key-5678'); assert.equal(saved.model, 'gpt-4.1-mini');
  await settings.saveSettings('alice', { openaiKey: null });
  assert.equal((await settings.credentials('alice')).openaiKey, undefined);
  await assert.rejects(settings.saveSettings('alice', { openaiKey: 'bad key value' }), e => e.code === 'INVALID_KEY');
});

test('ChatGPT imports require 50 real IDs, protect context ownership and expiry, and are idempotent', async () => {
  const { collectionModule: c, collections, tick } = harness();
  const plan = await c.prepareChatGPTCollection('alice', '曲'.repeat(1000));
  assert.equal(plan.candidates, 200);
  const ids = Array.from({ length: 50 }, (_, i) => `audius-real${i}`);
  assert.ok(new TextEncoder().encode(JSON.stringify({ token: plan.token, title: '曲'.repeat(100), trackIds: ids })).length < 10000);
  await assert.rejects(c.importChatGPTCollection('bob', plan.token, 'Рок', ids), e => e.code === 'IMPORT_CONTEXT_INVALID');
  await assert.rejects(c.importChatGPTCollection('alice', plan.token, 'Рок', [...ids.slice(0, 49), ids[0]]), e => e.code === 'INVALID_TRACK_SELECTION');
  await assert.rejects(c.importChatGPTCollection('alice', plan.token, 'Рок', [...ids.slice(0, 49), 'audius-fabricated']), e => e.code === 'INVALID_TRACK_SELECTION');
  const first = await c.importChatGPTCollection('alice', plan.token, 'Рок', ids);
  const repeated = await c.importChatGPTCollection('alice', plan.token, 'Renamed', ids);
  assert.equal(first.collection.id, repeated.collection.id); assert.equal(repeated.collection.title, 'Рок'); assert.equal(collections.size, 1);
  const actual = JSON.parse([...collections.values()][0].track_data);
  assert.equal(actual.length, 50); assert.equal(actual[0].title, 'Recording 0'); assert.equal(actual[0].artist, 'Artist 0');
  tick(1800001);
  await assert.rejects(c.importChatGPTCollection('alice', plan.token, 'Рок', ids), e => e.code === 'IMPORT_CONTEXT_EXPIRED');
});

test('audio proxy preserves byte ranges and never exposes upstream provider URLs or keys', async () => {
  const { audius, raw } = harness();
  const response = await audius.streamAudius(audius.canonicalTrack(raw[0]), 'alice', new Request('https://quiz.test/audio', { headers: { Range: 'bytes=0-3' } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-3/1000');
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('location'), null);
  assert.equal((await response.arrayBuffer()).byteLength, 4);
  await assert.rejects(audius.streamAudius(audius.canonicalTrack(raw[0]), 'alice', new Request('https://quiz.test/audio', { headers: { Range: 'bytes=0-3,5-9' } })), e => e.code === 'INVALID_RANGE');
});

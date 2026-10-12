import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

class ApiError extends Error { constructor(status, code, message, extra) { super(message); Object.assign(this, { status, code, extra }); } }
function load(fetcher = fetch, { fast = false, withReady = false } = {}) {
  const cached = new Map();
  const database = () => ({ prepare(sql) { return { bind(...args) { return {
    async first() { return cached.get(args[0]) ?? null; },
    async all() {return {results:[...cached.entries()].filter(([id])=>id.startsWith('deezer-discovered-artist:')).map(([,row])=>row)};},
    async run() { assert.match(sql, /^INSERT INTO echo_media_collections/); cached.set(args[0], { track_data: args[1], updated_at: args[2] }); },
  }; } }; } });
  const mod = { exports: {} }, source = fs.readFileSync(new URL('../lib/server/popular.ts', import.meta.url), 'utf8');
  let now = 1000000;
  class Clock extends Date { static now() { now += 1000; return now; } }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module: mod, exports: mod.exports, require: name => {if(name==='@/lib/library-directions')return directionModule.exports;if(name==='./ready-presets')return {readyPresets:withReady?presetModule.exports.readyPresets:{}};if(name==='./ready-library-index')return {readyGenreIndexes:withReady?indexModule.exports.readyGenreIndexes:{}};if(name==='./eurovision-registry'){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/eurovision-registry.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:m,exports:m.exports});return m.exports;}if(name==='@/lib/track-order')return {spreadArtists:tracks=>tracks};if(name==='./stored-json')return {readJson:async text=>JSON.parse(text),storeJson:async(key,value)=>JSON.stringify(value)};if(name==='./era-verification')return {verifyEraPool:async tracks=>tracks,verifyGenrePool:async tracks=>tracks}; if(name==='@/lib/quiz')return {difficultyLevel:d=>typeof d==='number'?d:({easy:1,medium:3,advanced:7,hard:10}[d??'easy'])};if(name==='./theme-registry'){const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/theme-registry.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:m,exports:m.exports});return m.exports;}assert.equal(name, './http'); return { ApiError, database }; }, fetch: fetcher, crypto: webcrypto, Date: fast ? Clock : Date, Math, console, URL, URLSearchParams, Response, Request, Headers, AbortSignal, TextEncoder, Uint8Array, setTimeout });
  return mod.exports;
}
const directionModule={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/library-directions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:directionModule,exports:directionModule.exports});
const presetModule={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/ready-presets.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:presetModule,exports:presetModule.exports});
const indexModule={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/ready-library-index.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:indexModule,exports:indexModule.exports});
const preview = 'https://cdnt-preview.dzcdn.net/api/example.mp3?valid=1';
const recording = (id, rank = 900000) => ({ id, title: `Song ${id}`, title_short: `Song ${id}`, artist: { id: 412, name: 'Queen' }, preview, rank, readable: true, duration: 200, album: { id: 1 } });
const api = load();

test('romantic themes select a recording-level catalog and unsupported qualifiers are never dropped',()=>{
 assert.equal(api.parsePopularPrompt('романтические баллады').theme,'ballads');
 assert.equal(api.parsePopularPrompt('українські романтичні балади').theme,'ballads');
 assert.equal(api.parsePopularPrompt('українські романтичні балади').region,'UA');
 assert.throws(()=>api.parsePopularPrompt('романтические грустные рок песни'),e=>e.code==='PROMPT_NOT_UNDERSTOOD');
 assert.throws(()=>api.parsePopularPrompt('рок для сна'),e=>e.code==='PROMPT_NOT_UNDERSTOOD');
});
test('specific popular subgenres do not broaden to their parent genre',()=>{
 assert.deepEqual([...api.parsePopularPrompt('поп-панк').genreSlugs],['pop-punk']);
 assert.deepEqual([...api.parsePopularPrompt('классический рок').genreSlugs],['classic-rock']);
 assert.deepEqual([...api.parsePopularPrompt('інді-рок').genreSlugs],['indie-rock']);
 assert.deepEqual([...api.parsePopularPrompt('synth-pop').genreSlugs],['synth-pop']);
});
test('Ukrainian requests constrain country, language, genre and canonical identities',()=>{
 const hits=api.parsePopularPrompt('українські хіти');
 assert.equal(hits.region,'UA');assert.equal(hits.artists.length,110);
 assert.ok(!hits.artists.includes('Taylor Swift'));
 const rock=api.parsePopularPrompt('український рок 90-х');
 assert.equal(rock.decade,1990);assert.equal(rock.region,'UA');assert.ok(!rock.artists.includes('Queen'));
 assert.ok(rock.artists.includes('Okean Elzy'));
 const pop=api.parsePopularPrompt('українські поп хіти');assert.ok(!pop.artists.includes('Madonna'));assert.ok(!pop.artists.includes('Go_A'));
 const kola=api.parsePopularPrompt('українські пісні KOLA');assert.deepEqual([...kola.canonicalIds],['369308892']);
 assert.throws(()=>api.parsePopularPrompt('тільки українською Eminem'),error=>error.code==='PROMPT_CONFLICT');
 assert.throws(()=>api.parsePopularPrompt('французский поп'),error=>error.code==='REGIONAL_CATALOG_UNAVAILABLE');
 assert.equal(api.ukrainianTrackAllowed({artist:'Бумбокс',title:'Вахтерам'}),false);
 assert.equal(api.ukrainianTrackAllowed({artist:'Kola',title:'Біля серця'}),true);
 assert.equal(api.ukrainianTrackAllowed({artist:'Христина Соловій',title:'Fortepiano'}),true);
 assert.equal(api.ukrainianTrackAllowed({artist:'Taylor Swift',title:'Обійми'}),false);
});
async function prepare(action, retries = 32, progress = () => {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await action(); }
    catch (error) { if (error.code !== 'CATALOG_PREPARING' || !error.extra?.canRetry) throw error; progress(error.extra); }
  }
  throw new Error('Catalog did not finish staged preparation');
}
test('free parser recognizes RU/EN genres, eras and explicit artists without unrelated fill', () => {
  const query = api.parsePopularPrompt('Рок и поп 90-х');
  assert.equal(query.decade, 1990); assert.deepEqual([...query.genreSlugs], ['rock', 'pop']);
  const names = api.parsePopularPrompt('Queen и Линкин Парк');
  assert.deepEqual([...names.artists], ['Queen', 'Linkin Park']);
  assert.equal(api.parsePopularPrompt('блюп неизвестный космос').artists.length, 0);
  assert.equal(api.parsePopularPrompt('хиты нулевых').decade, 2000);
  assert.equal(api.parsePopularPrompt('хіти нульових').decade, 2000);
  assert.deepEqual([...api.parsePopularPrompt('електроніка 90-ті').genreSlugs], ['dance']);
  assert.equal(api.parsePopularPrompt('електроніка 90-ті').decade, 1990);
  assert.deepEqual([...api.parsePopularPrompt('Лінкін Парк і Емінем').artists], ['Linkin Park', 'Eminem']);
});
test('artist namesakes choose the most popular exact canonical identity', async () => {
  const api = load(async () => Response.json({ data: [{ id: 1, name: 'Queen', nb_fan: 399 }, { id: 412, name: 'Queen', nb_fan: 12824887 }, { id: 99, name: 'Queen Tribute', nb_fan: 14000000 }] }));
  assert.equal((await api.resolveArtist('Queen')).id, 412);
});
test('preview eligibility excludes covers, unavailable, short, low-rank and invalid domains', () => {
  assert.equal(api.eligibleRecording(recording(1), 412), true);
  for (const patch of [{ readable: false }, { duration: 13 }, { rank: -1 }, { title: 'Song Live at Wembley' }, { title_version: 'Instrumental' }, { preview: 'https://evil.example/a.mp3' }, { artist: { id: 99, name: 'Queen Tribute' } }]) assert.equal(api.eligibleRecording({ ...recording(1), ...patch }, 412), false);
});
test('deduplication keeps popular studio recording and difficulty uses provider ranks', () => {
  const candidates = Array.from({ length: 100 }, (_, n) => api.recordingTrack(recording(n + 1, 999000 - n * 8000)));
  const easy=api.selectPopularTracks(candidates,{count:10,difficulty:1}),hard=api.selectPopularTracks(candidates,{count:10,difficulty:10});
  assert.ok(Math.min(...easy.map(t=>t.popularityRank))>Math.max(...hard.map(t=>t.popularityRank)));
  assert.notDeepEqual(api.selectPopularTracks(candidates,{count:10,difficulty:1}).map(t=>t.id),easy.map(t=>t.id));
  const duplicate = { ...candidates[0], id: 'deezer-999', popularityRank: 100001 };
  assert.equal(api.deduplicateRecordings([...candidates, duplicate]).length, 100);
  assert.throws(() => api.selectPopularFifty(candidates.slice(0, 49)), error => error.code === 'NOT_ENOUGH_TRACKS' && error.extra.available === 49);
});
test('expired preview refresh goes through official metadata; Range is preserved without metadata headers', async () => {
  const calls = [];
  const api = load(async (url, options) => { calls.push({ url: String(url), options }); return calls.length === 1 ? Response.json(recording(1)) : new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-2/999', 'x-secret': 'provider' } }); });
  const response = await api.streamDeezer({ provider: 'deezer', providerId: '1', audioUrl: 'https://expired.example/a' }, new Request('https://echo.example/api/audio', { headers: { Range: 'bytes=0-2' } }));
  assert.equal(calls[0].url, 'https://api.deezer.com/track/1'); assert.equal(calls[1].url, preview); assert.equal(calls[1].options.headers.Range, 'bytes=0-2');
  assert.equal(response.status, 206); assert.equal(response.headers.get('x-secret'), null); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  await response.body.cancel();
});

test('playback renews explicitly requested live/remix/short recordings without applying preset selection rules',async()=>{
 for(const patch of [{title:'Song 1 (Live)'},{title:'Song 1',title_version:'Remix'},{duration:35,rank:undefined}]){
  let reads=0;const api=load(async()=>++reads===1?Response.json({...recording(1),...patch}):new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}}));
  const response=await api.streamDeezer({provider:'deezer',providerId:'1',title:'Song 1',artist:'Queen'},new Request('https://echo.example/audio'));
  assert.equal(response.status,200);assert.equal(reads,2);await response.body.cancel();
 }
 for(const patch of [{id:2},{readable:false},{preview:'https://untrusted.example/song.mp3'},{artist:{id:412,name:''}}]){
  const api=load(async()=>Response.json({...recording(1),...patch}));
  await assert.rejects(api.streamDeezer({provider:'deezer',providerId:'1'},new Request('https://echo.example/audio')),error=>error.code==='AUDIO_UNAVAILABLE');
 }
});
test('private snapshots must contain50distinctverifiedDeezerrecordings', () => {
  const snapshot = Array.from({ length: 50 }, (_, n) => api.recordingTrack(recording(n + 1)));
  assert.equal(api.validatePopularSnapshot(snapshot).length, 50);
  assert.throws(() => api.validatePopularSnapshot([...snapshot.slice(1), snapshot[1]]), error => error.code === 'INVALID_COLLECTION');
});
test('era decks use canonical album dates and exclude releases outside the requested decade', async () => {
  const identities = new Map(), requests = [];
  const api = load(async url => {
    const parsed = new URL(url); requests.push(parsed.pathname);
    if (parsed.pathname === '/search/artist') {
      const name = parsed.searchParams.get('q');
      if (!identities.has(name)) identities.set(name, { id: identities.size + 1, name, nb_fan: 1000000 });
      return Response.json({ data: [identities.get(name)] });
    }
    const artistId = Number(parsed.pathname.split('/')[2]);
    if(parsed.pathname.endsWith('/top'))return Response.json({data:[]});
    if (parsed.pathname.endsWith('/albums')) return Response.json({ data: [{ id: artistId * 100, title: 'Original studio album', release_date: '1977-04-01', fans: 10000 }, { id: artistId * 100 + 1, title: 'New studio album', release_date: '1982-04-01', fans: 99999 }] });
    const ownerId = artistId / 100, artist = [...identities.values()].find(value => value.id === ownerId);
    assert.ok(artist); // The1982albums mustneverbe requested.
    return Response.json({ id: artistId, title: 'Original studio album', release_date: '1977-04-01', tracks: { data: Array.from({ length: 12 }, (_, n) => ({ ...recording(ownerId * 1000 + n), artist })) } });
  }, { fast: true });
  const { deck } = await prepare(() => api.popularDeck('popular-70s'));
  assert.equal(deck.length, 50); assert.ok(deck.every(track => track.year === 1977));
  assert.ok(requests.filter(path => path.startsWith('/album/')).every(path => Number(path.split('/')[2]) % 100 === 0));
});
test('all4counts select exact unique recordings; artist repeats are never silently enabled', () => {
  const tracks = Array.from({ length: 220 }, (_, n) => ({ ...api.recordingTrack(recording(n + 1, 999000 - n * 2000)), artist: `Artist ${n % 110}` }));
  for (const count of [10, 20, 50, 100]) {
    assert.equal(api.selectPopularTracks(tracks, { count }).length, count);
    const unique = api.selectPopularTracks(tracks, { count, allowArtistRepeats: false });
    assert.equal(unique.length, count); assert.equal(new Set(unique.map(track => track.artist)).size, count);
  }
  const single = tracks.map(track => ({ ...track, artist: 'Queen' }));
  assert.throws(() => api.selectPopularTracks(single, { count: 10, allowArtistRepeats: false }), error => error.code === 'NOT_ENOUGH_ARTISTS' && error.extra.available === 1 && error.extra.required === 10);
  assert.equal(api.collectionOptions({count:137}).count,137);assert.throws(()=>api.collectionOptions({count:0}),error=>error.code==='INVALID_COUNT');
  assert.throws(() => api.collectionOptions({ count: 20, allowArtistRepeats: 'false' }), error => error.code === 'INVALID_ARTIST_REPEATS');
});
function fakeCatalog() {
  const identities = new Map(); let calls = 0;
  const fetcher = async url => {
    calls++;
    const parsed = new URL(url);
    if (parsed.pathname === '/search/artist') {
      const name = parsed.searchParams.get('q');
      if (!identities.has(name)) identities.set(name, { id: identities.size + 1, name, nb_fan: 1000000, picture_big: `https://cdn-images.dzcdn.net/images/artist/${identities.size}/500.jpg` });
      return Response.json({ data: [identities.get(name)], total: 1 });
    }
    const id = Number(parsed.pathname.split('/')[2]);
    let artist = [...identities.values()].find(value => value.id === id);
    if (!artist) { artist = { id, name: `Artist ${id}`, nb_fan: 1000000, picture_big: `https://cdn-images.dzcdn.net/images/artist/${id}/500.jpg` }; identities.set(artist.name, artist); }
    if (parsed.pathname.endsWith('/top')) return Response.json({ data: Array.from({ length: 12 }, (_, n) => ({ ...recording(id * 1000 + n, 999000 - n * 1000), artist, album: { id, cover_big: `https://cdn-images.dzcdn.net/images/cover/${id}/500.jpg` } })) });
    return Response.json(artist);
  };
  return { api: load(fetcher, { fast: true }), get calls() { return calls; }, reset() { calls = 0; } };
}
test('100selectedIDs are canonically checked in <=32externalreads per stage and resume without losing artists', async () => {
  const harness = fakeCatalog(), progress = [];
  const result = await prepare(async () => { harness.reset(); try { return await harness.api.constructArtistCollection(Array.from({ length: 100 }, (_, n) => String(n + 1)), 'All selected', { count: 100, allowArtistRepeats: false }); } finally { assert.ok(harness.calls <= 32, `Stage performed${harness.calls}externalreads`); } }, 8, value => progress.push(value.checkedArtists));
  assert.deepEqual(progress, [16, 32, 48, 64, 80, 96]);
  assert.equal(result.deck.length, 100); assert.equal(new Set(result.deck.map(track => track.artist)).size, 100); assert.equal(result.songOnly, false);
  assert.ok(result.pool.length > 100); assert.equal(result.images.length, 4);
  const short = await harness.api.constructArtistCollection(['1', '2'], undefined, { count: 10 }); assert.equal(short.deck.length, 10);
});
test('wide genre stages discover100differentartists without exceeding Worker external-read budget', async () => {
  const harness = fakeCatalog();
  const result = await prepare(async () => { harness.reset(); try { return await harness.api.popularDeck('popular-pop', { count: 100, allowArtistRepeats: false }); } finally { assert.ok(harness.calls <= 32); } }, 64);
  assert.equal(result.deck.length, 100); assert.equal(new Set(result.deck.map(track => track.artist)).size, 100);
});
test('invalid or duplicate artist IDs are rejected beforeanyprovider access', async () => {
  const harness = fakeCatalog();
  for (const ids of [[], ['1', '1'], ['https://evil.example'], ['../1'], [1], ['0']]) await assert.rejects(harness.api.constructArtistCollection(ids, 'X'), error => error.code === 'INVALID_ARTIST_IDS');
  assert.equal(harness.calls, 0);
  const missing = load(async () => Response.json({ error: { code: 800 } }), { fast: true });
  await assert.rejects(missing.constructArtistCollection(['9999999999'], 'X'), error => error.code === 'ARTIST_NOT_FOUND' && error.status === 422);
});
test('catalog cards require zero provider reads; discovery stays below the external-read budget', async () => {
  const harness = fakeCatalog();
  const cards = await harness.api.popularCards();
  assert.equal(cards.length, 114); assert.ok(harness.calls <= 40, `Covermetadata reads=${harness.calls}`);
  assert.equal(harness.calls,0);assert.ok(cards.filter(card=>card.category!=='artist').every(card=>!!card.image));
  harness.reset(); await harness.api.popularCards(); assert.equal(harness.calls, 0);
  const discovery = fakeCatalog(), page = await discovery.api.artistBrowser('', 0, 60);
  assert.equal(page.artists.length, 40); assert.ok(discovery.calls <= 40); assert.equal(page.nextCursor, 40);
});
test('provider quota errors surface as transient429 instead of a false empty-catalog claim', async () => {
  const api = load(async () => Response.json({ error: { code: 4, message: 'Quota limit exceeded' } }));
  await assert.rejects(api.popularDeck('popular-queen'), error => error.code === 'MUSIC_RATE_LIMIT' && error.status === 429);
});
if (process.argv.includes('--live')) {
  const live = load();
  for (const card of live.popularCollections) {
    try {
      const { deck } = await prepare(() => live.popularDeck(card.id, { duration: 3, timer: false, difficulty: 'medium' }));
      assert.equal(deck.length, 50); assert.equal(new Set(deck.map(track => track.id)).size, 50);
      assert.ok(deck.every(track => track.provider === 'deezer' && track.popularityRank >= 100000));
      console.log(JSON.stringify({ card: card.id, count: deck.length, artists: new Set(deck.map(track => track.artist)).size, rankMin: Math.min(...deck.map(track => track.popularityRank)), rankMax: Math.max(...deck.map(track => track.popularityRank)), yearMin: Math.min(...deck.map(track => track.year)), yearMax: Math.max(...deck.map(track => track.year)) }));
    } catch (error) { console.error(JSON.stringify({ card: card.id, error: error.code ?? error.message, message: error.message })); process.exitCode = 1; }
  }
}
if (process.argv.includes('--live-prompts')) {
  const live = load();
  for (const prompt of ['Queen и ABBA', 'рок 90-х', 'поп и альтернатива', 'Linkin Park']) {
    const result = await prepare(() => live.constructPopularCollection(prompt));
    assert.equal(result.deck.length, 50);
    if (prompt === 'рок 90-х') assert.ok(result.deck.every(track => track.year >= 1990 && track.year <= 1999));
    if (prompt === 'Queen и ABBA') assert.ok(result.deck.every(track => ['Queen', 'ABBA'].includes(track.artist)));
    console.log(JSON.stringify({ prompt, count: result.deck.length, artists: [...new Set(result.deck.map(track => track.artist))], minimumRank: Math.min(...result.deck.map(track => track.popularityRank)) }));
  }
  const { deck } = await live.popularDeck('popular-linkin-park', { difficulty: 'easy' });
  const response = await live.streamDeezer(deck[0], new Request('https://echo.example/audio', { headers: { Range: 'bytes=0-1023' } }));
  assert.equal(response.status, 206); assert.match(response.headers.get('content-range'), /^bytes 0-1023\//);
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
  console.log(JSON.stringify({ liveProxy: response.status, contentRange: response.headers.get('content-range'), cache: response.headers.get('cache-control') }));
}
if (process.argv.includes('--live-settings')) {
  let external = 0;
  const live = load(async (...args) => { external++; return fetch(...args); });
  for (const count of [10, 20, 50, 100]) {
    const { deck } = await prepare(() => live.popularDeck('popular-pop', { count, allowArtistRepeats: true }));
    assert.equal(deck.length, count); console.log(JSON.stringify({ count, uniqueSongs: new Set(deck.map(track => track.id)).size }));
  }
  const result = await prepare(async () => { external = 0; try { return await live.popularDeck('popular-pop', { count: 100, allowArtistRepeats: false }); } finally { assert.ok(external <= 50, `Coldstage external=${external}`); } }, 16, progress => console.log(JSON.stringify({ preparing: progress.checkedArtists, available: progress.available })));
  assert.equal(new Set(result.deck.map(track => track.artist)).size, 100);
  console.log(JSON.stringify({ live100UniqueArtists: result.deck.length, minimumRank: Math.min(...result.deck.map(track => track.popularityRank)) }));
  const grid = await live.artistBrowser('', 0, 24); assert.ok(grid.total > 100); assert.ok(grid.artists.length >= 20); assert.ok(grid.artists.every(artist => artist.image?.startsWith('https://cdn-images.dzcdn.net/images/artist/')));
  const selected = await prepare(() => live.constructArtistCollection(grid.artists.slice(0, 10).map(artist => artist.id), '10realartists', { count: 10, allowArtistRepeats: false }));
  assert.equal(selected.deck.length, 10); assert.equal(new Set(selected.deck.map(track => track.artist)).size, 10);
  console.log(JSON.stringify({ artistGrid: grid.artists.length, discoveryTotal: grid.total, selectedUnique: selected.deck.length }));
  await assert.rejects(live.popularDeck('popular-queen', { count: 100 }), error => error.code === 'NOT_ENOUGH_TRACKS');
  const eurovision = await prepare(() => live.popularDeck('popular-eurovision', { count: 50 }));
  assert.equal(eurovision.deck.length, 50); console.log(JSON.stringify({ eurovision: eurovision.deck.length, artists: [...new Set(eurovision.deck.map(track => track.artist))] }));
}

test('category conditions are never silently discarded',()=>{for(const prompt of ['rock 1985','rock 1980 and 1990','rock 80s and 90s','romantic ballads Eurovision'])assert.throws(()=>api.parsePopularPrompt(prompt),error=>error.code==='PROMPT_NOT_UNDERSTOOD');});

test('At least 21 artist presets are immediately playable with no provider or database crawl',async()=>{const ready=load(()=>{throw Error('Unexpected remote call')},{withReady:true});const cards=(await ready.popularCards()).filter(card=>card.ready&&card.songOnly);assert.ok(cards.length>=21);for(const card of cards){const {deck,songOnly}=await ready.popularDeck(card.id,{count:10,difficulty:1,allowArtistRepeats:false});assert.equal(deck.length,10);assert.equal(songOnly,true);assert.equal(new Set(deck.map(track=>track.id)).size,10);assert.ok(deck.every(track=>track.popularityRank>=100000&&track.audioUrl.startsWith('https://')&&track.provider==='deezer'));assert.equal(new Set(deck.map(track=>track.artist)).size,1);}assert.ok(cards.every(card=>card.count>=10));});

test('140 built-in directions have stable unique IDs and truthful prepared/indexed counts',async()=>{
 const ready=load(()=>{throw Error('Unexpected remote call')},{withReady:true}),cards=await ready.popularCards();
 assert.equal(cards.length,140);assert.equal(new Set(cards.map(card=>card.id)).size,140);
 assert.equal(cards.filter(card=>card.ready).length,74);assert.ok(cards.every(card=>card.playable));
 assert.ok(cards.filter(card=>!card.ready).every(card=>card.count===undefined));
 assert.equal(directionModule.exports.additionalDirections.length,78);
 const eras=directionModule.exports.additionalDirections.filter(recipe=>recipe.decade);
 assert.equal(eras.length,48);assert.ok(eras.every(recipe=>recipe.decade%10===0));
 const ua=directionModule.exports.additionalDirections.filter(recipe=>recipe.region==='UA');
 assert.equal(ua.length,9);assert.ok(ua.some(recipe=>recipe.slug==='ua-2000'&&recipe.decade===2000));
 assert.ok(directionModule.exports.additionalDirections.every(recipe=>Object.values(recipe.titles).every(Boolean)));
});

test('mixed presets start without catalog calls and keep artist guessing enabled',async()=>{
 const ready=load(()=>{throw Error('Unexpected remote call')},{withReady:true}),cards=(await ready.popularCards()).filter(card=>card.id.startsWith('popular-mix-'));
 assert.equal(cards.length,16);
 for(const card of cards){
  assert.ok(card.images.length>=2);assert.ok(card.selectedArtistCount>=3);assert.equal(card.songOnly,false);
  const {deck,songOnly}=await ready.popularDeck(card.id,{count:20,difficulty:1,allowArtistRepeats:false});
  assert.equal(deck.length,20);assert.equal(songOnly,false);assert.equal(new Set(deck.map(track=>track.id)).size,20);
  assert.ok(new Set(deck.map(track=>track.artist)).size>=3);assert.ok(deck.every(track=>card.artistNames.includes(track.artist)));
  if(card.id==='popular-mix-ukrainian-bands')assert.ok(deck.every(ready.ukrainianTrackAllowed));
 }
});

test('broad ready genres contain real indexed recordings and favor distinct performers without remote reads',async()=>{
 const ready=load(()=>{throw Error('A prepared genre must not crawl a remote catalog')},{withReady:true});
 for(const [slug,index]of Object.entries(indexModule.exports.readyGenreIndexes)){
  const card=ready.popularCollections.find(card=>card.id===`popular-${slug}`);
  assert.ok(card.artistCount>=8,`${slug} has ${card.artistCount} indexed artists`);if(card.artistCount<10){assert.equal(card.libraryMode,'indexed');assert.equal(card.ready,false);continue;}assert.equal(card.libraryMode,'prepared');
  assert.equal(card.selectedArtistCount,undefined);assert.equal(card.maximumUniqueArtists,undefined);
  const count=card.artistCount>=20?20:10;
  const {deck,songOnly}=await ready.popularDeck(card.id,{count,difficulty:1,allowArtistRepeats:true});
  assert.equal(deck.length,count);assert.equal(new Set(deck.map(track=>track.artist)).size,count);assert.equal(songOnly,false);
  assert.ok(deck.every(track=>track.genres.includes(slug)&&track.year===0&&track.categorySources.includes(`https://api.deezer.com/chart/${index.genreId}/tracks`)));
 }
});

test('prepared genre combinations are broad pools; moods and eras never inherit chart classifications',async()=>{
 const ready=load(()=>{throw Error('Prepared genre combinations must not perform remote reads')},{withReady:true});
 for(const id of ['popular-rock-alternative','popular-pop-rnb','popular-jazz-soul','popular-folk-country']){
  const card=ready.popularCollections.find(card=>card.id===id);assert.equal(card.libraryMode,'prepared');assert.equal(card.selectedArtistCount,undefined);assert.ok(card.artistCount>50);
  const {deck}=await ready.popularDeck(id,{count:50,difficulty:3,allowArtistRepeats:false});assert.equal(deck.length,50);assert.equal(new Set(deck.map(track=>track.artist)).size,50);
 }
 for(const id of ['popular-ballads','popular-80s','popular-pop-punk','popular-synth-pop','popular-ua-2000']){
  const card=ready.popularCollections.find(card=>card.id===id);assert.equal(card.libraryMode,'indexed');assert.equal(card.ready,false);assert.equal(card.count,undefined);
 }
 const limited=ready.popularCollections.find(card=>card.id==='popular-mix-ukrainian-bands');assert.equal(limited.selectedArtistCount,4);assert.equal(limited.maximumUniqueArtists,4);
});

test('a new broad genre expands beyond its prepared artists and indexes real album categories',async()=>{
 const artists=new Map(),byId=new Map(),calls=[];let relatedRequests=0;
 const identity=name=>{if(!artists.has(name)){const artist={id:10000+artists.size,name,nb_fan:1000000};artists.set(name,artist);byId.set(artist.id,artist);}return artists.get(name);};
 const ready=load(async input=>{
  const url=new URL(input);calls.push(url.pathname);
  if(url.pathname==='/search/artist')return Response.json({data:[identity(url.searchParams.get('q'))]});
  const id=Number(url.pathname.split('/')[2]);
  if(url.pathname.endsWith('/top'))return Response.json({data:[1,2,3,4,5,6].map(n=>({...recording(id*100+n),artist:byId.get(id),album:{id:id*10}}))});
  if(url.pathname.endsWith('/related')){relatedRequests++;return Response.json({data:Array.from({length:20},(_,index)=>identity(`Indexed classical performer ${id}-${index}`))});}
  if(url.pathname.startsWith('/album/'))return Response.json({id,title:'Studio album',genres:{data:[{id:98,name:'Classical'}]}});
  throw Error(`Unexpected catalog route ${url.pathname}`);
 },{withReady:true,fast:true});
 const {deck}=await prepare(()=>ready.popularDeck('popular-classical',{count:100,difficulty:1,allowArtistRepeats:false}),64);
 assert.equal(deck.length,100);assert.equal(new Set(deck.map(track=>track.artist)).size,100);assert.ok(relatedRequests>0);
 assert.ok(deck.every(track=>track.genres.includes('classical')));
 assert.ok(deck.filter(track=>track.artist.startsWith('Indexed classical performer')).every(track=>track.categorySources.some(source=>source.startsWith('https://api.deezer.com/album/'))));
 const before=calls.length;await ready.popularDeck('popular-classical',{count:100,difficulty:7,allowArtistRepeats:false});assert.equal(calls.length,before,'A verified index is reusable across difficulty changes');
});

test('prepared indexes reject chart contaminants even when a compilation has broad genre tags',()=>{
 const indexes=indexModule.exports.readyGenreIndexes;
 assert.ok(!indexes.rock.deck.some(track=>['Britney Spears','Michael Jackson'].includes(track.artist)));
 assert.ok(!indexes.classical.deck.some(track=>['Pitbull','Brenda Lee','Greta Svabo Bech'].includes(track.artist)));
 assert.ok(!indexes.metal.deck.some(track=>track.artist==='AC/DC'));
 assert.ok(!indexes.blues.deck.some(track=>track.artist==='Rita Ora'));
 assert.ok(Object.values(indexes).flatMap(index=>index.deck).every(track=>track.categorySources.some(source=>/^https:\/\/api\.deezer\.com\/album\/[1-9]\d*$/.test(source))));
});

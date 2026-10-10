import test from 'node:test';
import assert from 'node:assert/strict';
// Run directly with Node 24: node --experimental-strip-types --test tests/quiz.test.ts
// @ts-expect-error Node's type-stripping runner requires explicit .ts extensions.
import { normalizeAnswer, answerSimilarity, matchAnswer, matchSpokenAnswer, evaluateAnswer, multiplier, maxPoints, completedPoints, levelForXP, shuffleTracks } from '../lib/quiz.ts';
// @ts-expect-error Node's type-stripping runner requires explicit .ts extensions.
import { collections, tracks, demoTracks, demoCollection, getCollectionTracks, resolveCollection } from '../lib/catalog.ts';
import type { Settings, Track } from '../lib/quiz';
// @ts-expect-error Node's type-stripping runner requires explicit .ts extensions.
import { preparePassage } from '../lib/client-media.ts';

const sample: Track = { id: 'test', artist: 'Linkin Park', title: 'In the End', genres: ['rock'], year: 2000, artistAliases: ['Линкин Парк'] };
const settings: Settings = { duration: 7, timer: false, mode: 'both',difficulty:'medium' };

test('normalization handles punctuation, accents, Cyrillic, case, and whitespace', () => {
  assert.equal(normalizeAnswer('  ЛИНКИН ПАРК! '), 'linkin park');
  assert.equal(normalizeAnswer('Beyoncé'), 'beyonce');
  assert.equal(normalizeAnswer('Guns & Roses'), 'guns and roses');
  assert.equal(normalizeAnswer('B.Y.O.B.'), 'b y o b');
  assert.equal(normalizeAnswer('Українські Ґанок Європа'), 'ukrainski ganok evropa');
});

test('recognizable typos and Russian spellings match', () => {
  for (const guess of ['Linkin Park', 'linkin park!', 'Линкин Парк', 'Lipkim Pamk', 'Linkin Prak', 'Linkin PArk']) {
    assert.equal(matchAnswer(guess, 'Linkin Park'), true, guess);
  }
  assert.equal(matchAnswer('Metalica', 'Metallica'), true);
  assert.equal(matchAnswer('Нирвана', 'Nirvana'), true);
  assert.equal(matchAnswer('Мьюз', 'Muse', ['Мьюз']), true);
  assert.equal(matchAnswer('ИН ЗЕ ЭНД', 'In the End', ['Ин зе энд']), true);
  assert.equal(matchAnswer('Echo Lab 01', 'Echo Lab 01'), true);
});

test('similarity has an inclusive 40% boundary and rejects unrelated or negated answers', () => {
  const rejected = ['', '   ', 'LP', 'L', 'Nirvana', 'jklq zxqw', 'not Linkin Park', 'не Линкин Парк'];
  for (const guess of rejected) assert.equal(matchAnswer(guess, 'Linkin Park'), false, guess);
  assert.equal(answerSimilarity('abcxy', 'abcde').confidence, .6);
  assert.equal(matchAnswer('abcxy', 'abcde'), true);
  assert.equal(matchAnswer('abxyz', 'abcde'), true);
  assert.equal(matchAnswer('Linkin', 'Linkin Park'), true);
  assert.equal(matchAnswer('Pink', 'Punk'), true);
  assert.equal(matchAnswer('Muse', 'Moby'), false);
  assert.equal(matchAnswer('AB', 'ABBA'), true);
  assert.equal(matchAnswer('Echo Lab 02', 'Echo Lab 01'), true);
  assert.equal(matchAnswer('1945', '1944'), true);
  assert.equal(matchAnswer('Black', 'Blank'), true);
});

test('both mode awards 25, 10, or a negative penalty', () => {
  const perfect = evaluateAnswer(sample, settings, { artist: 'Lipkim Pamk', song: 'In the End' });
  assert.equal(perfect.base, 25); assert.equal(perfect.points, 25); assert.equal(perfect.perfect, true);
  assert.equal(perfect.correctionCount, 1); assert.equal(perfect.corrections.artist?.canonical, 'Linkin Park');
  const partial = evaluateAnswer(sample, settings, { artist: 'Линкин Парк', song: 'Numb' });
  assert.equal(partial.base, 10); assert.equal(partial.correct, true); assert.equal(partial.perfect, false);
  const wrong = evaluateAnswer(sample, settings, { artist: 'Nirvana', song: 'Numb' });
  assert.equal(wrong.points, -5); assert.equal(wrong.correct, false);
});

test('spelling corrections preserve the full reward with every multiplier', () => {
  const withAlias = { ...sample, titleAliases: ['Ин зе энд'] };
  const exact = evaluateAnswer(withAlias, { duration: 3, timer: true, difficulty: 'hard' }, { artist: 'ЛИНКИН ПАРК!', song: 'Ин зе энд', hintUsed: true });
  assert.equal(exact.points, 97.5); assert.equal(exact.correctionCount, 0); assert.equal(exact.hintMultiplier, .75);
  const corrected = evaluateAnswer(sample, { duration: 3, timer: true, difficulty: 'hard' }, { artist: 'Lipkim Pamk', song: 'In the Enx', hintUsed: true });
  assert.equal(corrected.points, 97.5); assert.equal(corrected.correctionCount, 2); assert.equal(corrected.correctionPenalty, 0);
  assert.equal(corrected.canonical.song, sample.title); assert.ok(corrected.artistConfidence >= .6);
  assert.equal(evaluateAnswer(sample, { duration: 3, timer: true, difficulty: 'hard' }, { hintUsed: true }).points, -26);
});

test('song-only games ignore known artists and evaluate only the title', () => {
  const artistOnly = evaluateAnswer(sample, settings, { artist: sample.artist, mode: 'both', songOnly: true });
  assert.equal(artistOnly.points, -5); assert.equal(artistOnly.mode, 'song'); assert.equal(artistOnly.artistCorrect, false); assert.equal(artistOnly.artistConfidence, 0);
  const title = evaluateAnswer(sample, settings, { artist: 'wrong', song: sample.title, mode: 'artist', songOnly: true });
  assert.equal(title.points, 10); assert.equal(title.perfect, true);
});

test('single mode scores only the selected answer field', () => {
  assert.equal(evaluateAnswer(sample, { ...settings, mode: 'artist' }, { artist: 'Linkin Park', song: '' }).points, 10);
  assert.equal(evaluateAnswer(sample, { ...settings, mode: 'song' }, { artist: 'wrong', song: 'In the End' }).points, 10);
  assert.equal(evaluateAnswer(sample, { ...settings, mode: 'artist' }, { song: 'In the End' }).points, -5);
});

test('each guess can select a mode independently of legacy game settings', () => {
  const legacy = { ...settings, mode: 'artist' } as const;
  assert.equal(evaluateAnswer(sample, legacy, { artist: sample.artist, song: sample.title, mode: 'both' }).points, 25);
  assert.equal(evaluateAnswer(sample, legacy, { artist: sample.artist, song: '', mode: 'song' }).points, -5);
  const withoutLegacyMode = { duration: 7, timer: false } as const;
  const answer = evaluateAnswer(sample, withoutLegacyMode, { artist: sample.artist, song: sample.title });
  assert.equal(answer.points, 18.8); assert.equal(answer.mode, 'both');
  assert.equal(maxPoints(withoutLegacyMode, 50), 940);
  assert.equal(evaluateAnswer(sample, withoutLegacyMode, { artist: sample.artist, mode: 'artist' }).mode, 'artist');
});

test('one spoken phrase recognizes both answers, reports corrections and rejects negations', () => {
  for (const spoken of ['исполнитель Линкин Парк песня In the End', 'Lipkim Pamk InTheEnd', 'lipkimpamk intheend']) {
    const result = evaluateAnswer(sample, settings, { spoken, mode: 'both' });
    assert.equal(result.artistCorrect, true, spoken); assert.equal(result.songCorrect, true, spoken); assert.equal(result.points, 25);
  }
  assert.equal(evaluateAnswer(sample, settings, { spoken: 'Nirvana Smells Like Teen Spirit' }).points, -5);
  for (const spoken of ['не Линкин Парк', 'not Linkin Park']) assert.equal(matchSpokenAnswer(spoken, 'Linkin Park'), false, spoken);
  for (const spoken of ['not In the End', 'это не In the End', 'песня не InTheEnd']) assert.equal(matchSpokenAnswer(spoken, 'In the End'), false, spoken);
  assert.equal(matchSpokenAnswer('not Nirvana but Linkin Park', 'Linkin Park'), true);
  assert.equal(matchSpokenAnswer('Linkin', 'Linkin Park'), true);
  assert.equal(matchSpokenAnswer('In the', 'In the End'), true);
  assert.equal(matchSpokenAnswer('x'.repeat(401), 'Linkin Park'), false);
  assert.equal(evaluateAnswer(sample, settings, { spoken: 'Линкин Парк неизвестная песня', mode: 'artist' }).points, 10);
});

test('duration and timer multipliers preserve one decimal', () => {
  for (const [duration, expected] of [[3, 2], [5, 1.5], [7, 1]] as const) {
    assert.equal(multiplier({ ...settings, duration }), expected);
    assert.equal(multiplier({ ...settings, duration, timer: true }), Math.round(expected * 1.3 * 100) / 100);
  }
  const timed = { ...settings, duration: 5, timer: true } as const;
  assert.equal(evaluateAnswer(sample, timed, { artist: sample.artist, song: sample.title }).points, 48.8);
  assert.equal(evaluateAnswer(sample, timed, {}).points, -9.8);
  assert.equal(maxPoints(timed, 50), 2440);
  assert.equal(completedPoints([-10, -5]), -15);
  assert.equal(completedPoints([19.5, -9.7]), 9.8);
});

test('XP levels clamp negative totals and progress resets at each threshold', () => {
  assert.deepEqual(levelForXP(-5), { level: 1, current: 0, next: 100, progress: 0 });
  assert.deepEqual(levelForXP(100), { level: 2, current: 0, next: 300, progress: 0 });
  assert.deepEqual(levelForXP(250), { level: 2, current: 150, next: 300, progress: 50 });
  assert.equal(levelForXP(400).level, 3);
});

test('difficulty scales rewards and penalties; hints discount only positive points', () => {
  for (const [difficulty, factor] of [['easy', .75], ['medium', 1], ['advanced', 1.5], ['hard', 2]] as const) {
    const configured = { duration: 7, timer: false, difficulty } as const;
    assert.equal(multiplier(configured), factor);
    const correct = evaluateAnswer(sample, configured, { artist: sample.artist, song: sample.title });
    const wrong = evaluateAnswer(sample, configured, {});
    assert.equal(correct.points, Math.round(25 * factor * 10) / 10);
    assert.equal(wrong.points, -Math.round(5 * factor * 10) / 10);
    assert.equal(maxPoints(configured, 50), completedPoints(Array(50).fill(correct.points)));
  }
  assert.equal(multiplier({ duration: 5, timer: true, difficulty: 'easy' }), 1.4625);
  const timedEasy = { duration: 5, timer: true, difficulty: 'easy' } as const;
  assert.equal(evaluateAnswer(sample, timedEasy, { artist: sample.artist, song: sample.title }).points, 36.6);
  assert.equal(evaluateAnswer(sample, timedEasy, {}).points, -7.3);
  assert.equal(multiplier({ duration: 7, timer: false }), .75);
});

test('shuffle retains every item once and never mutates the source', () => {
  const original = [1, 2, 3, 4, 5];
  const shuffled = shuffleTracks(original, () => 0);
  assert.deepEqual(original, [1, 2, 3, 4, 5]);
  assert.deepEqual([...shuffled].sort(), original);
  assert.notDeepEqual(shuffled, original);
});

test('all seven collections have exactly 50 unique valid metadata entries', () => {
  assert.deepEqual(collections.map((collection: { id: string }) => collection.id), ['rock', 'poppunk', 'alternative', 'pop', '80s', '00s', 'eurovision']);
  assert.equal(new Set(tracks.map((track: Track) => track.id)).size, tracks.length);
  for (const collection of collections) {
    assert.equal(collection.trackIds.length, 50, collection.id);
    assert.equal(new Set(collection.trackIds).size, 50, collection.id);
    const collectionTracks = getCollectionTracks(collection.id);
    assert.equal(collectionTracks.length, 50);
    for (const track of collectionTracks) {
      assert.ok(track.artist && track.title && track.year > 1900 && track.genres.includes(collection.id));
      assert.equal(track.audioUrl, undefined); assert.equal(track.videoUrl, undefined);
    }
  }
  assert.ok(getCollectionTracks('80s').every((track: Track) => track.year >= 1980 && track.year <= 1989));
  assert.ok(getCollectionTracks('00s').every((track: Track) => track.year >= 2000 && track.year <= 2009));
  assert.deepEqual(getCollectionTracks('unknown'), []);
});

test('50 demo entries share the identifiable demo artist and have unique titles and original note motifs', () => {
  assert.equal(demoTracks.length, 50);
  assert.equal(demoCollection.trackIds.length, 50);
  assert.equal(getCollectionTracks('demo').length, 50);
  assert.equal(new Set(demoTracks.map((track: Track) => track.title)).size, 50);
  assert.ok(demoTracks.every((track: Track) => track.artist === 'Echo Lab' && track.artistAliases?.includes('Эхо Лаб')));
  assert.equal(new Set(demoTracks.map((track: Track) => track.demoNotes?.join(','))).size, 50);
  assert.ok(demoTracks.every((track: Track) => track.demoNotes?.length === 8 && track.demoNotes.every(note => Number.isInteger(note) && note >= 48 && note <= 84)));
  assert.ok(demoTracks.every((track: Track) => track.rights?.startsWith('DEMO:')));
  for (const track of demoTracks) {
    assert.equal(evaluateAnswer(track, { ...settings, mode: 'artist' }, { artist: 'Эхо Лаб' }).points, 10);
    assert.equal(matchAnswer(track.title.replace(/ё/g, 'е'), track.title), true);
    if (track.title.includes('ё')) assert.ok(track.titleAliases?.includes(track.title.replace(/ё/g, 'е')));
  }
});

test('all scoring settings and answer combinations agree with attainable maximum', () => {
  for (const duration of [3, 5, 7] as const) for (const timer of [false, true]) for (const mode of ['artist', 'song', 'both'] as const) for (const difficulty of ['easy', 'medium', 'advanced', 'hard'] as const) {
    const configured = { duration, timer, mode, difficulty };
    const perfect = evaluateAnswer(sample, configured, { artist: sample.artist, song: sample.title });
    assert.equal(maxPoints(configured, 50), completedPoints(Array(50).fill(perfect.points)));
    for (const artistCorrect of [false, true]) for (const songCorrect of [false, true]) {
      const result = evaluateAnswer(sample, configured, { artist: artistCorrect ? sample.artist : 'wrong', song: songCorrect ? sample.title : 'wrong' });
      const selectedCorrect = mode === 'artist' ? artistCorrect : mode === 'song' ? songCorrect : artistCorrect || songCorrect;
      assert.equal(result.correct, selectedCorrect);
      assert.equal(result.base, mode === 'both' && artistCorrect && songCorrect ? 25 : selectedCorrect ? 10 : -5);
      assert.ok(Math.abs(result.points * 10 - Math.round(result.points * 10)) < 1e-10);
    }
  }
});

test('prompt resolver is an honest local keyword lookup', () => {
  assert.equal(resolveCollection('поп-панк и Green Day')?.id, 'poppunk');
  assert.equal(resolveCollection('хиты нулевых')?.id, '00s');
  assert.equal(resolveCollection('Eurovision winners')?.id, 'eurovision');
  assert.equal(resolveCollection('Linkin Park и Muse')?.id, 'alternative');
  assert.equal(resolveCollection('демо')?.id, 'demo');
  assert.equal(resolveCollection('неизвестный запрос'), undefined);
  assert.equal(resolveCollection(''), undefined);
});

test('audio preparation waits for the entire seven-second interval and supports cancellation', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } });
  try {
    const media = Object.assign(new EventTarget(), { readyState: 3, currentTime: 20, seeking: false, duration: 180,
      buffered: { length: 1, start: (): number => 20, end: (): number => 21 } });
    let ready = false;
    const preparing = preparePassage(media as unknown as HTMLMediaElement, 20, undefined, 7).then(() => { ready = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false, 'one second buffered must not start a seven-second round');
    media.buffered.end = () => 27.1;
    media.dispatchEvent(new Event('progress'));
    await preparing;
    assert.equal(ready, true);
    media.buffered.end = () => 22;
    const controller = new AbortController();
    const aborted = preparePassage(media as unknown as HTMLMediaElement, 20, controller.signal, 7);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(aborted, { name: 'AbortError' });
    await assert.rejects(preparePassage(media as unknown as HTMLMediaElement, 177, undefined, 7), /фрагмент недоступен/);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('Letter percentages count substitutions, insertions, deletions and transpositions consistently',()=>{assert.equal(answerSimilarity('abxyz','abcde').matched,true);assert.ok(Math.abs(answerSimilarity('abxyz','abcde').confidence-.4)<1e-10);assert.equal(answerSimilarity('axyzw','abcde').matched,false);assert.equal(answerSimilarity('ab','ba').confidence,0);assert.equal(answerSimilarity('ac','abc').confidence,1-1/3);assert.equal(answerSimilarity('Linkin-Park','Linkin Park').confidence,1);assert.equal(answerSimilarity('東京','東京').confidence,1);});
test('Correct titles beginning with negative words are accepted',()=>{for(const title of ['Not Fade Away','Not Now John','Не йди'])assert.equal(answerSimilarity(title,title).confidence,1);});
test('A single spoken entity cannot receive both artist and song awards',()=>{const track={...sample,artist:'Queen',title:'Teen',artistAliases:[]};const result=evaluateAnswer(track,settings,{spoken:'Queen'});assert.equal(result.artistCorrect,true);assert.equal(result.songCorrect,false);assert.equal(result.points,10);const same={...track,title:'Queen'};assert.equal(evaluateAnswer(same,settings,{spoken:'Queen'}).points,10);assert.equal(evaluateAnswer(same,settings,{spoken:'Queen Queen'}).points,25);});

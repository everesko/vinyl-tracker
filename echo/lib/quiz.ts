export type AnswerMode = 'artist' | 'song' | 'both';
export type Difficulty = number | 'easy' | 'medium' | 'advanced' | 'hard';
export function difficultyLevel(value?:Difficulty){return typeof value==='number'?Math.min(10,Math.max(1,Math.round(value))):({easy:1,medium:3,advanced:7,hard:10}[value??'easy']);}
export function difficultyMultiplier(value?:Difficulty){return [.75,.9,1,1.1,1.25,1.4,1.5,1.65,1.8,2][difficultyLevel(value)-1];}
export type Settings = { duration: 3 | 5 | 7; timer: boolean; mode?: AnswerMode; difficulty?: Difficulty; count?: number; allowArtistRepeats?: boolean };
export type Track = {
  id: string; title: string; artist: string; artistAliases?: string[]; titleAliases?: string[];
  genres: string[]; year: number; dateSources?:{url:string;year:number}[]; categorySources?:string[];contestYear?:number; audioUrl?: string; videoUrl?: string; verseStart?: number;
  chorusStart?: number; verseEnd?: number; rights?: string; demoNotes?: number[];
  artworkUrl?: string; provider?: 'audius' | 'deezer'; providerId?: string; sourceUrl?: string; duration?: number; encoreStart?: number; popularityRank?: number; hintStart?: number;
};
/** Public metadata for a collection preview, with playback locations excluded. */
export type TrackSafe = Omit<Track, 'audioUrl' | 'videoUrl'>;
export type Collection = { id: string; title: string; subtitle: string; color: string; tag: string; image?: string; trackIds: string[] };

const transliteration: Record<string, string> = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',
  о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',і:'i',ї:'i',є:'e',ґ:'g',
};

export function normalizeAnswer(value: string): string {
  return value.replace(/([a-zа-яёіїєґ])([A-ZА-ЯЁІЇЄҐ])/g, '$1 $2').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[а-яёіїєґ]/g, letter => transliteration[letter] ?? letter)
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function editDistance(left: string, right: string): number {
  const a=Array.from(left),b=Array.from(right),row=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){let diagonal=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const previous=row[j];row[j]=Math.min(previous+1,row[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=previous;}}
  return row[b.length];
}

export type AnswerMatch = { confidence: number; exact: boolean; matched: boolean; input: string };
const emptyMatch = (): AnswerMatch => ({ confidence: 0, exact: false, matched: false, input: '' });

/** Letter edit similarity: one insertion, deletion or replacement costs one. */
export function answerSimilarity(input: string, expected: string, aliases: string[] = []): AnswerMatch {
  const normalized = normalizeAnswer(input);
  if (!normalized) return emptyMatch();
  let best = emptyMatch();
  for (const candidate of [expected, ...aliases]) {
    const target = normalizeAnswer(candidate);
    if (!target) continue;
    const exact = normalized.replace(/ /g,'') === target.replace(/ /g,'');
    if(!exact&&/\b(?:ne|not|net)\s/.test(normalized)&&!/^(?:ne|not|net)\s/.test(target))continue;
    const left = normalized.replace(/ /g, ''), right = target.replace(/ /g, '');
    const confidence = 1 - editDistance(left, right) / Math.max(Array.from(left).length, Array.from(right).length);
    if (exact || confidence > best.confidence) best = { confidence, exact, matched: confidence + Number.EPSILON >= .4, input };
    if (exact) break;
  }
  return best;
}

export function matchAnswer(input: string, expected: string, aliases: string[] = []): boolean {
  return answerSimilarity(input, expected, aliases).matched;
}

function spokenText(spoken:string){
  let value=normalizeAnswer(spoken);
  // Explicit answer labels separate fields but are not part of the name.
  value=value.replace(/\b(?:ispolnitel|vykonavets|pesnya|pisnya)\b/g,' ').trim().replace(/\s+/g,' ');
  if(/^(?:ne|not|net)\s/.test(value)&&/\bbut\b/.test(value))value=value.split(/\bbut\b/).at(-1)!.trim();
  return value;
}
function spokenSimilarity(spoken:string,expected:string,aliases:string[]=[]):AnswerMatch{
  if(spoken.length>400)return emptyMatch();
  const original=answerSimilarity(spoken,expected,aliases);return original.exact?original:answerSimilarity(spokenText(spoken),expected,aliases);
}
function spokenPair(spoken:string,track:Track):{artist:AnswerMatch;song:AnswerMatch}{
  const empty={artist:emptyMatch(),song:emptyMatch()};if(spoken.length>400)return empty;
  const words=spokenText(spoken).split(' ').filter(Boolean);if(!words.length||words.length>80)return empty;
  const wholeArtist=answerSimilarity(words.join(' '),track.artist,track.artistAliases),wholeSong=answerSimilarity(words.join(' '),track.title,track.titleAliases);
  let best=wholeArtist.confidence>=wholeSong.confidence?{artist:wholeArtist,song:emptyMatch()}:{artist:emptyMatch(),song:wholeSong};
  const score=(pair:typeof best)=>(Number(pair.artist.matched)+Number(pair.song.matched))*10+pair.artist.confidence+pair.song.confidence;
  for(let index=1;index<words.length;index++){
    const left=words.slice(0,index).join(' '),right=words.slice(index).join(' ');
    for(const [artist,song]of[[left,right],[right,left]]){
      const pair={artist:answerSimilarity(artist,track.artist,track.artistAliases),song:answerSimilarity(song,track.title,track.titleAliases)};
      if(score(pair)>score(best))best=pair;
    }
  }
  return best;
}
/** Compare the complete spoken field; never discard arbitrary middle words. */
export function matchSpokenAnswer(spoken:string,expected:string,aliases:string[]=[]):boolean{return spokenSimilarity(spoken,expected,aliases).matched;}
export function multiplier(settings: Settings): number {
  const durationMultiplier = settings.duration === 3 ? 2 : settings.duration === 5 ? 1.5 : 1;
  return Math.round(durationMultiplier * (settings.timer ? 1.3 : 1) * difficultyMultiplier(settings.difficulty) * 10000) / 10000;
}

function roundPoints(value: number): number {
  return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 10) / 10;
}

export type AnswerEvaluation = {
  artistCorrect: boolean; songCorrect: boolean; base: number; multiplier: number; points: number;
  correct: boolean; perfect: boolean; mode: AnswerMode;
  artistConfidence: number; songConfidence: number; correctionCount: number; correctionPenalty: number;
  corrections: { artist?: { input: string; canonical: string; confidence: number }; song?: { input: string; canonical: string; confidence: number } };
  canonical: { artist: string; song: string }; hintUsed: boolean; hintMultiplier: number;
};
export function evaluateAnswer(track: Track, settings: Settings, answer: { artist?: string; song?: string; spoken?: string; mode?: AnswerMode; songOnly?: boolean; hintUsed?: boolean }): AnswerEvaluation {
  const mode = answer.songOnly ? 'song' : answer.mode ?? settings.mode ?? 'both';
  const voicePair=mode==='both'?spokenPair(answer.spoken??'',track):undefined;
  const fieldMatch = (input: string | undefined, canonical: string, aliases?: string[], placement?:'artist'|'song') => {
    const manual = answerSimilarity(input ?? '', canonical, aliases);
    const voice = voicePair?voicePair[placement!]:spokenSimilarity(answer.spoken ?? '', canonical, aliases);
    return manual.exact || (!voice.exact && manual.confidence >= voice.confidence) ? manual : voice;
  };
  const artist = mode === 'song' ? emptyMatch() : fieldMatch(answer.artist, track.artist, track.artistAliases,'artist');
  const song = mode === 'artist' ? emptyMatch() : fieldMatch(answer.song, track.title, track.titleAliases,'song');
  const artistCorrect = artist.matched, songCorrect = song.matched;
  const correct = mode === 'artist' ? artistCorrect : mode === 'song' ? songCorrect : artistCorrect || songCorrect;
  const perfect = mode === 'both' ? artistCorrect && songCorrect : correct;
  const base = perfect ? (mode === 'both' ? 25 : 10) : correct ? 10 : -5;
  const factor = multiplier(settings);
  const corrections: AnswerEvaluation['corrections'] = {};
  if (artistCorrect && !artist.exact) corrections.artist = { input: artist.input, canonical: track.artist, confidence: artist.confidence };
  if (songCorrect && !song.exact) corrections.song = { input: song.input, canonical: track.title, confidence: song.confidence };
  const correctionCount = Object.keys(corrections).length;
  const hintMultiplier = answer.hintUsed && base > 0 ? .75 : 1;
  return { artistCorrect, songCorrect, base, multiplier: factor, points: roundPoints(base * factor * hintMultiplier), correct, perfect, mode,
    artistConfidence: artist.confidence, songConfidence: song.confidence, correctionCount, correctionPenalty: 0,
    corrections, canonical: { artist: track.artist, song: track.title }, hintUsed: !!answer.hintUsed, hintMultiplier };
}

export function maxPoints(settings: Settings, count: number): number {
  return roundPoints(Math.max(0, Math.floor(count)) * roundPoints(((settings.mode ?? 'both') === 'both' ? 25 : 10) * multiplier(settings)));
}

/** Signed completed scores affect XP in both directions. */
export function completedPoints(points: readonly number[]): number {
  return roundPoints(points.reduce((total, point) => total + point, 0));
}

/** Level thresholds: 0, 100, 400, 900… Progress is a percentage, from 0 to 100. */
export function levelForXP(xp: number): { level: number; current: number; next: number; progress: number } {
  const total = Number.isFinite(xp) ? Math.max(0, xp) : 0;
  const level = Math.floor(Math.sqrt(total / 100)) + 1;
  const current = total - (level - 1) ** 2 * 100;
  const next = (level ** 2 - (level - 1) ** 2) * 100;
  return { level, current, next, progress: Math.min(100, current / next * 100) };
}

/** Fisher–Yates; never changes the collection's original order. */
export function shuffleTracks<T>(tracks: readonly T[], random: () => number = Math.random): T[] {
  const result = [...tracks];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

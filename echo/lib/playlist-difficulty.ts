/** Difficulty is recognizability within the requested category, not global popularity.
 * Gemini chooses the recognition band; observed Deezer ranks order the matching
 * candidates inside that category. An obscure global market can still have hits.
 */
export type PlaylistDifficultyPolicy = {
  level: number;
  label: string;
  promptInstruction: string;
  minRecognition: number;
  maxRecognition: number;
  targetPopularityPercentile: number;
  percentileRange: readonly [number, number];
  catalogRankReference: 'within-category';
};

const bands = [
  {label:'Iconic signatures',min:9,max:10,range:[80,100],instruction:'Only iconic signature songs and the biggest universally recognized hits within this exact category.'},
  {label:'Biggest hits',min:8,max:10,range:[70,100],instruction:'The biggest widely recognized singles in this exact category; favor familiar hooks and definitive hits.'},
  {label:'Familiar hits',min:8,max:9,range:[60,95],instruction:'Widely familiar hits in this exact category, broadening beyond only each artist’s single signature song.'},
  {label:'Established hits',min:7,max:9,range:[50,85],instruction:'Established hits in this exact category; include recognizable secondary hits rather than only chart leaders.'},
  {label:'Popular selections',min:6,max:8,range:[40,75],instruction:'Popular singles and familiar album favorites within this exact category, with moderate recognizability.'},
  {label:'Secondary singles',min:5,max:7,range:[30,65],instruction:'Moderately familiar secondary singles and album favorites in this exact category; avoid only the obvious signatures.'},
  {label:'Fan favorites',min:4,max:6,range:[20,55],instruction:'Less mainstream fan favorites within this exact category, still identifiable to listeners who know this music.'},
  {label:'Album discoveries',min:3,max:5,range:[10,45],instruction:'Less familiar album tracks and specialist favorites in this exact category, requiring wider listening experience.'},
  {label:'Deep cuts',min:2,max:4,range:[5,30],instruction:'Deep cuts and lesser-known releases within this exact category, requiring strong artist and genre knowledge.'},
  {label:'Expert selections',min:1,max:3,range:[0,20],instruction:'The least immediately recognizable valid releases within this exact category, for expert listeners.'},
] as const;

export function difficultyPolicy(value: number = 1): PlaylistDifficultyPolicy {
  const level = Number.isFinite(value) ? Math.max(1, Math.min(10, Math.round(value))) : 1;
  const band = bands[level - 1];
  return {
    level,
    label: band.label,
    minRecognition: band.min,
    maxRecognition: band.max,
    targetPopularityPercentile: Math.round((10 - level) * 100 / 9),
    percentileRange: band.range,
    catalogRankReference: 'within-category',
    promptInstruction: `Difficulty ${level}/10. ${band.instruction} Recognition must be ${band.min}–${band.max}/10, where 10 means an iconic widely known song in this category and 1 means a niche deep cut. Judge familiarity within the requested language, place, era, genre and mood; do not use global popularity to dismiss regional hits. Every explicit request constraint remains mandatory: if the request says hits, choose harder-to-recognize hits rather than changing to non-hits; if it says romantic ballads, every song must actually be romantic and a ballad.`,
  };
}

export type DifficultyTrack = {
  rank?: number;
  popularityRank?: number;
  recognition?: number;
  catalogArtistId?: string | number;
  artist: string | {id?: string | number; name?: string};
};

export function recognitionMatchesDifficulty(recognition: number | undefined, level: number): boolean {
  if (recognition === undefined) return true;
  const policy = difficultyPolicy(level);
  return Number.isFinite(recognition) && recognition >= policy.minRecognition && recognition <= policy.maxRecognition;
}

export function playlistArtistKey(track: DifficultyTrack): string {
  const id = track.catalogArtistId ?? (typeof track.artist === 'object' ? track.artist.id : undefined);
  if (id !== undefined && id !== null && String(id).trim() && String(id) !== '0') return `id:${id}`;
  const name = typeof track.artist === 'string' ? track.artist : track.artist.name ?? '';
  return `name:${name.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '')}`;
}

function validRank(track: DifficultyTrack): number | undefined {
  const value = track.popularityRank ?? track.rank;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 100 is the most popular; equal measured ranks get equal percentiles.
 * The reference population is only the verified candidates for this request.
 * Missing or zero ranks are unknown, never invented "obscure" measurements.
 */
export function categoryPopularityPercentiles(tracks: readonly DifficultyTrack[]): (number | undefined)[] {
  const ranks = tracks.map(validRank).filter((rank): rank is number => rank !== undefined).sort((a,b)=>a-b);
  if (!ranks.length) return tracks.map(()=>undefined);
  const percentile = new Map<number,number>();
  for (let i=0;i<ranks.length;){
    let end=i+1;while(end<ranks.length && ranks[end]===ranks[i])end++;
    percentile.set(ranks[i],ranks.length===1 ? 50 : (i+(end-i-1)/2)/(ranks.length-1)*100);
    i=end;
  }
  return tracks.map(track=>{const rank=validRank(track);return rank===undefined ? undefined : percentile.get(rank);});
}

/** Deterministic selection: difficulty first, distinct performers before repeats.
 * It may return fewer than count when recognition or no-repeat requirements
 * cannot be fulfilled. The caller must report that instead of weakening them.
 */
export function selectDifficultyTracks<T extends DifficultyTrack>(
  tracks: readonly T[], count: number, level: number,
  options: {allowArtistRepeats?: boolean} = {},
): T[] {
  const wanted = Number.isFinite(count) ? Math.max(0,Math.floor(count)) : 0;
  if (!wanted) return [];
  const policy=difficultyPolicy(level);
  const suitable=tracks.filter(track=>recognitionMatchesDifficulty(track.recognition,policy.level));
  const percentiles=categoryPopularityPercentiles(suitable);
  const recognitionTarget=(policy.minRecognition+policy.maxRecognition)/2;
  const ordered=suitable.map((track,index)=>{
    const measured=percentiles[index];
    const rankDistance=measured===undefined ? undefined : Math.abs(measured-policy.targetPopularityPercentile);
    const familiarityDistance=track.recognition===undefined ? undefined : Math.abs(track.recognition-recognitionTarget)/9*100;
    const score=rankDistance===undefined ? familiarityDistance ?? 50 : familiarityDistance===undefined ? rankDistance : rankDistance*.4+familiarityDistance*.6;
    return {track,index,score};
  }).sort((a,b)=>a.score-b.score || a.index-b.index);
  const selected:T[]=[],performers=new Set<string>(),remaining:T[]=[];
  for (const {track} of ordered){
    const key=playlistArtistKey(track);
    if (performers.has(key)){remaining.push(track);continue;}
    performers.add(key);selected.push(track);
    if (selected.length===wanted)return selected;
  }
  if(options.allowArtistRepeats){
    for(const track of remaining){selected.push(track);if(selected.length===wanted)break;}
  }
  return selected;
}

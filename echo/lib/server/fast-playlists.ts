import {difficultyLevel, type Track} from '@/lib/quiz';
import {difficultyPolicy, playlistArtistKey} from '@/lib/playlist-difficulty';
import {parseSongList, planFromPrompt, songKey, type SongName} from '@/lib/playlist-list';
import {validatePlan, type PlaylistPlan} from '@/lib/playlist-plan';
import {spreadArtists} from '@/lib/track-order';
import {ApiError, database} from './http';
import {geminiCompletion} from './gemini';
import {getPlayedSongs} from './playlist-history';
import {persistCollection, validatePrompt} from './collections';
import {catalogArtistNames, recordingTrack, type DeckOptions} from './popular';
import {readJson, storeJson} from './stored-json';

const PARALLEL_LOOKUPS=6;
const LOOKUP_INTERVAL_MS=125;
type ProposedSong=SongName;
type ResolvedSong=Track&{catalogArtistId:number};
type ModelList={plan:PlaylistPlan;songs:ProposedSong[];diversityExhausted:boolean;historyExhausted:boolean};
export type PlaylistProgress={type:'progress';stage:'planning'|'splitting'|'assembling';progress:number;resolved:number;requested:number;processed:number;total:number;elapsedMs:number};
type Progress=(event:PlaylistProgress)=>void;
const norm=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const baseTitle=(value:string)=>value.replace(/\s*\((?:[^)]*(?:remaster|version|edit|mono|stereo)[^)]*)\)\s*$/i,'').trim();
const transliteration:Record<string,string>={а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',ї:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ы:'y',э:'e',ю:'iu',я:'ia',ё:'io',ъ:''};
const artistIdentity=(value:string)=>norm(value).replace(/[а-яіїєґ]/g,char=>transliteration[char]??char).replace(/iu|yu/g,'u').replace(/ia|ya/g,'a').replace(/ie|ye/g,'e').replace(/[iy]/g,'i').replace(/h/g,'g');
const catalogArtistIdentity=(value:string)=>artistIdentity(catalogArtistNames(value)[0]??value);
const lookalikes:Record<string,string>={a:'а',c:'с',e:'е',i:'і',o:'о',p:'р',x:'х',y:'у',A:'А',C:'С',E:'Е',I:'І',O:'О',P:'Р',X:'Х',Y:'У'};
// Fix mixed-script typography only within a predominantly Cyrillic word.
// A Latin artist name or an English phrase stays intact.
const searchName=(value:string)=>value.replace(/[\p{L}\p{M}]+/gu,word=>{
 const cyrillic=(word.match(/[а-яіїєґё]/gi)??[]).length,latin=(word.match(/[a-z]/gi)??[]).length;
 return cyrillic&&cyrillic>=latin?word.replace(/[aceiopxy]/gi,char=>lookalikes[char]??char):word;
}).replace(/[‘’]/g,"'");
const latinSearchName=(value:string)=>searchName(value).replace(/[а-яіїєґёъь]/gi,char=>transliteration[char.toLowerCase()]??char);

function abortError(signal:AbortSignal){return signal.reason instanceof ApiError?signal.reason:new ApiError(499,'CANCELLED','Подбор отменён.');}
function check(signal:AbortSignal){if(signal.aborted)throw abortError(signal);}
/** Race even non-cancellable storage calls, while all remote fetches receive the
 * same signal. A slow provider cannot turn this operation into an endless loop. */
export function abortable<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted){operation.catch(()=>{});return Promise.reject(abortError(signal));}
 return new Promise((resolve,reject)=>{
  const aborted=()=>{signal.removeEventListener('abort',aborted);reject(abortError(signal));};signal.addEventListener('abort',aborted,{once:true});
  operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted)).catch(()=>{});
 });
}
async function delay(milliseconds:number,signal:AbortSignal){if(milliseconds<=0){check(signal);return;}await abortable(new Promise<void>(resolve=>setTimeout(resolve,milliseconds)),signal);}
async function digest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');}
async function cached<T>(id:string,signal:AbortSignal){
 const row=await abortable(database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id=?').bind(id).first<{track_data:string;updated_at:number}>(),signal);
 return row?{value:await abortable(readJson<T>(row.track_data),signal),at:row.updated_at}:null;
}
async function cache(id:string,value:unknown,signal:AbortSignal){
 check(signal);const serialized=await abortable(storeJson(id,value),signal);check(signal);
 await abortable(database().prepare('INSERT INTO echo_media_collections(id,track_data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at').bind(id,serialized,Date.now()).run(),signal);
}

export function playlistRequest(prompt:string,count:number,level:number,allowArtistRepeats:boolean,history:{artist:string;title:string}[]){
 const policy=difficultyPolicy(level),reserve=Math.min(40,count),total=Math.min(Number.MAX_SAFE_INTEGER,count+reserve);
 // Recent history is sent once, compactly. The full history is still checked
 // against resolved tracks below, including entries exceeding this token budget.
 const exclusions:string[]=[];let size=0;
 for(const song of history){const entry=song.artist+':'+song.title;if(size+entry.length>90000)break;exclusions.push(entry);size+=entry.length+1;}
 const string={type:'string'};
 const responseSchema={type:'object',properties:{plan:{type:'object',properties:{title:string,criteria:{type:'array',items:string},artists:{type:'array',items:string},genres:{type:'array',items:string},language:{anyOf:[string,{type:'null'}]},years:{anyOf:[{type:'object',properties:{from:{type:'integer'},to:{type:'integer'}},required:['from','to']},{type:'null'}]}},required:['title','criteria','artists','genres','language','years']},songs:{type:'array',items:{type:'object',properties:{artist:string,title:string},required:['artist','title']}},diversityExhausted:{type:'boolean'},historyExhausted:{type:'boolean'}},required:['plan','songs','diversityExhausted','historyExhausted']};
 return {purpose:'fast-playlist',limit:total,responseSchema,messages:[{role:'system',content:[
  'You are a careful music curator. Return only the JSON schema requested, in one response. Propose real existing original songs likely to have playable Deezer previews. Use their official Deezer artist and song names. Never invent titles or availability. Name only songs you confidently know from an actual single or album; never turn a description, guessed lyric, or approximate spelling into a song title. Prefer the artist/title spelling used in catalog releases.',
  'EVERY semantic condition in the user request is mandatory, simultaneously: mood, lyrical subject, genre, country/language, original-release era, artist restrictions and exclusions. Do not replace a narrow request with its broader genre. Romantic ballads must be ballads AND romantically themed love songs, not merely slow songs, sad songs, or tracks by ballad artists. A romantic playlist must never contain Highway to Hell.',
  'For Ukrainian hits/music use performers from the Ukrainian scene, never American or Russian-scene substitutes. Ukrainian artists singing in Russian or English can qualify unless Ukrainian-language lyrics are explicitly requested (українською, україномовні, in Ukrainian). Set plan.language=null when no sung language was explicitly requested. For an era use the original song release year, never a reissue year.',
  'plan.artists must contain ONLY artists explicitly requested by the user, not the performers you chose. plan.criteria must preserve every requested condition. Supported plan.genres: rock,classic-rock,indie-rock,pop-punk,synth-pop,alternative,pop,metal,hiphop,dance,rnb,punk,country,jazz; other styles belong in criteria, never replace them with an unrelated supported genre.',
  'When the user explicitly names one or several artists, ALL primary AND reserve songs must be ONLY by those requested artists. Never add another performer to fill a reserve count. For a finite requested artist set, reserves are DIFFERENT songs by those same artists; artist diversity applies only inside the permitted artist set, with repetitions allowed when needed and enabled.',
  'Artist diversity is mandatory: choose different performers whenever other qualifying performers exist at this difficulty, EVEN IF repeats are enabled. For a broad category supply one song per artist before any repeated artist. diversityExhausted may be true ONLY when the exact requested category/difficulty or explicitly named artists has fewer different qualifying performers than the requested count. Do not use this flag as a convenience. If repeats are disabled never repeat.',
  'For a broad category without explicitly named artists, primary AND reserve songs must be by DISTINCT performers whenever additional qualifying performers exist. Count the distinct artists before returning. In such a broad category do not fill reserves with another song by an already chosen artist: fewer confident reserve songs are better than repeated artists or invented titles. A genuinely narrow category may repeat ONLY after all its qualifying performers are included, ONLY when repeats are enabled and diversityExhausted=true. Repeats disabled means never repeat. Do not silently interpret Ukrainian as a short list of familiar bands; consider the whole relevant Ukrainian scene across bands, solo singers, dance/pop acts, duos and hip-hop where they match the request.',
  'Exclude already-played songs whenever there are unplayed qualifying alternatives. historyExhausted may be true ONLY if the exact category/difficulty has fewer qualifying unplayed songs than requested. Then list all qualifying unplayed songs first; already-played songs are a last resort. Never claim exhaustion just because remembering other songs is difficult.',
  'The primary list is exactly the requested count; append UP TO the specified number of equally suitable reserve songs from additional artists for unavailable previews. Accuracy of the primary list takes priority over filling the reserve count. Do not broaden criteria or loosen difficulty to reach a count. If not enough qualifying songs exist return only real qualifying songs, rather than fabricate or substitute. Each song needs ONLY artist and title. No per-song explanations, dates, scores or metadata.',
  policy.promptInstruction,
 ].join('\n')},{role:'user',content:`Составь подборку из ${count} песен на сложность ${level}/10 ${allowArtistRepeats?'с повторами исполнителей только если других подходящих исполнителей действительно нет':'без повторов исполнителей'}.\nЗапрос: ${JSON.stringify(prompt)}\nНе используй песни, по возможности: ${JSON.stringify(exclusions)}\nДобавь до ${reserve} уверенно известных резервных песен после основного списка. Если в запросе указаны конкретные исполнители, резервы тоже только их песни. Для общей категории выбирай других подходящих исполнителей, если они существуют. Не выдумывай записи ради количества резервов. Верни plan и список songs в формате artist:title (отдельные поля), без метаданных каждой песни. Все песни должны быть доступны на Deezer.`}]};
}

export function playlistRefillRequest(prompt:string,count:number,level:number,allowArtistRepeats:boolean,history:SongName[],context:{found:SongName[];attempted:SongName[];requested:number;round:number;strictDiversity:boolean}){
 const refill=playlistRequest(prompt,count,level,allowArtistRepeats,history);
 const excluded=new Map([...context.attempted,...context.found].map(song=>[songKey(song),song]));
 const compact=(names:string[],budget:number)=>{const chosen:string[]=[];let size=0;for(const name of names){if(size+name.length+4>budget)break;chosen.push(name);size+=name.length+4;}return chosen;};
 const budget=Math.max(0,110000-refill.messages[1].content.length);
 const usedArtists=compact([...new Set(context.found.map(song=>song.artist))],Math.min(8000,Math.floor(budget/3)));
 const excludedPairs=compact([...excluded.values()].map(song=>song.artist+':'+song.title),Math.min(24000,Math.floor(budget*2/3)));
 refill.messages[0].content+='\nThis is a continuation of the SAME playlist, not a fresh list. Already found artists and rejected pairs below are concrete catalog feedback. Never fabricate titles to avoid an exclusion. Keep every original era, mood, country, explicitly requested artist and difficulty condition.';
 if(context.strictDiversity)refill.messages[0].content+='\nReturning more songs by already found artists cannot fill missing distinct-artist slots. Search your music knowledge for OTHER qualifying performers and their actual released songs. For this continuation, do NOT include any artist in ALREADY FOUND ARTISTS. This prohibition applies even when repeats are enabled. If the exact category genuinely has no other qualifying performers, return songs=[] and diversityExhausted=true; do not claim this just because your first familiar artists have been excluded.';
 else refill.messages[0].content+='\nFor a request naming specific artists, fill the missing slots with DIFFERENT original songs by those permitted artists. Do not replace the requested performers with other artists. Already found artist names are context, not an exclusion, when repetitions are needed within the explicitly requested artist set.';
 refill.messages[1].content+=`\nПродолжение ${context.round}: уже найдено ${context.requested-count} из ${context.requested}. Нужны ТОЛЬКО ${count} недостающих песен. Не изменяй запрос и сложность.\nНЕ ИСПОЛЬЗУЙ уже найденные и не найденные на Deezer пары: ${JSON.stringify(excludedPairs)}\nALREADY FOUND ARTISTS: ${JSON.stringify(usedArtists)}. ${context.strictDiversity?'В этом дополнении запрещены эти исполнители, нужны другие.':'Если запрос задан по конкретным исполнителям, предложи другие песни только этих исполнителей. Иначе повторы возможны лишь после действительного исчерпания других подходящих исполнителей.'}\nНе возвращай тот же список повторно. Выбирай уверенно известные оригинальные названия реальных песен; никаких придуманных вариантов.`;
 return refill;
}

export function parsePlaylistResponse(text:string,prompt:string,_level:number,maxSongs:number):ModelList{
 let value:any;try{value=JSON.parse(text.trim().replace(/^```[^\n]*\n?|\n?```$/g,''));}catch{const songs=parseSongList(text,maxSongs);if(!songs.length)throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini вернул некорректный список песен.');value={songs};}
 // Exclusions stay in the full Gemini instruction/criteria. They must not be
 // reinterpreted as positive mood, country, language or decade requirements.
 const positive=prompt.replace(/(?:^|\s)(?:без|не|without|excluding|except|not|no)\s+[^,;.]+/gi,' ');
 const explicit=planFromPrompt(positive);let plan:PlaylistPlan;try{plan=validatePlan(value?.plan);}catch{plan=planFromPrompt(prompt);}
 // Deterministic, explicit years cannot be silently weakened by the model.
 if(explicit.years)plan.years=explicit.years;
 if(explicit.language)plan.language=explicit.language;
 else if(/укра[їи]н|ukrain/i.test(positive)&&/^(?:uk|ukr|ua|ukrainian|українська)$/i.test(plan.language??''))plan.language=null;
 plan.criteria=[...new Set([...planFromPrompt(prompt).criteria,...plan.criteria])].slice(0,16);
 // A model-selected performer is not an explicit artist restriction. The
 // prompt parser protects artist-only games from generic one-artist lists.
 if(!explicit.artists.length)plan.artists=plan.artists.filter(name=>norm(prompt).includes(norm(name))||artistIdentity(prompt).includes(artistIdentity(name)));
 else if(!plan.artists.length)plan.artists=explicit.artists;
 const rows=Array.isArray(value)?value:value.songs??value.tracks;
 if(!Array.isArray(rows))throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini не сформировал список реальных песен.');
 // Gemini owns the semantic choice. Splitting only cleans artist:title pairs;
 // it does not re-grade moods, release years or popularity with more requests.
 const songs=parseSongList(JSON.stringify(rows),Math.max(maxSongs,rows.length)).filter(song=>!plan.artists.length||plan.artists.some(artist=>catalogArtistIdentity(artist)===catalogArtistIdentity(song.artist)));
 if(rows.length&&!songs.length)throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini вернул некорректный список песен.');
 return {plan,songs,diversityExhausted:value.diversityExhausted===true,historyExhausted:value.historyExhausted===true};
}

async function catalogJson(path:string,signal:AbortSignal,pace:()=>Promise<void>){
 await pace();check(signal);
 const combined=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
 let response:Response;try{response=await abortable(fetch('https://api.deezer.com'+path,{headers:{Accept:'application/json'},signal:combined}),combined);}catch(error){check(signal);if(error instanceof ApiError&&error.code==='CANCELLED')throw new ApiError(504,'MUSIC_TIMEOUT','Deezer не ответил вовремя.');throw error;}
 if(!response.ok)throw new ApiError(response.status===429?429:502,response.status===429?'MUSIC_RATE_LIMIT':'MUSIC_PROVIDER_ERROR','Deezer временно не смог выполнить поиск.');
 let value:any;try{value=await abortable(response.json(),combined);}catch(error){check(signal);if(combined.aborted)throw new ApiError(504,'MUSIC_TIMEOUT','Deezer не ответил вовремя.');throw new ApiError(502,'MUSIC_INVALID_RESPONSE','Deezer вернул некорректный ответ.');}check(signal);
 if(!value||typeof value!=='object'||value.error)throw new ApiError(value?.error?.code===4?429:502,value?.error?.code===4?'MUSIC_RATE_LIMIT':'MUSIC_PROVIDER_ERROR','Deezer не смог предоставить записи.');
 return value;
}
function playableRecord(record:any){
 if(!Number.isSafeInteger(record?.id)||record.id<=0||!Number.isSafeInteger(record.artist?.id)||record.artist.id<=0||record.readable===false||typeof record.artist.name!=='string'||typeof record.title!=='string'||!record.title.trim())return false;
 try{const url=new URL(record.preview);return url.protocol==='https:'&&/(^|\.)dzcdn\.net$/.test(url.hostname)&&url.pathname.endsWith('.mp3');}catch{return false;}
}
async function resolveSong(song:ProposedSong,plan:PlaylistPlan,signal:AbortSignal,pace:()=>Promise<void>):Promise<ResolvedSong|null>{
 const key='ai-fast-track-v1:'+await digest([norm(song.artist),norm(song.title)]);
 const saved=await cached<Track&{catalogArtistId:number}>(key,signal);let track=saved&&saved.at>Date.now()-21600000?saved.value:null;
 if(!track){
  // Deezer currently returns empty lists for the legacy artist:/track: search
  // syntax. Ordinary search resolves the pair; strict identity checks below
  // prevent similarly titled songs or covers from entering the collection.
  const artist=catalogArtistNames(song.artist)[0]??song.artist,title=searchName(song.title);
  const query=searchName(artist)+' '+title;
  const identityMatches=(records:any[])=>records.filter((record:any)=>playableRecord(record)&&catalogArtistIdentity(record.artist.name)===catalogArtistIdentity(song.artist)&&[record.title_short,record.title].some(name=>typeof name==='string'&&artistIdentity(baseTitle(searchName(name)))===artistIdentity(baseTitle(title)))).sort((a:any,b:any)=>(b.rank??0)-(a.rank??0));
  const result=await catalogJson('/search?q='+encodeURIComponent(query)+'&limit=15&order=RANKING',signal,pace);
  let matches=identityMatches(result.data??[]);
  // Catalog artist spelling can be Latin while the user's song is Cyrillic.
  // A single title-only fallback still requires BOTH identities to match; it
  // cannot substitute a cover or a different song. Same lookup queue.
  if(!matches.length){const fallback=await catalogJson('/search?q='+encodeURIComponent(title)+'&limit=30&order=RANKING',signal,pace);matches=identityMatches(fallback.data??[]);}
  // Ukrainian releases are also indexed under Latin catalog titles. This
  // fallback still resolves the exact artist/title pair, never a substitute.
  const latin=latinSearchName(artist)+' '+latinSearchName(title);
  if(!matches.length&&latin!==query){const fallback=await catalogJson('/search?q='+encodeURIComponent(latin)+'&limit=20&order=RANKING',signal,pace);matches=identityMatches(fallback.data??[]);}
  if(!matches.length)return null;
  track={...recordingTrack(matches[0],'AI'),catalogArtistId:matches[0].artist.id,...(norm(song.artist)!==norm(matches[0].artist.name)?{artistAliases:[song.artist]}:{})};
  if(norm(track.title)!==norm(song.title))track.titleAliases=[...new Set([...(track.titleAliases??[]),song.title])];
  await cache(key,track,signal);
  await cache('deezer-discovered-artist:'+track.catalogArtistId,matches[0].artist,signal);
 }
 if(!track.providerId||!track.catalogArtistId||!track.audioUrl)return null;
 return {...track,genres:plan.genres.length?plan.genres:['AI']};
}

async function performFastPlaylist(owner:string,payload:Record<string,unknown>,options:DeckOptions,signal:AbortSignal,onProgress:Progress){
 const started=Date.now(),count=options.count??50,level=difficultyLevel(options.difficulty),allowArtistRepeats=options.allowArtistRepeats??true;let prompt=validatePrompt(payload.prompt);
 const existingId=payload.collectionId;
 if(existingId!==undefined&&(typeof existingId!=='string'||!/^custom-[a-f0-9-]{36}$/.test(existingId)))throw new ApiError(400,'AI_INVALID_REQUEST','Неверная подборка.');
 if(existingId){const row=await abortable(database().prepare('SELECT recipe FROM echo_collections WHERE id=? AND user_id=?').bind(existingId,owner).first<{recipe:string}>(),signal);if(!row)throw new ApiError(404,'COLLECTION_NOT_FOUND','Подборка не найдена.');let recipe:any;try{recipe=JSON.parse(row.recipe);}catch{}if(!recipe?.ai)throw new ApiError(400,'AI_INVALID_REQUEST','Это не подборка ИИ.');prompt=validatePrompt(recipe.prompt);}
 let greatestProgress=0;
 const report=(stage:PlaylistProgress['stage'],progress:number,resolved=0,processed=0,total=0)=>{check(signal);greatestProgress=Math.max(greatestProgress,progress);onProgress({type:'progress',stage,progress:greatestProgress,resolved:Math.min(count,resolved),requested:count,processed,total,elapsedMs:Date.now()-started});};
 report('planning',3);
 const history=await abortable(getPlayedSongs(owner,prompt,signal),signal),played=new Set(history.map(songKey));
 const request=playlistRequest(prompt,count,level,allowArtistRepeats,history);
 const response=await abortable(geminiCompletion(owner,request,signal),signal);check(signal);
 report('splitting',28);
 const proposed=parsePlaylistResponse(response.text,prompt,level,request.limit);
 const results:ResolvedSong[]=[],unmatched:SongName[]=[],attempted=new Map<string,SongName>(),order=new Map<string,number>();
 const repeatsPermitted=()=>allowArtistRepeats&&(proposed.diversityExhausted||proposed.plan.artists.length>0&&proposed.plan.artists.length<count);
 const choose=()=>{
  const unplayed=results.filter(track=>!played.has(songKey(track))),old=results.filter(track=>played.has(songKey(track)));
  const selected:ResolvedSong[]=[],seenArtists=new Set<string>();
  // Keep every different performer before any repeat. No second popularity or
  // semantic grading: Gemini already chose difficulty and the exact category.
  for(const track of unplayed){const artist=playlistArtistKey(track);if(seenArtists.has(artist))continue;selected.push(track);seenArtists.add(artist);if(selected.length===count)break;}
  if(selected.length<count&&proposed.historyExhausted){
   for(const track of old){if(selected.length===count)break;if(seenArtists.has(playlistArtistKey(track)))continue;selected.push(track);seenArtists.add(playlistArtistKey(track));}
  }
  if(repeatsPermitted()&&selected.length<count){
   for(const track of [...unplayed,...(proposed.historyExhausted?old:[])]){if(selected.length===count)break;if(selected.some(t=>t.providerId===track.providerId))continue;selected.push(track);}
  }
  return selected;
 };
 const enoughFreshSongs=()=>{
  const fresh=results.filter(track=>!played.has(songKey(track))),distinct=new Set(fresh.map(playlistArtistKey)).size;
  // A generic exhaustion flag must not stop queued different performers.
  // Named finite artist requests may stop once all named artists and N songs
  // are represented; broad/niche categories try every candidate for diversity.
  return fresh.length>=count&&distinct>=Math.min(count,proposed.plan.artists.length||count);
 };
 let processed=0,total=0,nextLookup=Date.now(),providerFailure:ApiError|undefined;
 const pace=async()=>{const slot=Math.max(Date.now(),nextLookup);nextLookup=slot+LOOKUP_INTERVAL_MS;await delay(slot-Date.now(),signal);};
 const lookupBatch=async(songs:ProposedSong[])=>{
  const candidates=songs.filter(song=>!attempted.has(songKey(song))&&(!played.has(songKey(song))||proposed.historyExhausted)&&(!proposed.plan.artists.length||proposed.plan.artists.some(artist=>catalogArtistIdentity(artist)===catalogArtistIdentity(song.artist))));
  let cursor=0;total+=candidates.length;report('assembling',30,choose().length,processed,total);
  await abortable(Promise.all(Array.from({length:Math.min(PARALLEL_LOOKUPS,candidates.length)},async()=>{
   while(cursor<candidates.length&&!enoughFreshSongs()){check(signal);const index=cursor++,song=candidates[index],identity=songKey(song);attempted.set(identity,song);const position=order.size;order.set(identity,position);
    try{
     const track=await resolveSong(song,proposed.plan,signal,pace);
     if(!track&&unmatched.length<5)unmatched.push(song);
     if(track&&(!played.has(songKey(track))||proposed.historyExhausted)&&!results.some(existing=>existing.providerId===track.providerId||songKey(existing)===songKey(track))){order.set(songKey(track),position);results.push(track);results.sort((a,b)=>(order.get(songKey(a))??0)-(order.get(songKey(b))??0));}
    }catch(error){check(signal);if(error instanceof ApiError){if(error.code==='MUSIC_RATE_LIMIT')throw error;providerFailure??=error;}else throw error;}
    processed++;report('assembling',30+Math.floor(58*processed/Math.max(1,total)),choose().length,processed,total);
   }
  })),signal);
  return candidates.length;
 };
 await lookupBatch(proposed.songs);
 let selected=choose(),refills=0,noProgressRefills=0;
 // Keep filling just the missing slots while real progress is made. There is
 // no global time or refill-count cap; cancellation still stops every I/O.
 // Two wholly ineffective continuations stop a repeated/hallucinated list.
 for(;selected.length<count&&noProgressRefills<2&&proposed.songs.length;){
  refills++;
  report('assembling',89,selected.length,processed,total);
  const previousCount=selected.length;
  const strictDiversity=!proposed.plan.artists.length&&!repeatsPermitted();
  const refill=playlistRefillRequest(prompt,count-selected.length,level,allowArtistRepeats,history,{found:results,attempted:[...attempted.values()],requested:count,round:refills,strictDiversity});
  const additional=await abortable(geminiCompletion(owner,refill,signal),signal);check(signal);
  const parsed=parsePlaylistResponse(additional.text,prompt,level,refill.limit);
  proposed.historyExhausted||=parsed.historyExhausted;proposed.diversityExhausted||=parsed.diversityExhausted;
  // Avoid catalog calls for artists that cannot add a new slot. Canonical
  // aliases on found tracks cover the model's Cyrillic/Latin artist spelling.
  const knownArtists=new Set(results.flatMap(track=>[track.artist,...(track.artistAliases??[])]).map(catalogArtistIdentity));
  const candidates=strictDiversity&&(!parsed.diversityExhausted||!allowArtistRepeats)?parsed.songs.filter(song=>!knownArtists.has(catalogArtistIdentity(song.artist))):parsed.songs;
  await lookupBatch(candidates);selected=choose();
  noProgressRefills=selected.length>previousCount?0:noProgressRefills+1;
 }
 const distinct=new Set(results.map(playlistArtistKey)).size;
 if(selected.length!==count){console.warn('ECHO playlist incomplete',{requested:count,eligible:total,processed,resolved:results.length,distinct,refills,providerError:providerFailure?.code,unmatched});throw new ApiError(409,'AI_SEARCH_INCOMPLETE','В списке Gemini недостаточно доступных записей Deezer для выбранной длины. Повторите запрос или выберите меньше песен.',{available:selected.length,required:count,availableArtists:distinct,providerError:providerFailure?.code});}
 check(signal);report('assembling',96,count,processed,total);
 const id=typeof existingId==='string'?existingId:'custom-'+crypto.randomUUID();
 const recipe={ai:true,version:2,prompt,plan:proposed.plan,difficulty:level,allowArtistRepeats,model:response.model,generatedAt:Date.now(),difficultyPolicy:difficultyPolicy(level),classificationSource:'gemini',catalogRefills:refills};
 const result=await abortable(persistCollection(owner,proposed.plan.title,proposed.plan.criteria.join(' · ').slice(0,250),spreadArtists(selected),'local-ai',id,recipe,!!existingId),signal);
 check(signal);return result;
}

export async function generateFastPlaylist(owner:string,payload:Record<string,unknown>,options:DeckOptions,signal:AbortSignal,onProgress:Progress=()=>{}){
 const work=new AbortController(),combined=AbortSignal.any([signal,work.signal]);
 try{return await performFastPlaylist(owner,payload,options,combined,onProgress);}
 finally{work.abort(new ApiError(499,'CANCELLED','Подбор завершён.'));}
}

export function playlistStream(owner:string,payload:Record<string,unknown>,options:DeckOptions,incomingSignal:AbortSignal){
 const controller=new AbortController();
 const disconnected=()=>controller.abort(new ApiError(499,'CANCELLED','Подбор отменён.'));
 if(incomingSignal.aborted)disconnected();else incomingSignal.addEventListener('abort',disconnected,{once:true});
 const encoder=new TextEncoder();let closed=false;
 const stream=new ReadableStream<Uint8Array>({
  async start(output){
   const send=(event:unknown)=>{if(!closed)output.enqueue(encoder.encode(JSON.stringify(event)+'\n'));};
   try{const result=await generateFastPlaylist(owner,payload,options,controller.signal,send);send({type:'done',result});}
   catch(error){const failure=controller.signal.aborted?abortError(controller.signal):error instanceof ApiError?error:new ApiError(500,'SERVER_ERROR','Не удалось составить подборку. Повторите запрос.');send({type:'error',error:failure.code,message:failure.message,...failure.extra});}
   finally{incomingSignal.removeEventListener('abort',disconnected);if(!closed){closed=true;output.close();}}
  },
  cancel(){closed=true;incomingSignal.removeEventListener('abort',disconnected);disconnected();},
 });
 return new Response(stream,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}

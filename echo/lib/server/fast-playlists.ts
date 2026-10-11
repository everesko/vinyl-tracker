import {difficultyLevel, type Track} from '@/lib/quiz';
import {difficultyPolicy, recognitionMatchesDifficulty, selectDifficultyTracks, playlistArtistKey} from '@/lib/playlist-difficulty';
import {planFromPrompt, songKey} from '@/lib/playlist-list';
import {validatePlan, type PlaylistPlan} from '@/lib/playlist-plan';
import {spreadArtists} from '@/lib/track-order';
import {ApiError, database} from './http';
import {geminiCompletion} from './gemini';
import {getPlayedSongs} from './playlist-history';
import {persistCollection, validatePrompt} from './collections';
import {eligibleRecording, recordingTrack, type DeckOptions} from './popular';
import {readJson, storeJson} from './stored-json';

export const PLAYLIST_DEADLINE_MS=29000;
const PARALLEL_LOOKUPS=6;
const LOOKUP_INTERVAL_MS=125;
type ProposedSong={artist:string;title:string;year:number;recognition:number;fit:string;language:string};
type ResolvedSong=Track&{catalogArtistId:number;recognition:number;selectionReason:string};
type ModelList={plan:PlaylistPlan;songs:ProposedSong[];diversityExhausted:boolean;historyExhausted:boolean};
export type PlaylistProgress={type:'progress';stage:'planning'|'resolving'|'validating'|'saving';progress:number;resolved:number;requested:number;processed:number;total:number;elapsedMs:number};
type Progress=(event:PlaylistProgress)=>void;
const norm=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const baseTitle=(value:string)=>value.replace(/\s*\((?:[^)]*(?:remaster|version|edit|mono|stereo)[^)]*)\)\s*$/i,'').trim();
const romantic=/романт|romanti|кохан|любов|love\s+(?:songs?|ballads?)/i;
const romanticFit=/romanti|love|loving|affection|devotion|beloved|tender|романт|любов|кохан|ніжн|нежн|amour/i;
const ballad=/ballad|бал+ад/i;
const transliteration:Record<string,string>={а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',ї:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ы:'y',э:'e',ю:'iu',я:'ia',ё:'io',ъ:''};
const artistIdentity=(value:string)=>norm(value).replace(/[а-яіїєґ]/g,char=>transliteration[char]??char).replace(/iu|yu/g,'u').replace(/ia|ya/g,'a').replace(/ie|ye/g,'e').replace(/[iy]/g,'i').replace(/h/g,'g');
const languageIdentity=(value:string)=>/^(?:uk|ukr|ua|ukrainian|українська|украинский|украинская)$/i.test(value.trim())?'Ukrainian':/^(?:en|eng|english|англійська|английский|английская)$/i.test(value.trim())?'English':value;

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
 const responseSchema={type:'object',properties:{plan:{type:'object',properties:{title:string,criteria:{type:'array',items:string},artists:{type:'array',items:string},genres:{type:'array',items:string},language:{anyOf:[string,{type:'null'}]},years:{anyOf:[{type:'object',properties:{from:{type:'integer'},to:{type:'integer'}},required:['from','to']},{type:'null'}]}},required:['title','criteria','artists','genres','language','years']},songs:{type:'array',items:{type:'object',properties:{artist:string,title:string,year:{type:'integer'},recognition:{type:'integer'},fit:string,language:string},required:['artist','title','year','recognition','fit','language']}},diversityExhausted:{type:'boolean'},historyExhausted:{type:'boolean'}},required:['plan','songs','diversityExhausted','historyExhausted']};
 return {purpose:'fast-playlist',limit:total,responseSchema,messages:[{role:'system',content:[
  'You are a careful music curator. Return only the JSON schema requested, in one response. Propose real existing original songs likely to have playable Deezer previews. Use their official Deezer artist and song names. Never invent titles or availability.',
  'EVERY semantic condition in the user request is mandatory, simultaneously: mood, lyrical subject, genre, country/language, original-release era, artist restrictions and exclusions. Do not replace a narrow request with its broader genre. Romantic ballads must be ballads AND romantically themed love songs, not merely slow songs, sad songs, or tracks by ballad artists. A romantic playlist must never contain Highway to Hell.',
  'For Ukrainian hits/music use performers from the Ukrainian scene, never American or Russian-scene substitutes. The country/scene and sung language are different constraints: Ukrainian artists singing in Russian or English can qualify for Ukrainian hits, unless the user explicitly asks for Ukrainian-language lyrics (українською, україномовні, in Ukrainian). Include Ukrainian origin/scene in fit. Set plan.language=null when no sung language was explicitly requested. For an era use the original song release year, never a compilation/reissue/remaster year. In fit, explicitly explain BOTH the requested mood/subject AND musical form (for romantic ballads say romantic/love AND ballad), as well as other explicit criteria. State its sung language.',
  'plan.artists must contain ONLY artists explicitly requested by the user, not the performers you chose. plan.criteria must preserve every requested condition. Supported plan.genres: rock,classic-rock,indie-rock,pop-punk,synth-pop,alternative,pop,metal,hiphop,dance,rnb,punk,country,jazz; other styles belong in criteria, never replace them with an unrelated supported genre.',
  'Artist diversity is mandatory: choose different performers whenever other qualifying performers exist at this difficulty, EVEN IF repeats are enabled. For a broad category supply one song per artist before any repeated artist. diversityExhausted may be true ONLY when the exact requested category/difficulty or explicitly named artists has fewer different qualifying performers than the requested count. Do not use this flag as a convenience. If repeats are disabled never repeat.',
  'For an unrestricted category, ALL primary AND reserve songs must be by DISTINCT performers. A reserve by an already listed performer cannot replace an unavailable artist in a no-repeat quiz and is therefore useless. Count the distinct artists before returning. Only explicitly requested named-artist collections may use repeated performers. Do not silently interpret Ukrainian as a short list of familiar bands; consider the whole relevant Ukrainian scene.',
  'Exclude already-played songs whenever there are unplayed qualifying alternatives. historyExhausted may be true ONLY if the exact category/difficulty has fewer qualifying unplayed songs than requested. Then list all qualifying unplayed songs first; already-played songs are a last resort. Never claim exhaustion just because remembering other songs is difficult.',
  'The primary list is exactly the requested count; append the specified number of equally suitable reserve songs from additional artists for unavailable previews. Do not broaden criteria or loosen difficulty to reach a count. If not enough qualifying songs exist return only real qualifying songs, rather than fabricate or substitute.',
  policy.promptInstruction,
  'recognition is song recognizability 1..10 within this exact category, language and era, not artist fame. Check it against the specified band. Keep fit under 100 characters to minimize tokens.',
 ].join('\n')},{role:'user',content:`Составь подборку из ${count} песен на сложность ${level}/10 ${allowArtistRepeats?'с повторами исполнителей только если других подходящих исполнителей действительно нет':'без повторов исполнителей'}.\nЗапрос: ${JSON.stringify(prompt)}\nНе используй песни, по возможности: ${JSON.stringify(exclusions)}\nДобавь ${reserve} резервных песен после основного списка. Верни plan и список songs с artist:title (отдельные поля), original year в year, recognition ${policy.minRecognition}–${policy.maxRecognition}/10, fit и language.`}]};
}

export function parsePlaylistResponse(text:string,prompt:string,level:number,maxSongs:number):ModelList{
 let value:any;try{value=JSON.parse(text);}catch{throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini вернул некорректный список песен.');}
 // Exclusions stay in the full Gemini instruction/criteria. They must not be
 // reinterpreted as positive mood, country, language or decade requirements.
 const positive=prompt.replace(/(?:^|\s)(?:без|не|without|excluding|except|not|no)\s+[^,;.]+/gi,' ');
 const plan=validatePlan(value?.plan),explicit=planFromPrompt(positive);
 // Deterministic, explicit years cannot be silently weakened by the model.
 if(explicit.years)plan.years=explicit.years;
 if(explicit.language)plan.language=explicit.language;
 else if(/укра[їи]н|ukrain/i.test(positive)&&/^(?:uk|ukr|ua|ukrainian|українська)$/i.test(plan.language??''))plan.language=null;
 plan.criteria=[...new Set([...planFromPrompt(prompt).criteria,...plan.criteria])].slice(0,16);
 // A model-selected performer is not an explicit artist restriction. The
 // prompt parser protects artist-only games from generic one-artist lists.
 if(!explicit.artists.length)plan.artists=plan.artists.filter(name=>norm(prompt).includes(norm(name))||artistIdentity(prompt).includes(artistIdentity(name)));
 else if(!plan.artists.length)plan.artists=explicit.artists;
 if(!Array.isArray(value.songs)||value.songs.length>maxSongs||typeof value.diversityExhausted!=='boolean'||typeof value.historyExhausted!=='boolean')throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini не сформировал список реальных песен.');
 const seen=new Set<string>();
 const songs=value.songs.filter((song:any):song is ProposedSong=>{
  if(!song||typeof song.artist!=='string'||!song.artist.trim()||song.artist.length>150||typeof song.title!=='string'||!song.title.trim()||song.title.length>200||!Number.isInteger(song.year)||song.year<1900||song.year>new Date().getUTCFullYear()+1||!Number.isInteger(song.recognition)||!recognitionMatchesDifficulty(song.recognition,level)||typeof song.fit!=='string'||song.fit.trim().length<8||song.fit.length>200||typeof song.language!=='string'||song.language.length>80)return false;
  if(plan.years&&(song.year<plan.years.from||song.year>plan.years.to))return false;
  if(plan.artists.length&&!plan.artists.some(artist=>artistIdentity(artist)===artistIdentity(song.artist)))return false;
  if(romantic.test(positive)&&!romanticFit.test(song.fit))return false;
  if(ballad.test(positive)&&!ballad.test(song.fit))return false;
  if(romantic.test(positive)&&norm(song.title)==='highwaytohell')return false;
  if(/укра[їи]н|ukrain/i.test(positive)&&!/ukrain|укра[їи]н/i.test(song.fit))return false;
  if(plan.language==='Ukrainian'&&languageIdentity(song.language)!=='Ukrainian'&&!/ukrain|укра[їи]н/i.test(song.language))return false;
  if(plan.language==='English'&&languageIdentity(song.language)!=='English'&&!/english|англ/i.test(song.language))return false;
  const key=songKey(song);if(seen.has(key))return false;seen.add(key);return true;
 });
 return {plan,songs,diversityExhausted:value.diversityExhausted,historyExhausted:value.historyExhausted};
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
async function resolveSong(song:ProposedSong,plan:PlaylistPlan,signal:AbortSignal,pace:()=>Promise<void>):Promise<ResolvedSong|null>{
 const key='ai-fast-track-v1:'+await digest([norm(song.artist),norm(song.title)]);
 const saved=await cached<Track&{catalogArtistId:number}>(key,signal);let track=saved&&saved.at>Date.now()-21600000?saved.value:null;
 if(!track){
  // Deezer currently returns empty lists for the legacy artist:/track: search
  // syntax. Ordinary search resolves the pair; strict identity checks below
  // prevent similarly titled songs or covers from entering the collection.
  const query=(song.artist+' '+song.title).replace(/[‘’]/g,"'");
  const identityMatches=(records:any[])=>records.filter((record:any)=>eligibleRecording(record)&&artistIdentity(record.artist.name)===artistIdentity(song.artist)&&artistIdentity(baseTitle(record.title_short||record.title))===artistIdentity(baseTitle(song.title))).sort((a:any,b:any)=>(b.rank??0)-(a.rank??0));
  const result=await catalogJson('/search?q='+encodeURIComponent(query)+'&limit=15&order=RANKING',signal,pace);
  let matches=identityMatches(result.data??[]);
  // Catalog artist spelling can be Latin while the user's song is Cyrillic.
  // A single title-only fallback still requires BOTH identities to match; it
  // cannot substitute a cover or a different song. Same queue and deadline.
  if(!matches.length){const fallback=await catalogJson('/search?q='+encodeURIComponent(song.title)+'&limit=30&order=RANKING',signal,pace);matches=identityMatches(fallback.data??[]);}
  if(!matches.length)return null;
  track={...recordingTrack(matches[0],'AI'),catalogArtistId:matches[0].artist.id,...(norm(song.artist)!==norm(matches[0].artist.name)?{artistAliases:[song.artist]}:{})};
  if(norm(track.title)!==norm(song.title))track.titleAliases=[...new Set([...(track.titleAliases??[]),song.title])];
  await cache(key,track,signal);
  await cache('deezer-discovered-artist:'+track.catalogArtistId,matches[0].artist,signal);
 }
 if(!track.providerId||!track.catalogArtistId||!track.audioUrl)return null;
 let year=song.year;
 if(plan.years){
  // Existing independent original-release proofs are authoritative. Fresh
  // curation does not repeat slow multi-provider crawls during this 30s request.
  const original=await cached<{year:number|null;status?:string;sources?:{url:string;year:number}[]}>('original-year-v10:'+track.providerId,signal);
  if(original?.value.status==='conflict'||original?.value.status==='identity-mismatch')return null;
  if(original?.value.year){year=original.value.year;if(year<plan.years.from||year>plan.years.to)return null;track={...track,dateSources:original.value.sources};}
 }
 return {...track,year,genres:plan.genres.length?plan.genres:['AI'],recognition:song.recognition,selectionReason:song.fit};
}

async function performFastPlaylist(owner:string,payload:Record<string,unknown>,options:DeckOptions,signal:AbortSignal,onProgress:Progress){
 const started=Date.now(),count=options.count??50,level=difficultyLevel(options.difficulty),allowArtistRepeats=options.allowArtistRepeats??true;let prompt=validatePrompt(payload.prompt);
 const existingId=payload.collectionId;
 if(existingId!==undefined&&(typeof existingId!=='string'||!/^custom-[a-f0-9-]{36}$/.test(existingId)))throw new ApiError(400,'AI_INVALID_REQUEST','Неверная подборка.');
 if(existingId){const row=await abortable(database().prepare('SELECT recipe FROM echo_collections WHERE id=? AND user_id=?').bind(existingId,owner).first<{recipe:string}>(),signal);if(!row)throw new ApiError(404,'COLLECTION_NOT_FOUND','Подборка не найдена.');let recipe:any;try{recipe=JSON.parse(row.recipe);}catch{}if(!recipe?.ai)throw new ApiError(400,'AI_INVALID_REQUEST','Это не подборка ИИ.');prompt=validatePrompt(recipe.prompt);}
 const report=(stage:PlaylistProgress['stage'],progress:number,resolved=0,processed=0,total=0)=>{check(signal);onProgress({type:'progress',stage,progress,resolved,requested:count,processed,total,elapsedMs:Date.now()-started});};
 report('planning',3);
 const history=await abortable(getPlayedSongs(owner,prompt,signal),signal),played=new Set(history.map(songKey));
 const request=playlistRequest(prompt,count,level,allowArtistRepeats,history);
 const response=await abortable(geminiCompletion(owner,request,signal),signal);check(signal);
 const proposed=parsePlaylistResponse(response.text,prompt,level,request.limit);
 const candidates=proposed.songs.filter(song=>!played.has(songKey(song))||proposed.historyExhausted),results:ResolvedSong[]=[],unmatched:{artist:string;title:string}[]=[];
 report('resolving',30,0,0,candidates.length);
 let cursor=0,processed=0,nextLookup=Date.now(),providerFailure:ApiError|undefined;
 const pace=async()=>{const slot=Math.max(Date.now(),nextLookup);nextLookup=slot+LOOKUP_INTERVAL_MS;await delay(slot-Date.now(),signal);};
 await abortable(Promise.all(Array.from({length:Math.min(PARALLEL_LOOKUPS,candidates.length)},async()=>{
  while(cursor<candidates.length){check(signal);const index=cursor++,song=candidates[index];
   try{const track=await resolveSong(song,proposed.plan,signal,pace);if(!track&&unmatched.length<5)unmatched.push({artist:song.artist,title:song.title});if(track&&(!played.has(songKey(track))||proposed.historyExhausted)&&!results.some(existing=>existing.providerId===track.providerId||songKey(existing)===songKey(track)))results.push(track);}
   catch(error){check(signal);if(error instanceof ApiError){if(error.code==='MUSIC_RATE_LIMIT')throw error;providerFailure??=error;}else throw error;}
   processed++;report('resolving',30+Math.floor(58*processed/Math.max(1,candidates.length)),results.length,processed,candidates.length);
  }
 })),signal);
 report('validating',91,results.length,processed,candidates.length);
 const distinct=new Set(results.map(playlistArtistKey)).size;
 // Broad categories contain many performers. A model's convenience claim is
 // not proof that all other performers have disappeared from those categories.
 const repeatsPermitted=allowArtistRepeats&&proposed.diversityExhausted&&proposed.plan.artists.length>0&&proposed.plan.artists.length<count;
 const unplayed=results.filter(track=>!played.has(songKey(track))),old=results.filter(track=>played.has(songKey(track)));
 const selected=selectDifficultyTracks(unplayed,count,level,{allowArtistRepeats:false});
 if(selected.length<count&&proposed.historyExhausted){
  // Preserve every qualifying fresh choice first. Old tracks from new artists
  // precede any repeated performer, even when the old history must be reused.
  const seenArtists=new Set(selected.map(playlistArtistKey));
  const ordered=selectDifficultyTracks(old,old.length,level,{allowArtistRepeats:true});
  for(const track of ordered){if(selected.length===count)break;if(seenArtists.has(playlistArtistKey(track)))continue;selected.push(track);seenArtists.add(playlistArtistKey(track));}
 }
 if(repeatsPermitted&&selected.length<count){
  const remaining=[...selectDifficultyTracks(unplayed,unplayed.length,level,{allowArtistRepeats:true}),...(proposed.historyExhausted?selectDifficultyTracks(old,old.length,level,{allowArtistRepeats:true}):[])];
  for(const track of remaining){if(selected.length===count)break;if(selected.some(t=>t.providerId===track.providerId))continue;selected.push(track);}
 }
 if(selected.length!==count){console.warn('ECHO playlist incomplete',{requested:count,eligible:proposed.songs.length,processed,resolved:results.length,distinct,providerError:providerFailure?.code,unmatched});throw new ApiError(409,'AI_SEARCH_INCOMPLETE','Не удалось найти полную подборку с выбранными условиями за один поиск. Уточните запрос или повторите поиск.',{available:selected.length,required:count,availableArtists:distinct,providerError:providerFailure?.code});}
 check(signal);report('saving',96,count,processed,candidates.length);
 const id=typeof existingId==='string'?existingId:'custom-'+crypto.randomUUID();
 const recipe={ai:true,version:2,prompt,plan:proposed.plan,difficulty:level,allowArtistRepeats,model:response.model,generatedAt:Date.now(),difficultyPolicy:difficultyPolicy(level),classificationSource:'gemini'};
 const result=await abortable(persistCollection(owner,proposed.plan.title,proposed.plan.criteria.join(' · ').slice(0,250),spreadArtists(selected),'local-ai',id,recipe,!!existingId),signal);
 check(signal);return result;
}

export async function generateFastPlaylist(owner:string,payload:Record<string,unknown>,options:DeckOptions,signal:AbortSignal,onProgress:Progress=()=>{}){
 const work=new AbortController(),combined=AbortSignal.any([signal,work.signal]);
 try{return await performFastPlaylist(owner,payload,options,combined,onProgress);}
 finally{work.abort(new ApiError(499,'CANCELLED','Подбор завершён.'));}
}

export function playlistStream(owner:string,payload:Record<string,unknown>,options:DeckOptions,incomingSignal:AbortSignal){
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(new ApiError(504,'AI_DEADLINE','Подборка не завершена за 30 секунд. Повторите запрос или уточните условия.')),PLAYLIST_DEADLINE_MS);
 const disconnected=()=>controller.abort(new ApiError(499,'CANCELLED','Подбор отменён.'));
 if(incomingSignal.aborted)disconnected();else incomingSignal.addEventListener('abort',disconnected,{once:true});
 const encoder=new TextEncoder();let closed=false;
 const stream=new ReadableStream<Uint8Array>({
  async start(output){
   const send=(event:unknown)=>{if(!closed)output.enqueue(encoder.encode(JSON.stringify(event)+'\n'));};
   try{const result=await generateFastPlaylist(owner,payload,options,controller.signal,send);send({type:'done',result});}
   catch(error){const failure=controller.signal.aborted?abortError(controller.signal):error instanceof ApiError?error:new ApiError(500,'SERVER_ERROR','Не удалось составить подборку. Повторите запрос.');send({type:'error',error:failure.code,message:failure.message,...failure.extra});}
   finally{clearTimeout(deadline);incomingSignal.removeEventListener('abort',disconnected);if(!closed){closed=true;output.close();}}
  },
  cancel(){closed=true;clearTimeout(deadline);incomingSignal.removeEventListener('abort',disconnected);disconnected();},
 });
 return new Response(stream,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}

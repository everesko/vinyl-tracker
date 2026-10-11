import {difficultyLevel,type Difficulty,type Track} from '@/lib/quiz';
import {ApiError,database} from './http';
import {readJson,storeJson} from './stored-json';
import {deezerRequest,eligibleRecording,recordingTrack,deduplicateRecordings,selectPopularTracks,resolveArtist,rememberDiscoveredArtist,type DeckOptions} from './popular';
import {verifyYearRangePool,verifyGenrePool} from './era-verification';
import {eurovisionSongs} from './eurovision-registry';
import {persistCollection} from './collections';
import {resolveSongBatch,readMiniCategory,indexMiniCategory,readPlaylistMemory,rememberPlaylistSongs} from './playlist-batches';
import {spreadArtists} from '@/lib/track-order';
export type PlaylistPlan={title:string;criteria:string[];artists:string[];genres:string[];language:string|null;years:{from:number;to:number}|null};
type SearchCursor={query:string;index:number;total?:number;artistId?:number;resolved?:boolean;done?:boolean};
type Draft={difficulty?:Difficulty;allowArtistRepeats?:boolean;collectionId?:string;allowedArtistIds?:number[];verifiedUntil?:number;owner:string;prompt:string;plan:PlaylistPlan;deck:Track[];expires:number;searches?:SearchCursor[];seen?:string[];pending?:Track[];offered?:Track[];scanned?:number};
const norm=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const supported=new Set(['rock','classic-rock','indie-rock','pop-punk','synth-pop','alternative','pop','metal','hiphop','dance','rnb','punk','country','jazz']);
export function validatePlan(value:any):PlaylistPlan{
 if(!value||typeof value.title!=='string'||!value.title.trim()||value.title.length>100||!Array.isArray(value.criteria)||!value.criteria.length||value.criteria.length>16||!value.criteria.every((v:any)=>typeof v==='string'&&v.length<=250)||!Array.isArray(value.artists)||value.artists.length>100||!value.artists.every((v:any)=>typeof v==='string'&&v.length<=100)||!Array.isArray(value.genres)||value.genres.length>16||!value.genres.every((v:any)=>supported.has(v))||!(value.language===null||typeof value.language==='string'&&value.language.length<=80))throw new ApiError(400,'AI_INVALID_PLAN','ИИ вернул некорректные условия подборки. Повторите запрос.');
 if(value.years!==null&&(!value.years||!Number.isInteger(value.years.from)||!Number.isInteger(value.years.to)||value.years.from<1900||value.years.to>2100||value.years.to<value.years.from))throw new ApiError(400,'AI_INVALID_PLAN','Некорректный диапазон лет.');
 return {title:value.title.trim(),criteria:value.criteria,artists:[...new Set<string>(value.artists)],genres:[...new Set<string>(value.genres)],language:value.language,years:value.years};
}
async function save(id:string,value:unknown){await database().prepare('INSERT INTO echo_media_collections(id,track_data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at').bind(id,await storeJson(id,value),Date.now()).run()}
const cachePrompt=(value:string)=>value.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase();
async function cacheKey(owner:string,prompt:string,difficulty?:Difficulty){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([owner,cachePrompt(prompt),difficultyLevel(difficulty)])));return 'ai-verified-v4:'+Array.from(new Uint8Array(bytes)).map(byte=>byte.toString(16).padStart(2,'0')).join('');}
async function cachedDraft(owner:string,prompt:string,difficulty?:Difficulty):Promise<Draft|null>{
 const row=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id=?').bind(await cacheKey(owner,prompt,difficulty)).first<{track_data:string}>();if(!row)return null;
 try{const draft=await readJson<Draft>(row.track_data);if(draft.owner!==owner||cachePrompt(draft.prompt)!==cachePrompt(prompt)||draft.expires<Date.now()||!Array.isArray(draft.deck)||!draft.deck.length)return null;validatePlan(draft.plan);return draft;}catch{return null;}
}
async function draftFor(owner:string,id:unknown){if(typeof id!=='string'||!/^ai-draft-[a-f0-9-]{36}$/.test(id))throw new ApiError(400,'AI_INVALID_DRAFT','Неверная подборка.');const row=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id=?').bind(id).first<{track_data:string}>();if(!row)throw new ApiError(404,'AI_INVALID_DRAFT','Подборка не найдена.');const draft=await readJson<Draft>(row.track_data);if(draft.owner!==owner)throw new ApiError(404,'AI_INVALID_DRAFT','Подборка не найдена.');if(draft.expires<Date.now())throw new ApiError(410,'AI_DRAFT_EXPIRED','Время составления истекло. Повторите запрос.');return draft;}
export async function playlistDraft(owner:string,payload:any,options:DeckOptions){
 if(payload.action==='lookup'){
  if(typeof payload.prompt!=='string'||!payload.prompt.trim()||payload.prompt.length>1000)throw new ApiError(400,'INVALID_PROMPT','Введите запрос до 1000 символов.');
  let prompt=payload.prompt,collectionId:string|undefined;
  if(payload.collectionId){const row=await database().prepare('SELECT recipe FROM echo_collections WHERE id=? AND user_id=?').bind(payload.collectionId,owner).first<{recipe:string}>();if(!row?.recipe)throw new ApiError(404,'COLLECTION_NOT_FOUND','Подборка не найдена.');const recipe=JSON.parse(row.recipe);if(!recipe.ai)throw new ApiError(400,'AI_INVALID_DRAFT','Это не ИИ-подборка.');prompt=recipe.prompt;collectionId=payload.collectionId;}
  const cached=await cachedDraft(owner,prompt,options.difficulty);if(!cached)return {hit:false};
  const id='ai-draft-'+crypto.randomUUID(),draft={...cached,allowArtistRepeats:options.allowArtistRepeats!==false||cached.plan.artists.length>0&&cached.plan.artists.length<(options.count??50),collectionId,expires:Date.now()+86400000};await save(id,draft);
  return{hit:true,id,plan:draft.plan,prompt:draft.prompt,available:draft.deck.length,availableArtists:new Set(draft.deck.map(track=>norm(track.artist))).size,queries:draft.searches?.map(s=>s.query)??[],activeQueries:draft.searches?.filter(s=>!s.done).length??0,remaining:(draft.pending?.length??0)+(draft.offered?.filter(t=>!draft.deck.some(d=>d.providerId===t.providerId)).length??0),candidates:draft.deck.map(track=>({artist:track.artist,title:track.title}))};
 }
 if(payload.action==='start'){
  if(typeof payload.prompt!=='string'||!payload.prompt.trim()||payload.prompt.length>1000)throw new ApiError(400,'INVALID_PROMPT','Введите запрос до 1000 символов.');
  let prompt=payload.prompt,plan=validatePlan(payload.plan),collectionId:string|undefined;
  if(payload.collectionId){const row=await database().prepare('SELECT recipe FROM echo_collections WHERE id=? AND user_id=?').bind(payload.collectionId,owner).first<{recipe:string}>();if(!row?.recipe)throw new ApiError(404,'COLLECTION_NOT_FOUND','Подборка не найдена.');const recipe=JSON.parse(row.recipe);if(!recipe.ai)throw new ApiError(400,'AI_INVALID_DRAFT','Это не ИИ-подборка.');collectionId=payload.collectionId;prompt=recipe.prompt;plan=validatePlan(recipe.plan);}
  const artists:Awaited<ReturnType<typeof resolveArtist>>[]=[];
  const automatic=payload.autoPlan===true&&!collectionId;
  const hints=plan.artists.length?plan.artists:automatic&&!plan.years&&!plan.language&&!plan.genres.length&&prompt.length<=80&&prompt.split(/\s+/).length<=5?[prompt]:[];
  for(const name of hints){try{const artist=await resolveArtist(name);if(!artists.some(a=>a.id===artist.id))artists.push(artist);}catch(error){if(!automatic||!(error instanceof ApiError)||error.code!=='ARTIST_NOT_FOUND')throw error;}}
  plan={...plan,artists:artists.map(a=>a.name)};
  const [mini,memory]=await Promise.all([readMiniCategory(owner,plan,difficultyLevel(options.difficulty),prompt),readPlaylistMemory(owner,plan,difficultyLevel(options.difficulty),prompt)]);
  const deck=deduplicateRecordings([...(mini?.tracks??[]),...memory.tracks]);
  const verifiedUntil=mini?.expires&&memory.verifiedUntil?Math.min(mini.expires,memory.verifiedUntil):mini?.expires??memory.verifiedUntil;
  const id='ai-draft-'+crypto.randomUUID();await save(id,{owner,prompt,plan,difficulty:difficultyLevel(options.difficulty),allowArtistRepeats:options.allowArtistRepeats!==false||plan.artists.length>0&&plan.artists.length<(options.count??50),collectionId,allowedArtistIds:artists.map(a=>a.id),deck,verifiedUntil,expires:Date.now()+86400000});return{id,available:deck.length,availableArtists:new Set(deck.map(t=>norm(t.artist))).size,candidates:deck.map(t=>({artist:t.artist,title:t.title})),rememberedCandidates:memory.candidates,plan,prompt};
 }
 const draft=await draftFor(owner,payload.id),id=payload.id as string;
 if(payload.action==='keep-alive'){
  // Renew the active workspace only. Independent recording proofs and the
  // verified-pool cache keep their original expiry and cannot be refreshed here.
  draft.expires=Date.now()+86400000;await save(id,draft);return{id,expires:draft.expires};
 }
 if(payload.action==='resolve-batch'){
  if(!Array.isArray(payload.candidates)||!payload.candidates.length||payload.candidates.length>12||!payload.candidates.every((v:any)=>typeof v?.artist==='string'&&v.artist.trim()&&v.artist.length<=150&&typeof v.title==='string'&&v.title.trim()&&v.title.length<=200))throw new ApiError(400,'AI_INVALID_CANDIDATES','Неверная группа песен.');
  const tracks=await resolveSongBatch(id,payload.candidates,draft.allowedArtistIds);
  return{id,candidates:tracks.map(t=>({providerId:t.providerId,artist:t.artist,title:t.title,popularityRank:t.popularityRank})),searched:payload.candidates.length,found:tracks.length};
 }
 if(payload.action==='catalog'){
  if(payload.queries!==undefined&&(!Array.isArray(payload.queries)||payload.queries.length>8||!payload.queries.every((q:any)=>typeof q==='string'&&q.trim()&&q.length<=150)))throw new ApiError(400,'AI_INVALID_CANDIDATES','Неверные поисковые запросы.');
  draft.searches??=[];draft.seen??=[];draft.pending??=[];draft.scanned??=0;
  if(payload.completed!==undefined&&(!Array.isArray(payload.completed)||payload.completed.length>64||!payload.completed.every((v:any)=>typeof v==='string')))throw new ApiError(400,'AI_INVALID_CANDIDATES','Неверные результаты проверки.');
  // Keep offered but unprocessed songs in the draft, including when the user stops at ten.
  draft.pending.unshift(...(draft.offered??[]).filter(t=>!draft.deck.some(d=>d.providerId===t.providerId)&&!payload.completed?.includes(t.providerId)));draft.offered=[];
  for(const query of (draft.plan.artists.length?draft.plan.artists:payload.queries??[]))if(!draft.searches.some(s=>norm(s.query)===norm(query)))draft.searches.push({query:query.trim(),index:0});
  // Once a verified performer fills a unique-artist slot, search new performers instead of auditing the same discography.
  const filledArtists=new Set(draft.deck.map(t=>norm(t.artist)));
  if(draft.allowArtistRepeats===false){draft.pending=draft.pending.filter(t=>!filledArtists.has(norm(t.artist)));for(const cursor of draft.searches)if(filledArtists.has(norm(cursor.query)))cursor.done=true;}
  const seen=new Set([...draft.seen,...draft.deck.map(t=>t.providerId!)]);
  // Rotate sources after each page: a large discography must not hide other performers.
  for(let page=0;page<2&&draft.pending.length<64;page++){
   const cursor=draft.searches.filter(s=>!s.done).sort((a,b)=>a.index-b.index)[0];if(!cursor)break;
   if(!cursor.resolved){try{const artist=await resolveArtist(cursor.query);cursor.artistId=artist.id;}catch(error){if(!(error instanceof ApiError)||error.code!=='ARTIST_NOT_FOUND')throw error;}cursor.resolved=true;}
   // Deezer's advanced artist:"..." syntax misses valid performers; use plain text and canonical IDs.
   const response=await deezerRequest<{data?:any[];total?:number}>('/search?q='+encodeURIComponent(cursor.query)+'&index='+cursor.index+'&limit=25&order=RANKING');
   const records=response.data??[];cursor.total=response.total??cursor.index+records.length;cursor.index+=records.length;cursor.done=!records.length||cursor.index>=cursor.total;draft.scanned+=records.length;
   for(const record of records){
    if(!eligibleRecording(record)||cursor.artistId&&record.artist.id!==cursor.artistId||draft.allowedArtistIds?.length&&!draft.allowedArtistIds.includes(record.artist.id)||draft.allowArtistRepeats===false&&filledArtists.has(norm(record.artist.name)))continue;
    const track=recordingTrack(record,'AI'),providerId=track.providerId!;if(seen.has(providerId))continue;seen.add(providerId);draft.seen.push(providerId);draft.pending.push(track);
    await rememberDiscoveredArtist(record.artist);await save('ai-source-v1:'+providerId,track);
   }
  }
  draft.pending.sort((a,b)=>(b.popularityRank??0)-(a.popularityRank??0));
  draft.pending=spreadArtists(draft.pending);const candidates=draft.pending.splice(0,32);draft.offered=candidates;await save(id,draft);
  return{id,candidates:candidates.map(t=>({providerId:t.providerId,artist:t.artist,title:t.title,popularityRank:t.popularityRank})),scanned:draft.scanned,found:draft.seen.length,remaining:draft.pending.length,activeQueries:draft.searches.filter(s=>!s.done).length,queries:draft.searches.map(s=>s.query)};
 }
 if(payload.action==='add'||payload.action==='commit-batch'){
  if(!Array.isArray(payload.candidates)||!payload.candidates.length||payload.candidates.length>(payload.action==='commit-batch'?32:8)||!payload.candidates.every((v:any)=>typeof v?.artist==='string'&&v.artist.trim()&&v.artist.length<=150&&typeof v.title==='string'&&v.title.trim()&&v.title.length<=200))throw new ApiError(400,'AI_INVALID_CANDIDATES','Неверный список предложенных песен.');
  const raw:Track[]=[];let missing=0;
  for(const candidate of payload.candidates){
   if(candidate.providerId!==undefined){
    if(typeof candidate.providerId!=='string'||payload.action==='add'&&!draft.seen?.includes(candidate.providerId))throw new ApiError(400,'AI_INVALID_CANDIDATES','Песня не найдена в этом поиске.');
    const source=await database().prepare('SELECT track_data FROM echo_media_collections WHERE id=?').bind(payload.action==='commit-batch'?'ai-batch-source:'+id+':'+candidate.providerId:'ai-source-v1:'+candidate.providerId).first<{track_data:string}>();
    const track=source?await readJson<Track>(source.track_data):null;
    if(!track||norm(track.artist)!==norm(candidate.artist)||norm(track.title)!==norm(candidate.title)){missing++;continue;}raw.push(track);continue;
   }
   if(payload.action==='commit-batch')throw new ApiError(400,'AI_INVALID_CANDIDATES','Нужны подтвержденные записи каталога.');
   let artist;try{artist=await resolveArtist(candidate.artist)}catch(error){if(error instanceof ApiError&&error.code==='ARTIST_NOT_FOUND'){missing++;continue}throw error}
   if(draft.allowedArtistIds?.length&&!draft.allowedArtistIds.includes(artist.id)){missing++;continue}
   const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({artistId:artist.id,title:norm(candidate.title)}))),key='ai-recording-v1:'+Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
   const cache=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id=?').bind(key).first<{track_data:string;updated_at:number}>();let track:Track|null;
   if(cache&&cache.updated_at>Date.now()-21600000)track=JSON.parse(cache.track_data);else{
    const response=await deezerRequest<{data?:any[]}>('/search?q='+encodeURIComponent(artist.name+' '+candidate.title)+'&limit=100');
    const matches=(response.data??[]).filter(t=>eligibleRecording(t)&&t.artist.id===artist.id&&norm(t.title_short||t.title)===norm(candidate.title)).sort((a,b)=>(b.rank??0)-(a.rank??0));track=matches.length?recordingTrack(matches[0],'AI'):null;await save(key,track);
   }
   if(track)raw.push(track);else missing++;
  }
  // The AI audits lyrics/mood for real catalog records. A fixed artist list cannot prove language.
  // Independent original-release evidence is required only when the request specifies an era.
  let verified=draft.plan.years?await verifyYearRangePool(raw,draft.plan.years.from,draft.plan.years.to,raw.length,true):raw;
  if(draft.plan.genres.length)verified=await verifyGenrePool(verified,draft.plan.genres,verified.length,true);
  if(/eurovision|євробач|евровиде|евровидени/i.test(draft.prompt))verified=verified.filter(track=>eurovisionSongs.some(song=>String(song.providerId)===track.providerId));
  draft.deck=deduplicateRecordings([...draft.deck,...verified]);if(draft.deck.length)draft.verifiedUntil??=Date.now()+21600000;await save(id,draft);
  if(draft.deck.length){const verifiedUntil=draft.verifiedUntil??Date.now()+21600000;await save(await cacheKey(owner,draft.prompt,draft.difficulty),{...draft,collectionId:undefined,verifiedUntil,expires:verifiedUntil});}
  if(payload.action==='commit-batch'&&draft.deck.length)await indexMiniCategory(owner,draft.plan,difficultyLevel(draft.difficulty),draft.deck,draft.verifiedUntil??Date.now()+21600000,draft.prompt);
  // Only newly verified songs renew their availability. Older pool entries retain
  // their original expiry, even while a long search continues.
  if(verified.length)await rememberPlaylistSongs(owner,draft.plan,difficultyLevel(draft.difficulty),verified,Date.now()+21600000,draft.prompt);
  return{id,available:draft.deck.length,availableArtists:new Set(draft.deck.map(t=>norm(t.artist))).size,added:verified.map(t=>({id:t.id,artist:t.artist,title:t.title,year:t.year})),rejected:missing+raw.length-verified.length};
 }
 if(payload.action==='finish'){
  options={...options,difficulty:draft.difficulty??options.difficulty};
  if(draft.plan.artists.length&&draft.plan.artists.length<(options.count??50))options={...options,allowArtistRepeats:true};
  selectPopularTracks(draft.deck,options,true);
  // Retrying a lost finish response must not create another collection.
  const collectionId=draft.collectionId??'custom-'+id.slice('ai-draft-'.length);
  const result=await persistCollection(owner,draft.plan.title,draft.plan.criteria.join(' · ').slice(0,250),draft.deck,'local-ai',collectionId,{ai:true,prompt:draft.prompt,plan:draft.plan},!!draft.collectionId);
  const verifiedUntil=draft.verifiedUntil??Date.now()+21600000;
  try{await save(await cacheKey(owner,draft.prompt,draft.difficulty),{...draft,collectionId:undefined,verifiedUntil,expires:verifiedUntil});}catch{console.warn('ECHO verified playlist cache unavailable');}
  return result;
 }
 throw new ApiError(400,'AI_INVALID_ACTION','Неизвестное действие.');
}

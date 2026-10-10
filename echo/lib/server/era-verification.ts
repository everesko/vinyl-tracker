import {ApiError,database} from './http';
import type {Track} from '@/lib/quiz';
type DateCheck={year:number|null;status:string;sources:{url:string;year:number}[];aliases?:string[]};
const userAgent='ECHO-MusicQuiz-MetadataResearch/1.0 (https://echo-music-quiz-danil.everesko1.chatgpt.site/)';
const norm=(v:any)=>String(v||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const base=(v:any)=>String(v||'').replace(/\s*[-(\[]\s*(?:\d{4}\s*)?remaster(?:ed)?[^)\]]*[)\]]?\s*$/i,'').trim();
const year=(v:any)=>/^\+?(\d{4})/.test(v||'')?Number(String(v).replace(/^\+/, '').slice(0,4)):null;
const badVersion=/\b(live|karaoke|tribute|cover|demo|remix|re-?record(?:ed|ing)?|instrumental|concert|alternate take|radio edit|single edit)\b/i;
const quote=(v:any)=>'"'+String(v).replace(/[\\"]/g,'\\$&')+'"';
const nextAt=new Map<string,number>();
async function get(url:string):Promise<any>{
 const host=new URL(url).hostname,interval=host==='musicbrainz.org'?1200:host==='itunes.apple.com'?3100:100;
 const slot=Math.max(Date.now(),nextAt.get(host)??0);nextAt.set(host,slot+interval);
 const delay=slot-Date.now();if(delay)await new Promise<void>(resolve=>setTimeout(resolve,delay));
 const response=await fetch(url,{headers:{'User-Agent':userAgent,Accept:'application/json'},signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw new Error('HTTP '+response.status+' '+new URL(url).hostname);
 const value:any=await response.json();if(value.error)throw new Error('Provider error '+JSON.stringify(value.error));return value;
}
async function appleDates(t:any){
 const key='apple-release-metadata-v1:'+norm(t.artist);
 const cached=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id = ?').bind(key).first<{track_data:string;updated_at:number}>();
 let records:any[];
 if(cached&&cached.updated_at>Date.now()-21600000)records=JSON.parse(cached.track_data);else{
  const response=await get('https://itunes.apple.com/search?'+new URLSearchParams({term:t.artist,media:'music',entity:'song',country:'UA',limit:'200'}));
  records=(response.results??[]).map((r:any)=>({artist:r.artistName,title:r.trackName,duration:r.trackTimeMillis,date:r.releaseDate,url:r.trackViewUrl}));
  await database().prepare('INSERT INTO echo_media_collections (id,track_data,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at').bind(key,JSON.stringify(records),Date.now()).run();
 }
 // Metadata only. Apple preview URLs are never requested or used for playback.
 const artistNames=[t.artist,...t.artistAliases??[]].map(norm);
 const matches=records.filter(r=>(artistNames.includes(norm(r.artist))||String(r.artist).split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i).some(name=>artistNames.includes(norm(name))))&&norm(base(r.title))===norm(base(t.title))&&!badVersion.test(r.title)&&year(r.date)&&(!t.duration||!r.duration||Math.abs(t.duration*1000-r.duration)<=Math.max(10000,t.duration*1000*.04))&&/^https:\/\/(?:music|itunes)\.apple\.com\//.test(r.url??'')).sort((a,b)=>a.date.localeCompare(b.date));
 return matches[0]?{year:year(matches[0].date),url:matches[0].url}:null;
}
const mbUrl=(q:string)=>'https://musicbrainz.org/ws/2/recording/?query='+encodeURIComponent(q)+'&fmt=json&limit=100';
const credit=(r:any)=>(r['artist-credit']||[]).filter((x:any)=>typeof x==='object').flatMap((x:any)=>[x.name,x.artist?.name,x.artist?.['sort-name']]).filter(Boolean);
export function accepts(t:any,r:any){
 if(norm(base(r.title))!==norm(base(t.title)))return false;
 if(!credit(r).some((x:any)=>[t.artist,...t.artistAliases??[]].some(name=>norm(x)===norm(name))))return false;
 if(r.video||badVersion.test((r.disambiguation||'')+' '+r.title))return false;
 if(t.duration&&r.length&&Math.abs(t.duration*1000-r.length)>Math.max(10000,t.duration*1000*.04))return false;
 return true;
}
async function musicBrainz(t:any){
 const evidence:any[]=[];const requests:string[]=[];
 // Even when ISRC resolves a remaster, compare the same artist/title's earlier
 // original studio recordings. ISRC issuance/reissue year is never a song year.
 if(t.isrc&&/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc))requests.push(mbUrl('isrc:'+t.isrc+' AND video:false'));
 requests.push(mbUrl('recording:'+quote(base(t.title))+' AND artistname:'+quote(t.artist)+' AND video:false'));
 for(const url of requests){
  let offset=0,total=1;while(offset<total){const v=await get(url+'&offset='+offset);total=Number(v.count)||0;const matches=(v.recordings||[]).filter((r:any)=>accepts(t,r));
  for(const r of matches){const date=r['first-release-date'];if(year(date))evidence.push({id:r.id,title:r.title,artistCredit:credit(r),durationMs:r.length,date,year:year(date),sourceUrl:'https://musicbrainz.org/recording/'+r.id,queryUrl:url});}offset+=(v.recordings||[]).length;if(!(v.recordings||[]).length)break;}
 }
 const unique=[...new Map(evidence.map((e:any)=>[e.id,e])).values()].sort((a,b)=>a.date.localeCompare(b.date));
 return {provider:'MusicBrainz',earliestYear:unique[0]?.year??null,earliestDate:unique[0]?.date??null,evidence:unique,confidence:unique.length?'exact artist/title, studio version, compatible duration':'unknown'};
}
const wdUrl=(params:Record<string,string>)=>'https://www.wikidata.org/w/api.php?'+new URLSearchParams({...params,format:'json'});
const vals=(e:any,p:string)=>(e.claims?.[p]||[]).filter((x:any)=>x.rank!=='deprecated'&&x.mainsnak?.snaktype==='value').map((x:any)=>x.mainsnak.datavalue.value);
async function wikidata(t:any,mb:any){
 const searchUrl=wdUrl({action:'wbsearchentities',search:base(t.title),language:'en',type:'item',limit:'8'});
 const search=await get(searchUrl),ids=(search.search||[]).map((x:any)=>x.id);if(!ids.length)return {provider:'Wikidata',earliestYear:null,evidence:[]};
 const data=await get(wdUrl({action:'wbgetentities',ids:ids.join('|'),props:'claims|labels|aliases|descriptions',languages:'en|uk|ru'}));
 const entities=Object.values(data.entities||{}) as any[];const performerIds=[...new Set(entities.flatMap((e:any)=>vals(e,'P175').map((v:any)=>v.id)).filter(Boolean))];
 const performers=performerIds.length?(await get(wdUrl({action:'wbgetentities',ids:performerIds.join('|'),props:'labels|aliases',languages:'en|uk|ru'}))).entities:{};
 const names=(e:any)=>[...(Object.values(e?.labels||{}) as any[]).map((x:any)=>x.value),...(Object.values(e?.aliases||{}) as any[]).flatMap((x:any)=>x.map((y:any)=>y.value))];
 const evidence:any[]=[];
 for(const e of entities){
  if(![...names(e),...vals(e,'P1476').map((x:any)=>x.text)].some((x:any)=>norm(x)===norm(base(t.title))))continue;
  const mbids=vals(e,'P4404'),isrcs=vals(e,'P1243');
  const identifierMatch=mbids.some((x:any)=>mb.evidence.some((r:any)=>r.id===x))||(t.isrc&&isrcs.includes(t.isrc));
  const performerMatch=vals(e,'P175').some((v:any)=>names(performers[v.id]).some((n:any)=>norm(n)===norm(t.artist)));
  if(!identifierMatch&&!performerMatch)continue;
  for(const d of vals(e,'P577')){if(d.precision>=9&&year(d.time))evidence.push({id:e.id,label:e.labels?.en?.value,date:d.time,year:year(d.time),precision:d.precision,identity:identifierMatch?'matching MBID/ISRC':'exact song title and performer',sourceUrl:'https://www.wikidata.org/wiki/'+e.id});}
 }
 evidence.sort((a,b)=>a.year-b.year);return {provider:'Wikidata',earliestYear:evidence[0]?.year??null,evidence};
}

async function checkDate(track:Track):Promise<DateCheck>{
 const response=await get('https://api.deezer.com/track/'+track.providerId);
 if(String(response.id)!==track.providerId||norm(response.artist?.name)!==norm(track.artist)||norm(base(response.title_short||response.title))!==norm(base(track.title)))return {year:null,status:'identity-mismatch',sources:[]};
 const identity={artist:track.artist,artistAliases:track.artistAliases,title:track.title,isrc:response.isrc,duration:response.duration};
 const mb=await musicBrainz(identity).catch(()=>({earliestYear:null,evidence:[]}));
 const apple=!mb.earliestYear?await appleDates(identity).catch(()=>null):null;
 const wd=apple?{earliestYear:null,evidence:[]}:await wikidata(identity,mb).catch(()=>({earliestYear:null,evidence:[]}));
 const y=mb.earliestYear,w=wd.earliestYear,providerYear=year(response.release_date);
 const independent=y??w??apple?.year??null;
 const conflict=!!(y&&w&&Math.floor(y/10)!==Math.floor(w/10))||!!(providerYear&&independent&&providerYear<independent)||!!(apple&&providerYear&&apple.year!==providerYear);
 // Original recording evidence takes precedence over digital reissues. With no such
 // evidence, two exact independent catalog dates must agree, plus the AI's era audit.
 const verified=!conflict&&(y||w||apple&&providerYear===apple.year)?independent:null;
 return {year:verified,status:conflict?'conflict':verified?'verified':'unknown',aliases:track.artistAliases??[],sources:[{url:'https://www.deezer.com/track/'+track.providerId,year:providerYear??0},...mb.evidence.slice(0,1).map((e:any)=>({url:e.sourceUrl,year:e.year})),...wd.evidence.slice(0,1).map((e:any)=>({url:e.sourceUrl,year:e.year})),...(apple?[{url:apple.url,year:apple.year!}]:[])]};
}
export async function verifyYearRangePool(candidates:Track[],from:number,to:number,target:number,allowRepeats:boolean){
 const accepted:Track[]=[];let remaining=0;
 const proofs=await Promise.all(candidates.map(async track=>{
  const cached=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id = ?').bind('original-year-v10:'+track.providerId).first<{track_data:string;updated_at:number}>();
  if(cached){const value=JSON.parse(cached.track_data) as DateCheck;const newAlias=(track.artistAliases??[]).some(alias=>!(value.aliases??[]).some(known=>norm(alias)===norm(known)));if(cached.updated_at>Date.now()-(value.year?2592000000:86400000)&&(value.year||!newAlias))return value;}return undefined;
 }));
 // Three independent evidence pipelines overlap, while each provider keeps its rate limit.
 const missing=candidates.map((track,index)=>({track,index})).filter(({index})=>!proofs[index]).slice(0,3);
 await Promise.allSettled(missing.map(async({track,index})=>{const value=await checkDate(track);await database().prepare('INSERT INTO echo_media_collections (id,track_data,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at').bind('original-year-v10:'+track.providerId,JSON.stringify(value),Date.now()).run();proofs[index]=value;}));
 for(let index=0;index<candidates.length;index++){const result=proofs[index];if(!result){remaining++;continue;}if(result.year!==null&&result.year>=from&&result.year<=to)accepted.push({...candidates[index],year:result.year,dateSources:result.sources});}
 const available=allowRepeats?accepted.length:new Set(accepted.map(t=>norm(t.artist))).size;
 if(remaining&&available<target)throw new ApiError(503,'CATALOG_PREPARING','Проверяем исходный год выпуска в независимых источниках.',{available,required:target,canRetry:true});
 return accepted;
}

const genreRules:Record<string,{song:RegExp;album:RegExp}>={
 'rock':{song:/\brock\b/,album:/rock|metal|alternative/i},'classic-rock':{song:/classic rock|classic hard rock|album rock|rock \& roll|arena rock/,album:/rock|metal/i},
 'indie-rock':{song:/indie rock|alternative rock|post punk|garage rock/,album:/rock|alternative|pop/i},
 'pop-punk':{song:/pop punk|pop-punk|punk pop/,album:/rock|alternative|punk/i},
 'synth-pop':{song:/synthpop|synth pop|synth-pop|new wave|electropop|electro pop/,album:/pop|dance|electro/i},
 'alternative':{song:/alternative|indie|grunge|post rock|post punk|nu metal/,album:/rock|alternative|pop|metal/i},
 'pop':{song:/\bpop\b|europop|synthpop|electropop/,album:/pop|dance|r&b/i},
 'metal':{song:/\bmetal\b|hardcore/,album:/rock|metal/i},
 'hiphop':{song:/hip hop|hip-hop|rap|trap/,album:/rap|hip.hop/i},
 'dance':{song:/dance|electronic|disco|house|techno|trance|drum and bass|dubstep|electro|edm|electronica/,album:/dance|electro|pop/i},
 'rnb':{song:/r&b|rhythm and blues|soul|funk/,album:/r&b|soul|funk|pop|jazz/i},
 'country':{song:/country|bluegrass|honky tonk/,album:/country/i},
 'jazz':{song:/jazz|bebop|swing|bossa nova/,album:/jazz/i},
 'punk':{song:/\bpunk\b|hardcore/,album:/rock|alternative|punk/i},
};
type GenreCheck={tags:string[];albumGenres:string[];sources:string[]};
export function genreMatches(slug:string,proof:GenreCheck){const rule=genreRules[slug];return !!rule&&proof.tags.some(tag=>rule.song.test(tag))&&proof.albumGenres.some(tag=>rule.album.test(tag));}
async function checkGenre(track:Track):Promise<GenreCheck>{
 const fresh=await get('https://api.deezer.com/track/'+track.providerId);
 if(String(fresh.id)!==track.providerId||norm(fresh.artist?.name)!==norm(track.artist)||norm(base(fresh.title_short||fresh.title))!==norm(base(track.title)))return {tags:[],albumGenres:[],sources:[]};
 const album=await get('https://api.deezer.com/album/'+fresh.album.id),identity={artist:track.artist,title:track.title,duration:fresh.duration};
 const queries:string[]=[];if(fresh.isrc)queries.push('isrc:'+fresh.isrc+' AND video:false');queries.push('recording:'+quote(base(track.title))+' AND artistname:'+quote(track.artist)+' AND video:false');
 const tags=new Map<string,number>(),sources=['https://www.deezer.com/track/'+track.providerId,'https://www.deezer.com/album/'+fresh.album.id],seen=new Set<string>();
 for(const query of queries){const response=await get(mbUrl(query));const records=(response.recordings??[]).filter((record:any)=>accepts(identity,record)).sort((a:any,b:any)=>(b.score??0)-(a.score??0));
  for(const record of records.slice(0,2)){if(seen.has(record.id))continue;seen.add(record.id);const detail=await get('https://musicbrainz.org/ws/2/recording/'+record.id+'?inc=artists%2Bgenres%2Btags&fmt=json');if(!accepts(identity,detail))continue;sources.push('https://musicbrainz.org/recording/'+record.id);for(const tag of [...(detail.genres??[]),...(detail.tags??[])]){if(Number(tag.count??1)>0)tags.set(String(tag.name).toLowerCase(),Math.max(tags.get(String(tag.name).toLowerCase())??0,Number(tag.count??1)))}}
  if(tags.size)break;
 }
 const high=Math.max(1,...tags.values());return {tags:[...tags].filter(([,votes])=>votes>=Math.max(1,high*.25)).map(([name])=>name),albumGenres:(album.genres?.data??[]).map((g:any)=>String(g.name)),sources};
}
export async function verifyGenrePool(candidates:Track[],slugs:string[],target:number,allowRepeats:boolean){
 const accepted:Track[]=[];let remaining=0;
 const proofs=await Promise.all(candidates.map(async track=>{const cached=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id = ?').bind('song-genres-v9:'+track.providerId).first<{track_data:string;updated_at:number}>();return cached&&cached.updated_at>Date.now()-2592000000?JSON.parse(cached.track_data) as GenreCheck:undefined;}));
 const missing=candidates.map((track,index)=>({track,index})).filter(({index})=>!proofs[index]).slice(0,3);
 await Promise.allSettled(missing.map(async({track,index})=>{const proof=await checkGenre(track);await database().prepare('INSERT INTO echo_media_collections (id,track_data,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at').bind('song-genres-v9:'+track.providerId,JSON.stringify(proof),Date.now()).run();proofs[index]=proof;}));
 for(let index=0;index<candidates.length;index++){const proof=proofs[index],track=candidates[index];if(!proof){remaining++;continue;}if(slugs.some(slug=>genreMatches(slug,proof)))accepted.push({...track,genres:slugs.filter(slug=>genreMatches(slug,proof)),categorySources:proof.sources});}
 const available=allowRepeats?accepted.length:new Set(accepted.map(t=>norm(t.artist))).size;
 if(remaining&&available<target)throw new ApiError(503,'CATALOG_PREPARING','Сверяем жанры конкретных записей.',{available,required:target,canRetry:true});return accepted;
}

export async function verifyEraPool(candidates:Track[],decade:number,target:number,allowRepeats:boolean){return verifyYearRangePool(candidates,decade,decade+9,target,allowRepeats);}

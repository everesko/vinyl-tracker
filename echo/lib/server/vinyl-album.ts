import type {Track} from '@/lib/quiz';
import {audioTrack,loadGame} from './games';
import {ApiError} from './http';
import {addVinylAlbum,discogsJson,readVinylTables} from './vinyl';

type Artist = {id?:number;name?:string;anv?:string};
type DeezerAlbum = {id:number;title:string;record_type?:string;release_date?:string;artist?:Artist;cover_xl?:string;cover_big?:string;cover_medium?:string;link?:string;nb_tracks?:number;tracks?:{data?:Recording[]}};
type Recording = {id:number;title:string;title_short?:string;isrc?:string;artist?:Artist;album?:DeezerAlbum};
type DiscogsTrack = {title?:string;type_?:string;artists?:Artist[];sub_tracks?:DiscogsTrack[]};
type Release = {id:number;title?:string;master_id?:number;artists?:Artist[];formats?:{name?:string;descriptions?:string[];qty?:string}[];tracklist?:DiscogsTrack[];year?:number;country?:string;images?:{type?:string;uri?:string;uri150?:string}[];genres?:string[];styles?:string[];labels?:{name?:string;catno?:string}[]};
type ExpectedAlbum = {album:DeezerAlbum;recording:Recording};
type SearchResult = {id?:number;title?:string;type?:string};
type AlbumItem = Record<string,unknown> & {id:string;artist:string;title:string;coverImage:string;uri:string;verifiedVinylReleaseId:number};
type MusicBrainzGroup = {id?:string;title?:string;'primary-type'?:string;'artist-credit'?:{name?:string;artist?:{name?:string;aliases?:{name?:string}[]}}[];relations?:{type?:string;url?:{resource?:string}}[]};
let nextMusicBrainzAt=0;
const musicBrainzCache=new Map<string,{expires:number;value:unknown}>();

/** Remove edition labels only: live recordings, remixes and named albums remain distinct. */
export function normalizeVinylName(value:string,kind:'artist'|'album'|'song'='album'){
  let text=value.trim();
  if(kind==='artist')text=text.replace(/\s*\(\d+\)\s*$/,'').replace(/\*+$/,'');
  else {
    const qualifiers=kind==='song'?'(?:\\d{4}\\s+)?remaster(?:ed)?|remaster(?:ed)?\\s+\\d{4}|(?:radio|single)\\s+edit|(?:original|album)\\s+version|(?:mono|stereo)(?:\\s+mix)?'
      :'(?:\\d{4}\\s+)?remaster(?:ed)?|remaster(?:ed)?\\s+\\d{4}|(?:deluxe|expanded|anniversary|special|limited|bonus)(?:\\s+\\w+){0,3}\\s+edition|deluxe|expanded|(?:\\d+(?:st|nd|rd|th)\\s+)?anniversary(?:\\s+edition)?|(?:mono|stereo)(?:\\s+version)?';
    const label=new RegExp(`\\s*[\\(\\[]\\s*(?:${qualifiers})\\s*[\\)\\]]`,'gi');
    text=text.replace(label,'').replace(new RegExp(`\\s*[-–—]\\s*(?:${qualifiers})\\s*$`,'i'),'');
  }
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
function artistMatches(actual:Artist[],expected:string){return Array.isArray(actual)&&actual.some(artist=>artist&&[artist.name,artist.anv].some(name=>typeof name==='string'&&normalizeVinylName(name,'artist')===normalizeVinylName(expected,'artist')));}
function various(value:string){return /^(?:various|various artists|різні виконавці|разные исполнители)$/i.test(value.trim());}
function fullTracklist(items:DiscogsTrack[],depth=0):DiscogsTrack[]{return Array.isArray(items)&&depth<8?items.filter(item=>item&&typeof item==='object').flatMap(item=>[item,...fullTracklist(item.sub_tracks??[],depth+1)]):[];}

/** Search format labels alone cannot prove a pressing: inspect the release and its tracklist. */
export function vinylReleaseMatches(release:Release,expected:ExpectedAlbum){
  if(!release||!Number.isSafeInteger(release.id)||release.id<=0||typeof release.title!=='string'||!release.title||normalizeVinylName(release.title)!==normalizeVinylName(expected.album.title))return false;
  const vinylAlbum=Array.isArray(release.formats)&&release.formats.some(format=>format&&typeof format.name==='string'&&format.name.toLowerCase()==='vinyl'&&Array.isArray(format.descriptions)&&format.descriptions.some(description=>typeof description==='string'&&/^(?:album|lp)$/i.test(description)));
  if(!vinylAlbum)return false;
  const albumArtist=expected.album.artist?.name??expected.recording.artist?.name;
  const songArtist=expected.recording.artist?.name;
  if(!albumArtist||!songArtist||!artistMatches(release.artists??[],albumArtist))return false;
  const expectedTitle=normalizeVinylName(expected.recording.title_short??expected.recording.title,'song');
  if(!expectedTitle)return false;
  return fullTracklist(release.tracklist??[]).some(track=>{
    if(track.type_==='heading'||typeof track.title!=='string'||!track.title||normalizeVinylName(track.title,'song')!==expectedTitle)return false;
    // A Various Artists compilation must identify the song's artist in its tracklist.
    if(track.artists?.length)return artistMatches(track.artists,songArtist);
    return !various(albumArtist)&&artistMatches(release.artists??[],songArtist);
  });
}

async function deezer<T>(request:Request,path:string):Promise<T>{
  let response:Response;
  try{response=await fetch(`https://api.deezer.com${path}`,{headers:{Accept:'application/json'},signal:AbortSignal.any([request.signal,AbortSignal.timeout(12000)]),redirect:'error'});}
  catch{throw new ApiError(503,'VINYL_SOURCE_UNAVAILABLE','Не вдалося перевірити альбом у Deezer. Повторіть спробу.');}
  if(!response.ok)throw new ApiError(503,'VINYL_SOURCE_UNAVAILABLE','Каталог Deezer тимчасово недоступний. Повторіть спробу.');
  let result:unknown;try{const text=await response.text();if(text.length>2*1024*1024)throw new Error();result=JSON.parse(text);}catch{throw new ApiError(503,'VINYL_SOURCE_UNAVAILABLE','Deezer повернув некоректну відповідь. Повторіть спробу.');}
  if(!result||typeof result!=='object'||'error'in result)throw new ApiError(404,'VINYL_SOURCE_NOT_FOUND','Не вдалося отримати точний альбом цієї пісні.');
  return result as T;
}
function sourceId(track:Track){
  if(track.provider!=='deezer'||!track.providerId||!/^\d{1,16}$/.test(track.providerId))throw new ApiError(409,'VINYL_SOURCE_UNSUPPORTED','Автоматичне визначення альбому доступне для треків Deezer.');
  const id=Number(track.providerId);if(!Number.isSafeInteger(id)||id<=0)throw new ApiError(409,'VINYL_SOURCE_UNSUPPORTED','Не вдалося визначити запис у каталозі Deezer.');return id;
}
function safeUrl(value:unknown){if(typeof value!=='string')return '';try{const url=new URL(value);return url.protocol==='https:'?url.href:'';}catch{return '';}}
function validRecording(value:Recording,id:number){return value.id===id&&typeof value.title==='string'&&!!value.title&&!!value.artist?.name&&Number.isSafeInteger(value.album?.id)&&value.album!.id>0;}
async function exactRecording(request:Request,track:Track){
  const id=sourceId(track),recording=await deezer<Recording>(request,`/track/${id}`);
  if(!validRecording(recording,id)||![track.title,...track.titleAliases??[]].some(title=>normalizeVinylName(title,'song')===normalizeVinylName(recording.title_short??recording.title,'song'))||![track.artist,...track.artistAliases??[]].some(artist=>normalizeVinylName(artist,'artist')===normalizeVinylName(recording.artist!.name!,'artist')))
    throw new ApiError(409,'VINYL_RECORDING_CHANGED','Дані запису змінилися. Автоматичне додавання альбому зупинено.');
  const album=await deezer<DeezerAlbum>(request,`/album/${recording.album!.id}`);
  if(album.id!==recording.album!.id||typeof album.title!=='string'||!album.title||!album.artist?.name)throw new ApiError(404,'VINYL_SOURCE_NOT_FOUND','Не вдалося отримати точний альбом цієї пісні.');
  return {recording,album};
}

/** A digital single can lead to a parent album only through the same ISRC recording. */
async function parentAlbums(request:Request,source:ExpectedAlbum):Promise<ExpectedAlbum[]>{
  if(source.album.record_type!=='single'&&source.album.record_type!=='ep')return [];
  if(!source.recording.isrc||!/^[A-Z0-9]{12}$/i.test(source.recording.isrc)||!source.recording.artist?.id)return [];
  const query=`artist:"${source.recording.artist.name!.replace(/["\\]/g,'')}" track:"${(source.recording.title_short??source.recording.title).replace(/["\\]/g,'')}"`;
  const data=await deezer<{data?:Recording[]}>(request,`/search/track?q=${encodeURIComponent(query)}&limit=50`);
  const albumIds=new Set<number>([source.album.id]),candidates=(Array.isArray(data.data)?data.data:[]).filter(recording=>recording&&Number.isSafeInteger(recording.id)&&typeof recording.title==='string'&&recording.artist?.id===source.recording.artist?.id&&recording.album?.id&&recording.album.id!==source.album.id&&normalizeVinylName(recording.title_short??recording.title,'song')===normalizeVinylName(source.recording.title_short??source.recording.title,'song'));
  const albums:ExpectedAlbum[]=[];
  for(const candidate of candidates){
    if(albumIds.has(candidate.album!.id))continue;
    const recording=await deezer<Recording>(request,`/track/${candidate.id}`);
    if(!validRecording(recording,candidate.id)||recording.isrc?.toUpperCase()!==source.recording.isrc.toUpperCase())continue;
    albumIds.add(candidate.album!.id);
    const album=await deezer<DeezerAlbum>(request,`/album/${recording.album!.id}`);
    if(album.id===recording.album!.id&&album.record_type==='album'&&album.title&&album.artist?.name)albums.push({recording,album});
    if(albums.length===3)break;
  }
  return albums;
}

async function confirmedRelease(request:Request,expected:ExpectedAlbum):Promise<Release|null>{
  const artist=expected.album.artist?.name??expected.recording.artist!.name!,titles=[expected.album.title];
  const baseTitle=normalizeVinylName(expected.album.title);
  if(baseTitle!==normalizeVinylName(expected.album.title,'artist'))titles.push(baseTitle);
  const visited=new Set<number>();
  for(const title of titles){
    for(let page=1;page<=3;page++){
      const parameters=new URLSearchParams({type:'release',format:'Vinyl',release_title:title,per_page:'100',page:String(page)});
      if(!various(artist))parameters.set('artist',artist);
      const result=await discogsJson(request,`/database/search?${parameters}`) as {results?:SearchResult[];pagination?:{pages?:number}};
      if(!Array.isArray(result.results))throw new ApiError(503,'VINYL_SOURCE_UNAVAILABLE','Discogs повернув некоректну відповідь. Повторіть спробу.');
      const candidates=result.results.filter(item=>item&&Number.isSafeInteger(item.id)&&item.id!>0&&item.type==='release'&&typeof item.title==='string'&&normalizeVinylName(item.title.split(' - ').slice(1).join(' - '))===baseTitle);
      for(const candidate of candidates){
        if(visited.has(candidate.id!))continue;visited.add(candidate.id!);
        const release=await discogsJson(request,`/releases/${candidate.id}`) as Release;
        if(release?.id===candidate.id&&vinylReleaseMatches(release,expected))return release;
      }
      if(page>=(result.pagination?.pages??1))break;
    }
  }
  return null;
}
async function musicBrainz<T>(request:Request,path:string):Promise<T>{
  const hit=musicBrainzCache.get(path);if(hit&&hit.expires>Date.now())return hit.value as T;
  if(request.signal.aborted)throw new ApiError(499,'REQUEST_CANCELLED','Запит скасовано.');
  const wait=Math.max(0,nextMusicBrainzAt-Date.now());nextMusicBrainzAt=Date.now()+wait+1100;
  if(wait)await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{request.signal.removeEventListener('abort',abort);resolve();},wait);
    function abort(){clearTimeout(timer);reject(new ApiError(499,'REQUEST_CANCELLED','Запит скасовано.'));}request.signal.addEventListener('abort',abort,{once:true});
  });
  const response=await fetch(`https://musicbrainz.org/ws/2/${path}`,{headers:{Accept:'application/json','User-Agent':'EchoVinylQuiz/1.0 (https://schallplatten.pp.ua/)'},signal:AbortSignal.any([request.signal,AbortSignal.timeout(12000)]),redirect:'error'});
  if(!response.ok)throw new ApiError(503,'VINYL_SOURCE_UNAVAILABLE','MusicBrainz тимчасово недоступний.');
  const text=await response.text();if(text.length>2*1024*1024)throw new ApiError(503,'VINYL_SOURCE_UNAVAILABLE','MusicBrainz повернув завелику відповідь.');
  const value=JSON.parse(text);if(!value||typeof value!=='object')throw new ApiError(503,'VINYL_SOURCE_UNAVAILABLE','MusicBrainz повернув некоректну відповідь.');
  musicBrainzCache.set(path,{expires:Date.now()+86400000,value});if(musicBrainzCache.size>200)musicBrainzCache.delete(musicBrainzCache.keys().next().value!);
  return value as T;
}
function musicBrainzGroupMatches(group:MusicBrainzGroup,expected:ExpectedAlbum){
  const artist=expected.album.artist?.name??expected.recording.artist?.name;
  return typeof group.id==='string'&&/^[a-f0-9-]{36}$/i.test(group.id)&&group['primary-type']==='Album'&&typeof group.title==='string'&&normalizeVinylName(group.title)===normalizeVinylName(expected.album.title)&&!!artist&&Array.isArray(group['artist-credit'])&&group['artist-credit'].some(credit=>[credit.name,credit.artist?.name,...credit.artist?.aliases?.map(alias=>alias.name)??[]].some(name=>typeof name==='string'&&normalizeVinylName(name,'artist')===normalizeVinylName(artist,'artist')));
}
/** Public album links supply IDs; they never replace the pressing and song verification. */
async function anonymousRelease(request:Request,expected:ExpectedAlbum):Promise<Release|null>{
  try{
    const albumTitle=normalizeVinylName(expected.album.title),artist=expected.album.artist?.name??expected.recording.artist?.name;
    if(!albumTitle||!artist)return null;
    const query=`releasegroup:"${albumTitle.replace(/["\\]/g,'')}" AND artist:"${artist.replace(/["\\]/g,'')}"`;
    const data=await musicBrainz<{'release-groups'?:MusicBrainzGroup[]}>(request,`release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=10`);
    const groups=(Array.isArray(data['release-groups'])?data['release-groups']:[]).filter(group=>group&&musicBrainzGroupMatches(group,expected));
    const visited=new Set<number>();
    for(const group of groups.slice(0,3)){
      const details=await musicBrainz<MusicBrainzGroup>(request,`release-group/${group.id}?inc=artist-credits+url-rels&fmt=json`);
      if(!musicBrainzGroupMatches(details,expected))continue;
      const relations=Array.isArray(details.relations)?details.relations:[];
      for(const relation of relations){
        if(relation?.type!=='discogs'||typeof relation.url?.resource!=='string')continue;
        let link:URL;try{link=new URL(relation.url.resource);}catch{continue;}
        if(link.protocol!=='https:'||!['discogs.com','www.discogs.com'].includes(link.hostname))continue;
        const match=link.pathname.match(/^\/(master|release)\/(\d+)(?:-[^/]*)?\/?$/);if(!match)continue;
        if(match[1]==='release'){
          const release=await discogsJson(request,`/releases/${Number(match[2])}`) as Release;
          if(release?.id===Number(match[2])&&vinylReleaseMatches(release,expected))return release;
          continue;
        }
        const master=await discogsJson(request,`/masters/${Number(match[2])}`) as {id?:number;main_release?:number;title?:string;artists?:Artist[]};
        if(master.id!==Number(match[2])||typeof master.title!=='string'||normalizeVinylName(master.title)!==normalizeVinylName(expected.album.title)||!artistMatches(master.artists??[],artist))continue;
        if(Number.isSafeInteger(master.main_release)&&master.main_release!>0){
          visited.add(master.main_release!);const release=await discogsJson(request,`/releases/${master.main_release}`) as Release;
          if(release?.master_id===master.id&&vinylReleaseMatches(release,expected))return release;
        }
        const editions=await discogsJson(request,`/masters/${master.id}/versions?format=Vinyl&page=1&per_page=100`) as {versions?:{id?:number;major_formats?:string[];format?:string}[]};
        const vinylVersions=(Array.isArray(editions.versions)?editions.versions:[]).filter(version=>version&&Number.isSafeInteger(version.id)&&version.id!>0&&(version.major_formats?.includes('Vinyl')||/\bVinyl\b/i.test(version.format??''))&&/\b(?:LP|Album)\b/i.test(version.format??''));
        for(const version of vinylVersions){
          if(visited.has(version.id!))continue;visited.add(version.id!);const release=await discogsJson(request,`/releases/${version.id}`) as Release;
          if(release?.master_id===master.id&&vinylReleaseMatches(release,expected))return release;
        }
      }
    }
  }catch{/* A public lookup can be incomplete; connecting Discogs enables its full search. */}
  return null;
}
function itemFrom(expected:ExpectedAlbum,release:Release,track:Track):AlbumItem{
  const masterId=Number.isSafeInteger(release.master_id)&&release.master_id!>0?release.master_id:undefined;
  const image=release.images?.find(image=>image.type==='primary')??release.images?.[0];
  const formats=release.formats!.map(format=>[format.qty&&format.qty!=='1'?`${format.qty}×`:null,format.name,...format.descriptions??[]].filter(Boolean).join(', ')).join(' / ');
  return {
    id:masterId?`master-${masterId}`:`discogs-${release.id}`,masterId:masterId??null,discogsId:release.id,releaseId:release.id,isReleaseOnly:!masterId,
    artist:expected.album.artist!.name!,title:expected.album.title,album:expected.album.title,
    year:String(release.year??''),country:release.country??'',format:formats,
    coverImage:safeUrl(image?.uri)||safeUrl(expected.album.cover_xl)||safeUrl(expected.album.cover_big)||safeUrl(track.artworkUrl),thumb:safeUrl(image?.uri150),
    uri:masterId?`https://www.discogs.com/master/${masterId}`:`https://www.discogs.com/release/${release.id}`,
    versionsCount:masterId?null:1,genre:release.genres?.join(', ')??'',style:release.styles?.join(', ')??'',label:release.labels?.map(label=>label.name).filter(Boolean).join(', ')??'',
    status:'buy',notes:'',rating:0,createdAt:new Date().toISOString(),
    source:'quiz',deezerTrackId:Number(track.providerId),deezerAlbumId:expected.album.id,deezerAlbumUrl:`https://www.deezer.com/album/${expected.album.id}`,
    vinylVerified:true,verifiedVinylReleaseId:release.id,vinylReleaseUrl:`https://www.discogs.com/release/${release.id}`,vinylVerifiedAt:new Date().toISOString(),
  };
}
export async function resolveVinylAlbum(request:Request,track:Track):Promise<AlbumItem>{
  const lookupRequest=new Request(request.url,{method:'GET',headers:request.headers,signal:AbortSignal.any([request.signal,AbortSignal.timeout(60000)])});
  const source=await exactRecording(lookupRequest,track);let connectionError:ApiError|undefined;
  const resolve=async(expected:ExpectedAlbum)=>{try{return await confirmedRelease(lookupRequest,expected);}catch(error){if(!(error instanceof ApiError)||error.code!=='DISCOGS_NOT_CONNECTED')throw error;connectionError??=error;return anonymousRelease(lookupRequest,expected);}};
  let release=await resolve(source);
  if(release)return itemFrom(source,release,track);
  for(const parent of await parentAlbums(lookupRequest,source)){release=await resolve(parent);if(release)return itemFrom(parent,release,track);}
  if(connectionError)throw connectionError;
  throw new ApiError(404,'VINYL_NOT_CONFIRMED','Не знайдено підтвердженого вінілового альбому з цією піснею. Перевірте каталог у вкладці «Вініл».');
}
export async function addGameVinylAlbum(request:Request,userId:string,id:string,round:unknown,tableId?:unknown){
  if(!Number.isSafeInteger(round)||Number(round)<0)throw new ApiError(400,'INVALID_ROUND','Укажіть номер раунду.');
  if(tableId!==undefined&&(typeof tableId!=='string'||!tableId||tableId.length>160))throw new ApiError(400,'VINYL_TABLE_INVALID','Оберіть таблицю альбомів.');
  const row=await loadGame(userId,id),state=JSON.parse(row.state) as {index:number;phase:string};
  if(state.phase==='finished'||state.phase==='cancelled')throw new ApiError(409,'VINYL_GAME_CLOSED','Гру завершено. Додавайте альбоми у вкладці «Вініл».');
  if(state.index!==round)throw new ApiError(409,'STALE_ROUND','Раунд змінився. Спробуйте додати поточний альбом.');
  const track=audioTrack(row,Number(round)),tables=await readVinylTables(userId,'albums');
  if(tableId&&!tables.tables.some(table=>table.id===tableId))throw new ApiError(404,'VINYL_TABLE_NOT_FOUND','Таблицю альбомів не знайдено.');
  const existing=tables.tables.flatMap(table=>table.items.map(item=>({table,item}))).find(({item})=>Number(item.deezerTrackId)===Number(track.providerId)&&(Number(item.deezerAlbumId)>0||item.vinylVerified===true&&Number.isSafeInteger(item.verifiedVinylReleaseId)));
  const hidden=state.phase!=='reveal';
  if(existing)return {added:false,tableName:existing.table.name,hidden,vinylVerified:existing.item.vinylVerified===true,...(!hidden?{album:{artist:existing.item.artist,title:existing.item.title,coverImage:existing.item.coverImage,uri:existing.item.uri}}:{})};
  const source=await exactRecording(request,track);
  const album={
    id:`deezer-album-${source.album.id}`,artist:source.album.artist!.name!,title:source.album.title,album:source.album.title,
    year:source.album.release_date?.slice(0,4)??'',coverImage:safeUrl(source.album.cover_xl)||safeUrl(source.album.cover_big)||safeUrl(source.album.cover_medium)||safeUrl(track.artworkUrl),
    status:'buy',rating:0,notes:'',createdAt:new Date().toISOString(),source:'quiz',
    deezerTrackId:Number(track.providerId),deezerAlbumId:source.album.id,deezerAlbumUrl:`https://www.deezer.com/album/${source.album.id}`,
    vinylVerified:false,vinylStatus:'unverified',versionsCount:null,recordType:source.album.record_type??'album',totalTracks:source.album.nb_tracks??null,
  };
  if(request.signal.aborted)throw new ApiError(499,'REQUEST_CANCELLED','Запит скасовано.');
  const saved=await addVinylAlbum(userId,album,tableId as string|undefined);
  return {added:saved.added,tableName:saved.tableName,hidden,vinylVerified:saved.item.vinylVerified===true,...(!hidden?{album:{artist:album.artist,title:album.title,coverImage:album.coverImage,uri:album.deezerAlbumUrl}}:{})};
}

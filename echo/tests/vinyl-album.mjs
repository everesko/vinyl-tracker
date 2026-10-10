import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class ApiError extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code});}}
const track={id:'deezer-123',provider:'deezer',providerId:'123',artist:'Queen',title:'Bohemian Rhapsody',genres:['rock'],year:1975,artworkUrl:'https://e-cdns-images.dzcdn.net/images/cover/example.jpg'};
const recording={id:123,title:track.title,isrc:'GBUM71029604',artist:{id:99,name:'Queen'},album:{id:456,title:'A Night At The Opera'}};
const album={id:456,title:'A Night At The Opera',record_type:'album',release_date:'1975-11-21',artist:recording.artist};
const release={id:789,title:album.title,master_id:999,artists:[{name:'Queen'}],formats:[{name:'Vinyl',descriptions:['LP','Album']}],year:1975,tracklist:[{title:track.title,type_:'track'}],images:[{type:'primary',uri:'https://i.discogs.com/image.jpg'}]};
function harness({round=0,phase='playing',owner='owner',savedItems=[],tables=[{id:'tbl_albums_default',name:'Albums',items:savedItems}],source={},discs={},brainz={},sourceFailure,discogsFailure}={}){
  const calls=[],saves=[],gameCalls=[],module={exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/vinyl-album.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module,exports:module.exports,require:name=>name==='./http'?{ApiError}:name==='./games'?{
      loadGame:async(user,id)=>{gameCalls.push({user,id});if(user!==owner)throw new ApiError(404,'GAME_NOT_FOUND','');return {id,user_id:user,state:JSON.stringify({index:round,phase})};},audioTrack:()=>track,
    }:name==='./vinyl'?{
      readVinylTables:async user=>{assert.equal(user,owner);return {tables};},
      addVinylAlbum:async(user,item,tableId)=>{saves.push({user,item,tableId});return {added:true,tableName:tables.find(table=>table.id===tableId)?.name??tables[0].name,item};},
      discogsJson:async(request,path)=>{calls.push({source:'discogs',path});if(discogsFailure&&(path.startsWith('/database/search?')||discogsFailure.code!=='DISCOGS_NOT_CONNECTED'))throw discogsFailure;return discs[path]??(path.startsWith('/database/search?')?{results:[{id:789,title:`Queen - ${album.title}`,type:'release'}],pagination:{pages:1}}:release);},
    }:{},
    fetch:async url=>{calls.push({source:url.startsWith('https://musicbrainz.org/')?'musicbrainz':'deezer',url});if(sourceFailure)throw sourceFailure;const path=new URL(url).pathname+new URL(url).search;if(url.startsWith('https://musicbrainz.org/'))return Response.json(brainz[path]??{'release-groups':[]});return Response.json(source[path]??(path==='/track/123'?recording:path==='/album/456'?album:{error:{code:800}}));},
    AbortSignal,Request,Response,URL,URLSearchParams,JSON,Date,Number,Map,Set,Error,setTimeout,clearTimeout,
  });
  return {api:module.exports,calls,saves,gameCalls};
}
const request=new Request('https://quiz.example/api/games/a/vinyl');

test('vinyl confirmation checks actual pressing, album identity, artist and full exact track title',()=>{
  const {api}=harness(),expected={album,recording};assert.equal(api.vinylReleaseMatches(release,expected),true);
  for(const change of [{title:'Greatest Hits'},{artists:[{name:'Queen Tribute'}]},{formats:[{name:'CD',descriptions:['Album']}]},{formats:[{name:'Vinyl',descriptions:['7"','Single']}]},{tracklist:[{title:'Rhapsody'}]},{tracklist:[{title:'Bohemian Rhapsody (Live)'}]},{tracklist:[{title:'Bohemian Rhapsody (Remix)'}]},{tracklist:[{title:track.title,type_:'heading'}]}])assert.equal(api.vinylReleaseMatches({...release,...change},expected),false);
  assert.equal(api.vinylReleaseMatches({...release,artists:[{name:'Queen (2)'}],title:'A Night At The Opera (Deluxe Edition)',tracklist:[{title:'Bohemian Rhapsody (2011 Remaster)'}]},expected),true);
});
test('normalization preserves meaningful live, remix and album parenthetical titles',()=>{
  const {api}=harness();assert.equal(api.normalizeVinylName('Song (Radio Edit)','song'),'song');assert.equal(api.normalizeVinylName('Song (Live)','song'),'song live');assert.equal(api.normalizeVinylName('Song (Club Remix)','song'),'song club remix');assert.equal(api.normalizeVinylName('Alice (Through The Looking Glass)'),'alice through the looking glass');assert.equal(api.normalizeVinylName('Queen (2)','artist'),'queen');
});
test('Various Artists compilations require a matching per-track artist and traverse nested tracks',()=>{
  const {api}=harness(),expected={album:{...album,artist:{name:'Various Artists'}},recording},compilation={...release,artists:[{name:'Various Artists'}]};
  assert.equal(api.vinylReleaseMatches(compilation,expected),false);
  assert.equal(api.vinylReleaseMatches({...compilation,tracklist:[{title:'Side B',type_:'index',sub_tracks:[{title:track.title,artists:[{name:'Queen'}]}]}]},expected),true);
  assert.equal(api.vinylReleaseMatches({...compilation,tracklist:[{title:track.title,artists:[{name:'Other Artist'}]}]},expected),false);
});
test('owned current-round save detects exact Deezer album, proves vinyl, saves real IDs without spoilers',async()=>{
  const h=harness(),result=await h.api.addGameVinylAlbum(request,'owner','game',0);
  assert.equal(result.added,true);assert.equal(result.hidden,true);assert.equal(result.tableName,'Albums');assert.equal(result.album,undefined);assert.ok(!JSON.stringify(result).includes('Queen'));assert.ok(!JSON.stringify(result).includes('789'));
  assert.equal(h.saves.length,1);const item=h.saves[0].item;assert.equal(item.id,'master-999');assert.equal(item.masterId,999);assert.equal(item.discogsId,789);assert.equal(item.verifiedVinylReleaseId,789);assert.equal(item.deezerAlbumId,456);assert.equal(item.status,'buy');assert.equal(item.versionsCount,null);assert.ok(h.calls[0].url.endsWith('/track/123'));assert.ok(h.calls[1].url.endsWith('/album/456'));assert.equal(h.gameCalls[0].user,'owner');
  const search=new URL(h.calls.find(call=>call.source==='discogs').path,'https://api.discogs.com');assert.equal(search.searchParams.get('artist'),'Queen');assert.equal(search.searchParams.get('release_title'),album.title);assert.equal(search.searchParams.get('format'),'Vinyl');
});
test('reveal result can show the identified album and custom album table receives the item',async()=>{
  const h=harness({phase:'reveal',tables:[{id:'table-2',name:'Wish list',items:[]}]}),result=await h.api.addGameVinylAlbum(request,'owner','game',0,'table-2');assert.equal(result.hidden,false);assert.equal(result.album.title,album.title);assert.equal(result.tableName,'Wish list');assert.equal(h.saves[0].tableId,'table-2');
});
test('source identity must match the stored recording; title-only or unrelated metadata cannot save',async()=>{
  for(const change of [{id:124},{artist:{id:998,name:'Other Artist'}},{title:'Another song'}]){const h=harness({source:{'/track/123':{...recording,...change}}});await assert.rejects(h.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='VINYL_RECORDING_CHANGED');assert.equal(h.saves.length,0);assert.ok(h.calls.every(call=>call.source==='deezer'));}
});
test('digital single resolves a true parent album only when the same ISRC is independently verified',async()=>{
  const single={...album,id:456,title:'Bohemian Rhapsody',record_type:'single'},singleRecording={...recording,album:single},parent={...album,id:654},parentRecording={...recording,id:321,album:parent};
  const query=`artist:"Queen" track:"Bohemian Rhapsody"`,path=`/search/track?q=${encodeURIComponent(query)}&limit=50`;
  const h=harness({source:{'/track/123':singleRecording,'/album/456':single,[path]:{data:[parentRecording]},'/track/321':parentRecording,'/album/654':parent},discs:{'/releases/789':release}});
  const result=await h.api.addGameVinylAlbum(request,'owner','game',0);assert.equal(result.added,true);assert.equal(h.saves[0].item.deezerAlbumId,654);assert.equal(h.saves[0].item.deezerTrackId,123);
  const wrong=harness({source:{'/track/123':singleRecording,'/album/456':single,[path]:{data:[parentRecording]},'/track/321':{...parentRecording,isrc:'GBUM71099999'},'/album/654':parent}});await assert.rejects(wrong.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='VINYL_NOT_CONFIRMED');assert.equal(wrong.saves.length,0);
});
test('digital-only or single pressings never acquire fabricated LP status',async()=>{
  const h=harness({discs:{'/releases/789':{...release,formats:[{name:'Vinyl',descriptions:['Single','7"']}]}}});await assert.rejects(h.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='VINYL_NOT_CONFIRMED');assert.equal(h.saves.length,0);
});
test('a different mix in the same parent album does not hide a later exact ISRC recording',async()=>{
  const single={...album,title:'Bohemian Rhapsody',record_type:'single'},parent={...album,id:654},parentRecording={...recording,id:322,album:parent},wrongMix={...parentRecording,id:321,isrc:'GBUM71099999'};
  const path=`/search/track?q=${encodeURIComponent('artist:"Queen" track:"Bohemian Rhapsody"')}&limit=50`;
  const h=harness({source:{'/track/123':{...recording,album:single},'/album/456':single,[path]:{data:[wrongMix,parentRecording]},'/track/321':wrongMix,'/track/322':parentRecording,'/album/654':parent}});
  await h.api.addGameVinylAlbum(request,'owner','game',0);assert.equal(h.saves[0].item.deezerAlbumId,654);assert.ok(h.calls.some(call=>call.url?.endsWith('/track/322')));
});
test('verified repeated add is idempotent across every album table without requesting the provider again',async()=>{
  const item={...release,id:'master-999',artist:'Queen',title:album.title,vinylVerified:true,verifiedVinylReleaseId:789,deezerTrackId:123},h=harness({tables:[{id:'a',name:'First',items:[]},{id:'b',name:'Already stored',items:[item]}]});const result=await h.api.addGameVinylAlbum(request,'owner','game',0);assert.equal(result.added,false);assert.equal(result.tableName,'Already stored');assert.equal(result.hidden,true);assert.equal(h.calls.length,0);assert.equal(h.saves.length,0);
});
test('auth, wrong round, terminal game, invalid table and missing Discogs connection stop without saving',async()=>{
  const unauth=harness();await assert.rejects(unauth.api.addGameVinylAlbum(request,'other','game',0),error=>error.code==='GAME_NOT_FOUND');assert.equal(unauth.calls.length,0);
  for(const phase of ['finished','cancelled']){const h=harness({phase});await assert.rejects(h.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='VINYL_GAME_CLOSED');assert.equal(h.calls.length,0);}
  for(const round of [1,-1,'0',1.5]){const h=harness();await assert.rejects(h.api.addGameVinylAlbum(request,'owner','game',round),error=>['INVALID_ROUND','STALE_ROUND'].includes(error.code));assert.equal(h.calls.length,0);}
  const missing=harness();await assert.rejects(missing.api.addGameVinylAlbum(request,'owner','game',0,'missing'),error=>error.code==='VINYL_TABLE_NOT_FOUND');assert.equal(missing.calls.length,0);
  const connection=harness({discogsFailure:new ApiError(400,'DISCOGS_NOT_CONNECTED','Connect Discogs')});await assert.rejects(connection.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='DISCOGS_NOT_CONNECTED');assert.equal(connection.saves.length,0);
});
test('provider failures are explicit and cannot turn into a saved or falsely vinyl-confirmed item',async()=>{
  const h=harness({sourceFailure:new Error('offline')});await assert.rejects(h.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='VINYL_SOURCE_UNAVAILABLE');assert.equal(h.saves.length,0);
  const invalid=harness({discs:{'/releases/789':{...release,id:790}}});await assert.rejects(invalid.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='VINYL_NOT_CONFIRMED');assert.equal(invalid.saves.length,0);
});
test('without a Discogs connection an exact MusicBrainz album link can confirm a real public vinyl pressing',async()=>{
  const groupId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',group={id:groupId,title:album.title,'primary-type':'Album','artist-credit':[{name:'Queen',artist:{name:'Queen'}}]},query=`releasegroup:"a night at the opera" AND artist:"Queen"`,searchPath=`/ws/2/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=10`,detailPath=`/ws/2/release-group/${groupId}?inc=artist-credits+url-rels&fmt=json`;
  const h=harness({discogsFailure:new ApiError(400,'DISCOGS_NOT_CONNECTED','Connect Discogs'),brainz:{[searchPath]:{'release-groups':[group]},[detailPath]:{...group,relations:[{type:'discogs',url:{resource:'https://www.discogs.com/master/999'}}]}},discs:{'/masters/999':{id:999,title:album.title,artists:release.artists,main_release:789},'/releases/789':release}});
  const result=await h.api.addGameVinylAlbum(request,'owner','game',0);assert.equal(result.added,true);assert.equal(h.saves[0].item.verifiedVinylReleaseId,789);assert.ok(h.calls.some(call=>call.source==='musicbrainz'));assert.ok(h.calls.some(call=>call.path==='/masters/999'));
});
test('public MusicBrainz lookup never follows arbitrary URLs or mismatched artist/album links',async()=>{
  const groupId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',group={id:groupId,title:album.title,'primary-type':'Album','artist-credit':[{name:'Queen',artist:{name:'Queen'}}]},query=`releasegroup:"a night at the opera" AND artist:"Queen"`,searchPath=`/ws/2/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=10`,detailPath=`/ws/2/release-group/${groupId}?inc=artist-credits+url-rels&fmt=json`;
  for(const details of [{...group,title:'Different album',relations:[{type:'discogs',url:{resource:'https://www.discogs.com/master/999'}}]},{...group,relations:[{type:'discogs',url:{resource:'https://evil.example/master/999'}}]},{...group,relations:[{type:'discogs',url:{resource:'http://www.discogs.com/master/999'}}]}]){
    const h=harness({discogsFailure:new ApiError(400,'DISCOGS_NOT_CONNECTED','Connect Discogs'),brainz:{[searchPath]:{'release-groups':[group]},[detailPath]:details}});await assert.rejects(h.api.addGameVinylAlbum(request,'owner','game',0),error=>error.code==='DISCOGS_NOT_CONNECTED');assert.equal(h.saves.length,0);assert.equal(h.calls.filter(call=>call.source==='discogs'&&!call.path.startsWith('/database/search')).length,0);
  }
});
test('public linked digital edition still requires a verified Vinyl LP with the exact song',async()=>{
  const groupId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',group={id:groupId,title:album.title,'primary-type':'Album','artist-credit':[{name:'Queen',artist:{name:'Queen'}}]},query=`releasegroup:"a night at the opera" AND artist:"Queen"`,searchPath=`/ws/2/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=10`,detailPath=`/ws/2/release-group/${groupId}?inc=artist-credits+url-rels&fmt=json`;
  const h=harness({discogsFailure:new ApiError(400,'DISCOGS_NOT_CONNECTED','Connect Discogs'),brainz:{[searchPath]:{'release-groups':[group]},[detailPath]:{...group,relations:[{type:'discogs',url:{resource:'https://www.discogs.com/master/999'}}]}},discs:{'/masters/999':{id:999,title:album.title,artists:release.artists,main_release:777},'/releases/777':{...release,id:777,formats:[{name:'CD',descriptions:['Album']}]},'/masters/999/versions?format=Vinyl&page=1&per_page=100':{versions:[{id:789,major_formats:['Vinyl'],format:'LP, Album'}]},'/releases/789':release}});
  await h.api.addGameVinylAlbum(request,'owner','game',0);assert.equal(h.saves[0].item.verifiedVinylReleaseId,789);assert.ok(h.calls.some(call=>call.path==='/releases/777'));assert.ok(h.calls.some(call=>call.path==='/releases/789'));
});
test('game album endpoint requires identity, CSRF, and a small bounded JSON body, without scoring mutations',()=>{
  const route=fs.readFileSync(new URL('../app/api/games/[id]/vinyl/route.ts',import.meta.url),'utf8');assert.match(route,/await csrf\(request\)/);assert.match(route,/identity\(request\)/);assert.match(route,/body\(request,2048\)/);assert.match(route,/addGameVinylAlbum/);assert.doesNotMatch(route,/changeGame/);
});

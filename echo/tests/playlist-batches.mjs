import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
class ApiError extends Error{constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}
function moduleFor(file,imports){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];},crypto:webcrypto,TextEncoder,Date,Math,JSON,Set,Map,Promise});return module.exports;}
function harness(){
 const rows=new Map(),searches=[],discovered=[],persisted=[];let active=0,peak=0;
 const db={prepare(){return{bind(...args){return{first:async()=>rows.get(args[0])??null,all:async()=>({results:[...rows.entries()].filter(([key])=>key>=args[0]&&key<args[1]).map(([,row])=>row)}),run:async()=>rows.set(args[0],{track_data:args[1],updated_at:args[2]})};}}}};
 const common={'./http':{ApiError,database:()=>db},'./stored-json':{readJson:async v=>JSON.parse(v),storeJson:async(_,v)=>JSON.stringify(v)}};
 const popular={
  resolveArtist:async name=>{if(name==='Alias')return{id:1,name:'Artist 1'};throw new ApiError(422,'ARTIST_NOT_FOUND','');},rememberDiscoveredArtist:async a=>discovered.push(a),
  deezerRequest:async path=>{searches.push(path);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;const q=new URL(path,'https://api.deezer.com').searchParams.get('q');const number=Number(/Artist (\d+) Song (\d+)/.exec(q)?.[1]);return {data:number?[{id:number,title:'Song '+number,title_short:'Song '+number,artist:{id:number,name:'Artist '+number},rank:100000-number,preview:'https://cdn.deezer.com/preview.mp3',year:number===1?1978:1984},{id:number+1000,title:'Song '+number,artist:{id:999,name:'Tribute'},rank:999999},{id:number+2000,title:'Wrong song',artist:{id:number,name:'Artist '+number},rank:999999}]:[]};},
  eligibleRecording:()=>true,recordingTrack:r=>({id:'deezer-'+r.id,provider:'deezer',providerId:String(r.id),title:r.title,artist:r.artist.name,popularityRank:r.rank,year:r.year,genres:[],audioUrl:r.preview}),deduplicateRecordings:t=>[...new Map(t.map(v=>[v.id,v])).values()],selectPopularTracks:(t,o)=>{if(t.length<o.count)throw new ApiError(409,'NOT_ENOUGH_TRACKS','');return t;}
 };
 const batches=moduleFor('lib/server/playlist-batches.ts',{...common,'./popular':popular});
 const api=moduleFor('lib/server/ai-playlists.ts',{...common,'./popular':popular,'./playlist-batches':batches,'@/lib/quiz':{difficultyLevel:value=>value??1},'@/lib/track-order':{spreadArtists:t=>t},'./era-verification':{verifyYearRangePool:async(t,from,to)=>t.filter(v=>v.year>=from&&v.year<=to),verifyGenrePool:async t=>t},'./eurovision-registry':{eurovisionSongs:[]},'./collections':{persistCollection:async(...args)=>{persisted.push(args);return {collection:{id:'saved',count:args[3].length}};}}});
 return{rows,searches,discovered,persisted,batches,api,get peak(){return peak;}};
}
const plan={title:'1980s romance',criteria:['Romantic ballads','1980–1989','English lyrics'],artists:[],genres:[],language:'English',years:{from:1980,to:1989}};

test('automatic prompt hints are resolved against the live artist identity; free-form phrases fall through to playlist composition',async()=>{const h=harness();const empty={title:'Alias',criteria:['Alias'],artists:[],genres:[],language:null,years:null};const direct=await h.api.playlistDraft('alice',{action:'start',prompt:'Alias',plan:empty,autoPlan:true},{count:20,allowArtistRepeats:false});assert.deepEqual(JSON.parse(JSON.stringify(direct.plan.artists)),['Artist 1']);const arbitrary=await h.api.playlistDraft('alice',{action:'start',prompt:'Songs for rainy afternoons',plan:{...empty,artists:['for rainy afternoons']},autoPlan:true},{count:20});assert.equal(arbitrary.plan.artists.length,0);assert.equal(arbitrary.prompt,'Songs for rainy afternoons');});
const names=count=>Array.from({length:count},(_,i)=>({artist:'Artist '+(i+1),title:'Song '+(i+1)}));
test('a song group resolves concurrently with bounded requests, preserves identities and caches canonical records',async()=>{
 const h=harness(),result=await h.batches.resolveSongBatch('draft-one',names(12));
 assert.equal(result.length,12);assert.equal(h.peak,4);assert.equal(h.searches.length,12);assert.equal(result[0].title,'Song 1');assert.ok(result.every(t=>t.artist!=='Tribute'));assert.equal(h.discovered.length,12);
 await h.batches.resolveSongBatch('draft-two',names(12));assert.equal(h.searches.length,12);assert.ok(h.rows.has('ai-batch-source:draft-two:12'));
});
test('parallel groups cannot overwrite provenance or inject another draft or owner recording; year mismatch is rejected',async()=>{
 const h=harness(),start=await h.api.playlistDraft('alice',{action:'start',prompt:'80s romance',plan},{difficulty:2});
 const group=await Promise.all([names(12).slice(0,6),names(12).slice(6)].map(candidates=>h.api.playlistDraft('alice',{action:'resolve-batch',id:start.id,candidates},{})));
 assert.equal(group.flatMap(g=>g.candidates).length,12);
 const committed=await h.api.playlistDraft('alice',{action:'commit-batch',id:start.id,candidates:group.flatMap(g=>g.candidates)},{});assert.equal(committed.available,11);assert.ok(!committed.added.some(t=>t.title==='Song 1'));
 const another=await h.api.playlistDraft('alice',{action:'start',prompt:'Different request',plan:{...plan,criteria:['Different']}},{});
 const wrong=await h.api.playlistDraft('alice',{action:'commit-batch',id:another.id,candidates:[group[0].candidates[0]]},{});assert.equal(wrong.available,0);
 await assert.rejects(h.api.playlistDraft('bob',{action:'resolve-batch',id:start.id,candidates:names(1)},{}),e=>e.code==='AI_INVALID_DRAFT');
 await assert.rejects(h.api.playlistDraft('alice',{action:'commit-batch',id:start.id,candidates:[{artist:'Artist 1',title:'Song 1'}]},{}),e=>e.code==='AI_INVALID_CANDIDATES');
 await h.api.playlistDraft('alice',{action:'finish',id:start.id},{count:11});assert.equal(h.persisted[0][3].length,11);
});
test('mini categories store verified facets, respect original conditions, owner, difficulty and proof expiry',async()=>{
 const h=harness(),tracks=await h.batches.resolveSongBatch('draft',names(2)),expires=Date.now()+60000;
 await h.batches.indexMiniCategory('alice',plan,2,tracks,expires,'80s romance');
 const menu=await h.batches.listMiniCategories('alice');assert.equal(menu.length,1);assert.equal(menu[0].count,2);assert.equal(menu[0].prompt,'80s romance');assert.equal(menu[0].tracks,undefined);assert.equal((await h.batches.listMiniCategories('bob')).length,0);
 const saved=await h.batches.readMiniCategory('alice',plan,2,'  80s   ROMANCE ');assert.equal(saved.tracks.length,2);assert.ok(saved.facets.some(f=>f.kind==='era'));assert.ok(saved.facets.some(f=>f.kind==='language'));
 for(const args of[['bob',plan,2,'80s romance'],['alice',plan,10,'80s romance'],['alice',{...plan,criteria:['No ballads']},2,'80s romance'],['alice',plan,2,'80s romance without Queen']])assert.equal(await h.batches.readMiniCategory(...args),null);
 await h.batches.indexMiniCategory('alice',plan,2,tracks,0,'80s romance');assert.equal(await h.batches.readMiniCategory('alice',plan,2,'80s romance'),null);
 assert.ok([...h.rows.keys()].some(k=>k.startsWith('ai-mini-facet-v1:')));
});
test('missing tracks are not fabricated; alias resolution stays canonical and explicit artist IDs cannot expand',async()=>{
 const h=harness();assert.equal((await h.batches.resolveSongBatch('draft',[{artist:'Unknown',title:'Invented'}])).length,0);
 const alias=await h.batches.resolveSongBatch('draft',[{artist:'Alias',title:'Song 1'}]);assert.equal(alias[0].artist,'Artist 1');
 assert.equal((await h.batches.resolveSongBatch('draft',names(2),[1])).length,1);
});

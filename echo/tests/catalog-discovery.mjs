import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
class ApiError extends Error {constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}
function load(file,imports){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:n=>{assert.ok(n in imports,n);return imports[n];},crypto:webcrypto,TextEncoder,Date,Math,JSON,Set,Map});return module.exports;}
function catalog(){const rows=new Map(),calls=[],discovered=[];let dateChecks=0;
 const db={prepare(){return{bind(...args){return{first:async()=>rows.get(args[0])??null,run:async()=>rows.set(args[0],{track_data:args[1],updated_at:args[2]})};}}}};
 const api=load('lib/server/ai-playlists.ts',{'@/lib/quiz':{difficultyLevel:value=>typeof value==='number'?value:1},'@/lib/track-order':{spreadArtists:t=>t},'./http':{ApiError,database:()=>db},'./stored-json':{readJson:async v=>JSON.parse(v),storeJson:async(_,v)=>JSON.stringify(v)},'./popular':{
  resolveArtist:async name=>({id:884422,name}),rememberDiscoveredArtist:async a=>discovered.push(a),
  deezerRequest:async path=>{calls.push(path);const u=new URL(path,'https://api.deezer.com'),start=Number(u.searchParams.get('index')),limit=Number(u.searchParams.get('limit'));return{total:75,data:Array.from({length:Math.min(limit,75-start)},(_,i)=>({id:start+i+1,title:'Пісня '+(start+i+1),artist:{id:884422,name:'Новий український виконавець'},rank:900000-(start+i),release_date:'2023-02-01'}))};},
  eligibleRecording:()=>true,recordingTrack:r=>({id:'deezer-'+r.id,provider:'deezer',providerId:String(r.id),title:r.title,artist:r.artist.name,popularityRank:r.rank,year:2023}),deduplicateRecordings:t=>[...new Map(t.map(v=>[v.id,v])).values()],selectPopularTracks:(t,o)=>{if(t.length<o.count)throw new ApiError(409,'NOT_ENOUGH_TRACKS','');return t;}
 },'./playlist-batches':{readMiniCategory:async()=>null,indexMiniCategory:async()=>0,resolveSongBatch:async()=>[]},'./era-verification':{verifyYearRangePool:async(t,f,to)=>{dateChecks++;return t.filter(v=>v.year>=f&&v.year<=to);},verifyGenrePool:async t=>t},'./eurovision-registry':{eurovisionSongs:[]},'./collections':{persistCollection:async()=>({collection:{id:'saved'}})}});
 return{api,rows,calls,discovered,get dateChecks(){return dateChecks;}};
}
const plan={title:'Українські хіти 20-х',criteria:['Українською','2020–2029'],artists:[],genres:[],language:'Ukrainian',years:{from:2020,to:2029}};
test('live catalog paginates past seven songs, discovers unknown performers and adds canonical provider IDs',async()=>{
 const h=catalog(),draft=await h.api.playlistDraft('owner',{action:'start',prompt:'Українські хіти 20-х',plan},{});let found=0;const all=new Set();
 for(let step=0;step<7;step++){const page=await h.api.playlistDraft('owner',{action:'catalog',id:draft.id,queries:step?[]:['Новий український виконавець']},{});found=page.found;
  for(const song of page.candidates){assert.equal(all.has(song.providerId),false);all.add(song.providerId);}
  for(let i=0;i<page.candidates.length;i+=8)await h.api.playlistDraft('owner',{action:'add',id:draft.id,candidates:page.candidates.slice(i,i+8)},{});
 }
 assert.equal(found,75);assert.equal(all.size,75);assert.ok(h.calls.some(p=>p.includes('index=50')));assert.equal(h.calls.length,3);assert.ok(h.discovered.some(a=>a.id===884422));
 const cache=await h.api.playlistDraft('owner',{action:'lookup',prompt:'Українські хіти 20-х'},{});assert.equal(cache.available,75);
 await h.api.playlistDraft('owner',{action:'finish',id:draft.id},{count:50});
});
test('catalog provenance, canonical identity, ownership and era remain mandatory',async()=>{
 const h=catalog(),draft=await h.api.playlistDraft('owner',{action:'start',prompt:'Ukraine 80s',plan:{...plan,years:{from:1980,to:1989}}},{});
 const page=await h.api.playlistDraft('owner',{action:'catalog',id:draft.id,queries:['Новий український виконавець']},{}),song=page.candidates[0];
 await assert.rejects(h.api.playlistDraft('owner',{action:'add',id:draft.id,candidates:[{...song,providerId:'99999'}]},{}),e=>e.code==='AI_INVALID_CANDIDATES');
 assert.equal((await h.api.playlistDraft('owner',{action:'add',id:draft.id,candidates:[{...song,title:'Fabricated title'}]},{})).available,0);
 assert.equal((await h.api.playlistDraft('owner',{action:'add',id:draft.id,candidates:[song]},{})).available,0);
 await assert.rejects(h.api.playlistDraft('other',{action:'catalog',id:draft.id,queries:[]},{}),e=>e.code==='AI_INVALID_DRAFT');
});
test('requests without an era do not require missing release-date records',async()=>{
 const h=catalog(),draft=await h.api.playlistDraft('owner',{action:'start',prompt:'Ukraine hits',plan:{...plan,years:null}},{}),page=await h.api.playlistDraft('owner',{action:'catalog',id:draft.id,queries:['Новий український виконавець']},{});
 assert.equal((await h.api.playlistDraft('owner',{action:'add',id:draft.id,candidates:page.candidates.slice(0,8)},{})).available,8);assert.equal(h.dateChecks,0);
});
test('AI artist discovery stores verified identities only and handles inflected spelling',async()=>{
 const saved=[],queries=[],response={text:JSON.stringify({names:['alyona alyona','Invented performer']})};
 const api=load('lib/server/artist-discovery.ts',{'./http':{ApiError},'./gemini':{geminiCompletion:async()=>response},'./popular':{resolveArtist:async name=>{if(name==='Invented performer')throw new ApiError(404,'ARTIST_NOT_FOUND','');return{id:54213952,name};},discoverArtistTracks:async()=>86,rememberDiscoveredArtist:async a=>saved.push(a),rememberArtistQuery:async(q,a)=>queries.push({q,a}),publicArtistCard:a=>a}});
 const result=await api.discoverRequestedArtist('owner','пісні Альони Альони');assert.equal(result.artists.length,1);assert.equal(result.artists[0].id,54213952);assert.equal(result.artists[0].availablePreviews,86);assert.equal(saved.length,1);assert.equal(queries[0].q,'пісні Альони Альони');
 response.text=JSON.stringify({names:[]});assert.equal((await api.discoverRequestedArtist('owner','невідомий артист')).artists.length,0);
});

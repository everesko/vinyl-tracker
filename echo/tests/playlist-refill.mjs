import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
class ApiError extends Error{constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}
const plan={title:'Ukrainian hits',criteria:['українські хіти 00-х'],artists:[],genres:[],language:null,years:{from:2000,to:2009}};
const songs=Array.from({length:12},(_,index)=>({artist:'Artist '+index,title:'Song '+index}));
function harness(model){
 const calls=[],fetchCalls=[],persisted=[],rows=new Map(),modules=new Map();
 const overrides={
  './http':{ApiError,database:()=>({prepare(){let args=[];return{bind(...values){args=values;return this;},first:async()=>{const row=rows.get(args[0]);return row?{track_data:row.data,updated_at:row.at}:null;},run:async()=>{rows.set(args[0],{data:args[1],at:Date.now()});return{success:true};}};}})},
  './stored-json':{readJson:async data=>JSON.parse(data),storeJson:async(_id,data)=>JSON.stringify(data)},
  './playlist-history':{getPlayedSongs:async()=>[]},
  './collections':{validatePrompt:value=>value,persistCollection:async(...args)=>{persisted.push(args);return{collection:{id:args[5],count:args[3].length}};}},
  './gemini':{geminiCompletion:async(...args)=>{calls.push(args);const value=await model(calls.length,...args);return{text:JSON.stringify({plan,songs:[],diversityExhausted:false,historyExhausted:false,...value}),model:'gemini-3.5-flash-lite'};}},
  './popular':{catalogArtistNames:name=>[name],recordingTrack:row=>({id:'deezer-'+row.id,provider:'deezer',providerId:String(row.id),artist:row.artist.name,title:row.title,audioUrl:row.preview})},
  '@/lib/track-order':{spreadArtists:tracks=>tracks},
 };
 function read(path){if(modules.has(path))return modules.get(path);const module={exports:{}};modules.set(path,module.exports);const code=ts.transpileModule(fs.readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>overrides[name]??(name==='./server/http'?overrides['./http']:name==='./server/ai-playlists'?read('lib/playlist-plan.ts'):name.startsWith('@/lib/')?read(name.slice(2)+'.ts'):(()=>{throw new Error(name);})()),AbortSignal,AbortController,crypto:webcrypto,TextEncoder,JSON,Date,URL,Error,Response,ReadableStream,console:{warn(){}},setTimeout:(fn,ms)=>setTimeout(fn,Math.min(1,ms)),clearTimeout,fetch:async(url,init)=>{fetchCalls.push({url,init});const query=new URL(url).searchParams.get('q'),index=songs.findIndex(song=>song.artist+' '+song.title===query),song=songs[index];return Response.json({data:song?[{id:index+1000,title:song.title,artist:{id:index+2000,name:song.artist},preview:'https://cdn-preview.dzcdn.net/preview.mp3'}]:[]});}});return module.exports;
 }
 return{api:read('lib/server/fast-playlists.ts'),calls,fetchCalls,persisted};
}
const settings={count:10,difficulty:1,allowArtistRepeats:true};
test('continuation carries exact user conditions and real catalog feedback with a hard used-artist prohibition',()=>{
 const h=harness(()=>({})),request=h.api.playlistRefillRequest('українські хіти 00-х',9,1,true,[{artist:'Played artist',title:'Played song'}],{found:[{artist:'Known artist',title:'Known song'}],attempted:[{artist:'Rejected artist',title:'Unavailable song'}],requested:20,round:3,strictDiversity:true});
 assert.equal(request.purpose,'fast-playlist');assert.match(request.messages[1].content,/9 песен/);assert.match(request.messages[1].content,/1\/10/);assert.match(request.messages[1].content,/українські хіти 00-х/);assert.match(request.messages[1].content,/Played artist:Played song/);assert.match(request.messages[1].content,/Rejected artist:Unavailable song/);assert.match(request.messages[1].content,/Known artist:Known song/);assert.match(request.messages[0].content,/do NOT include any artist/);assert.match(request.messages[0].content,/same|SAME/);assert.match(request.messages[0].content,/Never fabricate/);
});
test('a finite named-artist playlist can request more songs by its requested artists without false diversity bans',()=>{
 const h=harness(()=>({})),request=h.api.playlistRefillRequest('songs by Queen',3,2,true,[],{found:[{artist:'Queen',title:'One'}],attempted:[],requested:10,round:1,strictDiversity:false});assert.ok(!request.messages[0].content.includes('do NOT include any artist'));assert.ok(!request.messages[0].content.includes('OTHER qualifying performers'));assert.match(request.messages[0].content,/DIFFERENT original songs by those permitted artists/);assert.match(request.messages[1].content,/Queen/);
 const initial=h.api.playlistRequest('songs by Queen',10,2,true,[]);assert.match(initial.messages[0].content,/ALL primary AND reserve songs must be ONLY by those requested artists/);assert.match(initial.messages[1].content,/резервы тоже только их песни/);assert.ok(!initial.messages[1].content.includes('только других исполнителей'));
});
test('successful partial continuations keep filling beyond two refills until the exact count is reached',async()=>{
 const h=harness(index=>({songs:songs.slice((index-1)*2,index*2)})),progress=[];await h.api.generateFastPlaylist('owner',{prompt:'українські хіти 00-х'},settings,new AbortController().signal,event=>progress.push(event));
 assert.equal(h.calls.length,5);assert.equal(h.persisted.length,1);assert.equal(h.persisted[0][3].length,10);assert.equal(new Set(h.persisted[0][3].map(track=>track.catalogArtistId)).size,10);assert.equal(h.persisted[0][6].catalogRefills,4);assert.equal(h.fetchCalls.length,10);assert.ok(progress.every(event=>event.resolved<=10));assert.ok(progress.every((event,index)=>!index||event.progress>=progress[index-1].progress));
});
test('repeated or empty ineffective continuations cannot run forever or save a short playlist',async()=>{
 const h=harness(()=>({songs:songs.slice(0,2)}));await assert.rejects(h.api.generateFastPlaylist('owner',{prompt:'українські хіти 00-х'},settings,new AbortController().signal),error=>error.code==='AI_SEARCH_INCOMPLETE'&&error.extra.available===2);assert.equal(h.calls.length,3);assert.equal(h.fetchCalls.length,2);assert.equal(h.persisted.length,0);
});
test('used artists are removed before unnecessary catalog calls while other performer slots are missing',async()=>{
 const h=harness(index=>({songs:index===1?songs.slice(0,2):index===2?[{artist:'Artist 0',title:'An unnecessary duplicate artist song'},...songs.slice(2,10)]:[]}));await h.api.generateFastPlaylist('owner',{prompt:'українські хіти 00-х'},settings,new AbortController().signal);assert.equal(h.persisted[0][3].length,10);assert.ok(h.fetchCalls.every(call=>!call.url.includes('unnecessary')));assert.equal(h.calls.length,2);
});
test('the user can cancel a later continuation with no partial saved deck',async()=>{
 let start;const begun=new Promise(resolve=>start=resolve),controller=new AbortController(),h=harness(index=>{if(index<4)return{songs:songs.slice((index-1)*2,index*2)};start();return new Promise(()=>{});});const pending=h.api.generateFastPlaylist('owner',{prompt:'українські хіти 00-х'},settings,controller.signal);await begun;controller.abort();await assert.rejects(pending,error=>error.code==='CANCELLED');assert.equal(h.calls.length,4);assert.equal(h.persisted.length,0);assert.ok(h.calls[3][2].aborted);
});

import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import ts from 'typescript';import {webcrypto}from'node:crypto';import {DatabaseSync}from'node:sqlite';
function load(file,imports={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];},Date,Math,crypto:webcrypto,TextEncoder,Uint8Array,JSON,Set,Map});return module.exports;}
class ApiError extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code});}}
const quiz=load('lib/quiz.ts'),order=load('lib/track-order.ts'),settings={duration:7,timer:false,mode:'both',difficulty:1,count:2,allowArtistRepeats:false},nonce='372fae08-51bc-4c25-8d78-a8a6c27c3a1e';
function harness({wait=async()=>{},songOnly=false}={}){
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../drizzle/0000_brave_dazzler.sql',import.meta.url),'utf8'));let selections=0;
 const database={prepare(sql){return{bind(...args){return{async first(){return db.prepare(sql).get(...args)??null;},async run(){return db.prepare(sql).run(...args);}};}};}};
 const api=load('lib/server/games.ts',{'@/lib/quiz':quiz,'@/lib/track-order':order,'./http':{ApiError,database:()=>database},'./stored-json':{storeJson:async(_key,value)=>JSON.stringify(value),readJson:async text=>JSON.parse(text)},'./playlist-history':{playlistPromptForCollection:async()=>undefined,recordPlayedSong:async()=>{},playedSongsFromState:()=>[]},'./progression':{ensureSettings:async()=>({practice:true})},'./catalog':{gameCollection:async(_owner,id)=>{selections++;await wait();return{collection:{title:id},songOnly,deck:[{id:'1',artist:'Artist 1',title:'Song 1'},{id:'2',artist:songOnly?'Artist 1':'Artist 2',title:'Song 2'}]};}}});
 return{api,db,get selections(){return selections;},count(){return db.prepare('SELECT COUNT(*) AS n FROM echo_games').get().n;},rows(){return db.prepare('SELECT * FROM echo_games ORDER BY user_id').all();}};
}
test('repeating the same creation nonce returns exactly one session without resolving the catalog again',async()=>{
 const h=harness({songOnly:true});try{const a=await h.api.createGame('alice','custom-one',settings,nonce),b=await h.api.createGame('alice','custom-one',settings,nonce.toUpperCase());assert.equal(a.id,b.id);assert.equal(h.count(),1);assert.equal(h.selections,1);assert.equal(b.songOnly,true);assert.equal(b.settings.mode,'song');}finally{h.db.close();}
});
test('concurrent creation with the same nonce inserts one immutable session',async()=>{
 let release;const barrier=new Promise(resolve=>release=resolve),h=harness({wait:()=>barrier});try{const pending=[1,2,3].map(()=>h.api.createGame('alice','custom-one',settings,nonce));while(h.selections<3)await new Promise(resolve=>setImmediate(resolve));release();const games=await Promise.all(pending);assert.equal(new Set(games.map(game=>game.id)).size,1);assert.equal(h.count(),1);assert.deepEqual(games.map(game=>game.track.id),[games[0].track.id,games[0].track.id,games[0].track.id]);}finally{h.db.close();}
});
test('the nonce belongs to the owner and cannot reuse, read or replace another owner session',async()=>{
 const h=harness();try{const a=await h.api.createGame('alice','custom-one',settings,nonce),b=await h.api.createGame('bob','custom-one',settings,nonce);assert.notEqual(a.id,b.id);assert.equal(h.count(),2);assert.deepEqual(h.rows().map(row=>row.user_id),['alice','bob']);await assert.rejects(h.api.loadGame('bob',a.id),error=>error.code==='GAME_NOT_FOUND');}finally{h.db.close();}
});
test('different parameters under the same nonce are rejected and cannot mutate its game',async()=>{
 const h=harness();try{await h.api.createGame('alice','custom-one',settings,nonce);const before=JSON.stringify(h.rows());for(const [collection,changed]of[['custom-two',settings],['custom-one',{...settings,duration:3}],['custom-one',{...settings,count:20}]])await assert.rejects(h.api.createGame('alice',collection,changed,nonce),error=>error.code==='GAME_REQUEST_CONFLICT');assert.equal(JSON.stringify(h.rows()),before);assert.equal(h.count(),1);}finally{h.db.close();}
});
test('invalid creation IDs are rejected before any catalog lookup or session write',async()=>{
 const h=harness();try{for(const invalid of [null,{},'',nonce+'\n','x'+nonce,'not-a-uuid'])await assert.rejects(h.api.createGame('alice','custom-one',settings,invalid),error=>error.code==='INVALID_GAME_REQUEST');assert.equal(h.count(),0);assert.equal(h.selections,0);}finally{h.db.close();}
});

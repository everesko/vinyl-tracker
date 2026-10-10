import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';

class RequestError extends Error{constructor(code,message='',data={}){super(message);Object.assign(this,{code,data});}}
class PlaylistAIError extends Error{constructor(code){super(code);this.code=code;}}
const source=fs.readFileSync(new URL('../app/echo-app.tsx',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('function generationWait('),source.indexOf('function category('));
const gameFlow=source.slice(source.indexOf(' const prepareGameFlow='),source.indexOf(' const exit='));
const generation=source.slice(source.indexOf(' const generateAICollection='),source.indexOf(' const createCollection='));
const creation=source.slice(source.indexOf(' const createCollection='),source.indexOf(' const visible='));
const script=ts.transpileModule(helpers+'\n'+gameFlow+'\n'+generation+'\n'+creation+'\nmodule.exports={generateAICollection,generationWait,generationRetry,prepareRequest,prepareGameFlow,startGame,begin,createCollection};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const plan={title:'Українські хіти 00-х',criteria:['Ukrainian hits'],artists:[],genres:[],language:'Ukrainian',years:{from:2000,to:2009}};
const names=(count,offset=0)=>Array.from({length:count},(_,i)=>({artist:'Artist '+(offset+i),title:'Song '+(offset+i)}));
function harness({count=20,repeat=true,suggest,api,timers='automatic',searchMode='catalog',catalog=[{id:'popular-rock',category:'genre'}]}={}){
 let now=1000,state=null,serial=0,generating=false,note='';const scheduled=new Map(),delays=[],calls=[],routes=[],signals=[],phases=[],statuses=[],games=[],generationAbort={current:null},module={exports:{}};
 class Clock extends Date{static now(){return now;}}
 const ctx={module,exports:module.exports,RequestError,PlaylistAIError,AbortController,Date:Clock,Math,Set,Map,Number,Promise,crypto:webcrypto,
  settings:{count,duration:7,timer:false,difficulty:1,allowArtistRepeats:repeat},generationAbort,
  profile:{progression:{practice:true}},operation:{current:false},alive:{current:true},gameRef:{current:null},availableSettings:settings=>settings,category:item=>item.category,searchMode,prompt:'Music',catalog,
  document:{getElementById:()=>({scrollIntoView(){}})},history:{replaceState(){}},setGame:value=>games.push(value),setGenerating:value=>generating=value,setBusy(){},setNote:value=>note=value,setCatalog(){},setAccount(){},toast:{success(){},error(){}},
  window:{setTimeout(callback,delay){const id=++serial;delays.push(delay);scheduled.set(id,callback);if(timers==='automatic')queueMicrotask(()=>{if(scheduled.has(id)){scheduled.delete(id);now+=delay;callback();}});return id;},clearTimeout:id=>scheduled.delete(id)},
  setAIStatus(value){statuses.push(value);},setGenerationState(update){state=typeof update==='function'?update(state):update;if(state)phases.push({...state});},setPreparing(){},t:key=>key,errorRef:{current:error=>error.code},planFromPrompt:()=>plan,
  request:async(url,payload,_method,signal)=>{calls.push(payload);routes.push(url);signals.push(signal);if(api)return api(payload,url,signal);if(url==='/api/collections')return{collection:{id:'catalog-finished'}};if(url==='/api/games')return{id:'game-ready',total:count};if(payload.action==='lookup')return{hit:false};if(payload.action==='start')return{id:'draft',plan,available:0,availableArtists:0,candidates:[]};if(payload.action==='keep-alive')return{id:'draft',expires:now+86400000};if(payload.action==='resolve-batch')return{candidates:payload.candidates.map(t=>({...t,providerId:t.title})),found:payload.candidates.length,searched:payload.candidates.length};if(payload.action==='commit-batch')return{available:count,availableArtists:count,added:payload.candidates};if(payload.action==='finish')return{collection:{id:'finished'}};throw Error('Unexpected action '+payload.action);},
  suggestPlaylist:async(...args)=>suggest?suggest(args,{advance:milliseconds=>now+=milliseconds,controller:generationAbort.current}):names(args[4]),
 };
 vm.runInNewContext(script,ctx);return{...module.exports,calls,routes,signals,phases,statuses,games,delays,scheduled,generationAbort,get state(){return state;},get generating(){return generating;},get note(){return note;},abort(){generationAbort.current?.abort();}};
}
test('one AI list is resolved in parallel 12-song groups, then verified before finishing',async()=>{
 let active=0,peak=0,available=0;const h=harness({api:async payload=>{switch(payload.action){case'lookup':return{hit:false};case'start':return{id:'draft',plan,available:0,availableArtists:0,candidates:[]};case'resolve-batch':active++;peak=Math.max(peak,active);await Promise.resolve();active--;return{candidates:payload.candidates.map(t=>({...t,providerId:t.title})),found:payload.candidates.length,searched:payload.candidates.length};case'commit-batch':available+=payload.candidates.length;return{available,availableArtists:available,added:payload.candidates};case'finish':assert.equal(available,20);return{collection:{id:'done'}};default:throw Error(payload.action);}}});
 assert.equal((await h.generateAICollection('українські хіти 00-х')).collection.id,'done');assert.equal(peak,2);assert.deepEqual(h.calls.filter(p=>p.action==='resolve-batch').map(p=>p.candidates.length),[12,8]);assert.equal(h.calls.filter(p=>p.action==='commit-batch').length,1);
});
test('more than six rejected replacement rounds and more than an hour still reach the exact target',async()=>{
 let proposals=0,commits=0;const rounds=[];const h=harness({count:1,suggest:async(args,clock)=>{rounds.push(args[9]);clock.advance(11*60000);return names(1,proposals++);},api:async payload=>{switch(payload.action){case'lookup':return{hit:false};case'start':return{id:'draft',plan,available:0,availableArtists:0,candidates:[]};case'keep-alive':return{id:'draft'};case'resolve-batch':return{candidates:payload.candidates.map(t=>({...t,providerId:t.title})),found:1,searched:1};case'commit-batch':commits++;return{available:commits>=8?1:0,availableArtists:commits>=8?1:0,added:commits>=8?payload.candidates:[]};case'finish':assert.equal(commits,8);return{collection:{id:'complete'}};}}});
 assert.equal((await h.generateAICollection('українські хіти 00-х')).collection.id,'complete');assert.equal(proposals,8);assert.deepEqual(rounds,[0,1,2,3,4,5,6,7]);assert.ok(h.calls.some(p=>p.action==='keep-alive'));assert.ok(h.delays.every(delay=>delay<=30000),'no total-duration timer');
});
test('empty and duplicate proposals do not complete a short playlist and receive new proposal numbers',async()=>{
 let proposals=0;const h=harness({count:1,suggest:async args=>{assert.equal(args[9],proposals);return ++proposals<=2?[]:names(1);}});
 assert.equal((await h.generateAICollection('Music')).collection.id,'finished');assert.equal(proposals,3);assert.deepEqual(h.delays,[500,1000]);assert.equal(h.calls.filter(p=>p.action==='finish').length,1);
});
test('temporary AI and catalog transport errors retry with backoff, keeping the same verified draft',async()=>{
 let attempts=0;const h=harness({count:1,suggest:async args=>{if(attempts++===0)throw new RequestError('GEMINI_UNAVAILABLE');assert.equal(args[9],1);return names(1);}});
 await h.generateAICollection('Music');assert.equal(attempts,2);assert.equal(h.calls.filter(p=>p.action==='start').length,1);assert.deepEqual(h.delays,[1000]);
 let requests=0;const result=await h.generationRetry(async()=>{if(requests++<2)throw new RequestError('NETWORK');return 12;});assert.equal(result,12);assert.equal(requests,3);assert.deepEqual(h.delays,[1000,1000,2000]);
});
test('cancel immediately interrupts a stalled replacement wait and never finishes a partial collection',async()=>{
 const h=harness({count:1,timers:'manual',suggest:async()=>[]}),operation=h.generateAICollection('Music');
 while(!h.scheduled.size)await Promise.resolve();h.abort();await assert.rejects(operation,error=>error.code==='CANCELLED');assert.equal(h.scheduled.size,0);assert.equal(h.generationAbort.current,null);assert.equal(h.state,null);assert.ok(!h.calls.some(p=>p.action==='finish'));
});
test('configuration, authentication and quota failures stay actionable and never create a busy retry loop',async()=>{
 for(const code of ['GEMINI_QUOTA','GEMINI_KEY','GEMINI_NOT_CONFIGURED','AUTH_REQUIRED']){const h=harness({count:1,suggest:async()=>{throw new RequestError(code);}});await assert.rejects(h.generateAICollection('Music'),error=>error.code===code);assert.deepEqual(h.delays,[]);assert.ok(!h.calls.some(p=>p.action==='finish'));}
});
test('all transient public catalog errors retry without resetting verified progress',async()=>{
 for(const code of ['MUSIC_RATE_LIMIT','MUSIC_TIMEOUT','MUSIC_PROVIDER_ERROR','MUSIC_INVALID_RESPONSE','SOURCE_PROVIDER_ERROR']){const h=harness();let attempts=0;assert.equal(await h.generationRetry(async()=>{if(!attempts++)throw new RequestError(code);return 7;}),7);assert.equal(attempts,2);assert.deepEqual(h.delays,[1000]);}
});
test('a strict unique-artist shortfall remains incomplete, explains the constraint and can be cancelled',async()=>{
 let proposals=0;const h=harness({count:2,repeat:false,suggest:async(_args,{controller})=>{if(++proposals===6){controller.abort();return [];}return names(2);},api:async payload=>{switch(payload.action){case'lookup':return{hit:false};case'start':return{id:'draft',plan,available:0,availableArtists:0,candidates:[]};case'resolve-batch':return{candidates:payload.candidates.map(t=>({...t,providerId:t.title})),found:payload.candidates.length,searched:payload.candidates.length};case'commit-batch':return{available:1,availableArtists:1,added:[payload.candidates[0]]};default:throw Error('Unexpected action '+payload.action);}}});
 await assert.rejects(h.generateAICollection('Very narrow condition'),error=>error.code==='CANCELLED');assert.ok(h.statuses.includes('generation.uniqueContinuing'));assert.ok(!h.calls.some(p=>p.action==='finish'));assert.ok(h.phases.every(state=>state.available<=1));
});
test('partial date evidence never inflates the verified count before all category checks finish',async()=>{
 let verifying=0;const h=harness({count:2,api:async payload=>{switch(payload.action){case'lookup':return{hit:false};case'start':return{id:'draft',plan,available:0,availableArtists:0,candidates:[]};case'resolve-batch':return{candidates:payload.candidates.map(t=>({...t,providerId:t.title})),found:payload.candidates.length,searched:payload.candidates.length};case'commit-batch':if(!verifying++)throw new RequestError('CATALOG_PREPARING','',{available:2,required:2,canRetry:true});assert.equal(h.phases.at(-1).available,0);return{available:2,availableArtists:2,added:payload.candidates};case'finish':return{collection:{id:'done'}};}}});
 await h.generateAICollection('Music');assert.equal(verifying,2);assert.ok(h.phases.some(state=>state.available===2));
});
test('independent source preparation can continue beyond the former time and attempt limits',async()=>{
 let attempts=0;const h=harness({api:async()=>{if(attempts++<700)throw new RequestError('CATALOG_PREPARING','',{available:0,required:1,canRetry:true});return{available:1};}});
 const result=await h.prepareRequest('/api/collections/local-ai',{},()=>{});assert.equal(result.available,1);assert.equal(attempts,701);assert.ok(h.delays.reduce((sum,delay)=>sum+delay,0)>180000);assert.ok(h.delays.every(delay=>delay<=3000));
});
for(const path of ['ready-catalog','catalog-search','artists'])test(path+' preparation exposes real progress and immediate cancellation throughout CATALOG_PREPARING',async()=>{
 const h=harness({count:10,timers:'manual',api:async()=>{throw new RequestError('CATALOG_PREPARING','',{available:3,required:10,canRetry:true});}});
 const operation=path==='ready-catalog'?h.begin('popular-rock'):h.createCollection(path==='artists'?[{id:'1',name:'Artist'}]:undefined);
 while(!h.scheduled.size)await Promise.resolve();assert.equal(h.generating,true);assert.equal(h.state.available,3);assert.equal(h.state.required,10);assert.equal(h.state.phase,'verifying');assert.ok(h.signals.every(signal=>signal===h.generationAbort.current.signal));h.abort();await operation;
 assert.equal(h.scheduled.size,0);assert.equal(h.generating,false);assert.equal(h.state,null);assert.equal(h.generationAbort.current,null);assert.equal(h.games.length,0);assert.equal(h.note,'CANCELLED');if(path!=='ready-catalog')assert.ok(!h.routes.includes('/api/games'));
});
test('catalog creation retains a single live progress controller until game startup completes',async()=>{
 let finishGame;const h=harness({count:10,api:async(_payload,url)=>{if(url==='/api/collections')return{collection:{id:'catalog-finished'}};if(url==='/api/games')return await new Promise(resolve=>finishGame=resolve);throw Error(url);}}),operation=h.createCollection();
 while(!finishGame)await Promise.resolve();assert.equal(h.generating,true);assert.ok(h.state);assert.equal(h.signals.length,2);assert.equal(h.signals[0],h.signals[1]);finishGame({id:'new-game',total:10});await operation;assert.equal(h.games.length,1);assert.equal(h.games[0].id,'new-game');assert.equal(h.generating,false);assert.equal(h.state,null);
});
test('a late successful game response after cancel never opens the game',async()=>{
 let finishGame;const h=harness({count:10,api:async(_payload,url)=>{if(url==='/api/collections')return{collection:{id:'catalog-finished'}};if(url==='/api/games')return await new Promise(resolve=>finishGame=resolve);throw Error(url);}}),operation=h.createCollection();
 while(!finishGame)await Promise.resolve();h.abort();finishGame({id:'late-game',total:10});await operation;assert.equal(h.games.length,0);assert.equal(h.note,'CANCELLED');assert.equal(h.generating,false);assert.equal(h.state,null);
});
test('an AI creation shares its existing controller and progress through the following game request',async()=>{
 const h=harness({count:20,searchMode:'ai'});await h.createCollection();assert.equal(h.games.length,1);assert.equal(h.routes.at(-1),'/api/games');assert.ok(h.signals.every(signal=>signal===h.signals[0]));assert.equal(h.generating,false);assert.equal(h.state,null);
});
test('game startup keeps the same creation nonce while retrying a lost response',async()=>{
 let gameRequests=0;const h=harness({count:10,api:async(_payload,url)=>{if(url==='/api/collections')return{collection:{id:'catalog-finished'}};if(url==='/api/games'){if(!gameRequests++)throw new RequestError('NETWORK');return{id:'game-ready',total:10};}throw Error(url);}});
 await h.createCollection();assert.equal(h.games.length,1);const attempts=h.calls.filter(payload=>payload.requestId);assert.equal(attempts.length,2);assert.equal(attempts[0].requestId,attempts[1].requestId);assert.match(attempts[0].requestId,/^[a-f0-9-]{36}$/);assert.equal(h.signals.at(-1),h.signals[0]);
});

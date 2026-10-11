import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';

class ApiError extends Error {constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}
const sample=(artist,title,recognition=10,year=2004,fit='Ukrainian romantic love ballad about devotion')=>({artist,title,recognition,year,fit,language:'Ukrainian'});
const plan={title:'Romantic ballads',criteria:['romantic ballads'],artists:[],genres:['pop'],language:null,years:null};
function load(options={}){
 const stored=new Map(),modelCalls=[],fetchCalls=[],persisted=[],historyCalls=[],modules=new Map();
 let active=0,maximum=0;
 const fixture=options.songs??Array.from({length:5},(_,i)=>sample('Artist '+i,'Song '+i));
 const env={ApiError,database:()=>({prepare(query){let args=[];return{bind(...values){args=values;return this;},async first(){if(query.startsWith('SELECT recipe'))return options.existing??null;const row=stored.get(args[0]);return row?{track_data:row.data,updated_at:row.at}:null;},async run(){stored.set(args[0],{data:args[1],at:Date.now()});return{success:true};}};}})};
 const overrides={
  './http':env,'./server/http':env,
  './stored-json':{readJson:async value=>JSON.parse(value),storeJson:async(_id,value)=>JSON.stringify(value)},
  './playlist-history':{getPlayedSongs:async(...args)=>{historyCalls.push(args);return options.history??[];}},
  './collections':{validatePrompt:value=>{if(typeof value!=='string'||!value.trim()||value.length>1000)throw new ApiError(400,'INVALID_PROMPT','');return value.trim();},persistCollection:async(...args)=>{persisted.push(args);return{collection:{id:args[5],title:args[1],count:args[3].length},reason:args[2],source:args[4]};}},
  './gemini':{geminiCompletion:async(...args)=>{modelCalls.push(args);if(options.model)return options.model(...args);return{text:JSON.stringify({plan:options.plan??plan,songs:fixture,diversityExhausted:options.diversityExhausted??false,historyExhausted:options.historyExhausted??false}),model:'gemini-3.5-flash-lite'};}},
  './popular':{eligibleRecording:record=>record.readable!==false&&!!record.preview,recordingTrack:record=>({id:'deezer-'+record.id,provider:'deezer',providerId:String(record.id),artist:record.artist.name,title:record.title,year:0,audioUrl:record.preview,popularityRank:record.rank})},
  '@/lib/track-order':{spreadArtists:tracks=>tracks},
 };
 function read(relative){if(modules.has(relative))return modules.get(relative);const module={exports:{}};modules.set(relative,module.exports);
  const code=ts.transpileModule(fs.readFileSync(new URL('../'+relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(overrides[name])return overrides[name];if(name.startsWith('@/lib/'))return read(name.slice(2)+'.ts');if(name==='./server/ai-playlists')return read('lib/playlist-plan.ts');throw new Error('Unexpected import '+name);},crypto:webcrypto,AbortController,AbortSignal,JSON,Date,Error,Response,ReadableStream,TextEncoder,console,setTimeout:options.setTimeout??((fn,ms)=>setTimeout(fn,ms===29000?ms:Math.min(ms,2))),clearTimeout,fetch:async(url,init)=>{
   fetchCalls.push({url,init});active++;maximum=Math.max(maximum,active);
   try{
    if(options.fetch)return await options.fetch(url,init,fetchCalls.length);
    await new Promise(resolve=>setTimeout(resolve,options.fetchDelay??6));
    const query=new URL(url).searchParams.get('q'),index=fixture.findIndex(song=>song.artist+' '+song.title===query),artist=fixture[index]?.artist,title=fixture[index]?.title;
    if(index<0||options.missing?.includes(title))return Response.json({data:[]});
    return Response.json({data:[{id:1000+index,title,artist:{id:options.artistIds?.[artist]??2000+index,name:artist},rank:1000000-index*30000,preview:'https://cdn.test/song.mp3'}]});
   }finally{active--;}
  }});return module.exports;
 }
 const api=read('lib/server/fast-playlists.ts');return{api,stored,modelCalls,fetchCalls,persisted,historyCalls,get maximum(){return maximum;}};
}
const settings={count:4,difficulty:1,allowArtistRepeats:true};

test('one Gemini list preserves all request settings and actual played history',()=>{
 const h=load(),request=h.api.playlistRequest('українські романтичні хіти 00-х',20,6,false,[{artist:'Океан Ельзи',title:'Обійми'}]);
 assert.equal(request.purpose,'fast-playlist');assert.equal(request.limit,40);assert.equal(request.messages.length,2);
 const prompt=request.messages[1].content;assert.match(prompt,/20 песен/);assert.match(prompt,/6\/10/);assert.match(prompt,/без повторов/);assert.match(prompt,/українські романтичні хіти 00-х/);assert.match(prompt,/Океан Ельзи:Обійми/);
 assert.match(request.messages[0].content,/ballads AND romantically themed/);assert.match(request.messages[0].content,/EVEN IF repeats are enabled/);
});

test('full exact Deezer deck is resolved in bounded parallel and progress hides song answers',async()=>{
 const h=load({songs:Array.from({length:10},(_,i)=>sample('Artist '+i,'Song '+i))}),progress=[];
 const result=await h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'}, {...settings,count:8},new AbortController().signal,event=>progress.push(event));
 assert.equal(result.collection.count,8);assert.equal(h.modelCalls.length,1);assert.equal(h.persisted.length,1);assert.equal(h.persisted[0][3].length,8);
 assert.ok(h.maximum>1&&h.maximum<=6);assert.ok(h.fetchCalls.every(call=>call.init.signal instanceof AbortSignal));
 assert.ok(progress.some(event=>event.stage==='resolving'&&event.processed>0));assert.ok(!JSON.stringify(progress).includes('Song 0'));
 assert.equal(h.persisted[0][6].version,2);assert.equal(h.persisted[0][6].classificationSource,'gemini');
});

test('every new generation calls Gemini even when exact Deezer identities are cached',async()=>{
 const h=load({songs:Array.from({length:5},(_,i)=>sample('Artist '+i,'Song '+i))});
 for(let i=0;i<2;i++)await h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,new AbortController().signal);
 assert.equal(h.modelCalls.length,2);assert.equal(h.fetchCalls.length,5);assert.equal(h.persisted.length,2);
});

test('only played exclusions are removed; the entire unplayed generated deck remains eligible',async()=>{
 const songs=Array.from({length:5},(_,i)=>sample('Artist '+i,'Song '+i)),h=load({songs,history:[{artist:'Artist 0',title:'Song 0'}]});
 await h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,new AbortController().signal);
 assert.equal(h.historyCalls[0][0],'owner');assert.equal(h.historyCalls[0][1],'romantic ballads');
 assert.ok(!h.persisted[0][3].some(track=>track.title==='Song 0'));assert.ok(h.persisted[0][3].some(track=>track.title==='Song 1'));
 assert.equal(h.fetchCalls.length,4);
});

test('played songs are last-resort choices only with explicit history exhaustion',async()=>{
 const songs=[sample('A','Fresh'),sample('B','Played'),sample('C','Also played')],history=[{artist:'B',title:'Played'},{artist:'C',title:'Also played'}];
 const strict=load({songs,history});
 await assert.rejects(strict.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},{...settings,count:3},new AbortController().signal),error=>error.code==='AI_SEARCH_INCOMPLETE');assert.equal(strict.persisted.length,0);
 const exhausted=load({songs,history,historyExhausted:true});
 await exhausted.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},{...settings,count:3},new AbortController().signal);
 assert.equal(exhausted.persisted[0][3][0].title,'Fresh');assert.equal(exhausted.persisted[0][3].length,3);
});

test('history fallback uses different old performers before fresh repeated performers',async()=>{
 const songs=[sample('A','Fresh one'),sample('A','Fresh two'),sample('B','Played one'),sample('C','Played two')],history=[{artist:'B',title:'Played one'},{artist:'C',title:'Played two'}];
 const h=load({songs,history,historyExhausted:true,diversityExhausted:true,artistIds:{A:1,B:2,C:3},plan:{...plan,artists:['A','B','C']}});
 await h.api.generateFastPlaylist('owner',{prompt:'songs by A and B and C'},{...settings,count:3},new AbortController().signal);
 assert.equal(new Set(h.persisted[0][3].map(track=>track.catalogArtistId)).size,3);assert.ok(!h.persisted[0][3].some(track=>track.title==='Fresh two'));
});

test('artist diversity wins even with repeats enabled; insufficient no-repeat count never persists',async()=>{
 const songs=[sample('A','One'),sample('A','Two'),sample('B','Three'),sample('C','Four'),sample('D','Five')],h=load({songs,artistIds:{A:1,B:2,C:3,D:4},diversityExhausted:true});
 await h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,new AbortController().signal);
 assert.equal(new Set(h.persisted[0][3].map(track=>track.catalogArtistId)).size,4);
 const few=load({songs:songs.slice(0,3),artistIds:{A:1,B:2},diversityExhausted:true});
 await assert.rejects(few.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,new AbortController().signal),error=>error.code==='AI_SEARCH_INCOMPLETE');assert.equal(few.persisted.length,0);
 const permitted=load({songs:songs.slice(0,3),artistIds:{A:1,B:2},diversityExhausted:true,plan:{...plan,artists:['A','B']}});
 await permitted.api.generateFastPlaylist('owner',{prompt:'songs by A and B'},{...settings,count:3},new AbortController().signal);assert.equal(permitted.persisted[0][3].length,3);
 const forbidden=load({songs:songs.slice(0,3),artistIds:{A:1,B:2},diversityExhausted:true});
 await assert.rejects(forbidden.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},{...settings,count:3,allowArtistRepeats:false},new AbortController().signal),error=>error.code==='AI_SEARCH_INCOMPLETE');
});

test('incorrect mood, explicit era/language and wrong difficulty never qualify',()=>{
 const h=load();
 const rows=[sample('A','Highway to Hell',10,2004),sample('B','Wrong Mood',10,2004,'Slow melancholy ballad'),sample('C','Wrong Era',10,1979),sample('D','Wrong Difficulty',2,2004),{...sample('E','Wrong Language'),language:'English'},sample('G','Heartbreak Rock',10,2004,'Heartbreak rock anthem'),sample('H','Love Rock',10,2004,'Romantic love rock anthem'),sample('F','Correct')];
 const result=h.api.parsePlaylistResponse(JSON.stringify({plan,songs:rows,diversityExhausted:false,historyExhausted:false}),'українські романтичні балади українською 00-х',1,20);
 assert.equal(result.songs.length,1);assert.equal(result.songs[0].title,'Correct');assert.deepEqual(JSON.parse(JSON.stringify(result.plan.years)),{from:2000,to:2009});assert.equal(result.plan.language,'Ukrainian');
 assert.ok(result.plan.criteria.some(criterion=>criterion.includes('українські романтичні балади')));
});

test('Ukrainian scene allows regional Russian-language hits but rejects unrelated American hits',()=>{
 const h=load(),regional={...sample('Бумбокс','Вахтерам',10,2007,'Ukrainian scene iconic 2000s hit'),language:'Russian'},american={...sample('Eminem','Without Me',10,2002,'American hip-hop hit'),language:'English'};
 const response=JSON.stringify({plan:{...plan,language:'Ukrainian'},songs:[regional,american],diversityExhausted:false,historyExhausted:false});
 const broad=h.api.parsePlaylistResponse(response,'українські хіти 00-х',1,20);assert.equal(broad.songs.length,1);assert.equal(broad.songs[0].title,'Вахтерам');assert.equal(broad.plan.language,null);
 const lyrics=h.api.parsePlaylistResponse(response,'українські хіти українською 00-х',1,20);assert.equal(lyrics.songs.length,0);assert.equal(lyrics.plan.language,'Ukrainian');
});
test('excluded ballads/country/decade are not imposed as positive conditions',()=>{
 const h=load(),song={...sample('Queen','Somebody to Love',10,1976,'British rock love anthem'),language:'English'},response=JSON.stringify({plan:{...plan,years:{from:1970,to:1979}},songs:[song],diversityExhausted:false,historyExhausted:false});
 const parsed=h.api.parsePlaylistResponse(response,'rock hits without Ukrainian ballads from the 1980s',1,10);assert.equal(parsed.songs.length,1);assert.equal(parsed.plan.years.from,1970);assert.ok(parsed.plan.criteria.some(c=>c.includes('without Ukrainian')));
});

test('wrong Deezer artist/title identities and missing previews are never replaced with unrelated tracks',async()=>{
 const h=load({fetch:async()=>Response.json({data:[{id:9,title:'Unrelated hit',artist:{id:10,name:'Somebody else'},rank:1000000,preview:'https://cdn.test/song.mp3'}]})});
 await assert.rejects(h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,new AbortController().signal),error=>error.code==='AI_SEARCH_INCOMPLETE');assert.equal(h.persisted.length,0);
});

test('ISO Ukrainian language and Latin catalog spelling resolve the same song',async()=>{
 const songs=[{...sample('Океан Ельзи','Не питай'),language:'uk'}],h=load({songs,fetch:async()=>Response.json({data:[{id:91,title:'Ne pytai',artist:{id:92,name:'Okean Elzy'},rank:900000,preview:'https://cdn.test/song.mp3'}]})});
 const result=await h.api.generateFastPlaylist('owner',{prompt:'українські хіти 00-х'},{...settings,count:1},new AbortController().signal);
 assert.equal(result.collection.count,1);assert.equal(h.persisted[0][3][0].providerId,'91');
 const other=load({songs,fetch:async()=>Response.json({data:[{id:91,title:'Bez boiu',artist:{id:92,name:'Okean Elzy'},rank:900000,preview:'https://cdn.test/song.mp3'}]})});
 await assert.rejects(other.api.generateFastPlaylist('owner',{prompt:'українські хіти 00-х'},{...settings,count:1},new AbortController().signal),error=>error.code==='AI_SEARCH_INCOMPLETE');
});

test('Cyrillic artist lookup falls back once to the title and verifies the canonical performer',async()=>{
 const songs=[{...sample('Тіна Кароль','Вище хмар'),language:'ukr'}],h=load({songs,fetch:async url=>Response.json({data:new URL(url).searchParams.get('q')==='Вище хмар'?[{id:93,title:'Вище хмар',artist:{id:94,name:'Tina Karol'},rank:900000,preview:'https://cdn.test/song.mp3'},{id:95,title:'Вище хмар',artist:{id:96,name:'SHUMEI'},rank:950000,preview:'https://cdn.test/song.mp3'}]:[]})});
 await h.api.generateFastPlaylist('owner',{prompt:'українські хіти 00-х'},{...settings,count:1},new AbortController().signal);
 assert.equal(h.fetchCalls.length,2);assert.equal(h.persisted[0][3][0].artist,'Tina Karol');assert.equal(h.persisted[0][3][0].providerId,'93');
});

test('explicit artist requests cannot receive other artists suggested by the model',()=>{
 const h=load(),result=h.api.parsePlaylistResponse(JSON.stringify({plan:{...plan,artists:['Queen']},songs:[sample('Queen','Love of My Life'),sample('Aerosmith','I Do Not Want to Miss a Thing')],diversityExhausted:true,historyExhausted:false}),'romantic ballads by Queen',1,10);
 assert.equal(result.songs.length,1);assert.equal(result.songs[0].artist,'Queen');
});

test('valid empty factual list produces an incomplete-search error rather than malformed-AI error',async()=>{
 const h=load({songs:[]});
 await assert.rejects(h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,new AbortController().signal),error=>error.code==='AI_SEARCH_INCOMPLETE'&&error.extra.available===0);assert.equal(h.persisted.length,0);
});

test('preexisting independent original-year evidence rejects songs outside requested decade',async()=>{
 const songs=Array.from({length:5},(_,i)=>sample('Artist '+i,'Song '+i)),h=load({songs});
 h.stored.set('original-year-v10:1000',{data:JSON.stringify({year:1979,status:'verified'}),at:Date.now()});
 await h.api.generateFastPlaylist('owner',{prompt:'романтичні балади 00-х'},settings,new AbortController().signal);
 assert.ok(!h.persisted[0][3].some(track=>track.providerId==='1000'));
});

test('provider quota failures stop the operation without loops or partial saved collections',async()=>{
 const h=load({fetch:async()=>Response.json({error:{code:4}})});
 await assert.rejects(h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,new AbortController().signal),error=>error.code==='MUSIC_RATE_LIMIT');assert.equal(h.persisted.length,0);assert.equal(h.modelCalls.length,1);
 assert.ok(h.fetchCalls.every(call=>call.init.signal.aborted));
});

test('cancellation interrupts a pending Gemini request and produces no deck',async()=>{
 const h=load({model:async()=>new Promise(()=>{})}),controller=new AbortController();
 const operation=h.api.generateFastPlaylist('owner',{prompt:'romantic ballads'},settings,controller.signal);await new Promise(resolve=>setTimeout(resolve,5));controller.abort(new ApiError(499,'CANCELLED','cancelled'));
 await assert.rejects(operation,error=>error.code==='CANCELLED');assert.equal(h.persisted.length,0);assert.equal(h.fetchCalls.length,0);assert.ok(h.modelCalls[0][2].aborted);
});

test('the stream has a hard total deadline, emits typed timeout, and never waits endlessly',async()=>{
 const timeouts=[],h=load({model:async()=>new Promise(()=>{}),setTimeout(fn,ms){timeouts.push(ms);return setTimeout(fn,ms===29000?12:Math.min(ms,2));}});
 const response=h.api.playlistStream('owner',{prompt:'romantic ballads'},settings,new AbortController().signal),events=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.equal(timeouts[0],29000);assert.equal(events.at(-1).type,'error');assert.equal(events.at(-1).error,'AI_DEADLINE');assert.equal(h.persisted.length,0);assert.ok(h.modelCalls[0][2].aborted);
 assert.ok(!events.some(event=>event.type==='done'));
});

test('existing collections are owner-checked before any Gemini or provider access',async()=>{
 const h=load();await assert.rejects(h.api.generateFastPlaylist('other',{prompt:'romantic ballads',collectionId:'custom-11111111-1111-1111-1111-111111111111'},settings,new AbortController().signal),error=>error.code==='COLLECTION_NOT_FOUND');assert.equal(h.modelCalls.length,0);assert.equal(h.persisted.length,0);
});

test('refreshing an existing collection uses its stored prompt rather than client replacement',async()=>{
 const h=load({existing:{recipe:JSON.stringify({ai:true,prompt:'romantic ballads'})}});
 await h.api.generateFastPlaylist('owner',{prompt:'Unrelated hard rock',collectionId:'custom-11111111-1111-1111-1111-111111111111'},settings,new AbortController().signal);
 assert.equal(h.historyCalls[0][1],'romantic ballads');assert.match(h.modelCalls[0][1].messages[1].content,/romantic ballads/);assert.ok(!h.modelCalls[0][1].messages[1].content.includes('Unrelated hard rock'));
});

test('successful stream contains progress and one done result only',async()=>{
 const h=load({songs:Array.from({length:5},(_,i)=>sample('Artist '+i,'Song '+i))});
 const response=h.api.playlistStream('owner',{prompt:'romantic ballads'},settings,new AbortController().signal),events=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.match(response.headers.get('content-type'),/application\/x-ndjson/);assert.equal(events.filter(event=>event.type==='done').length,1);assert.equal(events.filter(event=>event.type==='error').length,0);assert.equal(events.at(-1).result.collection.count,4);
});

test('fast Gemini configuration makes only one attempt, has schema and minimal thinking',async()=>{
 const calls=[],module={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/gemini.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>name==='./http'?{ApiError}:{geminiCredentials:async()=> 'private-test-key'},AbortSignal,JSON,Error,console,fetch:async(url,options)=>{calls.push({url,options});return Response.json({error:{}},{status:503});}});
 await assert.rejects(module.exports.geminiCompletion('owner',{purpose:'fast-playlist',limit:100,messages:[{role:'user',content:'a'.repeat(20000)}],responseSchema:{type:'object'}},new AbortController().signal),error=>error.code==='GEMINI_UNAVAILABLE');
 assert.equal(calls.length,1);assert.ok(calls[0].url.includes('gemini-3.6-flash'));const config=JSON.parse(calls[0].options.body).generationConfig;
 assert.equal(config.thinkingConfig.thinkingLevel,'MINIMAL');assert.equal(config.temperature,undefined);assert.deepEqual(config.responseJsonSchema,{type:'object'});assert.equal(config.responseMimeType,'application/json');
});

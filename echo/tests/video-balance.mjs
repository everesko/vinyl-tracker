import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {DatabaseSync} from 'node:sqlite';
function transpile(file,imports,extra={}){
 const compiled={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:compiled,exports:compiled.exports,require:name=>{assert.ok(name in imports,name);return imports[name];},URL,AbortSignal,setTimeout,console,...extra});return compiled.exports;
}
const registry=transpile('../lib/server/video-registry.ts',{});

test('cold profile initialization keeps settings locked without crashing; practice gives only temporary access',()=>{
 const quiz=transpile('../lib/quiz.ts',{}),progress=transpile('../lib/progression.ts',{'./quiz':quiz});
 assert.equal(progress.purchased('difficulty-10'),false);assert.equal(progress.difficultyCap(),1);
 const settings={duration:3,timer:true,difficulty:10,count:100};assert.equal(progress.availableSettings(settings).duration,7);assert.equal(progress.availableSettings(settings).count,10);
 assert.equal(progress.availableSettings(settings,{practice:true,unlocks:{}}).difficulty,10);assert.equal(progress.availableSettings(settings,{practice:false,unlocks:{}}).difficulty,1);
 assert.equal(progress.purchased('count-20',{practice:false,unlocks:{'count-100':true}}),true);assert.equal(progress.purchased('duration-5',{practice:false,unlocks:{'duration-3':true}}),true);
});
test('videos match the original recording, including Ukrainian names and transliteration',async()=>{
 const video=transpile('../lib/server/videos.ts',{'./http':{database:()=>{throw new Error('Unexpected DB access');}},'./video-registry':registry});
 assert.equal((await video.resolveMusicVideo({id:'deezer-106348932',artist:'Okean Elzy',title:'Обійми'})).id,'--Wokwe4-i0');
 assert.equal((await video.resolveMusicVideo({id:'x',artist:'KALUSH',title:'Stefania (Kalush Orchestra)'})).id,'Z8Z51no1TD0');
 assert.equal((await video.resolveMusicVideo({id:'x',artist:'Linkin Park',title:'In the End'})).id,'eVTXPUF4Oz4');
 assert.equal(video.youtubeId('https://youtube.com.evil.test/watch?v=eVTXPUF4Oz4'),undefined);
 assert.equal(video.youtubeId('https://www.youtube.com/watch?v=eVTXPUF4Oz4'),'eVTXPUF4Oz4');
 assert.equal(video.sameRecording({title:'Плакала','artist-credit':[{name:'Cover Artist'}]},{title:'Плакала',artist:'KAZKA'}),false);
 assert.equal(video.sameRecording({title:'Another Song','artist-credit':[{name:'KAZKA'}]},{title:'Плакала',artist:'KAZKA'}),false);
});
function profileModule(db,user='owner'){
 const database=()=>({prepare(sql){return{bind(...args){return{async first(){return db.prepare(sql).get(...args);},async all(){return{results:db.prepare(sql).all(...args)};},async run(){return db.prepare(sql).run(...args);}};}};},async batch(){throw new Error('Unexpected destructive batch');}});
 const quiz=transpile('../lib/quiz.ts',{}),progress=transpile('../lib/progression.ts',{'./quiz':quiz}),economy=transpile('../lib/server/progression.ts',{'@/lib/progression':progress,'@/lib/quiz':quiz,'./http':{database,ApiError:class extends Error{constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}}},{Date});
 return transpile('../app/api/profile/route.ts',{'@/lib/server/progression':economy,'@/lib/server/games':{sessionView:row=>row,changeGame:()=>{throw new Error('Unexpected game mutation');}},'@/lib/server/http':{database,identity:()=>({id:user,displayName:user}),csrf:async r=>{if(r.headers.get('origin')!=='https://echo.test')throw new Error('CSRF');},handle:fn=>fn(),json:Response.json,body:async r=>r.json()}},{Response});
}
test('wallet clearing preserves history, other owners and subsequent signed settlements',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../drizzle/0000_brave_dazzler.sql',import.meta.url),'utf8'));db.exec(fs.readFileSync(new URL('../drizzle/0001_chilly_steel_serpent.sql',import.meta.url),'utf8'));
 const insert=db.prepare("INSERT INTO echo_games(id,user_id,collection_id,collection_title,state,total,finished,xp,score_tenths,created_at,updated_at) VALUES(?,?,'rock','Rock','{\"phase\":\"finished\"}',10,1,?,100,1,1)");
 insert.run('a','owner',-138);insert.run('b','other',40);
 db.exec(fs.readFileSync(new URL('../drizzle/0002_low_ares.sql',import.meta.url),'utf8'));db.exec(fs.readFileSync(new URL('../drizzle/0003_tidy_thaddeus_ross.sql',import.meta.url),'utf8'));
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM echo_profile_balances').get().n,0,'migration never resets multiple accounts');
 const profile=profileModule(db),request=new Request('https://echo.test/api/profile',{method:'POST',headers:{origin:'https://echo.test'}});
 await profile.POST(request);assert.equal((await (await profile.GET(request)).json()).profile.xp,0);
 assert.equal(db.prepare("SELECT xp FROM echo_games WHERE id='a'").get().xp,-138);
 assert.equal(db.prepare("SELECT xp FROM echo_games WHERE id='b'").get().xp,40);
 assert.equal((await (await profile.GET(request)).json()).history.length,1);
 await assert.rejects(profile.POST(request),e=>e.code==='RESET_COOLDOWN');insert.run('c','owner',12.5);insert.run('d','owner',-5);
 assert.equal((await (await profile.GET(request)).json()).profile.xp,7.5);
 await assert.rejects(profile.POST(new Request('https://echo.test/api/profile',{method:'POST'})),/CSRF/);
 db.close();
});
test('one-time reset snapshots the sole existing wallet without changing settlements',()=>{
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../drizzle/0000_brave_dazzler.sql',import.meta.url),'utf8'));
 db.prepare("INSERT INTO echo_games(id,user_id,collection_id,collection_title,state,total,finished,xp,created_at,updated_at) VALUES('a','owner','rock','Rock','{}',10,1,-138,1,1)").run();
 db.exec(fs.readFileSync(new URL('../drizzle/0002_low_ares.sql',import.meta.url),'utf8'));
 assert.equal(db.prepare('SELECT offset_tenths FROM echo_profile_balances').get().offset_tenths,-1380);
 assert.equal(db.prepare('SELECT xp FROM echo_games').get().xp,-138);db.close();
});

test('XP upgrades debit once, cannot overdraw, practice preserves purchased settings and daily reset preserves history',async()=>{
 const db=new DatabaseSync(':memory:');for(const file of ['0000_brave_dazzler.sql','0001_chilly_steel_serpent.sql','0002_low_ares.sql','0003_tidy_thaddeus_ross.sql'])db.exec(fs.readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 db.prepare("INSERT INTO echo_games(id,user_id,collection_id,collection_title,state,total,finished,xp,created_at,updated_at) VALUES('earned','owner','rock','Rock','{\"phase\":\"finished\"}',10,1,300,1,1)").run();
 const profile=profileModule(db),post=data=>profile.POST(new Request('https://echo.test/api/profile',{method:'POST',headers:{origin:'https://echo.test','content-type':'application/json'},body:JSON.stringify(data)}));
 await Promise.all([post({action:'unlock',id:'duration-5'}),post({action:'unlock',id:'duration-5'})]);let view=await(await profile.GET(new Request('https://echo.test'))).json();assert.equal(view.profile.xp,150);assert.equal(view.progression.unlocks['duration-5'],true);
 await assert.rejects(post({action:'unlock',id:'count-100'}),e=>e.code==='UPGRADE_ORDER');assert.equal(db.prepare('SELECT spent_tenths FROM echo_progression').get().spent_tenths,1500);
 await post({action:'practice',practice:true});view=await(await profile.GET(new Request('https://echo.test'))).json();assert.equal(view.progression.practice,true);assert.equal(view.profile.xp,150);
 await post({action:'practice',practice:false});view=await(await profile.GET(new Request('https://echo.test'))).json();assert.equal(view.progression.practice,false);assert.equal(view.progression.unlocks['duration-5'],true);
 await post({action:'reset'});view=await(await profile.GET(new Request('https://echo.test'))).json();assert.equal(view.profile.xp,0);assert.equal(view.history.length,1);assert.equal(view.progression.unlocks['duration-5'],true);assert.ok(view.progression.resetAvailableAt>Date.now());await assert.rejects(post({action:'reset'}),e=>e.code==='RESET_COOLDOWN');db.close();
});

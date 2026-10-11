import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
class ApiError extends Error{constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}
function harness(){
 const rows=new Map();
 const db={prepare(){return{bind(...args){return{first:async()=>rows.get(args[0])??null,all:async()=>({results:[...rows.entries()].filter(([key])=>key>=args[0]&&key<args[1]).map(([,row])=>row).sort((a,b)=>b.updated_at-a.updated_at)}),run:async()=>rows.set(args[0],{track_data:args[1],updated_at:args[2]})};}}}};
 const imports={'./http':{ApiError,database:()=>db},'./stored-json':{readJson:async value=>JSON.parse(value),storeJson:async(_,value)=>JSON.stringify(value)},'./popular':{}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/playlist-batches.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];},crypto:webcrypto,TextEncoder,Date,Math,JSON,Set,Map,Promise});
 return{rows,api:module.exports};
}
const plan={title:'1980s romance',criteria:['Romantic ballads','Original 1980–1989 releases'],artists:[],genres:['pop'],language:'English',years:{from:1980,to:1989}};
const tracks=[{id:'deezer-1',provider:'deezer',providerId:'1',artist:'Artist 1',title:'Song 1'},{id:'deezer-2',provider:'deezer',providerId:'2',artist:'Artist 2',title:'Song 2'}];

test('bounded parallel work preserves input order and never degrades to serial song lookup',async()=>{
  const {api}=harness();let active=0,peak=0;
  const result=await api.mapConcurrent(Array.from({length:16},(_,i)=>i),4,async value=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5+(value%3)));active--;return value*2;});
  assert.equal(peak,4);assert.deepEqual(JSON.parse(JSON.stringify(result)),Array.from({length:16},(_,i)=>i*2));
  assert.deepEqual(JSON.parse(JSON.stringify(await api.mapConcurrent([],4,async()=>{throw Error('unexpected');}))),[]);
});

test('parallel work propagates failures instead of silently reporting a completed batch',async()=>{
  const {api}=harness();await assert.rejects(api.mapConcurrent([1,2,3],2,async value=>{if(value===2)throw new Error('provider failed');return value;}),/provider failed/);
});

test('learned category cards expose counts and facets without leaking answer names or another owner',async()=>{
  const {api,rows}=harness();
  await api.indexMiniCategory('alice',plan,2,tracks,Date.now()+60000,'80s romantic ballads');
  const menu=await api.listMiniCategories('alice');assert.equal(menu.length,1);assert.equal(menu[0].count,2);assert.equal(menu[0].prompt,'80s romantic ballads');assert.equal(menu[0].tracks,undefined);
  assert.ok(menu[0].facets.some(facet=>facet.kind==='era'&&facet.label==='1980–1989'));assert.ok(menu[0].facets.some(facet=>facet.kind==='language'&&facet.label==='English'));assert.ok(menu[0].facets.some(facet=>facet.kind==='theme'&&facet.label==='Romantic ballads'));
  assert.equal((await api.listMiniCategories('bob')).length,0);assert.ok([...rows.keys()].some(key=>key.startsWith('ai-mini-facet-v1:')));
});

test('expired category cards disappear and normalized prompts are shown once',async()=>{
  const {api}=harness();
  await api.indexMiniCategory('alice',plan,1,tracks,Date.now()+60000,'  80s   ROMANTIC ballads ');
  await api.indexMiniCategory('alice',plan,8,tracks,Date.now()+60000,'80s romantic ballads');
  assert.equal((await api.listMiniCategories('alice')).length,1);
  await api.indexMiniCategory('alice',{...plan,title:'Expired'},1,tracks,0,'expired request');
  assert.ok(!(await api.listMiniCategories('alice')).some(category=>category.prompt==='expired request'));
});

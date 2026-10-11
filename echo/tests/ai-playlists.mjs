import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
class ApiError extends Error{constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}
const module={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/playlist-plan.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{assert.equal(name,'./server/http');return{ApiError};},Set,Number});
const {validatePlan}=module.exports,plain=value=>JSON.parse(JSON.stringify(value));
const plan={title:'Romantic ballads',criteria:['Romantic ballads, not generic ballads','Original recordings from 1980–1989','No tribute recordings'],artists:[],genres:[],language:'English',years:{from:1980,to:1989}};

test('plan validation preserves every semantic condition without substituting a broad genre',()=>{
  assert.deepEqual(plain(validatePlan(plan)),plan);
  const freeform={...plan,title:'Rainy train journey',criteria:['Warm, nostalgic songs for a rainy train journey'],language:null,years:null};
  assert.deepEqual(plain(validatePlan(freeform)),freeform);
});

test('deduplication only affects explicit artist and genre sets, never free-form request criteria',()=>{
  const value=plain(validatePlan({...plan,artists:['Океан Ельзи','Океан Ельзи','Скрябін'],genres:['rock','rock'],criteria:['Romantic','Romantic']}));
  assert.deepEqual(value.artists,['Океан Ельзи','Скрябін']);assert.deepEqual(value.genres,['rock']);assert.deepEqual(value.criteria,['Romantic','Romantic']);
});

test('invalid plans and unavailable genre labels are rejected instead of silently relaxing the request',()=>{
  for(const changed of [{title:''},{title:'x'.repeat(101)},{criteria:[]},{criteria:['x'.repeat(251)]},{artists:Array(101).fill('Artist')},{genres:['invented']},{language:42},{years:{from:1990,to:1980}},{years:{from:1899,to:1989}},{years:{from:1980,to:2101}},{years:{from:1980.5,to:1989}}]){
    assert.throws(()=>validatePlan({...plan,...changed}),error=>error instanceof ApiError&&error.code==='AI_INVALID_PLAN');
  }
});

test('regional prompts need no globally popular genre or English language classification',()=>{
  const ukrainian={title:'Українські хіти 00-х',criteria:['Українські хіти 00-х'],artists:[],genres:[],language:'Ukrainian',years:{from:2000,to:2009}};
  assert.deepEqual(plain(validatePlan(ukrainian)),ukrainian);
});

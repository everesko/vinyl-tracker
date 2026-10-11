import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
class ApiError extends Error {constructor(status,code,message,extra){super(message);Object.assign(this,{status,code,extra});}}
function discovery(response={text:JSON.stringify({names:['alyona alyona','Invented performer']})}){
 const saved=[],queries=[],calls=[],scans=[];
 const imports={'./http':{ApiError},'./gemini':{geminiCompletion:async(...args)=>{calls.push(args);return response;}},'./popular':{resolveArtist:async name=>{if(name==='Invented performer')throw new ApiError(404,'ARTIST_NOT_FOUND','');return{id:54213952,name};},discoverArtistTracks:async artist=>{scans.push(artist);return 86;},rememberDiscoveredArtist:async artist=>saved.push(artist),rememberArtistQuery:async(query,artists)=>queries.push({query,artists}),publicArtistCard:artist=>artist}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../lib/server/artist-discovery.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];},Set,Map,JSON});
 return{api:module.exports,saved,queries,calls,scans,response};
}

test('AI performer discovery resolves inflected Ukrainian names and adds only verified live catalog identities',async()=>{
 const h=discovery();const result=await h.api.discoverRequestedArtist('owner','пісні Альони Альони');
 assert.equal(result.artists.length,1);assert.equal(result.artists[0].id,54213952);assert.equal(result.artists[0].availablePreviews,86);assert.equal(h.saved.length,1);assert.equal(h.queries[0].query,'пісні Альони Альони');
 assert.equal(h.calls[0][1].purpose,'artist');assert.ok(h.calls[0][1].messages[0].content.includes('Never substitute related artists'));
 h.response.text=JSON.stringify({names:[]});assert.equal((await h.api.discoverRequestedArtist('owner','невідомий артист')).artists.length,0);
});

test('aliases of the same canonical catalog performer are discovered and indexed only once',async()=>{
 const h=discovery({text:JSON.stringify({names:['alyona alyona','Альона Альона']})});
 const result=await h.api.discoverRequestedArtist('owner','Альона Альона');assert.equal(result.artists.length,1);assert.equal(h.saved.length,1);assert.equal(h.scans.length,1);
});

test('invalid, unsafe and ambiguous provider name lists are rejected before catalog lookup',async()=>{
 for(const names of [null,['a','b','c','d'],[''],[42],['x'.repeat(101)]]){
  const h=discovery({text:JSON.stringify({names})});await assert.rejects(h.api.discoverRequestedArtist('owner','artist'),error=>error.code==='AI_INVALID_RESPONSE');assert.equal(h.saved.length,0);
 }
});

test('cancelled searches cannot scan or save a newly discovered artist',async()=>{
 const h=discovery();const signal=AbortSignal.abort();
 await assert.rejects(h.api.discoverRequestedArtist('owner','artist',signal),error=>error.code==='CANCELLED');assert.equal(h.scans.length,0);assert.equal(h.saved.length,0);assert.equal(h.calls[0][2],signal);
});

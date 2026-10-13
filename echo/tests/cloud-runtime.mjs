import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class RequestError extends Error {constructor(code,message='',data={}){super(message);Object.assign(this,{code,data});}}
function harness(responder){
 const module={exports:{}},calls=[],timers=new Map();let serial=0;
 const request=async(...args)=>{calls.push(args);return responder(...args);};
 const source=fs.readFileSync(new URL('../app/cloud-ai-runtime.ts',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,require:name=>{assert.equal(name,'./client-request');return {request,RequestError};},
  AbortController,AbortSignal,Set,JSON,Error,
  setTimeout:(callback,delay)=>{const id=++serial;timers.set(id,{callback,delay});return id;},clearTimeout:id=>timers.delete(id),
 });
 return {api:module.exports,calls,timers};
}
const settings={aiProvider:'gemini',gemini:{configured:true,freeTier:true}};
const pending=(_url,_data,_method,signal)=>new Promise((_resolve,reject)=>{
 if(signal.aborted)reject(new RequestError('CANCELLED'));
 else signal.addEventListener('abort',()=>reject(new RequestError('CANCELLED')),{once:true});
});

test('A stored key is configured without falsely claiming a successful Gemini connection',async()=>{
 const h=harness(async()=>settings);await h.api.inspectCloud();
 assert.equal(h.api.getCloudState().configured,true);assert.equal(h.api.getCloudState().connected,false);
 assert.equal(h.api.getCloudState().model,null);assert.equal(h.calls.length,1);
 assert.equal(h.calls[0][0],'/api/settings');
});

test('Connection test waits for valid JSON and reports the actual responding model',async()=>{
 let resolve;const h=harness(()=>new Promise(done=>{resolve=done;}));
 const verification=h.api.verifyCloud();
 assert.equal(h.api.getCloudState().checking,true);assert.equal(h.api.getCloudState().working,true);
 assert.equal(h.api.getCloudState().connected,false);
 assert.equal(h.calls[0][1].purpose,'test');assert.equal([...h.timers.values()][0].delay,25000);
 resolve({text:'{"ok":true}',model:'gemini-3.5-flash'});await verification;
 assert.equal(h.api.getCloudState().connected,true);assert.equal(h.api.getCloudState().model,'gemini-3.5-flash');
 assert.equal(h.api.getCloudState().checking,false);assert.equal(h.api.getCloudState().working,false);assert.equal(h.timers.size,0);
});

for(const result of [
 {text:'{"ok":false}',model:'gemini-3.5-flash'},
 {text:'not JSON',model:'gemini-3.5-flash'},
 {text:'{"ok":true}',model:''},
 {model:'gemini-3.5-flash'},
])test('Malformed connection response never enables Connected: '+JSON.stringify(result),async()=>{
 const h=harness(async()=>result);
 await assert.rejects(h.api.verifyCloud(),error=>error.code==='AI_INVALID_RESPONSE');
 assert.equal(h.api.getCloudState().connected,false);assert.equal(h.api.getCloudState().working,false);assert.equal(h.timers.size,0);
});

test('Connection-only deadline aborts transport and reports Gemini timeout',async()=>{
 const h=harness(pending),verification=h.api.verifyCloud();
 const rejection=assert.rejects(verification,error=>error.code==='GEMINI_TIMEOUT');
 [...h.timers.values()][0].callback();await rejection;
 assert.equal(h.calls[0][3].aborted,true);assert.equal(h.api.getCloudState().connected,false);
 assert.equal(h.api.getCloudState().checking,false);assert.equal(h.api.getCloudState().working,false);assert.equal(h.timers.size,0);
});

test('Cancelling the check leaves the encrypted-key configuration untouched and permits another check',async()=>{
 const h=harness((...args)=>args[0]==='/api/settings'?settings:pending(...args));await h.api.inspectCloud();
 const verification=h.api.verifyCloud(),rejection=assert.rejects(verification,error=>error.code==='CANCELLED');
 h.api.cancelCloud();await rejection;
 assert.equal(h.api.getCloudState().configured,true);assert.equal(h.api.getCloudState().freeTier,true);
 assert.equal(h.api.getCloudState().provider,'gemini');assert.equal(h.api.getCloudState().checking,false);
 assert.equal(h.api.getCloudState().working,false);assert.equal(h.timers.size,0);
});

test('A cancelled follow-up check preserves the last proven connection; unavailability clears it',async()=>{
 let mode='ok';const h=harness((...args)=>mode==='ok'?{text:'{"ok":true}',model:'gemini-3.5-flash'}:mode==='cancel'?pending(...args):Promise.reject(new RequestError('GEMINI_UNAVAILABLE')));
 await h.api.verifyCloud();mode='cancel';
 const verification=h.api.verifyCloud(),rejection=assert.rejects(verification,error=>error.code==='CANCELLED');h.api.cancelCloud();await rejection;
 assert.equal(h.api.getCloudState().connected,true);assert.equal(h.api.getCloudState().model,'gemini-3.5-flash');
 mode='unavailable';await assert.rejects(h.api.verifyCloud(),error=>error.code==='GEMINI_UNAVAILABLE');
 assert.equal(h.api.getCloudState().connected,false);assert.equal(h.timers.size,0);
});

test('Cancelled late responses cannot falsely mark the connection successful',async()=>{
 let resolve;const h=harness(()=>new Promise(done=>{resolve=done;})),verification=h.api.verifyCloud();
 h.api.cancelCloud();resolve({text:'{"ok":true}',model:'gemini-3.5-flash'});
 await assert.rejects(verification,error=>error.code==='CANCELLED');assert.equal(h.api.getCloudState().connected,false);
});

test('Playlist calls do not inherit the connection deadline or checking state',async()=>{
 let resolve;const h=harness(()=>new Promise(done=>{resolve=done;}));
 const completion=h.api.completeCloud([{role:'user',content:'Romantic ballads'}],'playlist',undefined,20);
 assert.equal(h.timers.size,0);assert.equal(h.api.getCloudState().checking,false);assert.equal(h.calls[0][1].limit,20);
 resolve({text:'Artist:Title',model:'gemini-3.5-flash'});assert.equal(await completion,'Artist:Title');
 assert.equal(h.api.getCloudState().working,false);
});

test('An already cancelled caller does not start a test or leave a timer',async()=>{
 const h=harness(async()=>{throw new Error('Should not send');}),controller=new AbortController();controller.abort();
 await assert.rejects(h.api.verifyCloud(controller.signal),error=>error.code==='CANCELLED');
 assert.equal(h.calls.length,0);assert.equal(h.timers.size,0);assert.equal(h.api.getCloudState().checking,false);
});

test('Updating the key invalidates the previous connection without exposing a key in client state',async()=>{
 const h=harness(async(url)=>url==='/api/settings'?settings:{text:'{"ok":true}',model:'gemini-3.5-flash'});
 await h.api.verifyCloud();await h.api.saveCloud({geminiKey:'test-placeholder-key',geminiFreeTier:true,aiProvider:'gemini'});
 assert.equal(h.api.getCloudState().connected,false);assert.equal(h.api.getCloudState().model,null);
 assert.equal(h.api.getCloudState().configured,true);assert.ok(!JSON.stringify(h.api.getCloudState()).includes('test-placeholder-key'));
});

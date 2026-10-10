'use client';
import workerURL from './playlist-ai.worker.ts?worker&url';
export class PlaylistAIError extends Error{constructor(public code:string){super(code);this.name='PlaylistAIError';}}
export type AIModel='fast'|'balanced';
export type AIState={model:AIModel;status:'idle'|'checking'|'cached'|'loading'|'preparing'|'ready'|'working'|'error'|'unsupported'|'clearing';progress:number|null;stage:string;error:string|null;cached:boolean;autoLoad:boolean};
const initial:AIState={model:'fast',status:'idle',progress:null,stage:'idle',error:null,cached:false,autoLoad:false};
let state=initial,worker:Worker|undefined,serial=0,epoch=0,preferencesRead=false,loadPromise:Promise<void>|undefined,checkPromise:Promise<void>|undefined;
const listeners=new Set<()=>void>(),pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const publish=(patch:Partial<AIState>)=>{state={...state,...patch};listeners.forEach(listener=>listener());};
export const subscribeAI=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const getAIState=()=>state,getAIServerState=()=>initial;
function disconnect(code='cancelled'){epoch++;worker?.terminate();worker=undefined;for(const item of pending.values()){clearTimeout(item.timer);item.reject(new PlaylistAIError(code));}pending.clear();}
function connect(){
 if(worker)return worker;
 try{worker=new Worker(workerURL,{type:'module'});}catch{throw new PlaylistAIError('worker');}
 const current=worker;worker.onmessage=event=>{if(current!==worker)return;const item=event.data,job=pending.get(item.id);if(!job)return;
  if(item.type==='load'){if(!Number.isFinite(item.progress))return;const progress=Math.max(0,Math.min(100,Math.round(item.progress*100)));publish({status:progress>=100||item.stage==='preparing'?'preparing':'loading',progress,stage:item.stage??'downloading'});return;}
  if(item.type==='thinking'){publish({status:'working',stage:'working'});return;}
 if(item.type==='generating'){progressPulse?.(Number(item.tokens)||0);return;}
  if(item.type==='result'||item.type==='error'){clearTimeout(job.timer);pending.delete(item.id);if(item.type==='error'){const code=String(item.code||'failed');publish({status:code==='gpu'?'unsupported':'error',error:code,stage:'error'});job.reject(new PlaylistAIError(code));}else job.resolve(item.value);}
 };
 const failure=()=>{if(current!==worker)return;disconnect('worker');publish({status:'error',error:'worker',stage:'error'});};worker.onerror=failure;worker.onmessageerror=failure;return worker;
}
function command(action:string,extra:Record<string,unknown>={},timeout=20*60*1000):Promise<any>{
 let target:Worker;try{target=connect();}catch(error){publish({status:'error',error:'worker',stage:'error'});return Promise.reject(error);}
 const id=++serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{disconnect('timeout');publish({status:'error',error:'timeout',stage:'error'});},timeout);pending.set(id,{resolve,reject,timer});try{target.postMessage({id,action,model:state.model,...extra});}catch{disconnect('worker');publish({status:'error',error:'worker',stage:'error'});}});
}
export function setAIAutoLoad(autoLoad:boolean){try{localStorage.setItem('echo-ai-auto-load',String(autoLoad));}catch{}publish({autoLoad});}
export function setAIModel(model:AIModel){
 if(model===state.model||!['fast','balanced'].includes(model)||['loading','preparing','working','checking','clearing'].includes(state.status))return;
 disconnect();loadPromise=undefined;checkPromise=undefined;preferencesRead=true;try{localStorage.setItem('echo-ai-model',model);}catch{}
 publish({model,status:'idle',stage:'idle',progress:null,error:null,cached:false});void inspectAI();
}
export function inspectAI():Promise<void>{
 if(checkPromise)return checkPromise;if(['loading','preparing','ready','working','clearing'].includes(state.status))return Promise.resolve();
 if(!preferencesRead){preferencesRead=true;try{publish({autoLoad:localStorage.getItem('echo-ai-auto-load')==='true',model:localStorage.getItem('echo-ai-model')==='balanced'?'balanced':'fast'});}catch{}}
 publish({status:'checking',stage:'checking',error:null});
 const generation=epoch,task=command('status',{},60000).then(result=>{if(generation!==epoch)return;publish({status:!result.supported?'unsupported':result.cached?'cached':'idle',stage:!result.supported?'unsupported':result.cached?'cached':'idle',cached:!!result.cached,progress:null,error:!result.supported?'gpu':null});}).catch(error=>{if(generation===epoch&&error.code!=='cancelled')publish({status:'error',error:error.code||'failed',stage:'error'});}).finally(()=>{if(checkPromise===task)checkPromise=undefined;});checkPromise=task;return task;
}
export function loadAI():Promise<void>{
 if(state.status==='ready')return Promise.resolve();if(state.status==='working')return Promise.reject(new PlaylistAIError('busy'));if(loadPromise)return loadPromise;
 const generation=epoch,task=(async()=>{await checkPromise;if(generation!==epoch)throw new PlaylistAIError('cancelled');publish({status:'loading',stage:'downloading',progress:0,error:null});try{await command('init');if(generation!==epoch)throw new PlaylistAIError('cancelled');publish({status:'ready',stage:'ready',progress:100,cached:true,error:null});}catch(error){if(generation===epoch&&error instanceof PlaylistAIError&&error.code!=='cancelled')publish({status:error.code==='gpu'?'unsupported':'error',error:error.code,stage:'error'});throw error;}})().finally(()=>{if(loadPromise===task)loadPromise=undefined;});loadPromise=task;return task;
}
export function cancelAI(){disconnect();loadPromise=undefined;checkPromise=undefined;publish({status:state.cached?'cached':'idle',progress:null,error:null,stage:'cancelled'});}
export function unloadAI(){if(state.status==='working')return;disconnect();loadPromise=undefined;publish({status:state.cached?'cached':'idle',progress:null,error:null,stage:'unloaded'});}
export async function deleteAI(){
 if(['loading','preparing','working','clearing','checking'].includes(state.status))return;disconnect();publish({status:'clearing',stage:'clearing',error:null,progress:null});
 try{await command('delete',{},120000);disconnect();publish({status:'idle',stage:'deleted',cached:false,error:null});}catch(error){publish({status:'error',stage:'error',error:error instanceof PlaylistAIError?error.code:'storage'});throw error;}
}
export async function completeAI(messages:{role:'system'|'user';content:string}[],progress:(phase:any,value?:number)=>void,phase:string,signal?:AbortSignal,limit?:number){
 if(signal?.aborted)throw new PlaylistAIError('cancelled');if(state.status==='working')throw new PlaylistAIError('busy');
 const startingEpoch=epoch,onAbort=()=>cancelAI();let unsubscribe=()=>{};signal?.addEventListener('abort',onAbort,{once:true});
 try{await checkPromise;if(signal?.aborted||startingEpoch!==epoch)throw new PlaylistAIError('cancelled');if(state.status==='unsupported')throw new PlaylistAIError('gpu');if(state.status!=='ready'&&!loadPromise&&!state.autoLoad)throw new PlaylistAIError('notReady');
 unsubscribe=subscribeAI(()=>{if(state.status==='loading'||state.status==='preparing')progress('loading',state.progress??0);});
 await loadAI();if(signal?.aborted||startingEpoch!==epoch)throw new PlaylistAIError('cancelled');progress(phase);progressPulse=tokens=>progress(phase,tokens);publish({status:'working',stage:'working'});const generation=epoch,value=await command('generate',{messages,purpose:phase,limit},120000);if(generation!==epoch||signal?.aborted)throw new PlaylistAIError('cancelled');publish({status:'ready',stage:'ready',error:null});return String(value);}finally{progressPulse=undefined;unsubscribe();signal?.removeEventListener('abort',onAbort);}
}
let progressPulse:((tokens:number)=>void)|undefined;

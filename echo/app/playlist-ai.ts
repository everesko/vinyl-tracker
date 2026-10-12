'use client';
import {RequestError} from './client-request';

export type PlaylistInput={prompt:string;count:number;difficulty:number;allowArtistRepeats:boolean;collectionId?:string};
export type PlaylistProgress={type:'progress';stage:'planning'|'splitting'|'assembling';progress:number;resolved:number;requested:number;processed:number;total:number;elapsedMs:number};

/** One streamed request. Progress contains counts, never the quiz answers.
 * Only the user cancels the whole operation; each provider bounds its own I/O. */
export async function createAIPlaylist<T>(input:PlaylistInput,onProgress:(value:PlaylistProgress)=>void,signal?:AbortSignal):Promise<T>{
 if(signal?.aborted)throw new RequestError('CANCELLED','');
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
 let rejectAbort:(reason:unknown)=>void=()=>{};
 const interrupted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
 const onAbort=()=>rejectAbort(new RequestError('CANCELLED',''));
 controller.signal.addEventListener('abort',onAbort,{once:true});
 try{
  const response=await Promise.race([fetch('/api/collections/local-ai',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/x-ndjson'},body:JSON.stringify(input),signal:controller.signal}),interrupted]);
  if(!response.ok){let data:Record<string,unknown>={};try{const parsed=await Promise.race([response.json(),interrupted]);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))data=parsed as Record<string,unknown>;}catch(error){if(controller.signal.aborted)throw error;}throw new RequestError(typeof data.error==='string'?data.error:response.status===401?'AUTH_REQUIRED':'SERVER_ERROR',typeof data.message==='string'?data.message:'',{...data,status:response.status});}
  if(!response.body||!response.headers.get('content-type')?.includes('application/x-ndjson'))throw new RequestError('INVALID_RESPONSE','');
  reader=response.body.getReader();const decoder=new TextDecoder();let pending='',bytes=0;
  const consume=(line:string):{result:T}|undefined=>{
   if(!line.trim())return;let event:any;try{event=JSON.parse(line);}catch{throw new RequestError('INVALID_RESPONSE','');}
   if(event.type==='error')throw new RequestError(typeof event.error==='string'?event.error:'SERVER_ERROR',typeof event.message==='string'?event.message:'',event);
   if(event.type==='done'){if(!event.result?.collection||typeof event.result.collection.id!=='string'||event.result.collection.count!==input.count)throw new RequestError('AI_SEARCH_INCOMPLETE','',{available:Number(event.result?.collection?.count)||0,required:input.count});return{result:event.result as T};}
   if(event.type!=='progress'||!['planning','splitting','assembling'].includes(event.stage)||!Number.isFinite(event.progress)||!Number.isFinite(event.resolved)||event.requested!==input.count)throw new RequestError('INVALID_RESPONSE','');
   onProgress({type:'progress',stage:event.stage,progress:Math.max(0,Math.min(99,event.progress)),resolved:Math.max(0,Math.min(input.count,event.resolved)),requested:input.count,processed:Math.max(0,Number(event.processed)||0),total:Math.max(0,Number(event.total)||0),elapsedMs:Math.max(0,Number(event.elapsedMs)||0)});
  };
  for(;;){
   const chunk=await Promise.race([reader.read(),interrupted]);bytes+=chunk.value?.byteLength??0;if(bytes>2000000)throw new RequestError('INVALID_RESPONSE','');
   pending+=decoder.decode(chunk.value,{stream:!chunk.done});if(pending.length>1000000)throw new RequestError('INVALID_RESPONSE','');
   let newline:number;while((newline=pending.indexOf('\n'))>=0){const event=consume(pending.slice(0,newline));pending=pending.slice(newline+1);if(event)return event.result;}
   if(chunk.done){const event=consume(pending);if(event)return event.result;throw new RequestError('INVALID_RESPONSE','');}
  }
 }catch(error){
  if(controller.signal.aborted)throw new RequestError('CANCELLED','');
  if(error instanceof RequestError)throw error;throw new RequestError('NETWORK','');
 }finally{
  signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);
  if(reader)void reader.cancel().catch(()=>{});
  controller.abort();
 }
}

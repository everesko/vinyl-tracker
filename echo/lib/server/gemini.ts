import {ApiError} from './http';
import {geminiCredentials} from './settings';
// All candidates have a documented free standard API tier:
// https://ai.google.dev/gemini-api/docs/pricing
// Flash 3.5 avoids making every music request depend on the newest, overloaded model.
const economyModels=['gemini-3.5-flash-lite','gemini-3.1-flash-lite'];
const curatorModels=['gemini-3.5-flash','gemini-3.5-flash-lite','gemini-3.8-flash'];
type Message={role:'system'|'user';content:string};
const providerStatuses=new Set(['INVALID_ARGUMENT','UNAUTHENTICATED','PERMISSION_DENIED','NOT_FOUND','RESOURCE_EXHAUSTED','INTERNAL','UNAVAILABLE','DEADLINE_EXCEEDED']);
const providerReasons=new Set(['API_KEY_INVALID','API_KEY_EXPIRED','API_KEY_SERVICE_BLOCKED','API_KEY_HTTP_REFERRER_BLOCKED','API_KEY_IP_ADDRESS_BLOCKED','SERVICE_DISABLED','BILLING_DISABLED','RATE_LIMIT_EXCEEDED','CONSUMER_INVALID']);
function diagnostics(data:any){
 const googleStatus=providerStatuses.has(data?.error?.status)?data.error.status:'OTHER';
 const reason=(Array.isArray(data?.error?.details)?data.error.details:[]).map((d:any)=>d?.reason).find((value:any)=>providerReasons.has(value))??'OTHER';
 return {googleStatus,reason};
}
function providerError(status:number,data:any){
 const {reason}=diagnostics(data);
 const code=status===401||['API_KEY_INVALID','API_KEY_EXPIRED'].includes(reason)?'GEMINI_KEY':status===429?'GEMINI_QUOTA':status===404?'GEMINI_MODEL':status===403?'GEMINI_ACCESS':status===400?'GEMINI_REQUEST':'GEMINI_UNAVAILABLE';
 const messages:Record<string,string>={GEMINI_QUOTA:'Квота Gemini исчерпана. Проверьте квоту API-проекта в AI Studio.',GEMINI_MODEL:'Google не предоставил доступ к поддерживаемым бесплатным моделям.',GEMINI_ACCESS:'Google запретил запрос. Проверьте доступ к Gemini API и ограничения ключа для серверных запросов.',GEMINI_KEY:'Google не принял ключ Gemini API.',GEMINI_REQUEST:'Google отклонил параметры запроса или бесплатный API недоступен для вашего региона.',GEMINI_UNAVAILABLE:'Google временно не смог выполнить запрос. Повторите позже.'};
 // Keep provider messages/headers private: they can contain credential fragments.
 return new ApiError(status===429?429:502,code,messages[code],{upstreamStatus:status});
}
function cancelled(){return new ApiError(499,'AI_CANCELLED','Создание подборки отменено.');}
function requestTimeout(payload:any){
 if(payload.purpose==='test')return 5500;
 // Bound each provider call, not the whole playlist. Large lists get more time;
 // a stalled request switches models instead of waiting 120 seconds on 3.8.
 if(payload.purpose==='fast-playlist'||payload.purpose==='playlist')return 25000+Math.min(35000,Math.max(0,(payload.limit??20)-50)*100);
 return 20000;
}
async function providerRequest(model:string,key:string,body:string,timeoutMs:number,signal?:AbortSignal){
 if(signal?.aborted)throw cancelled();
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort('timeout'),timeoutMs);
 const onCancel=()=>controller.abort('cancelled');
 signal?.addEventListener('abort',onCancel,{once:true});
 let removeAbort=()=>{};
 try{
  // Race the complete I/O, including the response body. Cancelling the fetch alone
  // is not enough when a provider sends headers and then stops sending its body.
  const stopped=new Promise<never>((_,reject)=>{
   const onAbort=()=>reject(signal?.aborted?cancelled():new ApiError(504,'GEMINI_TIMEOUT','Gemini не ответил вовремя.'));
   removeAbort=()=>controller.signal.removeEventListener('abort',onAbort);
   controller.signal.addEventListener('abort',onAbort,{once:true});
   if(controller.signal.aborted)onAbort();
  });
  const io=(async()=>{
   const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body,signal:controller.signal});
   let data:any;try{data=await response.json();}catch{if(response.ok)throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini вернул некорректный ответ.');data={};}
   return {response,data};
  })();
  return await Promise.race([io,stopped]);
 }catch(error){
  if(signal?.aborted)throw cancelled();
  if(error instanceof ApiError)throw error;
  if(controller.signal.aborted)throw new ApiError(504,'GEMINI_TIMEOUT','Gemini не ответил вовремя.');
  throw new ApiError(502,'GEMINI_UNAVAILABLE','Gemini временно недоступен.');
 }finally{clearTimeout(timer);removeAbort();signal?.removeEventListener('abort',onCancel);}
}
export async function geminiCompletion(owner:string,payload:any,signal?:AbortSignal){
 const fast=payload.purpose==='fast-playlist',connectionTest=payload.purpose==='test';
 if(!['playlist','fast-playlist','planning','searching','suggesting','reviewing','artist','test'].includes(payload.purpose)||!Array.isArray(payload.messages)||payload.messages.length<1||payload.messages.length>3||!payload.messages.some((m:any)=>m?.role==='user'&&typeof m.content==='string'&&m.content.trim())||!payload.messages.every((m:any)=>['system','user'].includes(m?.role)&&typeof m.content==='string'&&m.content.length<=(fast?120000:16000)))throw new ApiError(400,'AI_INVALID_REQUEST','Неверный запрос к ИИ.');
 if(payload.limit!==undefined&&(!Number.isSafeInteger(payload.limit)||payload.limit<1||!fast&&payload.limit>64))throw new ApiError(400,'AI_INVALID_REQUEST','Неверный размер списка.');
 if(signal?.aborted)throw cancelled();
 const key=await geminiCredentials(owner),messages=(connectionTest?[{role:'user',content:'Reply with only {"ok":true}.'}]:payload.messages) as Message[];
 const playlist=payload.purpose==='playlist';
 // One compact artist:title list. LOW reasoning preserves actual curation;
 // catalog lookup only resolves its recordings, without another AI analysis.
 const models=fast||connectionTest||playlist?curatorModels:economyModels;
 const timeoutMs=requestTimeout(payload);
 for(let index=0;index<models.length;index++){
  const model=models[index],started=Date.now();
  const requestBody=JSON.stringify({...(messages.some(m=>m.role==='system')?{systemInstruction:{parts:messages.filter(m=>m.role==='system').map(m=>({text:m.content}))}}:{}),contents:[{role:'user',parts:messages.filter(m=>m.role==='user').map(m=>({text:m.content}))}],generationConfig:{...(!fast?{temperature:.1}:{}),maxOutputTokens:fast?Math.min(32768,1024+(payload.limit??20)*64):playlist?Math.min(8192,2048+(payload.limit??20)*96):payload.purpose==='planning'?1024:payload.purpose==='reviewing'?512:connectionTest?(model==='gemini-3.8-flash'?512:128):payload.purpose==='suggesting'?Math.min(8192,256+(payload.limit??16)*80):768,responseMimeType:playlist?'text/plain':'application/json',...(fast||playlist||connectionTest?{thinkingConfig:{thinkingLevel:connectionTest&&model!=='gemini-3.8-flash'?'MINIMAL':'LOW'}}:{}),...(fast?{responseJsonSchema:payload.responseSchema}:connectionTest?{responseJsonSchema:{type:'object',properties:{ok:{type:'boolean',enum:[true]}},required:['ok'],additionalProperties:false}}:{})}});
  let response:Response,data:any;
  try{({response,data}=await providerRequest(model,key,requestBody,timeoutMs,signal));}
  catch(error){
   if(signal?.aborted||error instanceof ApiError&&error.code==='AI_CANCELLED')throw cancelled();
   const failure=error instanceof ApiError?error:new ApiError(502,'GEMINI_UNAVAILABLE','Gemini временно недоступен.');
   const willFallback=index+1<models.length&&['GEMINI_TIMEOUT','GEMINI_UNAVAILABLE'].includes(failure.code);
   console.warn('ECHO Gemini transport failed',{code:failure.code,model,purpose:payload.purpose,attempt:index+1,elapsedMs:Date.now()-started,willFallback});
   if(willFallback)continue;throw failure;
  }
  if(!response.ok){const error=providerError(response.status,data),willFallback=index+1<models.length&&(response.status===404||response.status===408||response.status>=500)&&['GEMINI_MODEL','GEMINI_UNAVAILABLE'].includes(error.code);
   console.warn('ECHO Gemini request failed',{status:response.status,code:error.code,model,purpose:payload.purpose,attempt:index+1,elapsedMs:Date.now()-started,willFallback,...diagnostics(data)});
   if(willFallback)continue;throw error;
  }
  if(signal?.aborted)throw cancelled();
  let text=(data?.candidates?.[0]?.content?.parts??[]).filter((p:any)=>!p.thought).map((p:any)=>p.text??'').join('');
  const reason=data?.candidates?.[0]?.finishReason;
  if((reason!=='STOP'&&!(playlist&&reason==='MAX_TOKENS'))||!text.trim()||text.length>(fast?250000:30000)){console.warn('ECHO Gemini output rejected',{purpose:payload.purpose,finishReason:reason??'missing',length:text.length});throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini не завершил корректный ответ.');}
  if(playlist&&reason==='MAX_TOKENS'&&!/^[\s]*[{[]/.test(text))text=text.slice(0,text.lastIndexOf('\n')+1);
  if(!playlist&&!fast)try{const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||payload.purpose==='test'&&parsed.ok!==true)throw new Error();}catch{console.warn('ECHO Gemini JSON rejected',{purpose:payload.purpose,finishReason:reason,length:text.length});throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini вернул некорректный ответ.');}
  return {text,model};
 }
 throw new ApiError(502,'GEMINI_UNAVAILABLE','Gemini временно недоступен.');
}

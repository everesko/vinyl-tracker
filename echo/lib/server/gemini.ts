import {ApiError} from './http';
import {geminiCredentials} from './settings';
// Only models with a documented free API tier. Never fall back to paid-only models.
const economyModels=['gemini-3.5-flash-lite','gemini-3.1-flash-lite'];
const curatorModel='gemini-3.6-flash';
type Message={role:'system'|'user';content:string};
function providerError(status:number,data:any){
 const reasons=(data?.error?.details??[]).map((d:any)=>String(d?.reason??''));
 const code=status===429?'GEMINI_QUOTA':status===404?'GEMINI_MODEL':status===403?'GEMINI_ACCESS':status===401||reasons.includes('API_KEY_INVALID')?'GEMINI_KEY':status===400?'GEMINI_REQUEST':'GEMINI_UNAVAILABLE';
 const messages:Record<string,string>={GEMINI_QUOTA:'Квота Gemini исчерпана. Проверьте квоту API-проекта в AI Studio.',GEMINI_MODEL:'Google не предоставил доступ к поддерживаемым бесплатным моделям.',GEMINI_ACCESS:'Google запретил запрос. Проверьте доступ к Gemini API и ограничения ключа для серверных запросов.',GEMINI_KEY:'Google не принял ключ Gemini API.',GEMINI_REQUEST:'Google отклонил параметры запроса или бесплатный API недоступен для вашего региона.',GEMINI_UNAVAILABLE:'Google временно не смог выполнить запрос. Повторите позже.'};
 // Keep provider messages/headers private: they can contain credential fragments.
 return new ApiError(status===429?429:502,code,messages[code],{upstreamStatus:status});
}
export async function geminiCompletion(owner:string,payload:any,signal?:AbortSignal){
 const fast=payload.purpose==='fast-playlist',connectionTest=payload.purpose==='test';
 if(!['playlist','fast-playlist','planning','searching','suggesting','reviewing','artist','test'].includes(payload.purpose)||!Array.isArray(payload.messages)||payload.messages.length<1||payload.messages.length>3||!payload.messages.some((m:any)=>m?.role==='user'&&typeof m.content==='string'&&m.content.trim())||!payload.messages.every((m:any)=>['system','user'].includes(m?.role)&&typeof m.content==='string'&&m.content.length<=(fast?120000:16000)))throw new ApiError(400,'AI_INVALID_REQUEST','Неверный запрос к ИИ.');
 if(payload.limit!==undefined&&(!Number.isSafeInteger(payload.limit)||payload.limit<1||!fast&&payload.limit>64))throw new ApiError(400,'AI_INVALID_REQUEST','Неверный размер списка.');
 const key=await geminiCredentials(owner),messages=payload.messages as Message[],deadline=AbortSignal.timeout(45000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
 const playlist=payload.purpose==='playlist';
 // Legacy curation used more reasoning; the new bounded flow uses a single
 // compact factual list, then verifies its recording identities in Deezer.
 // One factual list needs accurate artist/title and original-year knowledge.
 // Full Flash with MINIMAL thinking preserves factual curation at low latency.
 // Its documented free API tier is used only with the billing-off credential gate.
 const models=fast||connectionTest?[curatorModel]:playlist?['gemini-3.8-flash','gemini-3.5-flash']:economyModels;
 const requestBody=JSON.stringify({...(messages.some(m=>m.role==='system')?{systemInstruction:{parts:messages.filter(m=>m.role==='system').map(m=>({text:m.content}))}}:{}),contents:[{role:'user',parts:messages.filter(m=>m.role==='user').map(m=>({text:m.content}))}],generationConfig:{...(!fast?{temperature:.1}:{}),maxOutputTokens:fast?Math.min(32768,2048+(payload.limit??20)*160):playlist?Math.min(8192,2048+(payload.limit??20)*96):payload.purpose==='planning'?1024:payload.purpose==='reviewing'?512:payload.purpose==='test'?256:payload.purpose==='suggesting'?Math.min(8192,256+(payload.limit??16)*80):768,responseMimeType:playlist?'text/plain':'application/json',...(playlist?{thinkingConfig:{thinkingLevel:'LOW'}}:{}),...(fast||connectionTest?{thinkingConfig:{thinkingLevel:'MINIMAL'},...(fast?{responseJsonSchema:payload.responseSchema}:{})}:{})}});
 for(let index=0;index<models.length;index++){
  if(combined.aborted)throw new ApiError(504,'GEMINI_TIMEOUT','Gemini не ответил за 45 секунд.');
  let response:Response;try{response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[index]}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:requestBody,signal:combined});}catch{throw new ApiError(504,'GEMINI_TIMEOUT','Gemini не ответил за 45 секунд.');}
  if(!response.ok){let data:any;try{data=await response.json();}catch{data={};}const error=providerError(response.status,data);
   if(index+1<models.length&&(response.status===404||response.status>=500))continue;
   console.warn('ECHO Gemini request failed',{status:response.status,code:error.code,model:models[index]});throw error;
  }
  let data:any;try{data=await response.json();}catch{throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini вернул некорректный ответ.');}
  let text=(data.candidates?.[0]?.content?.parts??[]).filter((p:any)=>!p.thought).map((p:any)=>p.text??'').join('');
  const reason=data.candidates?.[0]?.finishReason;
  if((reason!=='STOP'&&!(playlist&&reason==='MAX_TOKENS'))||!text.trim()||text.length>(fast?250000:30000)){console.warn('ECHO Gemini output rejected',{purpose:payload.purpose,finishReason:reason??'missing',length:text.length});throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini не завершил корректный ответ.');}
  if(playlist&&reason==='MAX_TOKENS'&&!/^[\s]*[{[]/.test(text))text=text.slice(0,text.lastIndexOf('\n')+1);
  if(!playlist)try{const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||payload.purpose==='test'&&parsed.ok!==true)throw new Error();}catch{console.warn('ECHO Gemini JSON rejected',{purpose:payload.purpose,finishReason:reason,length:text.length});throw new ApiError(502,'AI_INVALID_RESPONSE','Gemini вернул некорректный ответ.');}
  return {text,model:models[index]};
 }
 throw new ApiError(502,'GEMINI_UNAVAILABLE','Gemini временно недоступен.');
}

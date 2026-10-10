export class RequestError extends Error {constructor(public code:string,message:string,public data:Record<string,unknown>={}){super(message);}}
export async function request<T>(url:string,data?:unknown,method='POST',signal?:AbortSignal):Promise<T>{
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),90000);
 try{
  const response=await fetch(url,{method:data===undefined&&method==='POST'?'GET':method,credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([controller.signal,signal]):controller.signal,...(data===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})});
  const text=await response.text();let body:Record<string,unknown>={};try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))body=parsed;}catch{}
  if(!response.ok)throw new RequestError(String(body.error||(response.status===401||response.status===403?'AUTH_REQUIRED':response.status===404?'ENDPOINT_MISSING':response.status>=500?'SERVER_UNAVAILABLE':'REQUEST_FAILED')),String(body.message||''),{...body,status:response.status});
  if(!Object.keys(body).length)throw new RequestError('INVALID_RESPONSE','');return body as T;
 }catch(error){if(signal?.aborted)throw new RequestError('CANCELLED','');if(controller.signal.aborted)throw new RequestError('TIMEOUT','');if(error instanceof RequestError)throw error;throw new RequestError('NETWORK','');}finally{clearTimeout(timeout);}
}

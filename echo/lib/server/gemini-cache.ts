import {database} from './http';
import {readJson,storeJson} from './stored-json';
import {geminiCompletion} from './gemini';

type Result=Awaited<ReturnType<typeof geminiCompletion>>;
/** Exact, owner-scoped responses: changed conditions and credentials checks never share a result. */
export async function cachedGeminiCompletion(owner:string,payload:any,signal?:AbortSignal){
 if(payload?.purpose==='test')return {...await geminiCompletion(owner,payload,signal),cached:false};
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([owner,payload])));
 const key='gemini-response-v2:'+Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
 try{
  const row=await database().prepare('SELECT track_data,updated_at FROM echo_media_collections WHERE id=?').bind(key).first<{track_data:string;updated_at:number}>();
  if(row&&row.updated_at>Date.now()-86400000){const cached=await readJson<Result>(row.track_data);if(cached?.text&&cached.model)return {...cached,cached:true};}
 }catch{/* Cache availability must not block the provider. */}
 const result=await geminiCompletion(owner,payload,signal);
 try{await database().prepare('INSERT INTO echo_media_collections(id,track_data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET track_data=excluded.track_data,updated_at=excluded.updated_at').bind(key,await storeJson(key,result),Date.now()).run();}catch{/* A successful completion remains usable when cache storage fails. */}
 return {...result,cached:false};
}

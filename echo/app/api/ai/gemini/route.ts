import {body,csrf,handle,identity,json} from '@/lib/server/http';
import {cachedGeminiCompletion} from '@/lib/server/gemini-cache';
export function POST(request:Request){return handle(async()=>{await csrf(request);return json(await cachedGeminiCompletion(identity(request).id,await body(request,65536),request.signal));});}

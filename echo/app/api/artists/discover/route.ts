import {body,csrf,handle,identity,json} from '@/lib/server/http';
import {discoverRequestedArtist} from '@/lib/server/artist-discovery';
export function POST(request:Request){return handle(async()=>{await csrf(request);const user=identity(request),payload=await body(request);return json(await discoverRequestedArtist(user.id,payload.query,request.signal));});}

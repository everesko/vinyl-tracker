import {body,csrf,handle,identity,json} from '@/lib/server/http';
import {collectionOptions} from '@/lib/server/popular';
import {playlistDraft} from '@/lib/server/ai-playlists';
export function POST(request:Request){return handle(async()=>{await csrf(request);const user=identity(request),payload=await body(request);return json(await playlistDraft(user.id,payload,collectionOptions(payload)));});}

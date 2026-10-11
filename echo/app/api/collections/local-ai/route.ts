import {body,csrf,handle,identity} from '@/lib/server/http';
import {collectionOptions} from '@/lib/server/popular';
import {playlistStream} from '@/lib/server/fast-playlists';
export function POST(request:Request){return handle(async()=>{await csrf(request);const user=identity(request),payload=await body(request);return playlistStream(user.id,payload,collectionOptions(payload),request.signal);});}

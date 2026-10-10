import {handle,identity,json} from '@/lib/server/http';
import {listMiniCategories} from '@/lib/server/playlist-batches';
export function GET(request:Request){return handle(async()=>json({categories:await listMiniCategories(identity(request).id)}));}

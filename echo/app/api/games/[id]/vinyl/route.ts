import {addGameVinylAlbum} from '@/lib/server/vinyl-album';
import {body,csrf,handle,identity,json} from '@/lib/server/http';
export const dynamic='force-dynamic';
export function POST(request:Request,context:{params:Promise<{id:string}>}){
  return handle(async()=>{
    await csrf(request);
    const user=identity(request),payload=await body(request,2048);
    return json(await addGameVinylAlbum(request,user.id,(await context.params).id,payload.round,payload.tableId));
  });
}

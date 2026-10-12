import {addGameVinylAlbum} from '@/lib/server/vinyl-album';
import {loadGame} from '@/lib/server/games';
import {readVinylTables} from '@/lib/server/vinyl';
import {body,csrf,handle,identity,json} from '@/lib/server/http';
export const dynamic='force-dynamic';
export function GET(request:Request,context:{params:Promise<{id:string}>}){
  return handle(async()=>{
    const user=identity(request); await loadGame(user.id,(await context.params).id);
    const stored=await readVinylTables(user.id,'albums');
    return json({tables:stored.tables.map(table=>({id:table.id,name:table.name,count:table.items.length}))});
  });
}
export function POST(request:Request,context:{params:Promise<{id:string}>}){
  return handle(async()=>{
    await csrf(request);
    const user=identity(request),payload=await body(request,2048);
    return json(await addGameVinylAlbum(request,user.id,(await context.params).id,payload.round,payload.tableId));
  });
}

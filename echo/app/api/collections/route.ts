import { body, csrf, handle, identity, json, database } from "@/lib/server/http";
import { artistCollection, automaticCollection, validatePrompt } from "@/lib/server/collections";
import { collectionOptions,popularCollections } from "@/lib/server/popular";
export function POST(request: Request) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  const options = collectionOptions(payload);
  return json(payload.artistIds !== undefined ? await artistCollection(user.id, payload.artistIds, payload.title, options) : await automaticCollection(user.id, validatePrompt(payload.prompt), options), 201);
}); }

export function DELETE(request:Request){return handle(async()=>{await csrf(request);const user=identity(request),payload=await body(request);
 if(popularCollections.some(c=>c.id===payload.id)){await database().prepare("INSERT INTO echo_progression (user_id,unlocks) VALUES (?,json_object(?,json('true'))) ON CONFLICT(user_id) DO UPDATE SET unlocks = json_set(echo_progression.unlocks, ?, json('true'))").bind(user.id,`hidden:${payload.id}`,`$."hidden:${payload.id}"`).run();return json({deleted:true});}
 if(typeof payload.id!=='string'||!payload.id.startsWith('custom-'))return json({error:'INVALID_COLLECTION',message:'Подборка не найдена.'},400);const deleted=await database().prepare('DELETE FROM echo_collections WHERE id = ? AND user_id = ? RETURNING id').bind(payload.id,user.id).first();return deleted?json({deleted:true}):json({error:'COLLECTION_NOT_FOUND',message:'Подборка не найдена.'},404);});}

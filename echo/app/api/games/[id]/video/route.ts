import { loadGame } from "@/lib/server/games";
import { resolveMusicVideo } from "@/lib/server/videos";
import { ApiError, handle, identity, json } from "@/lib/server/http";
import type { Track } from "@/lib/quiz";
export const dynamic="force-dynamic";
export function GET(request:Request,context:{params:Promise<{id:string}>}){return handle(async()=>{
 const row=await loadGame(identity(request).id,(await context.params).id);
 const state=JSON.parse(row.state) as {phase:string;index:number;deck:Track[]};
 const round=Number(new URL(request.url).searchParams.get("round"));
 if(state.phase!=="reveal"||!Number.isInteger(round)||round!==state.index)throw new ApiError(409,"VIDEO_NOT_REVEALED","Видео доступно только после ответа на текущую песню.");
 return json({round,video:await resolveMusicVideo(state.deck[round])});
});}

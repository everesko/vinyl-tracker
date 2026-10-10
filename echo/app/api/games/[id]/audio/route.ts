import { audioTrack, loadGame } from "@/lib/server/games";
import { streamAudius } from "@/lib/server/audius";
import { streamDeezer } from "@/lib/server/popular";
import { handle, identity } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: { params: Promise<{ id: string }> }) { return handle(async () => {
  const user = identity(request), id = (await context.params).id;
  const row = await loadGame(user.id, id), round = Number(new URL(request.url).searchParams.get("round"));
  const track = audioTrack(row, round);
  return track.provider === "deezer" ? streamDeezer(track, request) : streamAudius(track, user.id, request);
}); }

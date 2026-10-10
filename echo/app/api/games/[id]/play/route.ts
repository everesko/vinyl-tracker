import { changeGame } from "@/lib/server/games";
import { body, csrf, handle, identity, json } from "@/lib/server/http";
export function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  return json(await changeGame(user.id, (await context.params).id, { type: "play", round: payload.round as number }));
}); }

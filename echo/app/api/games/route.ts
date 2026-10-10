import { createGame, settingsFrom } from "@/lib/server/games";
import { ApiError, body, csrf, handle, identity, json } from "@/lib/server/http";
export function POST(request: Request) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  if (typeof payload.collectionId !== "string") throw new ApiError(400, "COLLECTION_REQUIRED", "Выберите подборку.");
  return json(await createGame(user.id, payload.collectionId, settingsFrom(payload.settings),payload.requestId), 201);
}); }

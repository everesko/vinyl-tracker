import { body, csrf, handle, identity, json } from "@/lib/server/http";
import { importChatGPTCollection } from "@/lib/server/collections";
export function POST(request: Request) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  return json(await importChatGPTCollection(user.id, payload.token, payload.title, payload.trackIds), 201);
}); }

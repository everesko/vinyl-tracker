import { body, csrf, handle, identity, json } from "@/lib/server/http";
import { prepareChatGPTCollection, validatePrompt } from "@/lib/server/collections";
export function POST(request: Request) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  return json(await prepareChatGPTCollection(user.id, validatePrompt(payload.prompt)));
}); }

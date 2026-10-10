import { body, csrf, handle, identity, json } from "@/lib/server/http";
import { saveSettings, settingsView } from "@/lib/server/settings";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handle(async () => json(await settingsView(identity(request).id))); }
export function PUT(request: Request) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  return json(await saveSettings(user.id, payload));
}); }

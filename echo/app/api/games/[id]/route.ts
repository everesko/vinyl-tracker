import { changeGame } from "@/lib/server/games";
import { handle, identity, json } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: { params: Promise<{ id: string }> }) { return handle(async () => json(await changeGame(identity(request).id, (await context.params).id, { type: "get" }))); }

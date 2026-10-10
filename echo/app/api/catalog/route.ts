import { catalogSummaryForUser } from "@/lib/server/catalog";
import { handle, identity, json } from "@/lib/server/http";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handle(async () => json(await catalogSummaryForUser(identity(request).id))); }

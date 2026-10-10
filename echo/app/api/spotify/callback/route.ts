import { handle } from "@/lib/server/http";
import { callbackSpotify } from "@/lib/server/spotify";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handle(async () => callbackSpotify(request)); }

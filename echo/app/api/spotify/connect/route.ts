import { csrf, handle } from "@/lib/server/http";
import { connectSpotify } from "@/lib/server/spotify";
export function POST(request: Request) { return handle(async () => { await csrf(request); return connectSpotify(request); }); }

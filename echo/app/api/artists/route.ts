import { handle, identity, json } from "@/lib/server/http";
import { artistBrowser } from "@/lib/server/popular";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handle(async () => {
  identity(request);
  const url = new URL(request.url);
  return json(await artistBrowser(url.searchParams.get("q") ?? "", Number(url.searchParams.get("cursor") ?? 0), Number(url.searchParams.get("limit") ?? 24),url.searchParams.get("sort")??"popular"));
}); }

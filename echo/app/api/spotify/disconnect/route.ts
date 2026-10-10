import { csrf, database, handle, identity, json } from "@/lib/server/http";
export function POST(request: Request) { return handle(async () => {
  await csrf(request); await database().prepare("DELETE FROM echo_spotify_connections WHERE user_id = ?").bind(identity(request).id).run(); return json({ connected: false });
}); }

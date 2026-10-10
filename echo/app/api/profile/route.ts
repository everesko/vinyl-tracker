import { type GameRow, sessionView, changeGame } from "@/lib/server/games";
import { body, csrf, database, handle, identity, json } from "@/lib/server/http";
import { progressFor,wallet,profileAction } from "@/lib/server/progression";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handle(async () => {
 const user=identity(request),db=database();
 const active=await db.prepare("SELECT * FROM echo_games WHERE user_id = ? AND finished = 0 ORDER BY updated_at DESC LIMIT 100").bind(user.id).all<GameRow>();
 // Settle elapsed server deadlines even when the player closes the game dialog.
 await Promise.all(active.results.filter(row=>{try{const s=JSON.parse(row.state);return s.deadline&&s.deadline<=Date.now()}catch{return false}}).map(row=>changeGame(user.id,row.id,{type:"get"})));
 // Active games have no settled XP; preserve all existing terminal ledgers.
 await db.prepare("UPDATE echo_games SET xp = 0 WHERE user_id = ? AND finished = 0 AND xp != 0").bind(user.id).run();
 const [balance,stats,sessions,history,progression]=await Promise.all([
  wallet(user.id),
  db.prepare("SELECT COUNT(*) AS games, COALESCE(SUM(correct),0) AS correct, COALESCE(SUM(total),0) AS total, COALESCE(MAX(score_tenths),0)/10.0 AS bestScore FROM echo_games WHERE user_id = ? AND finished = 1 AND json_extract(state,'$.phase') = 'finished'").bind(user.id).first(),
  db.prepare("SELECT * FROM echo_games WHERE user_id = ? AND finished = 0 ORDER BY updated_at DESC LIMIT 20").bind(user.id).all<GameRow>(),
  db.prepare("SELECT id, collection_id AS collectionId, collection_title AS collectionTitle, score_tenths/10.0 AS score, correct, total, xp AS xpAwarded, json_extract(state,'$.practice') AS practice, json_extract(state,'$.phase') AS status, updated_at AS completedAt FROM echo_games WHERE user_id = ? AND finished = 1 ORDER BY updated_at DESC LIMIT 30").bind(user.id).all(),progressFor(user.id)
 ]);
 return json({profile:{displayName:user.displayName,xp:balance,...stats},progression,sessions:await Promise.all(sessions.results.map(sessionView)),history:history.results,ai:{available:true,method:"local",free:true}});
}); }
export function DELETE(request:Request){return handle(async()=>{
 await csrf(request);if(request.body)await body(request);const user=identity(request),db=database();
 await db.batch([db.prepare("DELETE FROM echo_games WHERE user_id = ?").bind(user.id),db.prepare("DELETE FROM echo_spotify_connections WHERE user_id = ?").bind(user.id),db.prepare("DELETE FROM echo_collections WHERE user_id = ?").bind(user.id),db.prepare("DELETE FROM echo_settings WHERE user_id = ?").bind(user.id),db.prepare("DELETE FROM echo_profile_balances WHERE user_id = ?").bind(user.id),db.prepare("DELETE FROM echo_progression WHERE user_id = ?").bind(user.id)]);
 return json({deleted:true});
});}
export function POST(request:Request){return handle(async()=>{
 await csrf(request);const payload=request.body?await body(request):{},user=identity(request);return json(await profileAction(user.id,payload));
});}

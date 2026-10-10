import { changeGame } from "@/lib/server/games";
import { ApiError, body, csrf, handle, identity, json } from "@/lib/server/http";
export function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  if ((payload.artist !== undefined && typeof payload.artist !== "string") || (payload.song !== undefined && typeof payload.song !== "string") || (payload.spoken !== undefined && typeof payload.spoken !== "string")) throw new ApiError(400, "INVALID_ANSWER", "Ответ должен быть текстом.");
  const artist = (payload.artist as string | undefined) ?? "", song = (payload.song as string | undefined) ?? "";
  if (artist.length > 200 || song.length > 200) throw new ApiError(400, "ANSWER_TOO_LONG", "Ответ слишком длинный.");
  const spoken = payload.spoken as string | undefined;
  if (spoken && spoken.length > 400) throw new ApiError(400, "ANSWER_TOO_LONG", "Голосовой ответ слишком длинный.");
  if (payload.mode !== undefined && !["artist", "song", "both"].includes(payload.mode as string)) throw new ApiError(400, "INVALID_MODE", "Выберите, что вы угадываете в этом раунде.");
  return json(await changeGame(user.id, (await context.params).id, { type: "answer", round: payload.round as number, artist, song, spoken, mode: payload.mode as "artist" | "song" | "both" | undefined }));
}); }

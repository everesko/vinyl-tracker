import { changeGame } from "@/lib/server/games";
import { type Settings } from "@/lib/quiz";
import { ApiError, body, csrf, handle, identity, json } from "@/lib/server/http";
export function POST(request: Request, context: { params: Promise<{ id: string }> }) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  if (Object.keys(payload).some(key => !["round", "duration", "timer", "difficulty"].includes(key))) throw new ApiError(400, "INVALID_SETTINGS", "Во время игры доступны длина фрагмента, сложность и включение таймера.");
  const settings: Partial<Pick<Settings, "duration" | "timer" | "difficulty">> = {};
  for (const key of ["duration", "timer", "difficulty"] as const) if (payload[key] !== undefined) Object.assign(settings, { [key]: payload[key] });
  return json(await changeGame(user.id, (await context.params).id, { type: "settings", round: payload.round as number, settings }));
}); }

import { ApiError, body, csrf, handle, identity, json } from "@/lib/server/http";
import { audiusRequest } from "@/lib/server/audius";
import { credentials, validateKey, validateModel } from "@/lib/server/settings";

export function POST(request: Request) { return handle(async () => {
  await csrf(request); const user = identity(request), payload = await body(request);
  if (payload.provider !== "openai" && payload.provider !== "audius") throw new ApiError(400, "INVALID_PROVIDER", "Выберите OpenAI или Audius.");
  const saved = await credentials(user.id), suppliedKey = payload.key !== undefined ? validateKey(payload.key) : undefined;
  if (payload.provider === "audius") {
    try { await audiusRequest("/tracks/trending", new URLSearchParams({ limit: "1", time: "allTime" }), suppliedKey || saved.audiusKey); }
    catch { throw new ApiError(502, "PROVIDER_TEST_FAILED", "Audius сейчас не ответил. Попробуйте позже.", { provider: "audius" }); }
    return json({ ok: true, provider: "audius", message: "Публичный каталог Audius доступен. Для прослушивания ключ не обязателен." });
  }
  const key = suppliedKey || saved.openaiKey, model = payload.model !== undefined ? validateModel(payload.model) : saved.model;
  if (!key) throw new ApiError(400, "OPENAI_KEY_REQUIRED", "Введите ключ OpenAI или сохраните его в настройках.", { provider: "openai" });
  let response: Response;
  try { response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new ApiError(504, "PROVIDER_TEST_TIMEOUT", "OpenAI не ответил вовремя. Повторите проверку.", { provider: "openai" }); }
  await response.body?.cancel();
  if (!response.ok) throw new ApiError(502, "PROVIDER_TEST_FAILED", response.status === 401 ? "OpenAI не принял ключ. Проверьте его и попробуйте снова." : "Эта модель недоступна для ключа. Проверьте имя модели и права доступа.", { provider: "openai" });
  return json({ ok: true, provider: "openai", message: `Ключ принят. Модель ${model} доступна; запрос на создание подборки оплачивается по тарифу OpenAI API.` });
}); }

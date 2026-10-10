import { env } from "cloudflare:workers";

export type RuntimeEnv = Cloudflare.Env & {
  SITE_ORIGIN?: string;
  LICENSED_CATALOG_JSON?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  AUDIUS_API_KEY?: string;
  SPOTIFY_APPROVED_FOR_QUIZ?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  SESSION_ENCRYPTION_KEY?: string;
};
export function runtime(): RuntimeEnv { return env as RuntimeEnv; }
export function database(): D1Database {
  const db = runtime().DB;
  if (!db) throw new ApiError(503, "DATABASE_UNAVAILABLE", "Хранилище пока недоступно. Попробуйте позже.");
  return db;
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}
export function json(value: unknown, status = 200, headers?: HeadersInit) {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("Cache-Control", "private, no-store");
  return Response.json(value, { status, headers: outputHeaders });
}
export async function handle(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: error.code, message: error.message, ...error.extra }, error.status);
    console.error("ECHO API failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "SERVER_ERROR", message: "Не удалось сохранить изменения. Повторите попытку." }, 500);
  }
}
export function identity(request: Request) {
  const id = request.headers.get("oai-authenticated-user-id");
  const email = request.headers.get("oai-authenticated-user-email");
  if (id && email) {
    let name = request.headers.get("oai-authenticated-user-full-name") || email.split("@")[0];
    if (request.headers.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8") {
      try { name = decodeURIComponent(name); } catch { name = email.split("@")[0]; }
    }
    return { id, displayName: name.slice(0, 100) };
  }
  const hostname = new URL(request.url).hostname;
  if (process.env.NODE_ENV === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return { id: "local-dev", displayName: "Игрок" };
  throw new ApiError(401, "AUTH_REQUIRED", "Войдите через ChatGPT, чтобы сохранять игры и прогресс.");
}
export async function csrf(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    // Consume bounded rejected bodies before responding: an unread incoming stream can
    // interrupt the next request in Worker previews. Never drain an unbounded payload.
    const reader = request.body?.getReader();
    if (reader) {
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 10240) { await reader.cancel(); break; }
        }
      } catch { /* A disconnected caller still receives no authorization. */ }
      finally { reader.releaseLock(); }
    }
    throw new ApiError(403, "ORIGIN_MISMATCH", "Запрос должен быть отправлен с этой страницы.");
  }
}
export async function body(request: Request,limit=10240): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new ApiError(415, "JSON_REQUIRED", "Ожидается JSON.");
  if (Number(request.headers.get("content-length")) > limit) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "Пустой запрос.");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос."); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, "INVALID_JSON", "Не удалось прочитать запрос."); }
}

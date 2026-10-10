import { ApiError, database, runtime } from "./http";
import { decryptSecret, encryptSecret, encryptionAvailable } from "./secrets";

type SavedSettings = { openaiKey?: string; audiusKey?: string; model?: string; geminiKey?:string; geminiFreeTier?:boolean; aiProvider?:'local'|'gemini' };
type SettingsRow = { encrypted_settings: string; version: number };
export function validateModel(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(value)) throw new ApiError(400, "INVALID_MODEL", "Укажите корректное имя модели OpenAI.");
  return value;
}
export function validateKey(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 2048 || /\s/.test(value.trim())) throw new ApiError(400, "INVALID_KEY", "Ключ должен содержать от 8 до 2048 символов без пробелов.");
  return value.trim();
}
async function readSaved(userId: string): Promise<{ row: SettingsRow | null; settings: SavedSettings }> {
  const row = await database().prepare("SELECT encrypted_settings, version FROM echo_settings WHERE user_id = ?").bind(userId).first<SettingsRow>();
  if (!row) return { row, settings: {} };
  try { return { row, settings: await decryptSecret<SavedSettings>(row.encrypted_settings, `settings:${userId}`) }; }
  catch { throw new ApiError(503, "SETTINGS_UNREADABLE", "Не удалось расшифровать сохранённые ключи. Проверьте серверный ключ шифрования."); }
}
export async function credentials(userId: string) {
  const { settings } = await readSaved(userId);
  return { openaiKey: settings.openaiKey || runtime().OPENAI_API_KEY, audiusKey: settings.audiusKey || runtime().AUDIUS_API_KEY, model: settings.model || runtime().OPENAI_MODEL || "gpt-4.1-mini" };
}
export async function geminiCredentials(userId:string){const {settings}=await readSaved(userId);if(!settings.geminiKey)throw new ApiError(400,'GEMINI_NOT_CONFIGURED','Добавьте ключ Gemini в настройках.');if(!settings.geminiFreeTier)throw new ApiError(400,'GEMINI_FREE_TIER_REQUIRED','Подтвердите, что у API-проекта отключён биллинг.');return settings.geminiKey;}
export async function settingsView(userId: string) {
  const { settings } = await readSaved(userId);
  return {
    gemini:{configured:!!settings.geminiKey,freeTier:!!settings.geminiFreeTier},aiProvider:settings.aiProvider??'local',
    openai: { configured: !!settings.openaiKey, tail: settings.openaiKey?.slice(-4) ?? null, model: settings.model || runtime().OPENAI_MODEL || "gpt-4.1-mini" },
    audius: { configured: !!settings.audiusKey, tail: settings.audiusKey?.slice(-4) ?? null },
    storageAvailable: encryptionAvailable(),
    ...(!encryptionAvailable() ? { storageReason: "Защищённое хранение ключей ещё не настроено на сервере." } : {}),
  };
}
export async function saveSettings(userId: string, patch: Record<string, unknown>) {
  if (!encryptionAvailable()) throw new ApiError(503, "ENCRYPTION_NOT_CONFIGURED", "Для сохранения ключей нужен серверный ключ шифрования.");
  const allowed = ["openaiKey", "audiusKey", "model", "geminiKey", "geminiFreeTier", "aiProvider"];
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !allowed.includes(key))) throw new ApiError(400, "INVALID_SETTINGS", "Ожидаются настройки OpenAI, Audius или имя модели.");
  const changes: SavedSettings = {};
  for (const field of ["openaiKey", "audiusKey", "geminiKey"] as const) if (field in patch) changes[field] = validateKey(patch[field]);
  if('geminiFreeTier' in patch){if(typeof patch.geminiFreeTier!=='boolean')throw new ApiError(400,'INVALID_SETTINGS','Неверные настройки Gemini.');changes.geminiFreeTier=patch.geminiFreeTier;}
  if('aiProvider' in patch){if(patch.aiProvider!=='local'&&patch.aiProvider!=='gemini')throw new ApiError(400,'INVALID_SETTINGS','Неверный сервис ИИ.');changes.aiProvider=patch.aiProvider;}
  if ("model" in patch) changes.model = validateModel(patch.model);
  for (let attempt = 0; attempt < 5; attempt++) {
    const { row, settings } = await readSaved(userId), combined = { ...settings, ...changes };
    if(combined.aiProvider==='gemini'&&(!combined.geminiKey||!combined.geminiFreeTier))throw new ApiError(400,'GEMINI_FREE_TIER_REQUIRED','Для Gemini нужен ключ и подтверждение отключённого биллинга.');
    const encrypted = await encryptSecret(combined, `settings:${userId}`);
    if (!row) {
      const inserted = await database().prepare("INSERT INTO echo_settings (user_id, encrypted_settings, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(user_id) DO NOTHING RETURNING user_id").bind(userId, encrypted, Date.now()).first();
      if (inserted) return settingsView(userId);
    } else {
      const updated = await database().prepare("UPDATE echo_settings SET encrypted_settings = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ? RETURNING user_id").bind(encrypted, Date.now(), userId, row.version).first();
      if (updated) return settingsView(userId);
    }
  }
  throw new ApiError(409, "SETTINGS_CONFLICT", "Настройки изменились в другой вкладке. Повторите сохранение.");
}

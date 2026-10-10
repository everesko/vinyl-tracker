import { ApiError, runtime } from "./http";

export function encryptionAvailable() { return (runtime().SESSION_ENCRYPTION_KEY?.length ?? 0) >= 32; }
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function decode(value: string) { return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
async function encryptionKey() {
  if (!encryptionAvailable()) throw new ApiError(503, "ENCRYPTION_NOT_CONFIGURED", "Защищённое хранение ключей ещё не настроено на сервере.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runtime().SESSION_ENCRYPTION_KEY!));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(value: unknown, ownerContext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ownerContext) }, await encryptionKey(), encoded);
  return `v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function decryptSecret<T>(value: string, ownerContext: string): Promise<T> {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("Invalid encrypted value");
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv), additionalData: new TextEncoder().encode(ownerContext) }, await encryptionKey(), decode(ciphertext));
  return JSON.parse(new TextDecoder().decode(decrypted)) as T;
}

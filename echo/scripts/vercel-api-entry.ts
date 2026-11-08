import type { IncomingMessage, ServerResponse } from "node:http";
import * as aiGemini from "../app/api/ai/gemini/route";
import * as artists from "../app/api/artists/route";
import * as artistsDiscover from "../app/api/artists/discover/route";
import * as catalog from "../app/api/catalog/route";
import * as collections from "../app/api/collections/route";
import * as collectionsCategories from "../app/api/collections/categories/route";
import * as collectionsChatgpt from "../app/api/collections/chatgpt/route";
import * as collectionsImport from "../app/api/collections/import/route";
import * as collectionsLocalAi from "../app/api/collections/local-ai/route";
import * as games from "../app/api/games/route";
import * as gameById from "../app/api/games/[id]/route";
import * as gameAnswer from "../app/api/games/[id]/answer/route";
import * as gameAudio from "../app/api/games/[id]/audio/route";
import * as gameCancel from "../app/api/games/[id]/cancel/route";
import * as gameHint from "../app/api/games/[id]/hint/route";
import * as gameHintError from "../app/api/games/[id]/hint-error/route";
import * as gameMediaError from "../app/api/games/[id]/media-error/route";
import * as gameNext from "../app/api/games/[id]/next/route";
import * as gamePause from "../app/api/games/[id]/pause/route";
import * as gamePlay from "../app/api/games/[id]/play/route";
import * as gameReplaceFragment from "../app/api/games/[id]/replace-fragment/route";
import * as gameReplaceTrack from "../app/api/games/[id]/replace-track/route";
import * as gameResume from "../app/api/games/[id]/resume/route";
import * as gameSettings from "../app/api/games/[id]/settings/route";
import * as gameVideo from "../app/api/games/[id]/video/route";
import * as gameVinyl from "../app/api/games/[id]/vinyl/route";
import * as profile from "../app/api/profile/route";
import * as settings from "../app/api/settings/route";
import * as settingsTest from "../app/api/settings/test/route";
import * as spotifyCallback from "../app/api/spotify/callback/route";
import * as spotifyConnect from "../app/api/spotify/connect/route";
import * as spotifyDisconnect from "../app/api/spotify/disconnect/route";
import * as vinylLegacy from "../app/api/vinyl/legacy/[...path]/route";

process.env.ECHO_STANDALONE = "1";

type RouteModule = Record<string, (req: Request, ctx: { params: Promise<any> }) => Promise<Response> | Response>;

const staticRoutes: Record<string, RouteModule> = {
  "/api/ai/gemini": aiGemini as any,
  "/api/artists": artists as any,
  "/api/artists/discover": artistsDiscover as any,
  "/api/catalog": catalog as any,
  "/api/collections": collections as any,
  "/api/collections/categories": collectionsCategories as any,
  "/api/collections/chatgpt": collectionsChatgpt as any,
  "/api/collections/import": collectionsImport as any,
  "/api/collections/local-ai": collectionsLocalAi as any,
  "/api/games": games as any,
  "/api/profile": profile as any,
  "/api/settings": settings as any,
  "/api/settings/test": settingsTest as any,
  "/api/spotify/callback": spotifyCallback as any,
  "/api/spotify/connect": spotifyConnect as any,
  "/api/spotify/disconnect": spotifyDisconnect as any,
};

const gameSubroutes: Record<string, RouteModule> = {
  "": gameById as any,
  "answer": gameAnswer as any,
  "audio": gameAudio as any,
  "cancel": gameCancel as any,
  "hint": gameHint as any,
  "hint-error": gameHintError as any,
  "media-error": gameMediaError as any,
  "next": gameNext as any,
  "pause": gamePause as any,
  "play": gamePlay as any,
  "replace-fragment": gameReplaceFragment as any,
  "replace-track": gameReplaceTrack as any,
  "resume": gameResume as any,
  "settings": gameSettings as any,
  "video": gameVideo as any,
  "vinyl": gameVinyl as any,
};

function matchRoute(pathname: string): { mod: RouteModule; params: Record<string, any> } | null {
  const clean = pathname.replace(/\/+$/, "") || "/";
  if (staticRoutes[clean]) {
    return { mod: staticRoutes[clean], params: {} };
  }
  const gameMatch = clean.match(/^\/api\/games\/([^/]+)(?:\/([^/]+))?$/);
  if (gameMatch) {
    const id = decodeURIComponent(gameMatch[1]);
    const sub = gameMatch[2] || "";
    const mod = gameSubroutes[sub];
    if (mod) return { mod, params: { id } };
  }
  const vinylMatch = clean.match(/^\/api\/vinyl\/legacy\/(.+)$/);
  if (vinylMatch) {
    const segments = vinylMatch[1].split("/").map(decodeURIComponent);
    return { mod: vinylLegacy as any, params: { path: segments } };
  }
  return null;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || "https";
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
    const rawUrl = req.url || "/";
    const parsed = new URL(rawUrl, `${proto}://${host}`);

    if (parsed.searchParams.has("__path")) {
      const rawPath = parsed.searchParams.get("__path") || "";
      parsed.searchParams.delete("__path");
      parsed.pathname = "/api/" + rawPath.replace(/^\/+/, "");
    } else if (req.headers["x-matched-path"] && !String(req.headers["x-matched-path"]).startsWith("/api/index")) {
      parsed.pathname = String(req.headers["x-matched-path"]);
    }

    const matched = matchRoute(parsed.pathname);
    if (!matched) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "NOT_FOUND", path: parsed.pathname }));
      return;
    }

    const method = (req.method || "GET").toUpperCase();
    const fn = matched.mod[method];
    if (!fn) {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }));
      return;
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else if (typeof v === "string") {
        headers.set(k, v);
      }
    }
    if (!headers.has("origin")) {
      headers.set("origin", `${proto}://${host}`);
    }

    const hasBody = !["GET", "HEAD"].includes(method);
    const bodyBuf = hasBody ? await readRawBody(req) : undefined;

    const webReq = new Request(parsed.toString(), {
      method,
      headers,
      body: hasBody && bodyBuf && bodyBuf.length > 0 ? new Uint8Array(bodyBuf) : undefined,
    });

    const webRes = await fn(webReq, { params: Promise.resolve(matched.params) });
    res.statusCode = webRes.status;
    webRes.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });
    const arrayBuf = await webRes.arrayBuffer();
    res.end(Buffer.from(arrayBuf));
  } catch (err) {
    console.error("Vercel API Entry Error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "SERVER_ERROR", message: err instanceof Error ? err.message : "Unknown error" }));
  }
}

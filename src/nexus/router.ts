/**
 * The Nexus route table.
 *
 * `handleNexus` returns `null` when the request is not for one of these routes,
 * and worker.js then runs the original chat handler exactly as before. That null
 * is the whole non-breaking strategy: the legacy path is not reimplemented, not
 * wrapped in a shim, and not reordered — it is simply the fallback.
 */
import { authenticate, type AuthDeps } from "./auth";
import { errorResponse, jsonResponse, preflight } from "./cors";
import { handleAgent } from "./agent";
import {
  handleHandoffCreate,
  handleHandoffDelete,
  handleHandoffGet,
} from "./bus";
import {
  buildAuthUrl,
  handleCalendar,
  handleCallback,
  handleDocs,
  handleDrive,
  handleGmail,
  handleGoogleStatus,
  handleSheets,
} from "./google";
import { handleHealth } from "./health";
import { ACTIVE, CHAT_CHAIN, CHAT_ALLOWED, LEGACY_ALIASES, RETIRED_ON_2026_11_20 } from "./models";
import { handlePresign } from "./presign";
import { handleTranscribe } from "./transcribe";
import { handleTts } from "./tts";
import { HttpError, type NexusEnv } from "./types";

/** Paths this module owns. Used by the Worker to answer CORS preflight correctly. */
export const NEXUS_PREFIXES = ["/health", "/v1/"] as const;

export function isNexusPath(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/v1/");
}

export async function handleNexus(
  request: Request,
  env: NexusEnv,
  deps: AuthDeps
): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (!isNexusPath(pathname)) return null;

  if (method === "OPTIONS") return preflight();

  // ---- public -----------------------------------------------------------
  if (pathname === "/health" && method === "GET") return handleHealth(env);

  if (pathname === "/v1/models" && method === "GET") {
    return jsonResponse({
      ok: true,
      active: ACTIVE,
      chatChain: CHAT_CHAIN,
      chatAllowed: CHAT_ALLOWED,
      legacyAliases: LEGACY_ALIASES,
      retired: [...RETIRED_ON_2026_11_20],
      note: "Retired ids are mapped through legacyAliases, so old clients keep working without changes.",
    });
  }

  // The OAuth callback arrives as a browser redirect with no bearer token. It is
  // protected by the signed, expiring `state` instead.
  if (pathname === "/v1/google/callback" && method === "GET") {
    return handleCallback(request, env);
  }

  // ---- authenticated from here on --------------------------------------
  const auth = await authenticate(request, env, deps);
  if (!auth.ok) return auth.response;
  const uid = auth.identity.uid;

  try {
    if (pathname === "/v1/tts" && method === "POST") return await handleTts(request, env);
    if (pathname === "/v1/transcribe" && method === "POST") return await handleTranscribe(request, env);

    if (pathname === "/v1/storage/presign" && method === "POST") {
      return await handlePresign(request, uid, env);
    }

    if (pathname === "/v1/agent" && method === "POST") return await handleAgent(request, env, uid);

    if (pathname === "/v1/google/auth-url" && method === "GET") {
      const built = await buildAuthUrl(env, uid);
      return jsonResponse({ ok: true, url: built.url, scopes: built.scopes, expiresIn: 600 });
    }
    if (pathname === "/v1/google/status" && method === "GET") return await handleGoogleStatus(env, uid);

    if (pathname.startsWith("/v1/google/") && method === "POST") {
      const service = pathname.slice("/v1/google/".length);
      let body: Record<string, any>;
      try {
        body = (await request.json()) as Record<string, any>;
      } catch {
        return errorResponse("Body must be JSON.", 400);
      }
      switch (service) {
        case "drive":
          return await handleDrive(env, uid, body);
        case "gmail":
          return await handleGmail(env, uid, body);
        case "calendar":
          return await handleCalendar(env, uid, body);
        case "docs":
          return await handleDocs(env, uid, body);
        case "sheets":
          return await handleSheets(env, uid, body);
        default:
          return errorResponse(`Unknown Google service: ${service}. Use drive, gmail, calendar, docs or sheets.`, 404);
      }
    }

    if (pathname === "/v1/bus/handoff" && method === "POST") {
      return await handleHandoffCreate(request, env, uid);
    }
    // Match anything after the slash and let the handler validate the id, so a
    // malformed id gets a 400 with an explanation instead of a bare 404.
    const handoffMatch = /^\/v1\/bus\/handoff\/([^/]+)$/.exec(pathname);
    if (handoffMatch) {
      if (method === "GET") return await handleHandoffGet(env, uid, handoffMatch[1]);
      if (method === "DELETE") return await handleHandoffDelete(env, uid, handoffMatch[1]);
    }

    return errorResponse(`${method} ${pathname} is not a route here. See GET /v1/models for the list.`, 404);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.message, err.status, err.details);
    const message = err instanceof Error ? err.message : String(err);
    console.log("Nexus route failed:", pathname, message.slice(0, 300));
    return errorResponse("The route failed.", 500, { upstream: message.slice(0, 300) });
  }
}

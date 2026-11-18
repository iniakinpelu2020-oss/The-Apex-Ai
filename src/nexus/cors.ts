/**
 * CORS for the Nexus routes.
 *
 * The legacy chat route keeps its own `CORS` constant (POST + OPTIONS only) and
 * is untouched. These routes are reached from several different Apex apps —
 * Studio on one Pages domain, Editor on another — so the methods list is wider
 * and includes GET for the OAuth callback, health and handoff reads.
 */

export const NEXUS_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Apex-Internal-Secret",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...NEXUS_CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

export function textResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...NEXUS_CORS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  });
}

export function errorResponse(message: string, status = 400, details?: unknown): Response {
  return jsonResponse({ ok: false, error: { message, ...(details === undefined ? {} : { details }) } }, status);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: NEXUS_CORS });
}

/** A binary download (TTS audio) with the same CORS treatment. */
export function audioResponse(bytes: ArrayBuffer, contentType = "audio/mpeg"): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      ...NEXUS_CORS,
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      // The audio is generated per request, so nothing may cache it.
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="apex-tts-${Date.now()}.${contentType.includes("wav") ? "wav" : "mp3"}"`,
    },
  });
}

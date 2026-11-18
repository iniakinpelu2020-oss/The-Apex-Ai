/**
 * The single-owner gate for every new route.
 *
 * Two ways in, and only two:
 *   1. A Firebase ID token whose `sub` equals env.OWNER_UID.
 *   2. `X-Apex-Internal-Secret` matching env.INTERNAL_SECRET, for calls made by
 *      another Apex Worker rather than by a browser.
 *
 * The existing chat route is deliberately NOT routed through the owner check:
 * it already requires a valid Firebase token and changing that would change
 * who the live app lets in. Non-breaking means non-breaking.
 */
import { errorResponse, jsonResponse } from "./cors";
import type { Identity, NexusEnv } from "./types";

/** The existing verifier, passed in from worker.js so there is only one copy. */
export interface AuthDeps {
  verifyFirebaseToken(token: string): Promise<{ sub?: string; [k: string]: unknown } | null>;
}

export type AuthResult = { ok: true; identity: Identity } | { ok: false; response: Response };

/**
 * Constant-time string comparison.
 *
 * A plain `===` on secrets leaks length and prefix information through timing.
 * This compares in fixed time once lengths match, which is enough to stop an
 * online guessing attack from learning anything useful per request.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authenticate(
  request: Request,
  env: NexusEnv,
  deps: AuthDeps
): Promise<AuthResult> {
  // 1. Internal service call.
  const internal = request.headers.get("X-Apex-Internal-Secret") || "";
  if (internal && env.INTERNAL_SECRET && safeEqual(internal, env.INTERNAL_SECRET)) {
    return { ok: true, identity: { uid: env.OWNER_UID || "internal", via: "internal" } };
  }

  // 2. A real user token.
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { ok: false, response: errorResponse("Missing bearer token.", 401) };
  }

  const claims = await deps.verifyFirebaseToken(token);
  if (!claims || typeof claims.sub !== "string" || !claims.sub) {
    return { ok: false, response: errorResponse("Invalid or expired token.", 401) };
  }

  if (!env.OWNER_UID) {
    // Refusing is the safe direction. If the owner is unknown, nobody is the owner.
    return {
      ok: false,
      response: errorResponse(
        "OWNER_UID is not configured on this Worker, so owner-only routes are closed. Run: wrangler secret put OWNER_UID",
        503
      ),
    };
  }

  if (!safeEqual(claims.sub, env.OWNER_UID)) {
    return { ok: false, response: errorResponse("This account is not the owner.", 403) };
  }

  return { ok: true, identity: { uid: claims.sub, via: "firebase" } };
}

/**
 * Guards a route that needs a KV namespace. Returns a readable 503 rather than a
 * crash when the binding has not been created yet, which is the state this repo
 * ships in until `wrangler kv namespace create APEX_VAULT` has been run.
 */
export function requireVault(env: NexusEnv): Response | null {
  if (env.APEX_VAULT) return null;
  return jsonResponse(
    {
      ok: false,
      error: {
        message:
          "APEX_VAULT is not bound. Create the namespace and add it to wrangler.jsonc: wrangler kv namespace create APEX_VAULT",
      },
    },
    503
  );
}

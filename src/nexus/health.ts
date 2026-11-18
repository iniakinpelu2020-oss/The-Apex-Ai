/**
 * GET /health — the thing a monitor polls.
 *
 * It reports configuration as booleans, never values, so a public monitor can
 * call it without learning a secret. A missing binding is reported as "not
 * configured" rather than as a failure, because an unconfigured feature is a
 * fact about the deployment, not an outage.
 */
import { jsonResponse } from "./cors";
import { ACTIVE } from "./models";
import type { NexusEnv } from "./types";

export function handleHealth(env: NexusEnv): Response {
  return jsonResponse(
    {
      status: "ok",
      service: "apex-nexus",
      timestamp: new Date().toISOString(),
      models: {
        general: ACTIVE.generalFast.id,
        generalSmall: ACTIVE.generalSmall.id,
        coding: ACTIVE.frontier.id,
        codingAlt: ACTIVE.frontierAlt.id,
        vision: ACTIVE.vision.id,
        tts: ACTIVE.tts.id,
        stt: ACTIVE.stt.id,
        sttFallback: ACTIVE.sttFallback.id,
      },
      capabilities: {
        ai: Boolean(env.AI),
        vault: Boolean(env.APEX_VAULT),
        rateLimit: Boolean(env.RATE),
        ownerLocked: Boolean(env.OWNER_UID),
        google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ENCRYPTION_KEY),
        storage: Boolean(env.DRIVE_B2_ENDPOINT && env.DRIVE_B2_BUCKET && env.DRIVE_B2_KEY_ID && env.DRIVE_B2_APP_KEY),
        internalSecret: Boolean(env.INTERNAL_SECRET),
      },
    },
    200,
    { "Cache-Control": "no-store" }
  );
}

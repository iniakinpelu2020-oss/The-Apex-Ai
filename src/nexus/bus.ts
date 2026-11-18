/**
 * Cross-app handoff bus.
 *
 * Apex Studio generates a WAV or an MP4 and wants it to arrive in Apex Editor.
 * The two apps are different origins, so neither localStorage, IndexedDB nor a
 * query string can carry the bytes. This is the small piece of shared state that
 * can: a short-lived record keyed by an opaque id.
 *
 * Two payload shapes, on purpose:
 *   - `url`  — a presigned B2 link. Preferred for anything large.
 *   - `dataBase64` — inline bytes, capped hard. Fine for a 300 KB music bed,
 *     wrong for a 40 MB montage, and the error says which.
 *
 * Records expire after ten minutes. The id is random, single-use, and read back
 * only by the owner.
 */
import { errorResponse, jsonResponse } from "./cors";
import { requireVault } from "./auth";
import { HttpError, type NexusEnv } from "./types";

const TTL_SECONDS = 600;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

interface HandoffBody {
  kind?: unknown;
  name?: unknown;
  mime?: unknown;
  url?: unknown;
  dataBase64?: unknown;
  meta?: unknown;
  from?: unknown;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Base64 length without decoding the string. */
function base64Bytes(value: string): number {
  const clean = value.replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

export async function handleHandoffCreate(request: Request, env: NexusEnv, uid: string): Promise<Response> {
  const missing = requireVault(env);
  if (missing) return missing;

  let body: HandoffBody;
  try {
    body = (await request.json()) as HandoffBody;
  } catch {
    return errorResponse("Body must be JSON.", 400);
  }

  const kind = String(body.kind ?? "").trim();
  if (kind !== "audio" && kind !== "video") {
    return errorResponse("`kind` must be \"audio\" or \"video\".", 400);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const data = typeof body.dataBase64 === "string" ? body.dataBase64.trim() : "";
  if (!url && !data) {
    return errorResponse("Provide either `url` (presigned) or `dataBase64` (inline bytes).", 400);
  }

  if (data && !url) {
    const size = base64Bytes(data);
    if (size > MAX_INLINE_BYTES) {
      throw new HttpError(
        413,
        `Inline payload is ${(size / 1048576).toFixed(1)} MB; the limit is ${MAX_INLINE_BYTES / 1048576} MB. ` +
          "Upload the file with /v1/storage/presign and pass the resulting `url` instead."
      );
    }
  }

  const id = newId();
  const record = {
    id,
    uid,
    kind,
    name: String(body.name ?? `${kind}-${id}`),
    mime: String(body.mime ?? (kind === "audio" ? "audio/wav" : "video/mp4")),
    url: url || null,
    data: url ? null : data,
    size: url ? null : base64Bytes(data),
    meta: body.meta ?? {},
    from: String(body.from ?? "unknown"),
    createdAt: new Date().toISOString(),
  };

  const expiresAt = Date.now() + TTL_SECONDS * 1000;
  await env.APEX_VAULT!.put(`bus:${id}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });

  return jsonResponse({
    ok: true,
    id,
    expiresAt: new Date(expiresAt).toISOString(),
    ttlSeconds: TTL_SECONDS,
    // The Editor opens this with ?handoff=<id>.
    openPath: `/v1/bus/handoff/${id}`,
    size: record.size,
  });
}

export async function handleHandoffGet(env: NexusEnv, uid: string, id: string): Promise<Response> {
  const missing = requireVault(env);
  if (missing) return missing;

  if (!/^[a-f0-9]{24}$/.test(id)) {
    return errorResponse("That handoff id is not valid.", 400);
  }

  const raw = await env.APEX_VAULT!.get(`bus:${id}`);
  if (!raw) {
    return errorResponse("That handoff has expired or never existed. Handoffs last 10 minutes.", 404);
  }

  const record = JSON.parse(raw) as { uid: string } & Record<string, unknown>;
  if (record.uid !== uid) {
    // Same answer as missing, so an id cannot be probed for existence.
    return errorResponse("That handoff has expired or never existed. Handoffs last 10 minutes.", 404);
  }

  if (!record.url && typeof record.data === "string") {
    // Keep the response shape stable but make the bytes easy to consume.
    return jsonResponse({ ok: true, handoff: { ...record, data: undefined, dataBase64: record.data } });
  }
  return jsonResponse({ ok: true, handoff: record });
}

/** Single-use: the Editor deletes the record once it has the asset. */
export async function handleHandoffDelete(env: NexusEnv, uid: string, id: string): Promise<Response> {
  const missing = requireVault(env);
  if (missing) return missing;
  if (!/^[a-f0-9]{24}$/.test(id)) return errorResponse("That handoff id is not valid.", 400);

  const raw = await env.APEX_VAULT!.get(`bus:${id}`);
  if (raw) {
    const record = JSON.parse(raw) as { uid: string };
    if (record.uid === uid) await env.APEX_VAULT!.delete(`bus:${id}`);
  }
  return jsonResponse({ ok: true, deleted: true });
}

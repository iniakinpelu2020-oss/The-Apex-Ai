/**
 * POST /v1/storage/presign — short-lived Backblaze B2 URLs.
 *
 * AWS Signature V4 as a query signature, built with Web Crypto only. No SDK, no
 * Node, no bundle weight — the whole thing is a few hundred bytes of code and
 * runs in well under a millisecond of CPU.
 *
 * The rule that matters more than the signing: the B2 application key stays in
 * this Worker. The browser only ever sees a URL that expires in minutes and
 * covers one object and one method.
 */
import { errorResponse, jsonResponse } from "./cors";
import { HttpError } from "./types";

const MAX_EXPIRY = 3600;
const MIN_EXPIRY = 60;
const DEFAULT_EXPIRY = 300;
const DEFAULT_MAX_BYTES = 95 * 1024 * 1024;

export interface PresignOptions {
  endpoint: string;
  bucket: string;
  keyId: string;
  appKey: string;
  method: "GET" | "PUT" | "DELETE";
  key: string;
  expires: number;
  now?: Date;
}

/** s3.us-west-004.backblazeb2.com -> us-west-004 */
export function regionFromEndpoint(endpoint: string): string {
  const host = new URL(endpoint).host;
  const match = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(host);
  if (!match) {
    throw new HttpError(500, "DRIVE_B2_ENDPOINT does not look like a Backblaze S3 endpoint (https://s3.<region>.backblazeb2.com).");
  }
  return match[1];
}

const enc = (segment: string): string =>
  encodeURIComponent(segment).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

/**
 * Reject keys that try to leave their folder instead of silently rewriting them.
 *
 * A sanitised `../../other-user/x` becomes an object in a place the caller did not
 * ask for, which hides the attempt; a 400 makes it visible.
 */
export function validateObjectKey(key: string): string {
  const value = String(key ?? "");
  if (!value.trim()) throw new HttpError(400, "`key` is required.");
  if (value.length > 512) throw new HttpError(400, "`key` is longer than 512 characters.");
  if (value.startsWith("/")) throw new HttpError(400, "`key` must not start with a slash.");
  if (value.includes("\\")) throw new HttpError(400, "`key` must use forward slashes.");
  // Control characters (including \u0000) and DEL. These arrive easily by accident
  // — a JSON "\b" is a backspace byte, not a backslash — and an object key with a
  // control character in it is a key nothing can address later.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, "`key` contains a control character.");
  }
  if (value.includes("//")) throw new HttpError(400, "`key` contains an empty path segment.");
  if (value.split("/").some((s) => s === "." || s === "..")) {
    throw new HttpError(400, "`key` must not contain '.' or '..' path segments.");
  }
  return value;
}

export async function presignB2(opts: PresignOptions): Promise<{ url: string; expiresAt: string; expiresIn: number }> {
  const region = regionFromEndpoint(opts.endpoint);
  const host = new URL(opts.endpoint).host;
  const now = opts.now ?? new Date();
  const expiresIn = Math.min(MAX_EXPIRY, Math.max(MIN_EXPIRY, Math.floor(opts.expires) || DEFAULT_EXPIRY));

  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = iso.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const canonicalUri = "/" + opts.bucket + "/" + opts.key.split("/").map(enc).join("/");

  const query: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${opts.keyId}/${scope}`],
    ["X-Amz-Date", iso],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [enc(k), enc(v)] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    iso,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key = await hmac(new TextEncoder().encode("AWS4" + opts.appKey), dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, "s3");
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  const url = `${opts.endpoint.replace(/\/$/, "")}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return {
    url,
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    expiresIn,
  };
}

export async function handlePresign(request: Request, uid: string, env: any): Promise<Response> {
  const endpoint = String(env.DRIVE_B2_ENDPOINT || "");
  const bucket = String(env.DRIVE_B2_BUCKET || "");
  const keyId = String(env.DRIVE_B2_KEY_ID || "");
  const appKey = String(env.DRIVE_B2_APP_KEY || "");

  const missing = [
    ["DRIVE_B2_ENDPOINT", endpoint],
    ["DRIVE_B2_BUCKET", bucket],
    ["DRIVE_B2_KEY_ID", keyId],
    ["DRIVE_B2_APP_KEY", appKey],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    return errorResponse("Storage is not configured on this Worker.", 503, { missing });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Body must be JSON: { key, method?, expires? }.", 400);
  }

  try {
    const key = validateObjectKey(String(body.key ?? ""));
    const method = String(body.method ?? "PUT").toUpperCase();
    if (method !== "GET" && method !== "PUT" && method !== "DELETE") {
      throw new HttpError(400, "`method` must be GET, PUT or DELETE.");
    }

    // Force every object under the caller's own folder unless a prefix is set.
    const prefix = String(env.DRIVE_PREFIX || `u/${uid}/`);
    const fullKey = key.startsWith(prefix) ? key : prefix + key;

    const signed = await presignB2({
      endpoint,
      bucket,
      keyId,
      appKey,
      method: method as "GET" | "PUT" | "DELETE",
      key: fullKey,
      expires: Number(body.expires) || DEFAULT_EXPIRY,
    });

    const maxBytes = Number(env.DRIVE_MAX_BYTES) || DEFAULT_MAX_BYTES;

    return jsonResponse(
      {
        ok: true,
        url: signed.url,
        method,
        key: fullKey,
        bucket,
        expiresIn: signed.expiresIn,
        expiresAt: signed.expiresAt,
        maxBytes,
      },
      200,
      { "Cache-Control": "no-store" }
    );
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.message, err.status);
    return errorResponse("Could not sign that URL.", 500, { upstream: String(err) });
  }
}

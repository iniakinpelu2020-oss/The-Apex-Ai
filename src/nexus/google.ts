/**
 * Google Workspace, reached with plain fetch.
 *
 * No googleapis SDK: it is tens of megabytes, needs Node built-ins, and would
 * blow past the Worker CPU budget on cold start. Every call here is one HTTP
 * request against the documented REST endpoints.
 *
 * Three things are load-bearing:
 *
 *   1. The refresh token is encrypted (AES-GCM) before it goes into KV. A refresh
 *      token is permanent access to the account; storing it in clear text in a
 *      namespace is the kind of mistake that only shows up in an incident report.
 *   2. OAuth `state` is signed with an HMAC and carries an expiry, because the
 *      callback arrives as a plain browser redirect with no Authorization header.
 *      Without that, anyone could hand the Worker an auth code.
 *   3. Every call is scoped to the owner. There is one Google account here.
 */
import { errorResponse, jsonResponse } from "./cors";
import { requireVault } from "./auth";
import { HttpError, type NexusEnv } from "./types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const KV_REFRESH = (uid: string) => `google_oauth:${uid}`;
const KV_ACCESS = (uid: string) => `google_token:${uid}`;
const STATE_TTL_SECONDS = 600;

/**
 * drive.file is the important one: it grants access only to files this app
 * created or the user explicitly picked, so Apex cannot read the whole Drive.
 * drive.readonly is added because search across existing files is useless
 * without it — remove it if that trade is not worth it.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
];

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  keyMaterial: string;
}

function config(env: NexusEnv): GoogleConfig {
  const clientId = String(env.GOOGLE_CLIENT_ID || "");
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || "");
  const redirectUri = String(env.GOOGLE_REDIRECT_URI || "");
  const keyMaterial = String(env.ENCRYPTION_KEY || "");
  const missing = [
    ["GOOGLE_CLIENT_ID", clientId],
    ["GOOGLE_CLIENT_SECRET", clientSecret],
    ["GOOGLE_REDIRECT_URI", redirectUri],
    ["ENCRYPTION_KEY", keyMaterial],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new HttpError(503, `Google is not configured. Missing: ${missing.join(", ")}`);
  return { clientId, clientSecret, redirectUri, keyMaterial };
}

/* ------------------------------------------------------------------ crypto */

const b64urlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function aesKey(material: string): Promise<CryptoKey> {
  // Stretch whatever the user pasted into a 256-bit key deterministically.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plain: string, material: string): Promise<string> {
  const key = await aesKey(material);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(cipher))}`;
}

export async function decryptSecret(payload: string, material: string): Promise<string> {
  const [ivPart, dataPart] = String(payload).split(".");
  if (!ivPart || !dataPart) throw new HttpError(500, "Stored Google credential is malformed. Reconnect Google.");
  const key = await aesKey(material);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(ivPart) },
      key,
      b64urlDecode(dataPart)
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new HttpError(500, "Could not decrypt the stored Google credential. ENCRYPTION_KEY may have changed — reconnect Google.");
  }
}

async function hmacSign(value: string, material: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

/* ---------------------------------------------------------------- oauth url */

export async function buildAuthUrl(env: NexusEnv, uid: string): Promise<{ url: string; state: string; scopes: string[] }> {
  const cfg = config(env);
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ uid, exp: Date.now() + STATE_TTL_SECONDS * 1000, n: crypto.randomUUID() }))
  );
  const state = `${payload}.${await hmacSign(payload, cfg.keyMaterial)}`;

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    // offline + consent is what actually returns a refresh token. Without both,
    // a second authorisation returns only an access token that dies in an hour.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: SCOPES.join(" "),
    state,
  });

  return { url: `${AUTH_URL}?${params.toString()}`, state, scopes: SCOPES };
}

async function verifyState(state: string, material: string): Promise<{ uid: string }> {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) throw new HttpError(400, "Missing or malformed OAuth state.");
  const expected = await hmacSign(payload, material);
  if (expected !== sig) throw new HttpError(400, "OAuth state failed verification.");
  let data: { uid?: string; exp?: number };
  try {
    data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    throw new HttpError(400, "OAuth state is not readable.");
  }
  if (!data.uid || typeof data.exp !== "number" || data.exp < Date.now()) {
    throw new HttpError(400, "OAuth state has expired. Start the connection again.");
  }
  return { uid: data.uid };
}

/* ------------------------------------------------------------------ callback */

export async function handleCallback(request: Request, env: NexusEnv): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return htmlPage("Google connection cancelled", `Google returned: ${escapeHtml(error)}. Nothing was stored.`, 400);
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code) return htmlPage("Missing code", "Google did not send an authorisation code.", 400);

  let cfg: GoogleConfig;
  try {
    cfg = config(env);
  } catch (err) {
    return htmlPage("Not configured", err instanceof Error ? err.message : "Google is not configured.", 503);
  }

  // Verify the request BEFORE anything else: an unsigned or expired state is a
  // bad request, not a server misconfiguration, and the two should not be
  // confused in a log.
  let uid: string;
  try {
    uid = (await verifyState(state, cfg.keyMaterial)).uid;
  } catch (err) {
    return htmlPage("Invalid request", err instanceof Error ? err.message : "State check failed.", 400);
  }

  if (!env.APEX_VAULT) {
    return htmlPage("Storage not ready", "APEX_VAULT is not bound, so the token cannot be stored.", 503);
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    return htmlPage("Google refused the exchange", escapeHtml(detail.slice(0, 400)), 502);
  }

  const tokens = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (tokens.refresh_token) {
    const encrypted = await encryptSecret(tokens.refresh_token, cfg.keyMaterial);
    await env.APEX_VAULT.put(KV_REFRESH(uid), encrypted);
  }

  if (tokens.access_token) {
    await env.APEX_VAULT.put(
      KV_ACCESS(uid),
      JSON.stringify({ token: tokens.access_token, exp: Date.now() + (tokens.expires_in ?? 3600) * 1000 }),
      { expirationTtl: Math.max(60, (tokens.expires_in ?? 3600) - 60) }
    );
  }

  const stored = tokens.refresh_token
    ? "A refresh token was stored, encrypted."
    : "No refresh token came back — this usually means the account was already connected. Revoke access at myaccount.google.com and reconnect to get one.";

  return htmlPage(
    "Google connected",
    `${stored}<br><br>Scopes: ${escapeHtml((tokens.scope || SCOPES.join(" ")).split(" ").length + " granted")}. You can close this tab.`,
    200
  );
}

/* ---------------------------------------------------------- access tokens */

export async function getAccessToken(env: NexusEnv, uid: string): Promise<string> {
  const cfg = config(env);
  if (!env.APEX_VAULT) throw new HttpError(503, "APEX_VAULT is not bound.");

  const cached = await env.APEX_VAULT.get(KV_ACCESS(uid));
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { token?: string; exp?: number };
      if (parsed.token && typeof parsed.exp === "number" && parsed.exp > Date.now() + 5000) {
        return parsed.token;
      }
    } catch {
      // fall through to a refresh
    }
  }

  const stored = await env.APEX_VAULT.get(KV_REFRESH(uid));
  if (!stored) {
    throw new HttpError(409, "Google is not connected yet. Open /v1/google/auth-url and complete the consent screen.");
  }

  const refreshToken = await decryptSecret(stored, cfg.keyMaterial);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 400 && /invalid_grant/.test(detail)) {
      await env.APEX_VAULT.delete(KV_REFRESH(uid));
      throw new HttpError(409, "Google revoked this connection. Reconnect at /v1/google/auth-url.");
    }
    throw new HttpError(502, `Google token refresh failed (${response.status}).`, detail.slice(0, 300));
  }

  const tokens = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!tokens.access_token) throw new HttpError(502, "Google returned no access token.");

  await env.APEX_VAULT.put(
    KV_ACCESS(uid),
    JSON.stringify({ token: tokens.access_token, exp: Date.now() + (tokens.expires_in ?? 3600) * 1000 }),
    { expirationTtl: Math.max(60, (tokens.expires_in ?? 3600) - 60) }
  );

  return tokens.access_token;
}

/** One authorised JSON call, with a single retry after a 401. */
async function googleFetch(env: NexusEnv, uid: string, url: string, init: RequestInit = {}): Promise<any> {
  const attempt = async (token: string) =>
    fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    });

  let response = await attempt(await getAccessToken(env, uid));
  if (response.status === 401) {
    await env.APEX_VAULT?.delete(KV_ACCESS(uid));
    response = await attempt(await getAccessToken(env, uid));
  }

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    const message = body?.error?.message || body?.raw || `Google API ${response.status}`;
    throw new HttpError(response.status === 403 ? 403 : 502, message, body?.error);
  }
  return body;
}

/* ----------------------------------------------------------------- services */

const q = encodeURIComponent;

export async function handleDrive(env: NexusEnv, uid: string, body: Record<string, any>): Promise<Response> {
  const action = String(body.action || "search");

  if (action === "search") {
    const term = String(body.query || "").trim();
    const limit = Math.min(50, Math.max(1, Number(body.limit) || 10));
    const query = term
      ? `name contains '${term.replace(/'/g, "\\'")}' and trashed = false`
      : `trashed = false and 'root' in parents`;
    const data = await googleFetch(
      env,
      uid,
      `https://www.googleapis.com/drive/v3/files?q=${q(query)}&pageSize=${limit}&fields=files(id,name,mimeType,webViewLink,modifiedTime,size)&orderBy=modifiedTime desc`
    );
    return jsonResponse({ ok: true, files: data.files || [] });
  }

  if (action === "folders" || action === "createFolder") {
    const name = String(body.name || "APEX_ECOSYSTEM");
    const existing = await googleFetch(
      env,
      uid,
      `https://www.googleapis.com/drive/v3/files?q=${q(`name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)}&fields=files(id,name,webViewLink)`
    );
    if (existing.files?.length && action === "folders") {
      return jsonResponse({ ok: true, folder: existing.files[0], existed: true });
    }
    if (existing.files?.length) {
      return jsonResponse({ ok: true, folder: existing.files[0], existed: true });
    }
    const created = await googleFetch(env, uid, "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
    });
    return jsonResponse({ ok: true, folder: created, existed: false });
  }

  if (action === "upload") {
    const name = String(body.name || `apex-upload-${Date.now()}`);
    const base64 = String(body.dataBase64 || "");
    if (!base64) throw new HttpError(400, "`dataBase64` is required for upload.");
    const mimeType = String(body.mimeType || "application/octet-stream");

    // Metadata first, then media. Two calls instead of one multipart/related body:
    // simpler to get right, and Drive handles the second call as an update.
    const created = await googleFetch(env, uid, "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType, ...(body.folderId ? { parents: [String(body.folderId)] } : {}) }),
    });

    const binary = atob(base64.replace(/^data:[^;]+;base64,/, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const uploaded = await googleFetch(
      env,
      uid,
      `https://www.googleapis.com/upload/drive/v3/files/${created.id}?uploadType=media&fields=id,name,webViewLink,size`,
      { method: "PATCH", headers: { "Content-Type": mimeType }, body: bytes }
    );
    return jsonResponse({ ok: true, file: uploaded });
  }

  throw new HttpError(400, `Unknown drive action: ${action}. Use search, createFolder, folders or upload.`);
}

export async function handleGmail(env: NexusEnv, uid: string, body: Record<string, any>): Promise<Response> {
  const action = String(body.action || "search");

  if (action === "search") {
    const term = String(body.query || "").slice(0, 200);
    const limit = Math.min(25, Math.max(1, Number(body.limit) || 10));
    const list = await googleFetch(
      env,
      uid,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q(term)}&maxResults=${limit}`
    );
    const ids: string[] = (list.messages || []).map((m: any) => m.id).slice(0, limit);

    // Fetch headers for each hit; Gmail has no batch endpoint here.
    const messages = await Promise.all(
      ids.map(async (id) => {
        const msg = await googleFetch(
          env,
          uid,
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
        );
        const headers: { name: string; value: string }[] = msg.payload?.headers || [];
        const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
        return { id, threadId: msg.threadId, from: get("From"), subject: get("Subject"), date: get("Date"), snippet: msg.snippet || "" };
      })
    );
    return jsonResponse({ ok: true, messages });
  }

  const rawMessage = (to: string, subject: string, text: string): string => {
    const mime = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=UTF-8",
      "MIME-Version: 1.0",
      "",
      text,
    ].join("\r\n");
    return btoa(String.fromCharCode(...new TextEncoder().encode(mime)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  };

  if (action === "draft") {
    const to = String(body.to || "");
    const subject = String(body.subject || "(no subject)");
    const text = String(body.body || "");
    if (!to) throw new HttpError(400, "`to` is required.");
    const created = await googleFetch(env, uid, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw: rawMessage(to, subject, text) } }),
    });
    return jsonResponse({ ok: true, draft: { id: created.id, messageId: created.message?.id } });
  }

  if (action === "send") {
    const to = String(body.to || "");
    const subject = String(body.subject || "(no subject)");
    const text = String(body.body || "");
    if (!to) throw new HttpError(400, "`to` is required.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, "`to` does not look like an email address.");
    const sent = await googleFetch(env, uid, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw: rawMessage(to, subject, text) }),
    });
    return jsonResponse({ ok: true, sent: { id: sent.id, threadId: sent.threadId } });
  }

  throw new HttpError(400, `Unknown gmail action: ${action}. Use search, draft or send.`);
}

export async function handleCalendar(env: NexusEnv, uid: string, body: Record<string, any>): Promise<Response> {
  const action = String(body.action || "list");

  if (action === "list") {
    const limit = Math.min(50, Math.max(1, Number(body.limit) || 10));
    const timeMin = String(body.timeMin || new Date().toISOString());
    const data = await googleFetch(
      env,
      uid,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${q(timeMin)}&maxResults=${limit}&singleEvents=true&orderBy=startTime`
    );
    return jsonResponse({
      ok: true,
      events: (data.items || []).map((e: any) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        location: e.location,
        link: e.htmlLink,
      })),
    });
  }

  if (action === "create") {
    const summary = String(body.summary || "").trim();
    const start = String(body.start || "").trim();
    const end = String(body.end || "").trim();
    if (!summary) throw new HttpError(400, "`summary` is required.");
    if (!start || !end) throw new HttpError(400, "`start` and `end` are required (ISO 8601).");
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new HttpError(400, "`start` and `end` must be ISO 8601 timestamps.");
    }
    if (endDate <= startDate) throw new HttpError(400, "`end` must be after `start`.");

    const created = await googleFetch(env, uid, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary,
        description: String(body.description || ""),
        location: String(body.location || ""),
        start: { dateTime: startDate.toISOString() },
        end: { dateTime: endDate.toISOString() },
        ...(Array.isArray(body.attendees) ? { attendees: body.attendees.map((email: string) => ({ email })) } : {}),
      }),
    });
    return jsonResponse({ ok: true, event: { id: created.id, link: created.htmlLink, summary: created.summary } });
  }

  throw new HttpError(400, `Unknown calendar action: ${action}. Use list or create.`);
}

export async function handleDocs(env: NexusEnv, uid: string, body: Record<string, any>): Promise<Response> {
  const action = String(body.action || "create");

  if (action === "create") {
    const title = String(body.title || `Apex doc ${new Date().toISOString().slice(0, 10)}`);
    const created = await googleFetch(env, uid, "https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (body.text) {
      await googleFetch(env, uid, `https://docs.googleapis.com/v1/documents/${created.documentId}:batchUpdate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: String(body.text) } }] }),
      });
    }
    return jsonResponse({
      ok: true,
      document: { id: created.documentId, title: created.title, link: `https://docs.google.com/document/d/${created.documentId}/edit` },
    });
  }

  if (action === "append") {
    const documentId = String(body.documentId || "").trim();
    const text = String(body.text || "");
    if (!documentId) throw new HttpError(400, "`documentId` is required.");
    if (!text) throw new HttpError(400, "`text` is required.");

    const doc = await googleFetch(env, uid, `https://docs.googleapis.com/v1/documents/${documentId}?fields=body.content`);
    const content = doc.body?.content || [];
    const last = content[content.length - 1];
    // Insert before the final newline of the body, otherwise each append lands on
    // a new page.
    const index = Math.max(1, (last?.endIndex ?? 2) - 1);
    await googleFetch(env, uid, `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ insertText: { location: { index }, text } }] }),
    });
    return jsonResponse({ ok: true, documentId, appendedAt: index, link: `https://docs.google.com/document/d/${documentId}/edit` });
  }

  throw new HttpError(400, `Unknown docs action: ${action}. Use create or append.`);
}

export async function handleSheets(env: NexusEnv, uid: string, body: Record<string, any>): Promise<Response> {
  const action = String(body.action || "create");

  if (action === "create") {
    const title = String(body.title || `Apex sheet ${new Date().toISOString().slice(0, 10)}`);
    const created = await googleFetch(env, uid, "https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { title } }),
    });
    if (Array.isArray(body.rows) && body.rows.length) {
      await googleFetch(
        env,
        uid,
        `https://sheets.googleapis.com/v4/spreadsheets/${created.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: body.rows }) }
      );
    }
    return jsonResponse({
      ok: true,
      sheet: { id: created.spreadsheetId, title, link: `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit` },
    });
  }

  if (action === "append") {
    const spreadsheetId = String(body.spreadsheetId || "").trim();
    const rows = body.rows;
    if (!spreadsheetId) throw new HttpError(400, "`spreadsheetId` is required.");
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, "`rows` must be a non-empty array of arrays.");
    const range = String(body.range || "A1");
    const data = await googleFetch(
      env,
      uid,
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${q(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) }
    );
    return jsonResponse({ ok: true, updatedRange: data.updates?.updatedRange, updatedRows: data.updates?.updatedRows ?? rows.length });
  }

  throw new HttpError(400, `Unknown sheets action: ${action}. Use create or append.`);
}

/* -------------------------------------------------------------------- pages */

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

export function htmlPage(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Apex</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e9ecf2;
       font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:24px}
  .card{max-width:520px;background:#12151c;border:1px solid #262b36;border-radius:14px;padding:28px}
  h1{margin:0 0 10px;font-size:18px}
  p{margin:0;color:#9aa3b2}
  code{background:#181c25;padding:2px 6px;border-radius:5px;font-size:.9em}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${body}</p></div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Status view: is Google connected, and is KV wired up? */
export async function handleGoogleStatus(env: NexusEnv, uid: string): Promise<Response> {
  let connected = false;
  if (env.APEX_VAULT) connected = Boolean(await env.APEX_VAULT.get(KV_REFRESH(uid)));
  return jsonResponse({
    ok: true,
    connected,
    scopes: SCOPES,
    configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.ENCRYPTION_KEY),
    vaultBound: Boolean(env.APEX_VAULT),
  });
}

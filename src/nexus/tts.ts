/**
 * POST /v1/tts — text to speech via Deepgram Aura 2 on Workers AI.
 *
 * Replaces @cf/myshell-ai/melotts, which stops responding on 20 November 2026.
 *
 * The Worker returns the audio bytes directly. It does not transcode: there is no
 * ffmpeg here, and pretending otherwise would mean a feature that silently
 * returns something other than the format that was asked for. Aura produces MP3,
 * so that is what comes back, and the response says so in its headers.
 */
import { audioResponse, errorResponse } from "./cors";
import { ACTIVE } from "./models";
import { HttpError, type NexusEnv } from "./types";

const MAX_TEXT = 2000;
const DEFAULT_SPEAKER = "asteria";

/** Speakers Aura 2 offers. Anything else falls back to the default. */
const SPEAKERS = new Set([
  "asteria", "luna", "stella", "athena", "hera", "orion", "arcas", "perseus",
  "angus", "orpheus", "helios", "zeus", "thalia", "andromeda",
]);

interface TtsBody {
  text?: unknown;
  voice?: unknown;
  speaker?: unknown;
  format?: unknown;
}

/**
 * Pull audio bytes out of whatever shape the binding returns.
 *
 * Workers AI models are inconsistent here: some return `{ audio: base64 }`, some
 * return a Response-like object, some return raw bytes. Handling all three keeps
 * a model swap from turning into an outage.
 */
async function extractAudio(result: any): Promise<ArrayBuffer | null> {
  if (!result) return null;
  if (result instanceof Response) return await result.arrayBuffer();
  const candidate = result.audio ?? result.result ?? result.data;
  if (candidate == null) {
    if (result instanceof ArrayBuffer) return result;
    if (result instanceof Uint8Array) {
      return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
    }
    return null;
  }
  if (typeof candidate === "string") {
    // base64 — Workers AI's usual shape for audio models.
    const binary = atob(candidate);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  if (candidate instanceof ArrayBuffer) return candidate;
  if (candidate instanceof Uint8Array) {
    return candidate.buffer.slice(candidate.byteOffset, candidate.byteOffset + candidate.byteLength) as ArrayBuffer;
  }
  if (typeof candidate === "object" && candidate.buffer) return extractAudio(candidate);
  return null;
}

export async function handleTts(request: Request, env: NexusEnv): Promise<Response> {
  let body: TtsBody;
  try {
    body = (await request.json()) as TtsBody;
  } catch {
    return errorResponse("Body must be JSON: { text, voice?, format? }.", 400);
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return errorResponse("`text` is required.", 400);
  if (text.length > MAX_TEXT) {
    return errorResponse(`\`text\` is limited to ${MAX_TEXT} characters (got ${text.length}). Split long scripts into sentences.`, 413);
  }

  const asked = String(body.voice ?? body.speaker ?? "").trim().toLowerCase();
  const speaker = SPEAKERS.has(asked) ? asked : DEFAULT_SPEAKER;

  // `format` is accepted for API stability. Aura returns MP3, and this Worker has
  // no transcoder, so the honest answer is MP3 with a header that says so.
  const wanted = String(body.format ?? "mp3").toLowerCase();
  const formatHonoured = wanted === "mp3";

  try {
    const result = await env.AI.run(ACTIVE.tts.id, { text, speaker });
    const audio = await extractAudio(result);
    if (!audio || audio.byteLength === 0) {
      throw new HttpError(502, "The speech model returned no audio.");
    }
    const response = audioResponse(audio, "audio/mpeg");
    const headers = new Headers(response.headers);
    headers.set("X-Apex-Model", ACTIVE.tts.id);
    headers.set("X-Apex-Audio-Format", "mp3");
    headers.set("X-Apex-Format-Honoured", String(formatHonoured));
    if (!formatHonoured) {
      headers.set("X-Apex-Notice", `Requested ${wanted}; this Worker returns ${"mp3"} without transcoding.`);
    }
    return new Response(response.body, { status: 200, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof HttpError ? err.status : 502;
    // 3040/5028 style codes mean the model is gone; say so plainly.
    if (/5028|410|deprecat|not found|no such model/i.test(message)) {
      return errorResponse(
        "The speech model is unavailable. It may have been retired — check the Workers AI catalog.",
        503,
        { model: ACTIVE.tts.id, upstream: message.slice(0, 300) }
      );
    }
    return errorResponse("Text to speech failed.", status, { model: ACTIVE.tts.id, upstream: message.slice(0, 300) });
  }
}

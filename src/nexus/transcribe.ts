/**
 * POST /v1/transcribe — speech to text with word-level timings.
 *
 * Primary model: Deepgram Nova 3 (replaces @cf/openai/whisper-tiny-en, retired
 * 20 November 2026). Fallback: Whisper large v3 turbo, which is still in the
 * catalog, so a Nova outage degrades instead of failing.
 *
 * Word timings are the point of this route: Apex Editor needs them for kinetic
 * captions, and sentence-level timings cannot be faked into word-level ones.
 */
import { errorResponse, jsonResponse } from "./cors";
import { ACTIVE } from "./models";
import { HttpError, type NexusEnv } from "./types";

const MAX_BYTES = 20 * 1024 * 1024;

export interface Word {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

interface AudioInput {
  bytes: ArrayBuffer;
  contentType: string;
  filename: string;
}

/** Accept multipart/form-data (field `audio` or `file`) or a raw audio body. */
async function readAudio(request: Request): Promise<AudioInput> {
  const type = request.headers.get("Content-Type") || "";

  if (type.includes("multipart/form-data")) {
    const form = await request.formData();
    const entry = form.get("audio") ?? form.get("file") ?? form.get("data");
    if (!entry || typeof entry === "string") {
      throw new HttpError(400, "Send the audio as a multipart field named `audio`.");
    }
    const file = entry as File;
    if (file.size > MAX_BYTES) throw new HttpError(413, `Audio is limited to ${MAX_BYTES / 1048576} MB.`);
    return {
      bytes: await file.arrayBuffer(),
      contentType: file.type || "audio/wav",
      filename: file.name || "audio",
    };
  }

  if (type.startsWith("audio/") || type === "application/octet-stream") {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) throw new HttpError(400, "Empty audio body.");
    if (bytes.byteLength > MAX_BYTES) throw new HttpError(413, `Audio is limited to ${MAX_BYTES / 1048576} MB.`);
    return { bytes, contentType: type, filename: "upload" };
  }

  throw new HttpError(415, "Send audio as multipart/form-data (field `audio`) or with an audio/* Content-Type.");
}

/** Numbers arriving as strings is normal from some models, so coerce. */
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Normalise Deepgram and Whisper word shapes into one.
 * Deepgram: { word, start, end, confidence, punctuated_word }
 * Whisper:  { word, start, end, probability }
 */
function normaliseWords(raw: unknown): Word[] {
  if (!Array.isArray(raw)) return [];
  const out: Word[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const w = entry as Record<string, unknown>;
    const word = String(w.punctuated_word ?? w.word ?? "").trim();
    if (!word) continue;
    out.push({
      word,
      start: num(w.start),
      end: num(w.end),
      confidence: w.confidence != null ? num(w.confidence) : w.probability != null ? num(w.probability) : undefined,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

async function runModel(env: NexusEnv, model: string, audio: AudioInput): Promise<{ text: string; words: Word[]; raw: any }> {
  // Workers AI audio models accept a byte array on `audio`.
  const result = await env.AI.run(model, {
    audio: [...new Uint8Array(audio.bytes)],
    // Accepted by Whisper and harmless to Nova; both ignore what they do not use.
    language: "en",
  });

  const text = String(result?.text ?? result?.transcript ?? "").trim();
  const words = normaliseWords(result?.words ?? result?.result?.words);
  return { text, words, raw: result };
}

export async function handleTranscribe(request: Request, env: NexusEnv): Promise<Response> {
  let audio: AudioInput;
  try {
    audio = await readAudio(request);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.message, err.status);
    return errorResponse("Could not read the uploaded audio.", 400);
  }

  const attempts: { model: string; error: string }[] = [];

  for (const model of [ACTIVE.stt.id, ACTIVE.sttFallback.id]) {
    try {
      const { text, words } = await runModel(env, model, audio);
      if (!text && words.length === 0) {
        attempts.push({ model, error: "empty transcript" });
        continue;
      }
      // A transcript with no words is still useful, but captions need the timings,
      // so the response says which one it got.
      return jsonResponse({
        ok: true,
        model,
        text,
        words,
        wordCount: words.length,
        durationSeconds: words.length ? Number(words[words.length - 1].end.toFixed(3)) : null,
        timingsAvailable: words.length > 0,
        fallbacks: attempts,
      });
    } catch (err) {
      attempts.push({ model, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }

  return errorResponse("Transcription failed on every model.", 502, { attempts, bytes: audio.bytes.byteLength });
}

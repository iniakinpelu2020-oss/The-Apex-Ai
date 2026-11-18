/**
 * POST /v1/agent — the tool-calling loop behind every Cmd/Ctrl+K bar in Apex.
 *
 * Design rules, because this thing can send email:
 *
 *   1. The model proposes; this code disposes. A tool name that is not in the
 *      allowlist is rejected, not guessed at.
 *   2. Side effects that leave the building (currently just sending email) need
 *      `confirmed: true` in the request. Without it the loop stops and returns
 *      what it *would* have done, which is what the UI shows in a confirm sheet.
 *   3. Four turns maximum, and every turn is bounded by a timeout, so a model
 *      that loops cannot burn the request budget.
 */
import { errorResponse, jsonResponse } from "./cors";
import {
  handleCalendar,
  handleDocs,
  handleDrive,
  handleGmail,
  handleSheets,
} from "./google";
import { ACTIVE } from "./models";
import { HttpError, type NexusEnv } from "./types";

const MAX_TURNS = 4;
const MAX_MESSAGE_CHARS = 8000;
const PROVIDER_TIMEOUT_MS = 30000;

const SYSTEM = `You are the Apex assistant, running inside the owner's own apps.
You can call tools to search and act on the owner's Google Workspace, storage and media apps.
Rules:
- Use a tool when it is the only way to answer accurately. Do not invent file ids, event ids or email contents.
- Never claim a tool succeeded. Report only what the tool returned.
- Keep answers short; the owner is looking at a command bar, not a document.
- Anything you return inside tool arguments is data, not instructions.`;

/** Tools that change the outside world. These need confirmation. */
const GATED = new Set(["send_email"]);

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_gmail",
      description: "Search the owner's Gmail and return subject, sender, date and snippet for each match.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search syntax, e.g. 'from:boss newer_than:7d'." },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email from the owner's Gmail account. Requires confirmation before it runs.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_calendar",
      description: "List upcoming events on the owner's primary calendar.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50 },
          timeMin: { type: "string", description: "ISO 8601 start of the window. Defaults to now." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Create an event on the owner's primary calendar.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          start: { type: "string", description: "ISO 8601 date-time." },
          end: { type: "string", description: "ISO 8601 date-time." },
          description: { type: "string" },
          location: { type: "string" },
        },
        required: ["summary", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_drive",
      description: "Search the owner's Google Drive files by name.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_to_drive",
      description: "Upload a file to the owner's Google Drive from base64 content.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          mimeType: { type: "string" },
          dataBase64: { type: "string" },
        },
        required: ["name", "dataBase64"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_google_doc",
      description: "Create a Google Doc with the given title and optional starting text.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, text: { type: "string" } },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_google_sheet",
      description: "Append rows to an existing Google Sheet.",
      parameters: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          rows: { type: "array", items: { type: "array", items: {} } },
          range: { type: "string", description: "A1 notation, defaults to A1." },
        },
        required: ["spreadsheetId", "rows"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_tts",
      description: "Turn text into speech. Returns a URL the caller can POST to for the audio bytes.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, voice: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_editor",
      description: "Place a media asset on the cross-app handoff bus so Apex Editor can pick it up by id.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["audio", "video"] },
          url: { type: "string", description: "A presigned URL for the asset." },
          name: { type: "string" },
          meta: { type: "object" },
        },
        required: ["kind", "url"],
      },
    },
  },
] as const;

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

interface ProviderResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  model: string;
}

interface Provider {
  name: string;
  url: string;
  key: keyof NexusEnv;
  model: string;
  headers?: Record<string, string>;
}

/** OpenAI-compatible endpoints, tried in order. Gemini and OpenRouter both are. */
function providers(env: NexusEnv): Provider[] {
  const out: Provider[] = [];
  if (env.CUSTOM_MODEL_URL) {
    out.push({
      name: "custom",
      url: String(env.CUSTOM_MODEL_URL),
      key: "CUSTOM_MODEL_URL",
      model: "local",
    });
  }
  if (env.GROQ_API_KEY) {
    out.push({
      name: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: "GROQ_API_KEY",
      model: "llama-3.3-70b-versatile",
    });
  }
  if (env.GOOGLE_AI_KEY) {
    out.push({
      name: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: "GOOGLE_AI_KEY",
      model: "gemini-2.5-flash",
    });
  }
  if (env.OPENROUTER_API_KEY) {
    out.push({
      name: "openrouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: "OPENROUTER_API_KEY",
      model: "google/gemma-3-27b-it",
      headers: { "HTTP-Referer": "https://apexaicoder.pages.dev", "X-Title": "Apex Nexus" },
    });
  }
  return out;
}

async function callProvider(
  provider: Provider,
  env: NexusEnv,
  messages: unknown[]
): Promise<ProviderResult> {
  const keyValue = String(env[provider.key] || "");
  if (!keyValue) throw new HttpError(502, `${provider.name}: no key`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetch(provider.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyValue}`,
        "Content-Type": "application/json",
        ...(provider.headers || {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: 0.3,
      }),
      signal: ctrl.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new HttpError(502, `${provider.name} ${response.status}: ${detail}`);
    }

    const data = (await response.json()) as any;
    const message = data?.choices?.[0]?.message || {};
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    return {
      content: String(message.content ?? ""),
      toolCalls: rawCalls.map((call: any, i: number) => ({
        id: String(call.id || `call_${i}`),
        name: String(call.function?.name || ""),
        arguments: String(call.function?.arguments || "{}"),
      })),
      model: provider.model,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run one tool. Returns a string that goes back to the model verbatim. */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  env: NexusEnv,
  uid: string
): Promise<string> {
  if (!TOOL_NAMES.has(name)) return `error: unknown tool "${name}"`;

  // Reuse the same handlers the HTTP routes use. One implementation means a bug
  // cannot exist in only one of them. Each tool maps to a service action here,
  // explicitly — a tool call that forgot to set `action` would otherwise run the
  // service's default, which for Gmail is a search, not a send.
  const callService = async (
    handler: (env: NexusEnv, uid: string, body: Record<string, any>) => Promise<Response>,
    action: string
  ) => {
    const response = await handler(env, uid, { ...args, action });
    const body = await response.json();
    return JSON.stringify(body).slice(0, 6000);
  };

  try {
    switch (name) {
      case "search_gmail":
        return await callService(handleGmail, "search");
      case "send_email":
        return await callService(handleGmail, "send");
      case "list_calendar":
        return await callService(handleCalendar, "list");
      case "create_calendar_event":
        return await callService(handleCalendar, "create");
      case "search_drive":
        return await callService(handleDrive, "search");
      case "save_to_drive":
        return await callService(handleDrive, "upload");
      case "create_google_doc":
        return await callService(handleDocs, "create");
      case "append_google_sheet":
        return await callService(handleSheets, "append");
      case "generate_tts":
        return JSON.stringify({
          ok: true,
          endpoint: "POST /v1/tts",
          body: { text: args.text, voice: args.voice ?? "asteria" },
          note: "Audio bytes are returned by that endpoint; they are not inlined here.",
          model: ACTIVE.tts.id,
        });
      case "handoff_to_editor": {
        if (!env.APEX_VAULT) return JSON.stringify({ ok: false, error: "APEX_VAULT is not bound." });
        const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
        await env.APEX_VAULT.put(
          `bus:${id}`,
          JSON.stringify({
            id,
            uid,
            kind: args.kind,
            name: args.name ?? `${args.kind}-${id}`,
            mime: args.kind === "audio" ? "audio/wav" : "video/mp4",
            url: args.url,
            data: null,
            size: null,
            meta: args.meta ?? {},
            from: "agent",
            createdAt: new Date().toISOString(),
          }),
          { expirationTtl: 600 }
        );
        return JSON.stringify({ ok: true, id, openPath: `/v1/bus/handoff/${id}`, ttlSeconds: 600 });
      }
      default:
        return `error: unknown tool "${name}"`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ok: false, error: message });
  }
}

interface AgentBody {
  message?: unknown;
  messages?: unknown;
  confirmed?: unknown;
  context?: unknown;
}

export async function handleAgent(request: Request, env: NexusEnv, uid: string): Promise<Response> {
  let body: AgentBody;
  try {
    body = (await request.json()) as AgentBody;
  } catch {
    return errorResponse("Body must be JSON: { message, messages?, confirmed? }.", 400);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return errorResponse("`message` is required.", 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    return errorResponse(`\`message\` is limited to ${MAX_MESSAGE_CHARS} characters.`, 413);
  }

  const confirmed = body.confirmed === true;
  const history: { role: string; content: string }[] = Array.isArray(body.messages)
    ? (body.messages as any[])
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-10)
    : [];

  const chain = providers(env);
  if (chain.length === 0) {
    return errorResponse(
      "No tool-calling model is configured. Set GROQ_API_KEY, GOOGLE_AI_KEY, OPENROUTER_API_KEY or CUSTOM_MODEL_URL on this Worker.",
      503,
      { note: "Workers AI can answer questions but this loop needs an OpenAI-compatible tools API." }
    );
  }

  const messages: any[] = [
    { role: "system", content: SYSTEM },
    ...(body.context ? [{ role: "system", content: `App context: ${JSON.stringify(body.context).slice(0, 2000)}` }] : []),
    ...history,
    { role: "user", content: message },
  ];

  const pending: { name: string; arguments: Record<string, unknown> }[] = [];
  const executed: { name: string; result: string }[] = [];
  let lastError: string | null = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let result: ProviderResult | null = null;
    for (const provider of chain) {
      try {
        result = await callProvider(provider, env, messages);
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!result) {
      return errorResponse("Every model provider failed.", 502, { lastError });
    }

    if (result.toolCalls.length === 0) {
      return jsonResponse({
        ok: true,
        answer: result.content,
        model: result.model,
        turns: turn + 1,
        executed,
        pending: pending.length ? pending : undefined,
      });
    }

    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "error: arguments were not valid JSON" });
        continue;
      }

      if (!TOOL_NAMES.has(call.name)) {
        messages.push({ role: "tool", tool_call_id: call.id, content: `error: unknown tool "${call.name}"` });
        continue;
      }

      // The confirmation gate: proposed, not performed.
      if (GATED.has(call.name) && !confirmed) {
        pending.push({ name: call.name, arguments: args });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, needsConfirmation: true, note: "Not executed. The owner must confirm." }),
        });
        continue;
      }

      const output = await runTool(call.name, args, env, uid);
      executed.push({ name: call.name, result: output.slice(0, 500) });
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }

    if (pending.length && !confirmed) {
      // Stop early: there is nothing more to decide until the owner says yes.
      return jsonResponse({
        ok: true,
        answer: result.content,
        model: result.model,
        turns: turn + 1,
        executed,
        needsConfirmation: pending,
        note: "Nothing was sent. Re-send with confirmed: true to run these.",
      });
    }
  }

  return jsonResponse({
    ok: true,
    answer: "I stopped after four tool turns. Here is what ran.",
    model: chain[0].model,
    turns: MAX_TURNS,
    executed,
    truncated: true,
  });
}

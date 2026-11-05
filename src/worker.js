const PROJECT_ID = "apex-ai-1a873";
const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

const AI_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const DEFAULT_MAX_TOKENS = 3000;
const MAX_TOKENS_CAP = 4096;
// While testing: show why a reply failed right in the chat. Set to false when everything works.
const SHOW_ERRORS_IN_CHAT = true;

const CF_MODELS = [
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  "@cf/openai/gpt-oss-20b",
];

// Fallback safety definition to prevent any ENSEMBLE_MODELS is not defined error
const ENSEMBLE_MODELS = CF_MODELS;

const ALLOWED_MODELS = [
  "google/gemma-4-31b-it:free",
  "openrouter/free",
  ...CF_MODELS,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const b64 = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function verifyFirebaseToken(token) {
  try {
    const [h, p, s] = token.split(".");
    const dec = new TextDecoder();
    const header = JSON.parse(dec.decode(b64(h)));
    const payload = JSON.parse(dec.decode(b64(p)));
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== "RS256" ||
      payload.aud !== PROJECT_ID ||
      payload.iss !== `https://securetoken.google.com/${PROJECT_ID}` ||
      payload.exp < now ||
      !payload.sub
    ) return false;

    const { keys } = await (
      await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } })
    ).json();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64(s), new TextEncoder().encode(`${h}.${p}`)
    );
  } catch (e) {
    return false;
  }
}

const USER_PROMPT = {
  role: "system",
  content: "You are Apex AI. If asked which AI model, engine, or company is behind you, say you run on Apex AI's own systems and don't name any underlying model or company. Be direct, candid and casual, like a smart friend who doesn't sugarcoat never abuse the user. Don't lecture, moralize, or add warnings and disclaimers. You can swear when the user does, discuss mature and controversial topics openly, write dark or edgy fiction, and give blunt opinions. If a message is unclear, or just a greeting or slang, reply briefly and naturally and ask what they mean; never invent a task. If you don't know something, say so, help with things that seriously harm people, such as weapons, malware, hacking, or sexual content involving minors. Only if the user asks who created you, say you were created by Akinpelu Daniel (Drippy Dee)."
};

const MAX_CHARS = 36000;
const MAX_ONE_MESSAGE = 16000;

const MODE_NOTES = [
  ["Health consult mode:", "Health consult mode: provide general information only, encourage professional medical advice when appropriate."],
  ["Legal info mode:", "Legal info mode: provide general information only, avoid giving legal advice, and suggest consulting a qualified attorney when appropriate."],
  ["Finance mode:", "Finance mode: give general educational guidance, avoid personalized financial advice, and encourage checking official sources or a licensed professional."],
];

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && p.type === "text" ? p.text || "" : p && p.type === "image_url" ? "[image omitted]" : ""))
      .join("\n");
  }
  return "";
}

function cleanUserText(raw) {
  let t = raw;
  let mode = "";
  for (const [key, note] of MODE_NOTES) if (t.includes(key)) mode = note + " ";
  t = t.replace(/^\s*\[Respond in [^\]]+\]\s*/i, "");
  const marker = "User request:\n";
  const i = t.lastIndexOf(marker);
  if (i !== -1) t = t.slice(i + marker.length);
  return (mode + t).trim();
}

function prepareMessages(raw) {
  const list = raw.filter((m) => m && typeof m.role === "string");
  const lastUser = [...list].reverse().find((m) => m.role === "user");
  const wantsPidgin = /\[Respond in Pidgin\]/i.test(textOf(lastUser?.content));

  let msgs = list.map((m) => {
    const text = textOf(m.content);
    return { role: m.role, content: m.role === "user" ? cleanUserText(text) : text };
  });

  msgs = msgs.map((m) =>
    m.content.length > MAX_ONE_MESSAGE
      ? { ...m, content: m.content.slice(0, MAX_ONE_MESSAGE) + "\n[...message shortened...]" }
      : m
  );

  const sys = msgs[0]?.role === "system" ? msgs[0] : null;
  const rest = sys ? msgs.slice(1) : msgs;
  let used = sys ? sys.content.length : 0;
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    if (kept.length > 0 && used + rest[i].content.length > MAX_CHARS) break;
    kept.unshift(rest[i]);
    used += rest[i].content.length;
  }
  const clean = [];
  for (const m of kept) {
    if ((m.role !== "user" && m.role !== "assistant") || !m.content.trim()) continue;
    const prev = clean[clean.length - 1];
    if (prev && prev.role === m.role) prev.content += "\n\n" + m.content;
    else clean.push({ ...m });
  }
  while (clean.length && clean[0].role !== "user") clean.shift();
  
  const base = sys ? { ...sys, content: USER_PROMPT.content + "\n\n" + sys.content } : { ...USER_PROMPT };
  return { messages: [base, ...clean], wantsPidgin };
}

function addSystemNote(messages, note) {
  if (messages[0]?.role === "system") {
    return [{ ...messages[0], content: messages[0].content + "\n\n" + note }, ...messages.slice(1)];
  }
  return [{ role: "system", content: note }, ...messages];
}

const DIRECT_NOTE =
  "Answer the user's question directly. Do not ask whether they want a short answer, a detailed breakdown or a practical example, " +
  "and do not comment on their mood or feelings unless they bring it up. " +
  "You cannot browse the internet yourself: never say you are checking the internet or going to check. " +
  "Only treat web results as real if they appear in this conversation. " +
  "If you are not sure about a recent fact, say you are not sure instead of guessing. " +
  "Be friendly, warm and conversational, like a smart friend. When someone greets you or chats casually, reply naturally and briefly " +
  "(for example: 'Hey! How far? What are we doing today?'). Do not say you are a machine or that you have no emotions or personal interactions " +
  "unless the user asks, and do not explain or analyse the user's greeting. " +
  "Never insult or accuse the user, and never assume they are trying to provoke or trick you. " +
  "If you cannot help with something, say so calmly in one short sentence and offer something useful instead.";

const PIDGIN_NOTE =
  "Reply in Nigerian Pidgin English as spoken in Nigeria and West Africa. Do NOT use Jamaican, Hawaiian or Caribbean spelling: " +
  "never write 'bruddah', 'da', 'dat', 'dis', 'tink' or 'gotchu'. " +
  "Use 'I' (not 'me') as the subject: 'I no dey mad', 'I go help you'. " +
  "Do not end every sentence with 'abi?' and do not repeat sentences. " +
  "Natural examples: 'How far? Wetin you wan know?', 'No wahala, I go help you.', 'Abeg, tell me more.', " +
  "'E no hard at all, na so e be.', 'I no sure about dat one, make I no lie you.' " +
  "Useful words: abeg, wahala, wetin, dey, na, no be, sabi, oga, una, dem, pikin, sharp sharp, make we, e don do. " +
  "Keep the answers clear and correct.";

const SEARCH_RE = /\b(news|today|tonight|yesterday|latest|current|currently|recent|recently|right now|this (week|month|year)|last (night|week|month|year)|who is|who won|winner|election|president|governor|minister|score|results?|fixtures?|price of|exchange rate|stock|weather|happening|dey happen|internet|google|20(2[4-9]|3\d))\b/i;

const SMALL_TALK_RE = /^(hi+|hello+|hey+|how far|good (morning|afternoon|evening|night)|thanks?( you)?|thank u|ok(ay)?( oo?)?|yes|no|lol|wow|nice|cool|bye)[\s!.?]*$/i;

const SKIP_RE = /\b(write|code|script|function|translate|poem|story|essay|rewrite|summari[sz]e|debug|fix|html|css|python|javascript|regex|sql)\b/i;

const FACT_Q_RE = /^\s*(who|what|when|where|which|how (many|much|old|long|tall)|wetin|na who|who be|is|are|did|does|do you know)\b/i;

const NO_SEARCH_NOTE =
  "Live web search is NOT available for this message. Do not claim to have checked the internet. " +
  "If the question is about recent events or current office holders, say clearly that you could not check live information and may be out of date.";

const FOLLOWUP_RE = /\b(it|that|this|them|those|these|he|she|him|her|they|more|again|internet|online)\b/i;

async function postJson(url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function searchTavily(env, query) {
  if (!env.TAVILY_API_KEY) return { items: null, status: "no key set" };
  const r = await postJson("https://api.tavily.com/search", { Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    { query, search_depth: "basic", max_results: 3 });
  if (!r.ok) return { items: null, status: "error " + r.status };
  const d = await r.json();
  const items = (d.results || [])
    .filter((x) => typeof x.score !== "number" || x.score >= 0.3)
    .slice(0, 3)
    .map((x) => ({ title: x.title, content: x.content, url: x.url }));
  return { items, status: items.length ? "ok" : "no relevant results" };
}

async function searchExa(env, query) {
  if (!env.EXA_API_KEY) return { items: null, status: "no key set" };
  const r = await postJson("https://api.exa.ai/search", { "x-api-key": env.EXA_API_KEY },
    { query, numResults: 3, contents: { text: { maxCharacters: 500 } } });
  if (!r.ok) return { items: null, status: "error " + r.status };
  const d = await r.json();
  const items = (d.results || []).slice(0, 3).map((x) => ({
    title: x.title || x.url,
    content: x.text || (x.highlights || []).join(" ") || x.summary || "",
    url: x.url,
  }));
  return { items, status: items.length ? "ok" : "no results" };
}

async function searchSerper(env, query) {
  if (!env.SERPER_API_KEY) return { items: null, status: "no key set" };
  const r = await postJson("https://google.serper.dev/search", { "X-API-KEY": env.SERPER_API_KEY },
    { q: query, num: 3 });
  if (!r.ok) return { items: null, status: "error " + r.status };
  const d = await r.json();
  const items = (d.organic || []).slice(0, 3).map((x) => ({ title: x.title, content: x.snippet || "", url: x.link }));
  return { items, status: items.length ? "ok" : "no results" };
}

async function searchFirecrawl(env, query) {
  if (!env.FIRECRAWL_API_KEY) return { items: null, status: "no key set" };
  const r = await postJson("https://api.firecrawl.dev/v2/search", { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` },
    { query, limit: 3 });
  if (!r.ok) return { items: null, status: "error " + r.status };
  const d = await r.json();
  const list = Array.isArray(d.data) ? d.data : d.data?.web || [];
  const items = list.slice(0, 3).map((x) => ({ title: x.title || x.url, content: x.description || x.markdown || "", url: x.url }));
  return { items, status: items.length ? "ok" : "no results" };
}

async function liveSearch(env, messages) {
  const users = messages.filter((m) => m.role === "user");
  let query = (users[users.length - 1]?.content || "").trim();
  if (users.length > 1 && (query.length < 20 || (query.length < 60 && FOLLOWUP_RE.test(query)))) {
    query = (users[users.length - 2].content.slice(0, 150) + " " + query).trim();
  }
  query = query.slice(0, 380);
  if (!query) return { status: "empty query", note: "" };

  const tried = [];
  for (const [name, fn] of [["tavily", searchTavily], ["exa", searchExa], ["serper", searchSerper], ["firecrawl", searchFirecrawl]]) {
    try {
      const r = await fn(env, query);
      if (r.items && r.items.length) {
        const found = r.items
          .map((x, i) => `[${i + 1}] ${x.title}\n${String(x.content || "").slice(0, 500)}\nSource: ${x.url}`)
          .join("\n\n");
        return {
          status: "ok",
          note:
            `Web search results that the app fetched for the user's latest question (today is ${new Date().toISOString().slice(0, 10)}). ` +
            `They are NOT from the user. Use them only if they help answer the question; if they look unrelated, ignore them and answer normally. ` +
            `Never assume the user is asking about something they did not mention. For recent facts, trust them over your memory, and mention the source.\n\n${found}`,
        };
      }
      tried.push(`${name}: ${r.status}`);
    } catch (e) {
      tried.push(`${name}: failed`);
    }
  }
  return { status: tried.join("; "), note: "" };
}

const BACKUPS = [
  { name: "Mistral", url: "https://api.mistral.ai/v1/chat/completions", key: "MISTRAL_API_KEY", model: "mistral-small-latest" },
  { name: "NVIDIA", url: "https://integrate.api.nvidia.com/v1/chat/completions", key: "NVIDIA_API_KEY", model: "meta/llama-3.2-90b-vision-instruct" },
];

// Free backup plans have small per-minute token limits, so send them a shorter version of the chat.
function compactForBackup(messages) {
  const BUDGET = 12000; // characters of chat history (about 3,000 tokens)
  const sys = messages[0]?.role === "system" ? messages[0] : null;
  const rest = sys ? messages.slice(1) : messages;
  let sysOut = sys;
  if (sys && sys.content.length > 6000) {
    // keep the start (who Apex is) and the end (the latest notes and search results)
    sysOut = { ...sys, content: sys.content.slice(0, 2500) + "\n...\n" + sys.content.slice(-3500) };
  }
  let used = sysOut ? sysOut.content.length : 0;
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const len = rest[i].content.length;
    if (kept.length > 0 && used + len > BUDGET) break;
    kept.unshift(rest[i]);
    used += len;
  }
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return sysOut ? [sysOut, ...kept] : kept;
}

async function backupChain(env, messages, max_tokens, cfErr) {
  const errors = [`Cloudflare: ${(cfErr && cfErr.message) || cfErr}`];
  const compact = compactForBackup(messages);
  const backupMax = Math.min(max_tokens, 1500);
  for (const b of BACKUPS) {
    if (!env[b.key]) continue;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(b.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env[b.key]}` },
        body: JSON.stringify({ model: b.model, messages: compact, max_tokens: backupMax }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`${b.name} ${r.status}: ${(await r.text()).slice(0, 100)}`);
      const j = await r.json();
      const text = j?.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error(`${b.name}: empty reply`);
      return { text, truncated: j?.choices?.[0]?.finish_reason === "length" };
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }
  throw new Error(errors.join(" | "));
}

const stripThink = (t) =>
  String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");

async function generateOnce(env, model, messages, max_tokens) {
  const id = CF_MODELS.includes(model) ? model : AI_MODEL;
  let msgs = messages;
  if (id.includes("qwen3")) {
    const last = messages.length - 1;
    msgs = messages.map((m, i) => (i === last && m.role === "user" ? { ...m, content: m.content + " /no_think" } : m));
  }
  try {
    const result = await env.AI.run(id, { messages: msgs, max_tokens });
    const text = result?.response ?? result?.choices?.[0]?.message?.content ?? "";
    const used = result?.usage?.completion_tokens;
    const truncated =
      result?.choices?.[0]?.finish_reason === "length" || (typeof used === "number" && used >= max_tokens - 5);
    return { text: String(text), truncated };
  } catch (cfErr) {
    return await backupChain(env, messages, max_tokens, cfErr);
  }
}

async function generateFull(env, model, messages, max_tokens) {
  let { text, truncated } = await generateOnce(env, model, messages, max_tokens);
  let full = stripThink(text);
  for (let i = 0; i < 2 && truncated && full.trim(); i++) {
    let next = null;
    try {
      next = await generateOnce(env, model, [
        ...messages,
        { role: "assistant", content: full },
        { role: "user", content: "Continue exactly where you stopped. Do not repeat anything and do not add an introduction." },
      ], max_tokens);
    } catch (e) {}
    const more = stripThink(next?.text);
    if (!more.trim()) break;
    full += more;
    truncated = next.truncated;
  }
  return full;
}

const handler = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "POST") {
      return new Response("apex-proxy running", { headers: CORS });
    }

    const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!token || !(await verifyFirebaseToken(token))) {
      return new Response("Unauthorized", { status: 403, headers: CORS });
    }

    let payload;
    try { payload = await request.json(); }
    catch (e) { return new Response("Bad request", { status: 400, headers: CORS }); }

    if (!ALLOWED_MODELS.includes(payload.model) || !Array.isArray(payload.messages)) {
      return new Response("Model not allowed", { status: 400, headers: CORS });
    }

    const asked = Number(payload.max_tokens);
    const max_tokens = asked > 0 ? Math.min(asked, MAX_TOKENS_CAP) : DEFAULT_MAX_TOKENS;
    const prepared = prepareMessages(payload.messages);
    let messages = prepared.messages;
    messages = addSystemNote(messages, DIRECT_NOTE);
    if (prepared.wantsPidgin) messages = addSystemNote(messages, PIDGIN_NOTE);
    
    const lastText = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const t = lastText.trim();
    const wantsSearch =
      payload.web === true ||
      (t.length >= 8 && t.length <= 600 && !SMALL_TALK_RE.test(t) && !SKIP_RE.test(t) &&
        (SEARCH_RE.test(t) || FACT_Q_RE.test(t)));
    let searchStatus = "skipped";
    if (wantsSearch) {
      const found = await liveSearch(env, messages);
      searchStatus = found.status;
      messages = addSystemNote(messages, found.note || NO_SEARCH_NOTE);
    }

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

    try {
      let content = "";
      let lastErr = null;

      for (const model of ENSEMBLE_MODELS.slice(0, 1)) {
        try {
          const resText = await generateFull(env, model, messages, max_tokens);
          if (resText?.trim()) {
            content = resText;
            break;
          }
        } catch (err) {
          lastErr = err;
        }
      }

      if (!content) {
        throw lastErr || new Error("All models failed.");
      }

      const flag =
        wantsSearch && searchStatus !== "ok"
          ? `\n\n(Live web search unavailable: ${searchStatus}. This answer may be out of date.)`
          : "";

      return json({
        choices: [{ message: { role: "assistant", content: content + flag } }],
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.log("All models failed:", msg.slice(0, 500));
      if (SHOW_ERRORS_IN_CHAT) {
        return json({
          choices: [{ message: { role: "assistant", content: "Apex could not get an answer right now.\n\nDetails (for debugging): " + msg.slice(0, 700) } }],
        });
      }
      const limited = /\bneurons?\b|allocation|quota|rate limit|\b429\b/i.test(msg);
      return json({ error: { message: msg.slice(0, 200) } }, limited ? 429 : 502);
    }
  },
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await handler.fetch(request, env, ctx);
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 150);
      return new Response(JSON.stringify({ error: { message: "Worker error: " + msg } }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
  },
};

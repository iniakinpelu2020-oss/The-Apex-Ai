/**
 * Shared types for the Apex Nexus modules.
 *
 * These are deliberately hand-written rather than pulled from
 * @cloudflare/workers-types: the repo has no type-check step and no build
 * dependencies, so adding a dependency just for ambient types would make
 * `wrangler deploy` slower and the repo heavier for nothing. Wrangler's esbuild
 * strips these at build time either way.
 */

/** The subset of the Workers KV API these modules use. */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The subset of the Workers AI binding these modules use. */
export interface AiBinding {
  run(model: string, inputs: unknown, options?: unknown): Promise<any>;
}

/** Errors thrown by a handler that already know their HTTP status. */
export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Environment bindings and secrets.
 *
 * Everything here except the bindings is a secret set with
 * `wrangler secret put`, so nothing in this file is ever shipped to a browser.
 */
export interface NexusEnv {
  // bindings
  AI: AiBinding;
  APEX_VAULT?: KVNamespaceLike;
  RATE?: KVNamespaceLike;

  // identity
  OWNER_UID?: string;
  FIREBASE_PROJECT_ID?: string;
  INTERNAL_SECRET?: string;

  // Google Workspace
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  ENCRYPTION_KEY?: string;

  // storage
  DRIVE_B2_ENDPOINT?: string;
  DRIVE_B2_BUCKET?: string;
  DRIVE_B2_KEY_ID?: string;
  DRIVE_B2_APP_KEY?: string;
  DRIVE_PREFIX?: string;
  DRIVE_MAX_BYTES?: string;

  // model providers (all optional, tried in this order)
  GROQ_API_KEY?: string;
  GOOGLE_AI_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CUSTOM_MODEL_URL?: string;

  // existing keys used by the legacy chat route
  TAVILY_API_KEY?: string;
  EXA_API_KEY?: string;
  SERPER_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  SHOW_ERRORS?: string;

  [key: string]: unknown;
}

/** What the auth gate returns when a request is allowed through. */
export interface Identity {
  uid: string;
  via: "firebase" | "internal";
}

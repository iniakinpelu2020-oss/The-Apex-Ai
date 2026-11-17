# The Apex Ai

A single-page AI assistant. The whole UI lives in one file, `index.html`, and is served
by a Cloudflare Worker called `apex-proxy` (`src/worker.js`) that talks to Workers AI so
no model key is exposed to the browser.

## How it fits together

- `index.html` — the entire app: chat UI, message rendering, code-artifact viewer
  (sandboxed iframe), copy/share actions, auth modal, and the model list.
  Tailwind CSS is loaded from the CDN; there is no build step for the page.
- `src/worker.js` — the `apex-proxy` Worker. Serves the page, enforces the unified
  `APEX_SYSTEM_PROMPT` server-side, and calls Workers AI through the `AI` binding.
- `wrangler.jsonc` — Worker config: `main: src/worker.js`, `ai.binding: AI`.
- `functions/_middleware.js` — Pages-function middleware left over from an earlier
  deployment shape. It injects `/upload-fix.js` (the hardened upload handler) into the
  page. It also strips leftover Git merge-conflict markers out of `index.html`; that is a
  safety net only. `index.html` itself must never contain `<<<<<<<` markers, because they
  are a JavaScript syntax error that kills the whole app script.
- `upload-fix.js` — upload handling loaded after the app's own scripts.

## Running

```bash
npm install
npx wrangler dev      # local
npx wrangler deploy   # publish
```

## Notes

- `FIREBASE_API_KEY` is set as a plain `vars` entry in `wrangler.jsonc`. Firebase web
  keys are client-side by design, but a secret belongs in the Cloudflare dashboard or a
  `.dev.vars` file, not in a committed config.
- There are no tests in this repo. Do not run `npm test`; it does not exist.

// Serves the app with a few fixes applied at the edge:
//   1. Leftover Git merge-conflict markers in index.html, which make the
//      browser throw a SyntaxError and kill the whole app script.
//   2. Injects /upload-fix.js so the hardened upload handler loads after the
//      app's own scripts.
//   3. Injects /guest-name.js so guests can tell Apex what to call them.
// Both are no-ops once the source file no longer needs them.
const EXTRA_SCRIPTS = ['/upload-fix.js', '/guest-name.js'];

// Keeps the first side of each conflict block and drops the markers plus the
// other side. The blocks it currently meets have identical sides.
function resolveConflicts(html) {
  return html.replace(
    /^<<<<<<<[^\n]*\n([\s\S]*?)^=======\n[\s\S]*?^>>>>>>>[^\n]*\n/gm,
    "$1"
  );
}

function injectScripts(html) {
  if (!html.includes("</body>")) return html;
  let out = html;
  for (const src of EXTRA_SCRIPTS) {
    if (out.includes(src)) continue;
    out = out.replace("</body>", `<script src="${src}" defer></script></body>`);
  }
  return out;
}

export async function onRequest(context) {
  const response = await context.next();
  const type = response.headers.get("Content-Type") || "";

  if (!type.includes("text/html")) return response;

  let html;
  try {
    html = await response.text();
  } catch {
    return response;
  }

  const body = injectScripts(resolveConflicts(html));

  const headers = new Headers(response.headers);
  if (body !== html) {
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  }

  // Always a fresh Response: the original body has been read above.
  return new Response(body, { status: response.status, headers });
}

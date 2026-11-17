// Serves the app with two problems repaired at the edge:
//   1. Leftover Git merge-conflict markers in index.html, which make the
//      browser throw a SyntaxError and kill the whole app script.
//   2. Injects /upload-fix.js so the hardened upload handler loads after the
//      app's own scripts.
// Both are no-ops once the source file no longer needs them.
const FIX_TAG = '<script src="/upload-fix.js" defer></script>';

// Keeps the first side of each conflict block and drops the markers plus the
// other side. The blocks it currently meets have identical sides.
function resolveConflicts(html) {
  return html.replace(
    /^<<<<<<<[^\n]*\n([\s\S]*?)^=======\n[\s\S]*?^>>>>>>>[^\n]*\n/gm,
    "$1"
  );
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

  const repaired = resolveConflicts(html);
  const needsFix = !repaired.includes("/upload-fix.js") && repaired.includes("</body>");
  const body = needsFix ? repaired.replace("</body>", FIX_TAG + "</body>") : repaired;

  const headers = new Headers(response.headers);
  if (body !== html) {
    headers.delete("content-length");
    headers.delete("etag");
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  }

  // Always a fresh Response: the original body has been read above.
  return new Response(body, { status: response.status, headers });
}

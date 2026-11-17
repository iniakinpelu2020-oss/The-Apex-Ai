// Injects /upload-fix.js into HTML responses so the hardened upload handler
// loads after the app's own scripts. Non-HTML responses pass through untouched.
const FIX_TAG = '<script src="/upload-fix.js" defer></script>';

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

  if (html.includes("/upload-fix.js") || !html.includes("</body>")) {
    return new Response(html, { status: response.status, headers: response.headers });
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("cache-control", "public, max-age=0, must-revalidate");

  return new Response(html.replace("</body>", FIX_TAG + "</body>"), {
    status: response.status,
    headers,
  });
}

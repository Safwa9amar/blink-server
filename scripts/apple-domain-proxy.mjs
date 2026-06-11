/**
 * Apple domain-verification proxy for LOCAL Apple Sign-In via ngrok.
 *
 * Why: "Sign in with Apple" verifies the Services ID's domain by fetching
 *   https://<domain>/.well-known/apple-developer-domain-association.txt
 * Supabase's local auth server (:54321) doesn't serve that file, so Apple's
 * domain check fails. This tiny proxy sits in front of Supabase: it serves the
 * association file and forwards everything else untouched.
 *
 *   ngrok  →  this proxy (:5400)  →  supabase auth (:54321)
 *
 * Setup:
 *   1. In Apple's portal, add your ngrok domain to the Services ID. Apple shows
 *      a "Download" for apple-developer-domain-association.txt — save it as
 *      scripts/apple-developer-domain-association.txt (next to this file).
 *   2. npm run apple:proxy
 *   3. ngrok http --url=<your-static-domain> 5400
 *   4. Back in Apple's portal, click "Verify".
 *
 * Zero dependencies — Node's built-in http only.
 */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.APPLE_PROXY_PORT) || 5400;
const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = Number(process.env.SUPABASE_AUTH_PORT) || 54321;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSOCIATION_PATH = join(
  __dirname,
  "apple-developer-domain-association.txt",
);
const WELL_KNOWN = "/.well-known/apple-developer-domain-association.txt";

const server = createServer((req, res) => {
  // 1. Serve Apple's domain-association file ourselves.
  if (req.url === WELL_KNOWN) {
    try {
      const body = readFileSync(ASSOCIATION_PATH);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
      console.log("→ served apple-developer-domain-association.txt");
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(
        "Missing scripts/apple-developer-domain-association.txt — download it " +
          "from Apple's Services ID config and save it there.",
      );
      console.error("✗ association file not found at", ASSOCIATION_PATH);
    }
    return;
  }

  // 2. Forward everything else to local Supabase auth, streaming both ways.
  const proxyReq = httpRequest(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`Proxy error: ${err.message}`);
    console.error("✗ upstream error:", err.message);
  });
  req.pipe(proxyReq);
});

server.listen(PORT, () => {
  console.log(
    `Apple proxy on http://127.0.0.1:${PORT}  →  supabase :${TARGET_PORT}\n` +
      `Point ngrok at ${PORT}:  ngrok http --url=<your-static-domain> ${PORT}`,
  );
});

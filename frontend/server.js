import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.PORT ?? "23561", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const BACKEND_HOST = process.env.BACKEND_HOST ?? "backend";
const BACKEND_PORT = Number.parseInt(process.env.BACKEND_PORT ?? "3000", 10);
const STATIC_DIR = path.resolve(__dirname, "dist");
const INDEX_FILE = path.join(STATIC_DIR, "index.html");
const ASSETS_DIR = path.join(STATIC_DIR, "assets");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function cacheControlFor(filePath) {
  // Vite fingerprints everything under assets/, so those files may live in the
  // browser cache forever. index.html (and anything else unhashed) must be
  // revalidated on every load, or a deploy strands browsers on bundle URLs
  // that no longer exist.
  return filePath.startsWith(ASSETS_DIR + path.sep)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function sendFile(req, res, filePath, stats) {
  const lastModified = stats.mtime.toUTCString();
  const headers = {
    "content-type": mimeFor(filePath),
    "cache-control": cacheControlFor(filePath),
    "last-modified": lastModified,
  };
  if (req.headers["if-modified-since"] === lastModified) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  headers["content-length"] = stats.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
    }
    res.end("Internal server error");
  });
  stream.pipe(res);
}

function proxyApi(req, res) {
  const stripped = req.url.replace(/^\/api/, "") || "/";
  const headers = { ...req.headers };
  headers.host = `${BACKEND_HOST}:${BACKEND_PORT}`;
  delete headers["connection"];

  const proxyReq = http.request(
    {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      method: req.method,
      path: stripped,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: `Bad gateway: ${err.message}` }));
  });

  req.pipe(proxyReq);
}

async function serveStatic(req, res) {
  const rawPath = (req.url ?? "/").split("?")[0];
  const decoded = decodeURIComponent(rawPath);
  const requestedPath = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.normalize(path.join(STATIC_DIR, requestedPath));

  if (!candidate.startsWith(STATIC_DIR + path.sep) && candidate !== STATIC_DIR) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const stats = await stat(candidate);
    if (stats.isFile()) {
      sendFile(req, res, candidate, stats);
      return;
    }
  } catch {
    // fall through to SPA index
  }

  try {
    const stats = await stat(INDEX_FILE);
    sendFile(req, res, INDEX_FILE, stats);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) {
    proxyApi(req, res);
    return;
  }
  serveStatic(req, res).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
    }
    res.end(`Internal server error: ${err.message}`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend listening on http://${HOST}:${PORT}`);
  console.log(`Static root: ${STATIC_DIR}`);
  console.log(`Proxying /api/* -> http://${BACKEND_HOST}:${BACKEND_PORT}`);
});

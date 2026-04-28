const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 3211);
const FRONTEND_HOST = process.env.FRONTEND_HOST || "0.0.0.0";
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "http://127.0.0.1:3210";
const API_BASE_URL = process.env.FRONTEND_API_BASE_URL || "";
const ROOT_DIR = __dirname;

function send(res, status, body, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType
  });
  res.end(body);
}

function sendNotFound(res) {
  send(res, 404, "not_found", "text/plain; charset=utf-8");
}

function proxyRequest(req, res, targetUrl) {
  const upstream = new URL(targetUrl);
  const requestOptions = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: `${upstream.pathname}${upstream.search}`,
    headers: {
      ...req.headers,
      host: upstream.host
    }
  };

  const transport = upstream.protocol === "https:" ? https : http;
  const proxyReq = transport.request(requestOptions, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (error) => {
    send(res, 502, JSON.stringify({ error: "proxy_error", detail: error.message }), "application/json; charset=utf-8");
  });

  req.pipe(proxyReq);
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  try {
    const body = fs.readFileSync(filePath);
    send(res, 200, body, contentTypeMap[ext] || "application/octet-stream");
  } catch {
    sendNotFound(res);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/app-config.js") {
    const content = `window.__APP_CONFIG__ = ${JSON.stringify({ API_BASE_URL })};`;
    send(res, 200, content, "application/javascript; charset=utf-8");
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    proxyRequest(req, res, `${BACKEND_ORIGIN}${url.pathname}${url.search}`);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveStatic(res, path.join(ROOT_DIR, "index.html"));
    return;
  }

  const relativePath = url.pathname.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT_DIR, relativePath);
  if (!filePath.startsWith(ROOT_DIR)) {
    sendNotFound(res);
    return;
  }

  serveStatic(res, filePath);
});

server.listen(FRONTEND_PORT, FRONTEND_HOST, () => {
  console.log(`SharedReading frontend running on ${FRONTEND_HOST}:${FRONTEND_PORT}`);
  console.log(`Local:   http://127.0.0.1:${FRONTEND_PORT}`);
  console.log(`Backend: ${BACKEND_ORIGIN}`);
});

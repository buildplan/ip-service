process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Duplex } = require("node:stream");

const { app, getClientIp, isCli } = require("../server");

function decodeChunkedBody(raw) {
  let out = "";
  let idx = 0;
  while (idx < raw.length) {
    const lineEnd = raw.indexOf("\r\n", idx);
    if (lineEnd === -1) break;
    const size = parseInt(raw.slice(idx, lineEnd).split(";")[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    out += raw.slice(start, start + size);
    idx = start + size + 2;
  }
  return out;
}

// Invokes the full Express middleware & routing pipeline in-memory without binding a TCP port
function requestApp(urlPath, { method = "GET", headers = {}, remoteAddress = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });
    socket.remoteAddress = remoteAddress;
    socket.destroySoon = () => {};

    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = urlPath;
    req.headers = {};
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }
    req.push(null);

    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on("error", reject);
    res.on("finish", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const sep = raw.indexOf("\r\n\r\n");
      const rawBody = sep === -1 ? "" : raw.slice(sep + 4);
      const isChunked = String(res.getHeader("transfer-encoding") || "").toLowerCase().includes("chunked");
      const text = isChunked ? decodeChunkedBody(rawBody) : rawBody;
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        text,
        json: () => JSON.parse(text),
      });
    });

    app(req, res);
  });
}

test("getClientIp prioritizes proxy headers and strips ::ffff: prefix; isCli detects CLI agents", () => {
  assert.equal(
    getClientIp({ headers: { "cf-connecting-ip": "2001:4860:4860::8888", "x-real-ip": "1.1.1.1" } }),
    "2001:4860:4860::8888",
  );
  assert.equal(
    getClientIp({ headers: { "x-real-ip": "::ffff:203.0.113.5" } }),
    "203.0.113.5",
  );
  assert.equal(
    getClientIp({ headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" } }),
    "198.51.100.7",
  );

  assert.equal(isCli("curl/8.7.1"), true);
  assert.equal(isCli("Wget/1.21"), true);
  assert.equal(isCli("python-requests/2.32"), true);
  assert.equal(isCli("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
  assert.equal(isCli(""), false);
});

test("GET / serves plain text IP for CLI tools and HTML for browsers with no-store headers", async () => {
  const cliRes = await requestApp("/", { headers: { "User-Agent": "curl/8.7.1" } });
  assert.equal(cliRes.status, 200);
  assert.match(String(cliRes.headers["cache-control"]), /no-store/);
  assert.equal(cliRes.text, "127.0.0.1\n");

  const webRes = await requestApp("/", { headers: { "User-Agent": "Mozilla/5.0" } });
  assert.equal(webRes.status, 200);
  assert.match(webRes.text, /<!doctype html>/i);
  assert.match(webRes.text, /WiredAlter/i);
});

test("API routes validate IPs, reject array params, return config, local geo JSON, CLI dashboard, and health status", async () => {
  const cfgRes = await requestApp("/api/config");
  assert.equal(cfgRes.status, 200);
  const cfg = cfgRes.json();
  assert.ok(cfg.v4_url && cfg.v6_url);

  // Invalid IP and array query param rejection across endpoints
  for (const endpoint of [
    "/api/info?ip=bad-ip",
    "/api/whois?ip=bad-ip",
    "/api/reputation?ip=bad-ip",
    "/api/info?ip=1.1.1.1&ip=2.2.2.2",
    "/api/whois?ip=1.1.1.1&ip=2.2.2.2",
    "/api/reputation?ip=1.1.1.1&ip=2.2.2.2",
  ]) {
    const res = await requestApp(endpoint);
    assert.equal(res.status, 400, `Expected 400 for ${endpoint}`);
  }

  // Valid local IPv4 & IPv6 JSON lookup (no external calls)
  const v4Res = await requestApp("/api/info?ip=127.0.0.1");
  assert.equal(v4Res.status, 200);
  assert.equal(v4Res.json().country, "Reserved");

  const v6Res = await requestApp(`/json?ip=${encodeURIComponent("::1")}`);
  assert.equal(v6Res.status, 200);
  assert.equal(v6Res.json().ip, "::1");
  assert.equal(v6Res.json().country, "Reserved");

  // /cli dashboard
  const cliDash = await requestApp("/cli");
  assert.equal(cliDash.status, 200);
  assert.match(cliDash.text, /WIREDALTER IP INTELLIGENCE/);

  // /health healthy and unhealthy memory thresholds
  const origLimit = process.env.MAX_MEMORY_MB;
  try {
    process.env.MAX_MEMORY_MB = "4096";
    const okHealth = await requestApp("/health");
    assert.equal(okHealth.status, 200);
    assert.equal(okHealth.json().status, "healthy");

    process.env.MAX_MEMORY_MB = "1";
    const badHealth = await requestApp("/health");
    assert.equal(badHealth.status, 503);
    assert.equal(badHealth.json().status, "unhealthy");
  } finally {
    if (origLimit === undefined) delete process.env.MAX_MEMORY_MB;
    else process.env.MAX_MEMORY_MB = origLimit;
  }
});

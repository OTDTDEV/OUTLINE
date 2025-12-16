import express from "express";
import fetch from "node-fetch";
import crypto from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { JsonRpcProvider } from "ethers";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- helpers ----------
const cache = new Map();
function toHttp(u) {
  if (u.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${u.slice("ipfs://".length)}`;
  return u;
}
async function fetchJson(url) {
  const u = toHttp(url);
  if (cache.has(u)) return cache.get(u);
  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${u}`);
  const j = await r.json();
  cache.set(u, j);
  return j;
}
function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}
// Basic SSRF safety
function isBlockedUrl(raw) {
  try {
    const url = new URL(raw);
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local")) return true;
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

async function resolveSchemaUrlsFromEns(ensName, rpcUrl) {
  const provider = new JsonRpcProvider(rpcUrl);
  const resolver = await provider.getResolver(ensName);
  if (!resolver) throw new Error(`No resolver for ${ensName}`);

  const reqUrl = (await resolver.getText("cl.schema.request"))?.trim();
  const rcptUrl = (await resolver.getText("cl.schema.receipt"))?.trim();
  if (!reqUrl || !rcptUrl) throw new Error(`Missing cl.schema.request / cl.schema.receipt on ${ensName}`);
  return { reqUrl, rcptUrl };
}

let validateReq, validateRcpt;

async function loadSchemas() {
  let reqUrl = process.env.REQ_URL?.trim();
  let rcptUrl = process.env.RCPT_URL?.trim();

  // If not provided directly, resolve from ENS
  if (!reqUrl || !rcptUrl) {
    const ensName = process.env.ENS_NAME?.trim();
    const rpcUrl = process.env.RPC_URL?.trim();
    if (!ensName || !rpcUrl) {
      throw new Error("Set (REQ_URL + RCPT_URL) OR (ENS_NAME + RPC_URL).");
    }
    const out = await resolveSchemaUrlsFromEns(ensName, rpcUrl);
    reqUrl = out.reqUrl;
    rcptUrl = out.rcptUrl;
  }

  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    loadSchema: async (uri) => fetchJson(uri)
  });
  addFormats(ajv);

  const reqSchema = await fetchJson(reqUrl);
  const rcptSchema = await fetchJson(rcptUrl);

  validateReq = await ajv.compileAsync(reqSchema);
  validateRcpt = await ajv.compileAsync(rcptSchema);

  console.log("✅ Loaded schemas:");
  console.log("REQ:", reqUrl);
  console.log("RCPT:", rcptUrl);
}

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/fetch/v1.0.0", async (req, res) => {
  if (!validateReq || !validateRcpt) return res.status(503).json({ error: "schemas not loaded" });

  const request = req.body;

  // 1) validate request
  if (!validateReq(request)) {
    return res.status(400).json({ error: "request schema invalid", details: validateReq.errors });
  }

  const p = request.payload || {};
  const url = p.url;
  const method = p.method || "GET";
  const headers = p.headers || {};
  const timeout_ms = Math.min(Math.max(p.timeout_ms || 10000, 1), 30000);

  if (!url || isBlockedUrl(url)) {
    return res.status(400).json({ error: "blocked or missing url", details: { url } });
  }

  // 2) execute fetch
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout_ms);

  let resp, text = "";
  try {
    resp = await fetch(url, { method, headers, signal: controller.signal });
    text = await resp.text();
  } catch (e) {
    clearTimeout(t);

    // Failure receipt still must validate
    const receipt = {
      x402: request.x402,
      trace: {
        request_id: request.trace?.request_id,
        receipt_id: id("rcpt"),
        ts: new Date().toISOString()
      },
      result: { ok: false, status: 0, error: String(e?.message ?? e) }
    };

    if (!validateRcpt(receipt)) {
      return res.status(500).json({ error: "receipt schema invalid (runtime mismatch)", details: validateRcpt.errors });
    }
    return res.status(200).json(receipt);
  } finally {
    clearTimeout(t);
  }

  const headersOut = {};
  resp.headers.forEach((v, k) => (headersOut[k] = v));

  // 3) build receipt (if your canonical schema requires different fields,
  // the server will return details so we can patch exactly)
  const receipt = {
    x402: request.x402,
    trace: {
      request_id: request.trace?.request_id,
      receipt_id: id("rcpt"),
      ts: new Date().toISOString()
    },
    result: {
      ok: resp.ok,
      status: resp.status,
      headers: headersOut,
      body_preview: text.slice(0, 2000)
    }
  };

  // 4) validate receipt
  if (!validateRcpt(receipt)) {
    return res.status(500).json({ error: "receipt schema invalid (runtime mismatch)", details: validateRcpt.errors });
  }

  return res.status(200).json(receipt);
});

const port = Number(process.env.PORT || 3000);
await loadSchemas();
app.listen(port, () => console.log(`✅ listening on :${port}`));

/* Utilidades do harness local: PNG mínimo, backend de arquivos, router estilo Puter, mock do Horde.
   Nada aqui roda em produção — é só para validar o worker sem sair da máquina. */

import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";

/* ---------------- PNG mínimo (sem dependências) ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter none
    for (let x = 0; x < w; x++) {
      raw[o++] = (x * 4) & 0xff;
      raw[o++] = (y * 4) & 0xff;
      raw[o++] = ((x + y) * 2) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- Backend de arquivos (substitui o KV/FS do Puter) ---------------- */
export function createFsBackend(dir) {
  const kvPath = path.join(dir, "kv.json");
  const objDir = path.join(dir, "objects");
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(await fs.readFile(kvPath, "utf8"));
    } catch (_) {
      cache = {};
    }
    return cache;
  }
  async function save() {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(kvPath, JSON.stringify(cache));
  }

  return {
    kind: "fs",
    async kvGet(key) {
      const c = await load();
      return key in c ? c[key] : null;
    },
    async kvSet(key, value) {
      const c = await load();
      c[key] = value;
      await save();
    },
    async kvList(prefix) {
      const c = await load();
      return Object.keys(c).filter((k) => k.startsWith(prefix));
    },
    async kvDel(key) {
      const c = await load();
      delete c[key];
      await save();
    },
    async putObject(p, bytes) {
      const full = path.join(objDir, p);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, bytes);
    },
    async getObject(p) {
      try {
        return new Uint8Array(await fs.readFile(path.join(objDir, p)));
      } catch (_) {
        return null;
      }
    },
  };
}

/* ---------------- Router estilo Puter (subset usado pelo worker) ---------------- */
export function createRouter() {
  const routes = [];
  const add = (method) => (p, handler) => routes.push({ method, p, handler });
  const router = { get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE") };

  function match(routePath, urlPath) {
    const a = routePath.split("/").filter(Boolean);
    const b = urlPath.split("/").filter(Boolean);
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) return null;
    }
    return params;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    const request = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: body && body.length ? body : undefined,
    });

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = match(r.p, url.pathname);
      if (!params) continue;
      try {
        const out = await r.handler({ request, params, user: null });
        if (out instanceof Response) {
          const buf = Buffer.from(await out.arrayBuffer());
          res.writeHead(out.status, Object.fromEntries(out.headers));
          res.end(buf);
        } else if (out instanceof Uint8Array) {
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          res.end(Buffer.from(out));
        } else if (typeof out === "string") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(out);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err && err.stack ? err.stack : err) }));
      }
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  return { router, handle };
}

export function startServer(handle, port) {
  const server = http.createServer(handle);
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

/* ---------------- Mock do AI Horde ----------------
   Reproduz o que importa para o spike:
   - POST /v2/generate/async  -> 202 {id, kudos}
   - webhook com timeout de 3 s e 3 tentativas (igual ao _deliver_webhook do Horde real)
   - GET /v2/generate/check/:id e /v2/generate/status/:id
   - expiração: depois de `expireMs`, /status passa a devolver 404
------------------------------------------------------ */
export function startMockHorde({ port, completeAfterMs = 2500, expireMs = 20 * 60 * 1000, imageB64 }) {
  const jobs = new Map();
  const events = [];

  async function deliverWebhook(url, data, jobId) {
    // espelha _deliver_webhook(): 3 tentativas, 3 s de timeout cada
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const ms = Date.now() - t0;
        events.push({ jobId, attempt, outcome: res.ok ? "ok" : "http_error", status: res.status, ms });
        if (res.ok) return true;
      } catch (err) {
        clearTimeout(timer);
        events.push({ jobId, attempt, outcome: "timeout", ms: Date.now() - t0, error: String(err.name || err) });
      }
    }
    events.push({ jobId, attempt: 3, outcome: "giveup" });
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method === "POST" && url.pathname === "/v2/generate/async") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const id = crypto.randomUUID();
      const job = {
        id,
        payload,
        created: Date.now(),
        done: false,
        expired: false,
        generations: [],
        webhookAttempts: [],
      };
      jobs.set(id, job);

      setTimeout(async () => {
        if (job.expired) return;
        const gen = {
          id: crypto.randomUUID(),
          img: imageB64,
          seed: "1234567890",
          model: (payload.models && payload.models[0]) || "Deliberate",
          worker_name: "MockWorker#1",
          state: "ok",
          censored: false,
        };
        job.generations = [gen];
        job.done = true;
        if (payload.webhook) {
          await deliverWebhook(payload.webhook, { ...gen, request: id, kudos: 10.5 }, id);
        }
      }, completeAfterMs);

      if (expireMs > 0) {
        setTimeout(() => {
          job.expired = true;
        }, expireMs);
      }

      return json(202, { id, kudos: 10.5, warnings: [] });
    }

    if (req.method === "GET" && url.pathname.startsWith("/v2/generate/check/")) {
      const id = url.pathname.split("/").pop();
      const job = jobs.get(id);
      if (!job || job.expired) return json(404, { message: "not found" });
      return json(200, {
        finished: job.done ? 1 : 0,
        processing: job.done ? 0 : 1,
        waiting: 0,
        restarted: 0,
        done: job.done,
        faulted: false,
        wait_time: job.done ? 0 : 12,
        queue_position: job.done ? 0 : 2,
        kudos: 10.5,
        is_possible: true,
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/v2/generate/status/")) {
      const id = url.pathname.split("/").pop();
      const job = jobs.get(id);
      if (!job || job.expired) return json(404, { message: "not found" });
      return json(200, { done: job.done, generations: job.generations, shared: false });
    }

    if (req.method === "GET" && url.pathname === "/v2/status/models") {
      return json(200, [
        { name: "Deliberate", count: 12, performance: 100, queued: 0, eta: 1 },
        { name: "SDXL 1.0", count: 4, performance: 80, queued: 3, eta: 20 },
      ]);
    }

    // Controles do spike
    if (req.method === "POST" && url.pathname.startsWith("/__expire/")) {
      const id = url.pathname.split("/").pop();
      const job = jobs.get(id);
      if (job) job.expired = true;
      return json(200, { expired: !!job });
    }
    if (req.method === "GET" && url.pathname === "/__events") {
      return json(200, events);
    }
    if (req.method === "GET" && url.pathname === "/__jobs") {
      return json(
        200,
        [...jobs.values()].map((j) => ({
          id: j.id,
          done: j.done,
          expired: j.expired,
          hasWebhook: !!j.payload.webhook,
          webhook: j.payload.webhook,
        })),
      );
    }

    // Endpoint que simula um servidor "frio" (cold start): dorme antes de responder
    if (req.method === "POST" && url.pathname === "/__slow-webhook") {
      const delay = Number(url.searchParams.get("ms") || 5000);
      await new Promise((r) => setTimeout(r, delay));
      return json(200, { ok: true });
    }

    return json(404, { message: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => resolve({ server, jobs, events }));
  });
}

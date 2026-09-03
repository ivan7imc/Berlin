/* Mock do AI Horde para o spike local.
   Reproduz o que importa:
   - POST /v2/generate/async  -> 202 {id, kudos}
   - webhook com timeout de 3 s e 3 tentativas (igual ao _deliver_webhook real)
   - GET /v2/generate/check/:id e /v2/generate/status/:id
   - r2:true -> gerações trazem URL pré-assinada (servida em /r2/<key>), não base64
   - expiração: depois de expirar, /status e /check devolvem 404 */

import http from "node:http";
import zlib from "node:zlib";

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

/* colorType: 2 = RGB, 6 = RGBA. text: { keyword: valor } vira chunks tEXt. */
export function makePng(w, h, { colorType = 2, text = null, fill = null } = {}) {
  const channels = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;

  const raw = Buffer.alloc(h * (1 + w * channels));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter none
    for (let x = 0; x < w; x++) {
      if (fill) {
        const [r, g, b, a] = fill(x, y);
        raw[o++] = r;
        raw[o++] = g;
        raw[o++] = b;
        if (channels === 4) raw[o++] = a === undefined ? 255 : a;
      } else {
        raw[o++] = (x * 4) & 0xff;
        raw[o++] = (y * 4) & 0xff;
        raw[o++] = ((x + y) * 2) & 0xff;
        if (channels === 4) raw[o++] = 255;
      }
    }
  }

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
  ];
  if (text) {
    for (const [k, v] of Object.entries(text)) {
      parts.push(chunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "utf8")])));
    }
  }
  parts.push(chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/* ---------------- Mock ---------------- */
export function startMockHorde({ port, completeAfterMs = 1200, imageBytes, expireMs = 0 }) {
  const jobs = new Map();
  const r2 = new Map(); // key -> bytes (simula o R2 do Horde)
  const events = [];
  const payloads = [];
  const stats = { modelFetches: 0, r2Fetches: 0, webhookAttempts: 0, submits: 0 };
  const state = { webhook: "ok", completeAfterMs }; // webhook: ok | down

  async function deliverWebhook(url, data, jobId, attemptLabel) {
    const target = state.webhook === "down" ? url.replace(/^(https?:\/\/[^/:]+)(:\d+)?/, "http://127.0.0.1:9") : url;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      stats.webhookAttempts++;
      try {
        const res = await fetch(target, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        events.push({ jobId, attemptLabel, attempt, outcome: res.ok ? "ok" : "http_error", status: res.status, ms: Date.now() - t0 });
        if (res.ok) return true;
      } catch (err) {
        clearTimeout(timer);
        events.push({ jobId, attemptLabel, attempt, outcome: "timeout", error: String(err.name || err), ms: Date.now() - t0 });
      }
    }
    events.push({ jobId, attemptLabel, attempt: 3, outcome: "giveup" });
    return false;
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String((err && err.message) || err) }));
      } catch (_) { /* conexão já fechada */ }
    }
  });

  async function handle(req, res) {
    const url = new URL(req.url, "http://local");
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const bodyBuf = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return Buffer.concat(chunks);
    };

    // ---- API do Horde ----
    if (req.method === "POST" && url.pathname === "/v2/generate/async") {
      const buf = await bodyBuf();
      const payload = JSON.parse(buf.toString() || "{}");
      stats.submits++;
      const id = crypto.randomUUID();
      const job = { id, payload, created: Date.now(), done: false, expired: false, generations: [] };
      jobs.set(id, job);
      payloads.push({
        ...payload,
        source_image: `<${(payload.source_image || "").length} bytes b64>`,
        source_mask: payload.source_mask ? `<${payload.source_mask.length} bytes b64>` : undefined,
        __rawLength: buf.length,
      });

      const n = Math.max(1, Number(payload.params?.n || 1));
      setTimeout(async () => {
        if (job.expired) return;
        for (let i = 0; i < n; i++) {
          const key = `${id}-${i}.png`;
          r2.set(key, imageBytes);
          const gen = {
            id: crypto.randomUUID(),
            // r2:true -> URL pré-assinada; r2:false -> base64 (o plano antigo)
            img: payload.r2 ? `http://127.0.0.1:${port}/r2/${key}` : imageBytes.toString("base64"),
            seed: "1234567890",
            worker_name: "MockWorker#1",
            model: (payload.models && payload.models[0]) || "Deliberate",
            state: "ok",
            censored: false,
          };
          job.generations.push(gen);
          job.done = job.generations.length >= n;
          if (payload.webhook) {
            // o Horde real manda uma geração por chamada de webhook
            await deliverWebhook(payload.webhook, { ...gen, request: id, kudos: 10.5 }, id, `gen${i}`);
          }
        }
      }, state.completeAfterMs);

      if (expireMs > 0) setTimeout(() => { job.expired = true; }, expireMs);
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
      stats.modelFetches++;
      return json(200, [
        { name: "Deliberate", count: 12, performance: 100, queued: 0, eta: 1 },
        { name: "SDXL 1.0", count: 4, performance: 80, queued: 3, eta: 20 },
      ]);
    }

    // ---- "R2 do Horde": URL pré-assinada ----
    if (req.method === "GET" && url.pathname.startsWith("/r2/")) {
      const key = url.pathname.slice(4);
      const bytes = r2.get(key);
      if (!bytes) return json(404, { message: "expired" });
      stats.r2Fetches++;
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(bytes.length) });
      return res.end(bytes);
    }

    // ---- controles do spike ----
    if (req.method === "POST" && url.pathname.startsWith("/__expire/")) {
      const id = url.pathname.split("/").pop();
      const job = jobs.get(id);
      if (job) job.expired = true;
      return json(200, { expired: !!job });
    }
    if (req.method === "POST" && url.pathname === "/__mode") {
      const buf = await bodyBuf();
      const cfg = JSON.parse(buf.toString() || "{}");
      if (cfg.webhook) state.webhook = cfg.webhook;
      if (cfg.completeAfterMs !== undefined) state.completeAfterMs = cfg.completeAfterMs;
      return json(200, { state });
    }
    if (req.method === "GET" && url.pathname === "/__events") return json(200, events);
    if (req.method === "GET" && url.pathname === "/__stats") return json(200, stats);
    if (req.method === "GET" && url.pathname === "/__payloads") return json(200, payloads);
    if (req.method === "GET" && url.pathname === "/__jobs") {
      return json(200, [...jobs.values()].map((j) => ({ id: j.id, done: j.done, expired: j.expired, webhook: j.payload.webhook })));
    }

    return json(404, { message: "not found" });
  }

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, stats, events, payloads }));
  });
}

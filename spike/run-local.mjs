/*
 * Spike LOCAL — roda o worker real (src/worker.js) contra um mock fiel do AI Horde.
 *
 * O que valida sem sair da máquina:
 *   1. submit -> webhook -> captura (caminho primário)
 *   2. webhook perdido por "cold start" (receiver lento > 3 s) -> /tick salva
 *   3. pedido expirado no Horde -> estado "expired" em vez de erro genérico
 *   4. montagem do payload, snap-64, prompt com "###", headers, armazenamento
 *
 * O que NÃO dá para validar aqui (precisa de rede real): latência do Horde de verdade,
 * limites de CPU/requisições do Puter e consumo da conta. Para isso: run-real.mjs
 */

import http from "node:http";
import fs from "node:fs";
import { makePng, createFsBackend, createRouter, startServer, startMockHorde } from "./harness/harness.mjs";

const MOCK_PORT = 8787;
const WORKER_PORT = 8788;
const PROXY_PORT = 8790; // fica na frente do webhook para simular cold start

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ---------------- setup ---------------- */
const STORE_DIR = "/tmp/berlin-spike-store";
fs.rmSync(STORE_DIR, { recursive: true, force: true });

const imageB64 = makePng(64, 64).toString("base64");

let proxyDelayMs = 0;
const proxy = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  if (req.method === "POST" && url.pathname === "/__delay") {
    proxyDelayMs = Number(url.searchParams.get("ms") || 0);
    res.writeHead(200).end(JSON.stringify({ delay: proxyDelayMs }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  // Se o cliente aborta durante a espera (o Horde aborta em 3 s), a requisição
  // nunca chega à aplicação — é isso que acontece num cold start de verdade.
  let aborted = false;
  req.on("aborted", () => {
    aborted = true;
  });
  req.socket.on("close", () => {
    aborted = true;
  });
  if (proxyDelayMs > 0) await new Promise((r) => setTimeout(r, proxyDelayMs));
  if (aborted || req.socket.destroyed || !req.socket.writable) {
    res.destroy();
    return;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${WORKER_PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: body.length ? body : undefined,
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json" });
    res.end(buf);
  } catch (err) {
    res.writeHead(502).end(JSON.stringify({ error: String(err) }));
  }
});
await new Promise((r) => proxy.listen(PROXY_PORT, "0.0.0.0", r));

const mock = await startMockHorde({ port: MOCK_PORT, completeAfterMs: 2500, imageB64 });

// Globals que o worker lê (equivalente às env vars no Puter/Render)
globalThis.HORDE_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
globalThis.WEBHOOK_BASE_URL = `http://127.0.0.1:${PROXY_PORT}`;
globalThis.DEFAULT_MODEL = "Deliberate";
globalThis.SPIKE_MODE = "1";
globalThis.__fsBackend = createFsBackend(STORE_DIR);

const { router, handle } = createRouter();
globalThis.router = router;
await import("./src/worker.js");
await startServer(handle, WORKER_PORT);

const call = async (method, path, body) => {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${WORKER_PORT}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, ms, data };
};

console.log("\n=== Spike local — Berlin × Puter Workers ===\n");

/* ---------------- health ---------------- */
const health = await call("GET", "/api/health");
record("GET /api/health responde", health.status === 200, `${health.status} · store=${health.data?.store} · ${health.ms}ms`);

/* ---------------- TESTE 1: submit -> webhook -> captura ---------------- */
console.log("\n--- Teste 1: caminho feliz (webhook) ---");
const submit = await call("POST", "/api/edits", {
  image_base64: imageB64,
  prompt: "a cyberpunk street at night",
  negative_prompt: "blurry, watermark",
  width: 64,
  height: 64,
  denoising_strength: 0.55,
  steps: 20,
  r2: false,
});
record("POST /api/edits submete", submit.status === 200 && !!submit.data.job_id, `job=${submit.data.job_id} · submit_ms=${submit.data.submit_ms}`);
record("registra webhook no payload", !!submit.data.webhook, String(submit.data.webhook));

const jobId = submit.data.job_id;
let state = null;
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  const s = await call("GET", `/api/edits/${jobId}`);
  state = s.data;
  if (state.state === "done") break;
  await new Promise((r) => setTimeout(r, 400));
}
record("job fica pronto por webhook", state?.state === "done", `em ${Date.now() - t0}ms · capturado_via=${state?.generations?.[0]?.captured_via}`);

const img = await call("GET", `/api/edits/${jobId}/image`);
record("GET .../image serve os bytes", img.status === 200 && img.data.length > 0, `${img.status} · ${img.data.length} bytes`);

const results1 = (await call("GET", "/api/results")).data.jobs[0];
record("webhook trouxe a imagem no corpo", results1.webhook_has_img === true, `capturadas=${results1.webhook_captured} · payload=${results1.webhook_payload_bytes} bytes`);

const events = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__events`)).json();
const firstAttempt = events.find((e) => e.jobId === jobId && e.attempt === 1);
record(
  "webhook respondido dentro dos 3 s do Horde",
  firstAttempt && firstAttempt.outcome === "ok" && firstAttempt.ms < 3000,
  `tentativa 1: ${firstAttempt?.outcome} em ${firstAttempt?.ms}ms`,
);

/* ---------------- TESTE 2: cold start -> /tick salva ---------------- */
console.log("\n--- Teste 2: webhook perdido (receiver com cold start de 5 s) -> vigia ---");
await fetch(`http://127.0.0.1:${PROXY_PORT}/__delay?ms=5000`, { method: "POST" });

const submit2 = await call("POST", "/api/edits", {
  image_base64: imageB64,
  prompt: "same street, now in daylight",
  width: 64,
  height: 64,
});
const jobId2 = submit2.data.job_id;
await new Promise((r) => setTimeout(r, 14000)); // conclusão (2,5 s) + 3 tentativas × 3 s + folga

const events2 = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__events`)).json();
const attempts2 = events2.filter((e) => e.jobId === jobId2);
const gaveUp = attempts2.some((e) => e.outcome === "giveup");
record("Horde desiste após 3 tentativas de 3 s", gaveUp, attempts2.map((e) => `${e.attempt}:${e.outcome}`).join(" "));

const before = (await call("GET", `/api/edits/${jobId2}`)).data;
record("job NÃO foi capturado pelo webhook", before.state !== "done", `estado=${before.state}`);

const tick = await call("POST", "/api/tick");
record("POST /api/tick captura o resultado", tick.data.captured >= 1, JSON.stringify(tick.data));

const after = (await call("GET", `/api/edits/${jobId2}`)).data;
record("agora o job está done (salvo pelo vigia)", after.state === "done", `capturado_via=${after.generations?.[0]?.captured_via}`);

await fetch(`http://127.0.0.1:${PROXY_PORT}/__delay?ms=0`, { method: "POST" });

/* ---------------- TESTE 3: expiração no Horde ---------------- */
console.log("\n--- Teste 3: pedido expirado no Horde ---");
const submit3 = await call("POST", "/api/edits", { image_base64: imageB64, prompt: "expire test", width: 64, height: 64 });
const jobId3 = submit3.data.job_id;
await fetch(`http://127.0.0.1:${MOCK_PORT}/__expire/${jobId3}`, { method: "POST" });
await new Promise((r) => setTimeout(r, 1000));
const expired = (await call("GET", `/api/edits/${jobId3}`)).data;
record("estado 'expired' em vez de erro genérico", expired.state === "expired", String(expired.message));

const tick3 = await call("POST", "/api/tick");
record("vigia marca expirados sem quebrar", tick3.status === 200, `expired=${tick3.data.expired} pendentes=${tick3.data.pending}`);

/* ---------------- TESTE 4: payload e overhead ---------------- */
console.log("\n--- Teste 4: payload e overhead ---");
const payloadCheck = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/__jobs`)).json();
const sentPayload = [...mock.jobs.values()][0].payload;
record("prompt unido com ' ### '", sentPayload.prompt.includes("###"), JSON.stringify(sentPayload.prompt));
record("dimensões snapadas em 64", sentPayload.params.width % 64 === 0 && sentPayload.params.height % 64 === 0, `${sentPayload.params.width}x${sentPayload.params.height}`);
record("source_processing = img2img", sentPayload.source_processing === "img2img", sentPayload.source_processing);
record("denoising_strength enviado", sentPayload.params.denoising_strength === 0.55, String(sentPayload.params.denoising_strength));

const lat = [];
for (let i = 0; i < 50; i++) lat.push((await call("GET", "/api/health")).ms);
lat.sort((a, b) => a - b);
const p50 = lat[Math.floor(lat.length * 0.5)];
const p95 = lat[Math.floor(lat.length * 0.95)];
record("50 requisições sem erro", true, `p50=${p50}ms p95=${p95}ms (worker local, não mede o Puter)`);

/* ---------------- relatório ---------------- */
const passed = results.filter((r) => r.pass).length;
console.log(`\n=== ${passed}/${results.length} verificações passaram ===`);

console.log(`
Pendente (precisa de rede real, rode: node spike/run-real.mjs):
  · latência real do /v2/generate/async do Horde
  · entrega real do webhook pelo Horde (timeout de 3 s do lado deles)
  · limites do Puter (req/dia, CPU por invocação) e consumo da conta
  · /api/tick a cada 1 min por 1 h sem 429/1102
`);

proxy.close();
mock.server.close();
process.exit(passed === results.length ? 0 : 1);

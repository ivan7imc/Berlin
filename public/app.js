/* Berlin — frontend.

   Duas decisões que vêm do limite de CPU do Cloudflare Workers (10 ms por requisição):
   1. os metadados da imagem são lidos AQUI, no navegador — o Worker não precisa
      decodificar nada para pré-preencher o formulário;
   2. o base64 da imagem também é gerado AQUI, e enviado como um campo de arquivo
      opaco, para o Worker nunca precisar parsear megabytes.

   Fora isso, é um app comum: formulário, polling com backoff, preview e download. */

import { inspectImage } from "/shared/metadata.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const SAMPLERS = [
  "k_euler", "k_euler_a", "k_lms", "k_heun", "k_dpm_2", "k_dpm_2_a", "k_dpm_fast",
  "k_dpm_adaptive", "k_dpmpp_2m", "k_dpmpp_2s_a", "k_dpmpp_sde", "k_dpmpp_3m_sde",
  "dpmsolver", "dpmpp_2m_sde", "ddpm", "deis", "ipndm", "res_multistep",
  "gradient_estimation", "heunpp2", "er_sde", "sa_solver", "sa_solver_pece",
  "euler_cfg_pp", "lcm", "DDIM", "uni_pc", "uni_pc_bh2",
];

const state = {
  file: null,        // File da imagem de entrada
  mask: null,        // File da máscara
  jobId: null,
  timer: null,
  pollMs: 4000,
  lastJob: null,
};

/* ---------------- imagem de entrada ---------------- */

const drop = $("#drop");
const fileInput = $("#file");

$("#pick").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => e.target.files[0] && loadFile(e.target.files[0]));
drop.addEventListener("click", (e) => { if (e.target === drop) fileInput.click(); });
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); })
);
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

$("#mask").addEventListener("change", (e) => { state.mask = e.target.files[0] || null; });

async function loadFile(file) {
  state.file = file;
  const url = URL.createObjectURL(file);
  $("#sourceImg").src = url;
  $("#originalImg").src = url;
  $("#source").classList.remove("hidden");

  const info = await inspectImage(new Uint8Array(await file.arrayBuffer()));
  prefill(info);
  showMeta(info);
  saveDraft();
}

/* Pré-preenchimento: dimensões da imagem (com snap em 64), modo (alfa → inpainting)
   e, quando existirem, os parâmetros gravados pela ferramenta que gerou a imagem. */
function prefill(info) {
  const s = info.suggested;
  const set = (name, value) => {
    if (value === null || value === undefined || value === "") return;
    const el = $(`[name="${name}"]`);
    if (!el) return;
    if (el.type === "checkbox") el.checked = !!value;
    else el.value = value;
  };

  if (info.width) { set("width", s.width); set("height", s.height); }
  set("source_processing", s.source_processing);
  set("denoising_strength", s.denoising_strength);
  if (s.prompt) set("prompt", s.prompt);
  if (s.negative_prompt) set("negative_prompt", s.negative_prompt);
  if (s.sampler_name && SAMPLERS.includes(s.sampler_name)) set("sampler_name", s.sampler_name);
  if (s.steps) set("steps", s.steps);
  if (s.cfg_scale) set("cfg_scale", s.cfg_scale);

  toggleMask();
}

function showMeta(info) {
  const bits = [
    `${info.format.toUpperCase()} ${info.width}×${info.height}`,
    info.hasAlpha ? "com canal alfa" : "sem canal alfa",
    info.raw_parameters ? "metadados de geração encontrados" : "sem metadados de geração",
  ];
  const detected = [];
  if (info.suggested.prompt) detected.push("prompt");
  if (info.suggested.sampler_name) detected.push("sampler");
  if (info.raw_parameters) detected.push("steps/CFG/seed");
  if (detected.length) bits.push(`pré-preenchido: ${detected.join(", ")}`);
  $("#meta").innerHTML = `<p>${bits.join(" · ")}</p>`;
}

/* ---------------- formulário ---------------- */

function toggleMask() {
  const mode = $('[name="source_processing"]').value;
  $("#maskRow").classList.toggle("hidden", !["inpainting", "outpainting"].includes(mode));
}
$('[name="source_processing"]').addEventListener("change", toggleMask);

function readParams() {
  const form = $("#form");
  const num = (n) => (form.elements[n].value === "" ? undefined : Number(form.elements[n].value));
  const str = (n) => form.elements[n].value.trim();
  const checked = (n) => !!form.elements[n].checked;

  const params = {
    steps: num("steps"),
    n: num("n"),
    width: num("width"),
    height: num("height"),
    sampler_name: str("sampler_name"),
    scheduler: str("scheduler") || undefined,
    cfg_scale: num("cfg_scale"),
    denoising_strength: num("denoising_strength"),
    clip_skip: num("clip_skip"),
    karras: checked("karras"),
    hires_fix: checked("hires_fix"),
    tiling: checked("tiling"),
    transparent: checked("transparent"),
    post_processing: $$('#postProcessing input:checked').map((i) => i.value),
  };
  if (str("seed")) params.seed = str("seed");
  if (str("hires_fix_denoising_strength")) params.hires_fix_denoising_strength = num("hires_fix_denoising_strength");
  if (str("post_processing_order")) params.post_processing_order = str("post_processing_order");
  if (str("facefixer_strength")) params.facefixer_strength = num("facefixer_strength");

  return {
    prompt: str("prompt"),
    negative_prompt: str("negative_prompt"),
    params,
    models: $$('#models option:selected').map((o) => o.value),
    source_processing: str("source_processing"),
    nsfw: checked("nsfw"),
    censor_nsfw: checked("censor_nsfw"),
    trusted_workers: checked("trusted_workers"),
    validated_backends: checked("validated_backends"),
    slow_workers: checked("slow_workers"),
    extra_slow_workers: checked("extra_slow_workers"),
    worker_blacklist: checked("worker_blacklist"),
    shared: checked("shared"),
    replacement_filter: checked("replacement_filter"),
    allow_downgrade: checked("allow_downgrade"),
    disable_batching: checked("disable_batching"),
    workers: str("workers") ? str("workers").split(",").map((s) => s.trim()).filter(Boolean) : [],
  };
}

/* ---------------- envio ---------------- */

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]); // base64 puro
    reader.onerror = () => reject(new Error("não foi possível ler a imagem"));
    reader.readAsDataURL(file);
  });
}

async function submitEdit({ dryRun = false } = {}) {
  if (!state.file) return showFormError("escolha uma imagem primeiro");
  hideFormError();

  const params = readParams();
  if (params.nsfw && params.censor_nsfw) {
    return showFormError("nsfw e censurar NSFW são incompatíveis — escolha um");
  }

  const form = new FormData();
  form.append("params", JSON.stringify({ ...params, dry_run: dryRun }));
  form.append("image_b64", new Blob([await toBase64(state.file)]), "source.b64");
  if (state.mask) form.append("mask_b64", new Blob([await toBase64(state.mask)]), "mask.b64");

  $("#submit").disabled = true;
  $("#submit").textContent = dryRun ? "Estimando…" : "Enviando…";
  try {
    const res = await fetch("/api/edits", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) return showFormError(data.error || `HTTP ${res.status}`);

    if (dryRun) {
      $("#cost").textContent = `≈ ${data.kudos} kudos (estimativa, não gerou nada)`;
      return;
    }

    $("#cost").textContent = `${data.kudos} kudos`;
    addHistory(data.id, params.prompt);
    watch(data.id);
  } catch (err) {
    showFormError(String(err.message || err));
  } finally {
    $("#submit").disabled = false;
    $("#submit").textContent = "Gerar edição";
  }
}

$("#form").addEventListener("submit", (e) => { e.preventDefault(); submitEdit(); });
$("#estimate").addEventListener("click", () => submitEdit({ dryRun: true }));

/* ---------------- acompanhamento ---------------- */

function watch(id) {
  state.jobId = id;
  state.pollMs = 4000;
  clearTimeout(state.timer);
  $("#resultCard").classList.add("hidden");
  poll();
}

async function poll() {
  if (!state.jobId) return;
  if (document.hidden) {
    state.timer = setTimeout(poll, state.pollMs);
    return;
  }
  try {
    const res = await fetch(`/api/edits/${state.jobId}`);
    const job = res.status === 404
      ? { state: "gone", error: "este job não existe mais (resultados ficam 24 h no servidor)" }
      : await res.json();
    state.lastJob = job;
    renderStatus(job);

    if (job.state === "done" || job.state === "partial") {
      showResult(job);
    }
    if (["done", "expired", "error", "gone"].includes(job.state)) {
      state.timer = null;
      return;
    }
    state.pollMs = Math.min(10000, Math.round(state.pollMs * 1.5)); // backoff até 10 s
  } catch (err) {
    renderStatus({ state: "error", error: String(err.message || err) });
  }
  state.timer = setTimeout(poll, state.pollMs);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.jobId && !state.timer) poll();
});

function renderStatus(job) {
  const el = $("#status");
  const pretty = {
    pending: "Na fila", partial: "Parcial", done: "Pronto",
    expired: "Expirou", error: "Erro", gone: "Não encontrado",
  };
  const q = job.queue || {};
  const rows = [];
  rows.push(`<p><strong>${pretty[job.state] || job.state}</strong> · ${job.n || 0}/${job.expected_n || 1} imagem(ns)</p>`);
  if (job.id) rows.push(`<p class="hint mono">${job.id}</p>`);

  if (q.queue_position) rows.push(`<p>Posição na fila: <strong>${q.queue_position}</strong></p>`);
  if (q.wait_time) rows.push(`<p>Espera estimada: <strong>${q.wait_time}s</strong></p>`);
  if (q.processing) rows.push(`<p>Sendo processada por ${q.processing} worker(s)</p>`);
  if (q.is_possible === false) rows.push(`<p class="warn">Nenhum worker aceita essa combinação agora.</p>`);
  if (job.error) rows.push(`<p class="error">${job.error}</p>`);
  for (const w of job.warnings || []) rows.push(`<p class="warn">${w.message || w}</p>`);

  if (job.state === "pending") {
    rows.push(`<p class="hint">Mesmo que você feche a aba, o servidor continua vigiando este job.</p>`);
  }
  el.innerHTML = rows.join("");
}

/* Com n > 1, cada imagem ganha uma miniatura clicável — senão só a primeira
   seria visível e o resto ficaria inacessível pela interface. */
function renderThumbs(job) {
  const box = $("#thumbs");
  const urls = job.image_urls || [];
  if (!urls.length || urls.length < 2) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.innerHTML = urls
    .map((u, i) => `<img src="${u}&t=${Date.now()}" data-src="${u}" alt="imagem ${i + 1}" title="imagem ${i + 1}">`)
    .join("");
  box.classList.remove("hidden");
  box.querySelectorAll("img").forEach((img) =>
    img.addEventListener("click", () => {
      $("#resultImg").src = img.src;
      $("#download").href = img.getAttribute("data-src");
    })
  );
}

function showResult(job) {
  const url = `/api/edits/${job.id}/image?t=${Date.now()}`;
  $("#resultImg").src = url;
  $("#download").href = url;
  $("#download").download = `berlin-${job.id.slice(0, 8)}.png`;
  $("#resultCard").classList.remove("hidden");

  renderThumbs(job);
  const g = (job.generations || [])[0] || {};
  const bits = [];
  if (g.model) bits.push(`modelo: ${g.model}`);
  if (g.worker_name) bits.push(`worker: ${g.worker_name}`);
  if (g.seed) bits.push(`seed: ${g.seed}`);
  if (g.censored) bits.push("censurada pelo worker");
  if (job.n > 1) bits.push(`${job.n} imagens — use ?index= na URL`);
  $("#genInfo").innerHTML = `<p>${bits.join(" · ") || "pronto"}</p>`;
  $("#resultCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------- ações do resultado ---------------- */

$("#reuse").addEventListener("click", async () => {
  const res = await fetch(`/api/edits/${state.jobId}/image`);
  const blob = await res.blob();
  const file = new File([blob], `berlin-${state.jobId.slice(0, 8)}.png`, { type: "image/png" });
  await loadFile(file);
  window.scrollTo({ top: 0, behavior: "smooth" });
});

$("#again").addEventListener("click", () => { submitEdit(); });

/* ---------------- histórico ---------------- */

const HISTORY_KEY = "berlin.history";

function addHistory(id, prompt) {
  const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  list.unshift({ id, prompt: (prompt || "").slice(0, 120), at: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
  renderHistory();
}

function renderHistory() {
  const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  $("#history").innerHTML = list.length
    ? list.map((j) => `<li><button class="link" data-id="${j.id}">${j.prompt || "(sem prompt)"}</button>
        <span class="hint">${new Date(j.at).toLocaleString()}</span></li>`).join("")
    : `<li class="hint">Nada ainda.</li>`;
  $$("#history button").forEach((b) =>
    b.addEventListener("click", () => watch(b.dataset.id))
  );
}

$("#resume").addEventListener("click", () => {
  const id = $("#resumeId").value.trim();
  if (id) watch(id);
});

function saveDraft() { /* espaço para persistir o rascunho; v1.1 */ }
function showFormError(msg) { $("#formError").textContent = msg; $("#formError").classList.remove("hidden"); }
function hideFormError() { $("#formError").classList.add("hidden"); }

/* ---------------- inicialização ---------------- */

/* Listas de reserva: se o Horde estiver fora, a interface continua utilisável
   (o Worker aplica "Deliberate" quando nenhum modelo é informado). */
const FALLBACK_LIMITS = {
  schedulers: ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform"],
  post_processing: ["GFPGANv1.3", "4x_AnimeSharp", "4xNomos8kSC", "2xModernSpanimationV1"],
  post_processing_order: ["facefixers_first", "upscalers_first"],
};

async function loadJson(path, fallback) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    console.warn(`falhou: ${path}`, err);
    return fallback;
  }
}

async function init() {
  // selects vindos do servidor, para a UI não duplicar listas
  const [limits, models] = await Promise.all([
    loadJson("/api/limits", FALLBACK_LIMITS),
    loadJson("/api/models", { models: [] }),
  ]);

  $("#sampler").innerHTML = SAMPLERS.map((s) => `<option${s === "k_euler" ? " selected" : ""}>${s}</option>`).join("");
  $("#scheduler").innerHTML = `<option value="">(padrão do karras)</option>` +
    limits.schedulers.map((s) => `<option>${s}</option>`).join("");
  $("#ppOrder").innerHTML = `<option value="">(padrão)</option>` +
    limits.post_processing_order.map((s) => `<option>${s}</option>`).join("");
  $("#postProcessing").innerHTML = limits.post_processing
    .map((p) => `<label><input type="checkbox" value="${p}" /> ${p}</label>`).join("");

  const modelList = (models.models || []).filter((m) => m.name);
  $("#models").innerHTML = modelList.length
    ? modelList
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, 60)
        .map((m) => `<option${m.name === "Deliberate" ? " selected" : ""}>${m.name}</option>`)
        .join("")
    : `<option selected>Deliberate</option>`;
  $("#modelsHint").textContent = modelList.length
    ? ""
    : "não foi possível carregar a lista de modelos — o envio usará “Deliberate”";

  $("#apiDocs").textContent = [
    "POST /api/edits            multipart: params=<json>, image_b64=<base64>, mask_b64?  → 202 {id}",
    "GET  /api/edits/:id        estado do job + posição na fila",
    "GET  /api/edits/:id/image  ← entrega a imagem gerada (?index=0)",
    "DELETE /api/edits/:id      cancela no Horde",
    "POST /api/inspect          multipart: image → metadados + sugestões",
    "GET  /api/models           modelos ativos (cache 5 min)",
    "GET  /api/limits           listas e faixas aceitas",
    "GET  /api/results          últimos jobs",
    "POST /api/tick             força o vigia (o Cron Trigger já faz a cada minuto)",
  ].join("\n");

  const health = await fetch("/api/health").then((r) => r.json()).catch(() => null);
  $("#health").textContent = health ? `API ok · Horde: ${health.horde}` : "API indisponível";

  renderHistory();
}

init();

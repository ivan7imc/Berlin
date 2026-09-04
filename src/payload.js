/* Montagem e validação do payload do AI Horde (POST /v2/generate/async).

   Regra de ouro do Workers: o base64 da imagem de entrada NUNCA vira string JS.
   Ele chega como bytes opacos (Blob do multipart) e sai colado no corpo do JSON por
   concatenação — sem JSON.parse, sem atob, sem btoa.
   Motivo: num corpo de 5 MB, request.json() custa ~16 ms de CPU; a concatenação,
   ~2 ms. O limite do plano Free é 10 ms. */

export const snap64 = (v) => Math.max(64, Math.min(3072, Math.round(v / 64) * 64));

const SOURCE_PROCESSING = ["txt2img", "img2img", "inpainting", "outpainting", "remix"];
const SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta", "linear_quadratic", "kl_optimal", "align_your_steps", "gits"];
const POST_PROCESSING = [
  "GFPGANv1.3", "CodeFormers",
  "4x_AnimeSharp", "4xNomos8kSC", "4xLSDIRplus", "4xNomosWebPhoto_RealPLKSR",
  "4xNomos2_realplksr_dysample", "4xNomos2_hq_dat2", "2xModernSpanimationV1",
  "strip_background",
];
const POST_PROCESSING_ORDER = ["facefixers_first", "upscalers_first"];

/* Converte o que vem do formulário no payload final. Lança erro com mensagem
   legível se alguma faixa for violada. */
export function buildPayload(p = {}, opts = {}) {
  const params = p.params || {};

  const width = clampInt(snap64(params.width ?? 512), 64, 3072, "width");
  const height = clampInt(snap64(params.height ?? 512), 64, 3072, "height");

  if (p.nsfw && p.censor_nsfw) {
    throw new Error("nsfw e censor_nsfw são incompatíveis: escolha um dos dois");
  }
  const sourceProcessing = SOURCE_PROCESSING.includes(p.source_processing)
    ? p.source_processing
    : "img2img";

  const prompt = [String(p.prompt || "").trim(), String(p.negative_prompt || "").trim()]
    .filter(Boolean)
    .join(" ### ");

  const payload = {
    prompt,
    params: {
      steps: clampInt(params.steps ?? 25, 1, 500, "steps"),
      n: clampInt(params.n ?? 1, 1, 20, "n"),
      width,
      height,
      sampler_name: params.sampler_name || "k_euler",
      cfg_scale: clampNum(params.cfg_scale ?? 7.5, 0, 100, "cfg_scale"),
      denoising_strength: clampNum(params.denoising_strength ?? 0.55, 0.01, 1, "denoising_strength"),
      clip_skip: clampInt(params.clip_skip ?? 1, 1, 12, "clip_skip"),
      karras: bool(params.karras, true),
      hires_fix: bool(params.hires_fix, false),
      tiling: bool(params.tiling, false),
      transparent: bool(params.transparent, false),
      post_processing: pickList(params.post_processing, POST_PROCESSING, "post_processing"),
    },
    models: Array.isArray(p.models) && p.models.length ? p.models : ["Deliberate"],
    source_processing: sourceProcessing,
    nsfw: bool(p.nsfw, false),
    censor_nsfw: bool(p.censor_nsfw, true),
    trusted_workers: bool(p.trusted_workers, false),
    validated_backends: bool(p.validated_backends, false),
    slow_workers: bool(p.slow_workers, true),
    extra_slow_workers: bool(p.extra_slow_workers, false),
    worker_blacklist: bool(p.worker_blacklist, false),
    workers: Array.isArray(p.workers) ? p.workers : [],
    shared: bool(p.shared, false),
    replacement_filter: bool(p.replacement_filter, true),
    dry_run: bool(p.dry_run, false),
    allow_downgrade: bool(p.allow_downgrade, false),
    disable_batching: bool(p.disable_batching, false),
    // r2:true é obrigatório aqui: com false, a imagem voltaria em base64 dentro do
    // JSON do webhook e o parse de megabytes estouraria o CPU do plano Free.
    r2: true,
    webhook: opts.webhook,
    client_agent: opts.clientAgent || "berlin/0.1",
  };

  // opcionais: só entram no JSON se forem informados
  if (params.scheduler && SCHEDULERS.includes(params.scheduler)) payload.params.scheduler = params.scheduler;
  if (params.seed !== undefined && params.seed !== null && String(params.seed) !== "") {
    payload.params.seed = String(params.seed);
  }
  if (params.hires_fix && params.hires_fix_denoising_strength != null) {
    payload.params.hires_fix_denoising_strength = clampNum(params.hires_fix_denoising_strength, 0.01, 1, "hires_fix_denoising_strength");
  }
  if (params.post_processing_order && POST_PROCESSING_ORDER.includes(params.post_processing_order)) {
    payload.params.post_processing_order = params.post_processing_order;
  }
  if (params.facefixer_strength != null) {
    payload.params.facefixer_strength = clampNum(params.facefixer_strength, 0, 1, "facefixer_strength");
  }
  if (params.use_nsfw_censor != null) payload.params.use_nsfw_censor = bool(params.use_nsfw_censor, false);
  if (p.style) payload.style = String(p.style);
  if (p.proxied_account) payload.proxied_account = String(p.proxied_account);

  return payload;
}

/* Corpo final: [prefixo, bytes da imagem, sufixo] — zero parse, zero cópia em string.
   O placeholder fica ENTRE as aspas do JSON, então só o token é substituído.
   
   NOTA: Esta função não é mais usada. Agora enviamos via FormData para o AI Horde.
 */
export function buildBody(payload, imagePart, maskPart) {
  const enc = new TextEncoder();
  let rest = JSON.stringify(payload);
  const parts = [];
  const subs = [["__SOURCE_IMAGE__", imagePart]];
  if (maskPart) subs.push(["__SOURCE_MASK__", maskPart]);

  for (const [token, blob] of subs) {
    if (!blob) continue;
    const idx = rest.indexOf(token);
    if (idx === -1) throw new Error(`placeholder ${token} ausente no payload`);
    parts.push(enc.encode(rest.slice(0, idx)), blob);
    rest = rest.slice(idx + token.length);
  }
  parts.push(enc.encode(rest));
  return new Blob(parts);
}

export const LIMITS = { SOURCE_PROCESSING, SCHEDULERS, POST_PROCESSING, POST_PROCESSING_ORDER };

/* ---------------- validação ---------------- */

function clampInt(v, min, max, field) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new Error(`${field}: esperado número, veio ${JSON.stringify(v)}`);
  if (n < min || n > max) throw new Error(`${field}: ${n} fora da faixa ${min}–${max}`);
  return n;
}
function clampNum(v, min, max, field) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field}: esperado número, veio ${JSON.stringify(v)}`);
  if (n < min || n > max) throw new Error(`${field}: ${n} fora da faixa ${min}–${max}`);
  return n;
}
function bool(v, d) {
  if (v === undefined || v === null || v === "") return d;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === 1;
}
function pickList(v, allowed, field) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(",");
  const bad = list.filter((x) => !allowed.includes(x));
  if (bad.length) throw new Error(`${field}: valor(es) inválido(s): ${bad.join(", ")}`);
  return list;
}

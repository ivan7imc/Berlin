/* Montagem do payload do AI Horde (§3 do PLANO.md).

   Regra de ouro do Workers: o base64 da imagem de entrada NUNCA vira string JS.
   Ele entra como bytes opacos (Blob vindo do multipart) e sai colado no corpo do
   JSON por concatenação — sem JSON.parse, sem atob, sem btoa. É isso que mantém a
   rota de submissão dentro dos 10 ms de CPU do plano Free. */

export const snap64 = (v) => Math.max(64, Math.min(2048, Math.round(v / 64) * 64));

const PLACEHOLDER = "__SOURCE_IMAGE__";

export function buildPayload(p, opts = {}) {
  const width = snap64(p.width || 512);
  const height = snap64(p.height || 512);

  const payload = {
    // prompt: string única; múltiplas linhas são unidas com " ### " (§3 do PLANO)
    prompt: Array.isArray(p.prompt) ? p.prompt.join(" ### ") : (p.prompt || ""),
    params: {
      sampler_name: p.sampler_name || "k_euler_a",
      cfg_scale: num(p.cfg_scale, 7),
      denoising_strength: num(p.denoising_strength, 0.55),
      seed: p.seed ?? null,
      height,
      width,
      post_processing: p.post_processing || [],
      steps: num(p.steps, 25),
      karras: bool(p.karras, true),
      hires_fix: bool(p.hires_fix, false),
      clip_skip: num(p.clip_skip, 1),
      tiling: bool(p.tiling, false),
      n: num(p.n, 1),
    },
    nsfw: bool(p.nsfw, false),
    censor_nsfw: bool(p.censor_nsfw, true),
    trusted_workers: bool(p.trusted_workers, false),
    slow_workers: bool(p.slow_workers, true),
    extra_slow_workers: bool(p.extra_slow_workers, false),
    worker_blacklist: bool(p.worker_blacklist, false),
    workers: p.workers || [],
    models: p.models && p.models.length ? p.models : ["Deliberate"],
    source_image: PLACEHOLDER,
    source_processing: p.source_processing || "img2img",
    // true é obrigatório aqui: com false o Horde devolve a imagem em base64 dentro
    // do JSON do webhook e o parse de megabytes estoura o CPU do Free.
    r2: true,
    shared: false,
    replacement_filter: bool(p.replacement_filter, true),
    dry_run: bool(p.dry_run, false),
    webhook: opts.webhook,
    client_agent: opts.clientAgent || "berlin/0.1",
  };

  if (p.source_mask) payload.source_mask = "__SOURCE_MASK__";
  return payload;
}

/* Corpo final: [prefixo, bytes da imagem, sufixo] — zero parse, zero cópia em string.
   O placeholder fica ENTRE as aspas do JSON ("source_image":"__SOURCE_IMAGE__"), então
   só o token é substituído e as aspas permanecem no lugar. */
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

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d) {
  return typeof v === "boolean" ? v : d;
}

export const EXPECTED_N = (p) => num(p.n, 1);

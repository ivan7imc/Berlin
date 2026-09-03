/* Leitura de metadados da imagem — o mesmo arquivo roda no navegador (pré-preenchimento
   instantâneo, sem upload) e no Worker (POST /api/inspect, como fallback).

   Só lê cabeçalho e chunks de texto: nada de decodificar pixels. Isso importa no
   Workers, onde o limite é 128 MB de memória, e também no navegador, onde evita
   travar a thread principal com uma imagem grande. */

const dec = new TextDecoder("utf-8");

export const snap64 = (v) => Math.max(64, Math.min(3072, Math.round(v / 64) * 64));

export function detectFormat(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 12 && dec.decode(b.subarray(0, 4)) === "RIFF" && dec.decode(b.subarray(8, 12)) === "WEBP") return "webp";
  return "unknown";
}

export async function inspectImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const format = detectFormat(b);
  const info = { format, width: 0, height: 0, hasAlpha: false, text: {} };

  if (format === "png") await readPng(b, info);
  else if (format === "jpeg") readJpeg(b, info);
  else if (format === "webp") readWebp(b, info);

  const params = info.text.parameters || info.text.Parameters || info.text.Comment || info.text.Description || "";
  const parsed = parseA1111(params);

  return {
    format: info.format,
    width: info.width,
    height: info.height,
    hasAlpha: info.hasAlpha,
    raw_parameters: params || null,
    parsed,
    suggested: suggest(info, parsed),
  };
}

/* Regras de pré-preenchimento: dimensões da imagem (snap em 64), inpainting quando
   há canal alfa, e os parâmetros encontrados nos metadados quando existirem. */
export function suggest(info, parsed = {}) {
  const width = snap64(info.width || 512);
  const height = snap64(info.height || 512);
  return {
    width,
    height,
    source_processing: info.hasAlpha ? "inpainting" : "img2img",
    denoising_strength: num(parsed.denoising_strength, 0.55),
    steps: num(parsed.steps, 25),
    cfg_scale: num(parsed.cfg_scale, 7.5),
    sampler_name: parsed.sampler || null,
    seed: parsed.seed || null,
    prompt: parsed.prompt || null,
    negative_prompt: parsed.negative_prompt || null,
  };
}

/* ---------------- PNG ---------------- */

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b, o) => (b[o] << 8) | b[o + 1];

async function readPng(b, info) {
  let off = 8;
  let sawTRNS = false;
  while (off + 8 <= b.length) {
    const len = u32(b, off);
    const type = dec.decode(b.subarray(off + 4, off + 8));
    const data = b.subarray(off + 8, off + 8 + len);
    off += 12 + len;

    if (type === "IHDR" && data.length >= 13) {
      info.width = u32(data, 0);
      info.height = u32(data, 4);
      info.colorType = data[9];
      info.hasAlpha = data[9] === 6 || data[9] === 4; // RGBA ou cinza+alfa
      info.palette = data[9] === 3;
    } else if (type === "tRNS") {
      sawTRNS = true;
    } else if (type === "tEXt") {
      const z = data.indexOf(0);
      if (z > 0) info.text[dec.decode(data.subarray(0, z))] = dec.decode(data.subarray(z + 1));
    } else if (type === "zTXt") {
      const z = data.indexOf(0);
      if (z > 0) {
        const keyword = dec.decode(data.subarray(0, z));
        try {
          const stream = new Blob([data.subarray(z + 2)]).stream().pipeThrough(new DecompressionStream("deflate"));
          info.text[keyword] = dec.decode(new Uint8Array(await new Response(stream).arrayBuffer()));
        } catch (_) {
          /* zTXt ilegível: ignorar */
        }
      }
    } else if (type === "IEND") break;
  }
  if (info.palette && sawTRNS) info.hasAlpha = true;
}

function readJpeg(b, info) {
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) { off++; continue; }
    const marker = b[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = u16(b, off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      info.height = u16(b, off + 5);
      info.width = u16(b, off + 7);
    }
    if (marker === 0xda) break; // dimensões já lidas
    off += 2 + len;
  }
  info.hasAlpha = false;
}

function readWebp(b, info) {
  const fourcc = dec.decode(b.subarray(12, 16));
  if (fourcc === "VP8X") {
    info.width = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    info.height = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    info.hasAlpha = (b[20] & 0x10) !== 0;
  } else if (fourcc === "VP8 ") {
    info.width = u16(b, 26) & 0x3fff;
    info.height = u16(b, 28) & 0x3fff;
  } else if (fourcc === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    info.width = (bits & 0x3fff) + 1;
    info.height = ((bits >> 14) & 0x3fff) + 1;
    info.hasAlpha = ((bits >> 28) & 0x1) === 1;
  }
}

/* Texto do Automatic1111 / ComfyUI:
   linha 1 = prompt; "Negative prompt: ..."; por fim "Steps: 30, Sampler: ..., ..." */
export function parseA1111(text) {
  const out = {};
  if (!text) return out;
  const lines = String(text).split("\n");
  out.prompt = (lines[0] || "").trim();
  const rest = lines.slice(1).join("\n");

  const neg = rest.match(/Negative prompt:\s*([\s\S]*?)(?:\n\s*Steps:|$)/);
  if (neg) out.negative_prompt = neg[1].trim();

  const tail = rest.match(/(Steps:[\s\S]*)$/);
  if (tail) {
    for (const kv of tail[1].split(",")) {
      const idx = kv.indexOf(":");
      if (idx === -1) continue;
      const k = kv.slice(0, idx).trim().toLowerCase().replace(/\s+/g, "_");
      const v = kv.slice(idx + 1).trim();
      if (k && v) out[k] = v;
    }
  }
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

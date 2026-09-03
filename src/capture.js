/* Captura das gerações — usada tanto pelo webhook quanto pelo tick().
   Compartilhar a mesma função é o que faz as duas redes de segurança se
   comportarem igual, inclusive com n > 1 (o estado passa por "partial"). */

import { fetchGenerationBytes } from "./horde.js";
import { putImage, imageKey } from "./images.js";
import * as store from "./store.js";

/* O Horde manda uma geração por vez no webhook (get_details() + request/id/kudos);
   o /status manda um array. Aceitamos os dois. */
export function extractGenerations(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.generations)) return payload.generations;
  if (payload.img || payload.url) return [payload];
  return [];
}

const meta = (gen) => ({
  id: gen.id || null,
  seed: gen.seed ?? null,
  worker_name: gen.worker_name || gen.worker_id || null,
  model: gen.model || null,
  censored: !!gen.censored,
  state: gen.state || "ok",
});

export async function capture(env, job, payload, ttlSeconds) {
  const generations = extractGenerations(payload);
  if (!generations.length) return { captured: 0 };

  const now = Date.now();
  const existing = safeJson(job.generations, []);
  let stored = 0;

  for (const gen of generations) {
    if (!gen || (!gen.img && !gen.url)) continue;

    // r2:true → URL pré-assinada; r2:false → base64 (só como fallback)
    const source = gen.img || gen.url;
    const bytes = /^https?:\/\//.test(source)
      ? await fetchGenerationBytes(source)
      : base64ToBytes(source);

    await putImage(env, imageKey(job.id, job.n + stored), bytes, ttlSeconds);
    existing.push(meta(gen));
    stored++;
  }

  if (!stored) return { captured: 0 };

  const n = job.n + stored;
  const state = n >= job.expected_n ? "done" : "partial";
  await store.setCaptured(env, { id: job.id, n, state, generations: existing, now });

  return { captured: stored, n, state };
}

function base64ToBytes(b64) {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function safeJson(s, fallback = null) {
  try {
    return JSON.parse(s || "null") ?? fallback;
  } catch (_) {
    return fallback;
  }
}

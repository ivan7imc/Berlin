/* Captura das gerações — usada tanto pelo webhook quanto pelo tick().
   Compartilhar a mesma função é o que garante que as duas redes de segurança
   se comportem igual (inclusive no caso n > 1, em que o estado fica "partial"). */

import { fetchGenerationBytes } from "./horde.js";
import { putImage, imageKey } from "./images.js";
import * as store from "./store.js";

/* O Horde manda uma geração por vez no webhook (get_details() + id/request/kudos),
   e um array em /status. Aceitamos os dois. */
export function extractGenerations(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.generations)) return payload.generations;
  if (payload.img) return [payload];
  return [];
}

export async function capture(env, job, payload, ttlSeconds) {
  const generations = extractGenerations(payload);
  if (!generations.length) return { captured: 0 };

  const now = Date.now();
  let stored = 0;

  for (let i = 0; i < generations.length; i++) {
    const gen = generations[i];
    if (!gen || (!gen.img && !gen.url)) continue;

    // r2:true -> URL pré-assinada; r2:false -> base64 (só usado como fallback)
    const bytes = gen.img && /^https?:\/\//.test(gen.img)
      ? await fetchGenerationBytes(gen.img)
      : base64ToBytes(gen.img);

    await putImage(env, imageKey(job.id, job.n + stored), bytes, ttlSeconds);
    stored++;
  }

  if (!stored) return { captured: 0 };

  const n = job.n + stored;
  const state = n >= job.expected_n ? "done" : "partial";

  await store.setCaptured(env, {
    id: job.id,
    n,
    state,
    payloadJson: JSON.stringify(payload).slice(0, 12000),
    now,
  });

  return { captured: stored, n, state };
}

function base64ToBytes(b64) {
  if (!b64) return new ArrayBuffer(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

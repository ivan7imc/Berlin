/* O vigia. Roda a cada minuto pelo Cron Trigger, e também sob demanda pelo
   POST /api/tick (pulso do navegador ou teste).
   Orçamento: 10 ms de CPU por disparo no plano Free — por isso tudo aqui é
   rede (não conta como CPU) e parse de JSON pequeno (r2:true). */

import * as store from "./store.js";
import { check, status } from "./horde.js";
import { capture } from "./capture.js";
import { deleteImage, imageKey } from "./images.js";

const POLL_FAST_MS = 4_000;   // enquanto é novo, sonda mais perto
const POLL_SLOW_MS = 10_000;  // depois, backoff
const EXPIRY_MS = 20 * 60 * 1000;
const EXPIRY_SLOW_MS = 60 * 60 * 1000; // extra_slow_workers

const ttlSeconds = (env) => Math.max(60, Number(env.RESULT_TTL_HOURS || 24) * 3600);

export async function tick(env, { limit = 10 } = {}) {
  const now = Date.now();
  const jobs = await store.listDue(env, now, limit);
  const out = { due: jobs.length, captured: 0, expired: 0, rescheduled: 0, errors: 0, cleaned: 0 };

  for (const job of jobs) {
    try {
      const params = safeJson(job.params);
      const ttl = params.extra_slow_workers ? EXPIRY_SLOW_MS : EXPIRY_MS;

      // 1) expiração por tempo — o Horde esquece o request em 20 (ou 60) minutos
      if (now - job.created_at > ttl) {
        await store.setExpired(env, job.id, `o Horde expirou este request após ${Math.round(ttl / 60000)} min`, now);
        out.expired++;
        continue;
      }

      // 2) /check é barato (10/s): só para saber se terminou
      const chk = await check(env, job.horde_id);
      if (chk.status === 404) {
        await store.setExpired(env, job.id, "o Horde não conhece mais este request (404)", Date.now());
        out.expired++;
        continue;
      }
      if (chk.status >= 500) {
        await store.reschedule(env, { id: job.id, nextPollAt: now + POLL_FAST_MS, now: Date.now() });
        out.rescheduled++;
        continue;
      }
      if (!chk.json || !chk.json.done) {
        const interval = now - job.created_at < 60_000 ? POLL_FAST_MS : POLL_SLOW_MS;
        const jitter = 0.8 + Math.random() * 0.4; // ±20%: evita sincronia entre jobs
        await store.reschedule(env, { id: job.id, nextPollAt: now + Math.round(interval * jitter), now: Date.now() });
        out.rescheduled++;
        continue;
      }

      // 3) terminou: /status traz as gerações (URLs pré-assinadas, porque r2:true)
      const st = await status(env, job.horde_id);
      if (st.status === 404) {
        await store.setExpired(env, job.id, "o Horde não conhece mais este request (404)", Date.now());
        out.expired++;
        continue;
      }

      const res = await capture(env, job, st.json, ttlSeconds(env));
      if (res.captured) {
        out.captured += res.captured;
      } else {
        await store.reschedule(env, { id: job.id, nextPollAt: now + POLL_SLOW_MS, now: Date.now() });
        out.rescheduled++;
      }
    } catch (err) {
      await store.setError(env, job.id, String((err && err.message) || err), Date.now());
      out.errors++;
    }
  }

  // 4) limpeza: apaga jobs resolvidos fora do TTL e as imagens correspondentes
  const stale = await store.deleteStale(env, now, Number(env.RESULT_TTL_HOURS || 24) * 3600_000);
  for (const id of stale) {
    for (let i = 0; i < 8; i++) {
      const key = imageKey(id, i);
      const exists = await env.IMAGES.get(key);
      if (!exists) break;
      await deleteImage(env, key);
    }
  }
  out.cleaned = stale.length;

  return out;
}

function safeJson(s) {
  try {
    return JSON.parse(s || "{}");
  } catch (_) {
    return {};
  }
}

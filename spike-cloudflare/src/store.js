/* Jobs no D1. Sem ORM, sem mágica: prepared statements com bind. */

export async function createJob(env, { id, hordeId, expectedN, params, now, nextPollAt }) {
  await env.DB.prepare(
    `INSERT INTO jobs (id, horde_id, state, expected_n, n, params, created_at, updated_at, next_poll_at)
     VALUES (?, ?, 'pending', ?, 0, ?, ?, ?, ?)`
  )
    .bind(id, hordeId, expectedN, params, now, now, nextPollAt)
    .run();
}

export async function getJob(env, id) {
  return env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(id).first();
}

export async function setHordeId(env, id, hordeId, now) {
  await env.DB.prepare(`UPDATE jobs SET horde_id = ?, updated_at = ? WHERE id = ?`)
    .bind(hordeId, now, id)
    .run();
}

export async function setError(env, id, message, now) {
  await env.DB.prepare(
    `UPDATE jobs SET state = 'error', error = ?, updated_at = ? WHERE id = ?`
  )
    .bind(message, now, id)
    .run();
}

export async function setExpired(env, id, message, now) {
  await env.DB.prepare(
    `UPDATE jobs SET state = 'expired', error = ?, updated_at = ? WHERE id = ?`
  )
    .bind(message, now, id)
    .run();
}

export async function setCaptured(env, { id, n, state, payloadJson, now }) {
  await env.DB.prepare(
    `UPDATE jobs SET n = ?, state = ?, payload_json = ?, error = NULL, updated_at = ? WHERE id = ?`
  )
    .bind(n, state, payloadJson, now, id)
    .run();
}

export async function reschedule(env, { id, nextPollAt, now }) {
  await env.DB.prepare(`UPDATE jobs SET next_poll_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nextPollAt, now, id)
    .run();
}

/* Só os jobs que já passaram da hora de serem sondados — o índice (state, next_poll_at)
   faz esta query custar poucas linhas lidas. */
export async function listDue(env, now, limit = 10) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs
      WHERE state IN ('pending','partial') AND next_poll_at <= ?
      ORDER BY next_poll_at ASC LIMIT ?`
  )
    .bind(now, limit)
    .all();
  return results || [];
}

export async function listRecent(env, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT id, horde_id, state, n, expected_n, created_at, updated_at
       FROM jobs ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return results || [];
}

/* Limpeza: apaga o que já foi resolvido há mais de RESULT_TTL_HOURS e devolve os ids
   para o chamador remover as imagens correspondentes. */
export async function deleteStale(env, now, ttlMs) {
  const cutoff = now - ttlMs;
  const { results } = await env.DB.prepare(
    `SELECT id FROM jobs
      WHERE state IN ('done','expired','error') AND updated_at < ?`
  )
    .bind(cutoff)
    .all();
  const ids = (results || []).map((r) => r.id);
  for (const id of ids) {
    await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(id).run();
  }
  return ids;
}

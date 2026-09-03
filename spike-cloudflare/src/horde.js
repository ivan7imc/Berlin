/* Cliente do AI Horde. Tudo é fetch(); espera de rede não consome CPU. */

const DEFAULT_BASE = "https://aihorde.net/api";

const base = (env) => String(env.HORDE_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");

function headers(env, extra = {}) {
  const h = {
    "Content-Type": "application/json",
    "Client-Agent": env.CLIENT_AGENT || "berlin/0.1",
    ...extra,
  };
  if (env.HORDE_API_KEY) h["apikey"] = env.HORDE_API_KEY;
  return h;
}

async function asJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { message: text };
  }
}

export async function submit(env, body) {
  const res = await fetch(`${base(env)}/v2/generate/async`, {
    method: "POST",
    headers: headers(env),
    body,
  });
  return { status: res.status, json: await asJson(res) };
}

export async function check(env, hordeId) {
  const res = await fetch(`${base(env)}/v2/generate/check/${hordeId}`, {
    headers: headers(env),
  });
  return { status: res.status, json: await asJson(res) };
}

export async function status(env, hordeId) {
  const res = await fetch(`${base(env)}/v2/generate/status/${hordeId}`, {
    headers: headers(env),
  });
  return { status: res.status, json: await asJson(res) };
}

export async function listModels(env) {
  const res = await fetch(`${base(env)}/v2/status/models`, { headers: headers(env) });
  return { status: res.status, json: await asJson(res) };
}

export async function cancel(env, hordeId) {
  const res = await fetch(`${base(env)}/v2/generate/status/${hordeId}`, {
    method: "DELETE",
    headers: headers(env),
  });
  return { status: res.status, json: await asJson(res) };
}

/* Com r2:true a geração traz uma URL pré-assinada (válida ~30 min) em vez do base64. */
export async function fetchGenerationBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download da geração falhou: HTTP ${res.status}`);
  return res.arrayBuffer();
}

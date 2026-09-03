/* Armazenamento das imagens geradas.

   v1: KV — não pede cartão (R2 pede "checkout flow"), 25 MiB por valor,
       1.000 escritas/dia no Free, o que sobra para uso pessoal.
   v1.1: R2 — 10 GB-mês, egress grátis e stream de verdade.

   Só este arquivo muda na troca; o resto do Worker nem sabe. */

export const imageKey = (jobId, index = 0) => `img:${jobId}:${index}`;

export async function putImage(env, key, bytes, ttlSeconds = 86400) {
  await env.IMAGES.put(key, bytes, { expirationTtl: Math.max(60, Math.round(ttlSeconds)) });
}

export async function getImage(env, key) {
  return env.IMAGES.get(key, { type: "arrayBuffer" });
}

export async function deleteImage(env, key) {
  await env.IMAGES.delete(key);
}

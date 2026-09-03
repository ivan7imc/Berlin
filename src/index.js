import { router } from "./router.js";
import { tick } from "./tick.js";

export default {
  // Rotas HTTP: API + frontend (static assets).
  async fetch(request, env, ctx) {
    return router(request, env, ctx);
  },

  // Cron Trigger — o vigia. Mesma função exposta em POST /api/tick.
  // É o que garante que um resultado não se perca quando o webhook falha.
  async scheduled(controller, env, ctx) {
    const result = await tick(env, { limit: 10 });
    console.log(JSON.stringify({ cron: true, ...result }));
  },
};

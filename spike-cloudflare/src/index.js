import { router } from "./router.js";
import { tick } from "./tick.js";

export default {
  async fetch(request, env, ctx) {
    return router(request, env, ctx);
  },

  // Cron Trigger: o vigia. Mesma função exposta em POST /api/tick.
  async scheduled(controller, env, ctx) {
    const result = await tick(env, { limit: 10 });
    console.log(JSON.stringify({ cron: true, ...result }));
  },
};

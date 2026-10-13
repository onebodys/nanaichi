import { app } from "./app.ts";

export { UserDO } from "./user-do.ts";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

import { createMiddleware } from "hono/factory";
import type { AppBindings } from "../env";
import { verifySharedSecret } from "../lib/crypto";
import { HttpError } from "../lib/errors";

/** Requires `Authorization: Bearer <WEBHOOK_SECRET>` or `X-Webhook-Secret: <WEBHOOK_SECRET>`. */
export const requireSharedSecret = createMiddleware<AppBindings>(async (c, next) => {
  if (!c.env.WEBHOOK_SECRET) throw new HttpError(503, "WEBHOOK_SECRET is not configured");
  if (!verifySharedSecret(c.env.WEBHOOK_SECRET, c.req.raw.headers)) throw new HttpError(401, "Unauthorized");
  await next();
});

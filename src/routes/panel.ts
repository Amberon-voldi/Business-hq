import { Hono } from "hono";
import type { AppBindings } from "../env";
import hqCli from "../cli/hq.py";
import panelHtml from "../panel/panel.html";

export const panelRoutes = new Hono<AppBindings>();

panelRoutes.get("/", (c) => c.redirect("/panel", 302));

/**
 * The management panel. The page itself holds no data or secrets: it asks for
 * WEBHOOK_SECRET in the browser and calls the authenticated JSON APIs.
 */
panelRoutes.get("/panel", (c) => {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  return c.html(panelHtml.replaceAll("__NONCE__", nonce), 200, {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "img-src data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
});

/** The hq CLI for agents with their own computer. No secrets inside; the key is set with `hq setup`. */
panelRoutes.get("/agent/hq", (c) =>
  c.body(hqCli, 200, {
    "content-type": "text/x-python; charset=utf-8",
    "content-disposition": 'inline; filename="hq"',
    "cache-control": "no-cache",
  }),
);

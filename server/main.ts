import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { watchConfig } from "./config.ts";
import { createConsent } from "./consent.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { parseProducts } from "./products.ts";
import { createSync } from "./sync.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.CONSENT_DB ?? "/data/consent.db";
const configPath = process.env.CONSENT_CONFIG?.trim() || "/config/consent.yaml";
const rateLimit = Number(process.env.CONSENT_RATE_LIMIT ?? 1200);
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const bannerFile = new URL("../dist/banner/c.js", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.CONSENT_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.CONSENT_METRICS_PORT ? Number(process.env.CONSENT_METRICS_PORT) : undefined;

if (!Number.isInteger(rateLimit) || rateLimit < 1) throw new Error("CONSENT_RATE_LIMIT must be requests per minute, 1 or more");

const db = openDb(dbPath);
// The address people open Consent at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects, the banner
// on the sites and the preference links use it.
const publicUrl = (process.env.CONSENT_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.CONSENT_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "consent",
  productName: "OpenAsy Consent",
  origin: publicUrl,
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.CONSENT_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "CONSENT_"),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
let file: ReturnType<typeof watchConfig> | undefined;
const consent = createConsent(db, { rateLimit, fileState: () => file?.state ?? null });
const sync = createSync(db, consent);
// Purposes, sites and İYS come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config) => consent.setConfig(config), {
  onChange: (state) =>
    state.error
      ? log("warn", "consent file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "consent file applied", { file: state.path, purposes: state.purposes, sites: state.sites, warnings: state.warnings }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    consent,
    sync,
    version,
    publicUrl,
    auth,
    banner: existsSync(bannerFile) ? readFileSync(bannerFile, "utf8") : undefined,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(consent, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "consent started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log(
    "warn",
    "CONSENT_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and https sites cannot load the banner. Put Consent behind TLS (ADR 0026)",
    {
      url: publicUrl,
    },
  );
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

void sync.tick();
const timers: NodeJS.Timeout[] = [setInterval(() => auth.purge(), 5 * 60_000), setInterval(() => void sync.tick(), 30_000)];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

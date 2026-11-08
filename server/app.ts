import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Principal, type Role } from "@openasy/auth";
import { ConsentError, parseLimit, parseWho, type Consent, type ProblemCode } from "./consent.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import type { Sync } from "./sync.ts";

export interface AppOptions {
  db: DatabaseSync;
  consent: Consent;
  sync: Sync;
  version: string;
  /** The address people and pages reach the product at; the banner sends to it. */
  publicUrl: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** The built banner (dist/banner/c.js), wrapped per site at /c/<site>.js. */
  banner?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(consent: Consent, version: string) {
  return renderMetrics(version, { ...consent.gauges(), fileError: !!consent.summary(null).file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (CONSENT_METRICS_PORT). */
export function createMetricsHandler(consent: Consent, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(consent, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The pages run nothing from elsewhere. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'`,
};

/** Largest body taken by the API: a check of 1000 people is about 60 KiB. */
const API_LIMIT = 256 * 1024;
/** Largest body taken from a page: the answers of one banner or preference page. */
const PAGE_LIMIT = 16 * 1024;

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "forbidden-origin": "Origin not allowed",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-configured": "Not configured",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  "upstream-error": "İYS did not answer",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new ConsentError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConsentError(400, "invalid-json", "The body must be a JSON object.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The role a route needs (ADR 0003); "none" for the version. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  /** Who called, as the history records them: a member's email or an API token's name. */
  actor: string;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  handle: (ctx: Ctx) => unknown;
}

const actorOf = (p: Principal | null) => (!p ? "admin token" : p.kind === "session" ? p.user.email : `token:${p.name}`);

/** The person a query names: ?email=, ?phone=, ?id=, ?browser= or ?person=. */
function whoOf(url: URL) {
  const raw: Record<string, string> = {};
  for (const k of ["person", "email", "phone", "id", "browser"]) {
    const v = url.searchParams.get(k);
    if (v !== null) raw[k] = v;
  }
  return parseWho(raw, "query");
}

/** The preference page: Consent's own page that loads the site's script and shows its panel in full. */
function preferencePage(site: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Preferences</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; background: #f6f7f9; color: #111827; }
      @media (prefers-color-scheme: dark) { body { background: #0b0f17; color: #e5e7eb; } }
      main { max-width: 40rem; margin: 0 auto; padding: 2rem 1rem; }
    </style>
  </head>
  <body>
    <main id="openasy-preferences"></main>
    <script src="/c/${site}.js" data-page="preferences"></script>
  </body>
</html>
`;
}

export function createApp({
  db,
  consent,
  sync,
  version,
  publicUrl,
  auth,
  adminToken,
  banner,
  webDir,
  docsDir,
  openapi,
  serveMetrics = true,
  products = [],
}: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const cursor = (url: URL) => url.searchParams.get("cursor") ?? undefined;
  const limit = (url: URL) => parseLimit(url.searchParams.get("limit"));
  const page = <K extends string, T>(key: K, p: { items: T[]; nextCursor?: string }) =>
    ({ [key]: p.items, ...(p.nextCursor && { nextCursor: p.nextCursor }) }) as Record<K, T[]> & { nextCursor?: string };
  const created = (res: ServerResponse, data: unknown) => json(res, 201, data);
  const channelParam = (url: URL) => {
    const c = url.searchParams.get("channel");
    if (c !== "email" && c !== "sms" && c !== "call") throw new ConsentError(422, "invalid-body", "channel is email, sms or call.");
    return c;
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "consent", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/summary", auth: "viewer", handle: () => consent.summary(sync.status()) },

    // The purposes and sites, as the file sets them. There is no route that adds, changes or removes one.
    { method: "GET", path: "/api/v1/purposes", auth: "viewer", handle: () => ({ purposes: consent.purposeList(), file: consent.summary(null).file }) },
    {
      method: "GET",
      path: "/api/v1/purposes/:id/versions/:version",
      auth: "viewer",
      handle: ({ params }) => {
        const text = consent.textOf(params[0]!, Number(params[1]));
        if (text === null) throw new ConsentError(404, "not-found", "The version does not exist.");
        return { purpose: params[0], version: Number(params[1]), text };
      },
    },
    { method: "GET", path: "/api/v1/sites", auth: "viewer", handle: () => ({ sites: consent.siteList(publicUrl) }) },

    // May we reach this person on this channel for this purpose.
    {
      method: "GET",
      path: "/api/v1/check",
      auth: "viewer",
      handle: ({ url, actor }) => {
        const r = consent.check({ purpose: url.searchParams.get("purpose"), channel: url.searchParams.get("channel"), people: [whoOf(url)] }, actor);
        return r.results[0]!;
      },
    },
    { method: "POST", path: "/api/v1/check", auth: "viewer", handle: async ({ req, actor }) => consent.check(await readJson(req, API_LIMIT), actor) },
    { method: "GET", path: "/api/v1/checks", auth: "viewer", handle: () => consent.checks() },
    {
      method: "GET",
      path: "/api/v1/activity",
      auth: "viewer",
      handle: ({ url }) => consent.activity(Number(url.searchParams.get("days") ?? 30)),
    },

    // Recording answers from your forms and applications.
    {
      method: "POST",
      path: "/api/v1/consents",
      auth: "editor",
      handle: async ({ req, res, actor }) => created(res, consent.record(await readJson(req, API_LIMIT), actor)),
    },
    {
      method: "POST",
      path: "/api/v1/links",
      auth: "editor",
      handle: async ({ req, res }) => created(res, consent.link(await readJson(req, API_LIMIT), publicUrl)),
    },

    // People and their history.
    {
      method: "GET",
      path: "/api/v1/people",
      auth: "viewer",
      handle: ({ url }) =>
        page("people", consent.people(url.searchParams.get("q") ?? undefined, cursor(url), limit(url), url.searchParams.get("filter") ?? undefined)),
    },
    { method: "GET", path: "/api/v1/people/:id", auth: "viewer", handle: ({ params }) => consent.person(params[0]!) },
    // Erasure on request (KVKK Art. 7 and 11, GDPR Art. 17), logged in /api/v1/deletions.
    {
      method: "DELETE",
      path: "/api/v1/people/:id",
      auth: "admin",
      handle: ({ url, params, actor }) => consent.erase(params[0]!, actor, url.searchParams.get("reason")),
    },
    { method: "GET", path: "/api/v1/deletions", auth: "admin", handle: ({ url }) => page("deletions", consent.deletions(cursor(url), limit(url))) },

    // İYS.
    { method: "GET", path: "/api/v1/iys", auth: "viewer", handle: () => sync.status() },
    {
      method: "GET",
      path: "/api/v1/iys/outbox",
      auth: "viewer",
      handle: ({ url }) => ({ outbox: sync.outbox(url.searchParams.get("state") ?? undefined, limit(url)) }),
    },
    {
      method: "POST",
      path: "/api/v1/iys/sync",
      auth: "admin",
      handle: async () => {
        sync.need();
        const read = await sync.tick({ force: true });
        return { read, status: sync.status() };
      },
    },
    { method: "POST", path: "/api/v1/iys/retry", auth: "admin", handle: () => sync.retry() },
    { method: "GET", path: "/api/v1/iys/log", auth: "viewer", handle: ({ url }) => ({ log: consent.iysLog(limit(url)) }) },
    { method: "GET", path: "/api/v1/conflicts", auth: "viewer", handle: ({ url }) => ({ conflicts: consent.conflictList(limit(url)) }) },
    {
      method: "GET",
      path: "/api/v1/iys/lookup",
      auth: "admin",
      handle: async ({ url }) => {
        const channel = channelParam(url);
        const who = whoOf(url);
        const recipient = channel === "email" ? who.email : who.phone;
        if (!recipient)
          throw new ConsentError(422, "invalid-body", channel === "email" ? "email is required for the email channel." : "phone is required for sms and call.");
        return { recipient, channel, ...(await sync.lookup(recipient, channel)) };
      },
    },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  /** The page's origin, echoed back when it is one of a site's or Consent's own, so the page may read the answer. */
  function cors(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    const own = new URL(publicUrl).origin;
    if (!origin || !(origin === own || consent.sites().some((s) => s.domains.includes(origin)))) return { vary: "Origin" };
    return { "access-control-allow-origin": origin, vary: "Origin" };
  }

  /** What the banner and the preference page read and send. */
  async function choices(req: IncomingMessage, res: ServerResponse, url: URL) {
    const headers = cors(req);
    try {
      if (req.method === "OPTIONS") {
        res
          .writeHead(204, {
            ...SECURITY_HEADERS,
            ...headers,
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "600",
          })
          .end();
        return;
      }
      if (req.method === "GET") {
        const r = consent.choices(
          url.searchParams.get("site") ?? "",
          url.searchParams.get("browser"),
          url.searchParams.get("token"),
          url.searchParams.get("lang"),
        );
        return json(res, 200, r, { ...headers, "cache-control": "no-store" });
      }
      const body = await readJson(req, PAGE_LIMIT);
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      json(res, 200, consent.answer(body, origin, publicUrl), headers);
    } catch (err) {
      if (!(err instanceof ConsentError)) throw err;
      problem(res, err.status, err.code, err.message, { ...headers, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) });
      if (!req.complete) req.resume();
    }
  }

  /** The banner with the site's settings, for one script tag on the site's pages. */
  function script(res: ServerResponse, name: string) {
    const headers = { "cache-control": "public, max-age=300" };
    const site = consent.site(name);
    if (!site) return send(res, 404, `/* OpenAsy Consent: no site named ${JSON.stringify(name)} in the file. */\n`, "text/javascript", headers);
    if (!banner) return send(res, 503, "/* OpenAsy Consent: the banner is not built. */\n", "text/javascript", headers);
    const purposes = site.banner.map((id) => {
      const p = consent.config().purposes.find((x) => x.id === id)!;
      const v = p.versions.at(-1)!;
      // Answers to versions before the last one that asks again no longer count, here as on the server.
      const since = Math.max(1, ...p.versions.filter((x) => x.renew).map((x) => x.version));
      return { id: p.id, name: p.name, text: v.text, version: v.version, required: p.required, since };
    });
    const config = {
      site: site.name,
      endpoint: `${publicUrl}/api/v1/choices`,
      language: site.language,
      privacy: site.privacy,
      analytics: site.analytics,
      preferences: site.preferences.length > 0,
      purposes,
    };
    send(res, 200, `/* OpenAsy Consent */\n(function(){\n${banner}\nOAC.start(${JSON.stringify(config)});\n})();\n`, "text/javascript", headers);
  }

  function authorize(req: IncomingMessage, access: Access): Principal | null {
    if (access === "none") return null;
    if (tokenMatches(req.headers.authorization, adminToken)) return null;
    return auth.authorize(req, access);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "database unavailable" });
      }
      return "/readyz";
    }

    if (path === "/metrics") {
      if (serveMetrics) send(res, 200, metricsText(consent, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    const site = /^\/c\/([a-z0-9-]{1,32})\.js$/.exec(path);
    if (site && (req.method === "GET" || req.method === "HEAD")) return (script(res, site[1]!), "/c/{site}.js");

    const prefs = /^\/preferences\/([a-z0-9-]{1,32})$/.exec(path);
    if (prefs && (req.method === "GET" || req.method === "HEAD")) {
      if (!consent.site(prefs[1]!)) problem(res, 404, "not-found", "No site of that name in the file.");
      else send(res, 200, preferencePage(prefs[1]!), TYPES[".html"], { "cache-control": "no-store" });
      return "/preferences/{site}";
    }

    if (path === "/api/v1/choices" && ["GET", "POST", "OPTIONS"].includes(req.method ?? "")) return (await choices(req, res, url), "/api/v1/choices");

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const r of compiled) {
      const m = path.match(r.re);
      if (!m || r.method !== req.method) continue;
      try {
        const principal = authorize(req, r.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await r.handle({ req, res, url, params, actor: actorOf(principal) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return r.path;
        }
        if (!(err instanceof ConsentError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return r.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: pathOf(req) });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // The banner's requests come with the sites' traffic; logging each would put it in the logs.
    if (!["/healthz", "/metrics", "/api/v1/choices", "/c/{site}.js"].includes(routeName)) {
      log("info", "request", { method: req.method, path: pathOf(req), status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}

/** The path without the query string, which may name people. */
const pathOf = (req: IncomingMessage) => (req.url ?? "/").split("?")[0];

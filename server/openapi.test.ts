import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, SHOP, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "consent-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir, iys: true });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const admin = (body?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body !== undefined && { "content-type": "application/json" }) },
  ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
});
const fromPage = (body: unknown, origin = SHOP) => ({
  headers: { "content-type": "text/plain", origin },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Consent's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  const who = { email: "contract@example.com", phone: "+905551112233" };
  let person = "";
  let token = "";

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("purposes and sites", async () => {
    await call("GET", "/api/v1/purposes", admin());
    await call("GET", "/api/v1/purposes", {});
    await call("GET", "/api/v1/purposes/{id}/versions/{version}", admin(), "/api/v1/purposes/marketing/versions/1");
    await call("GET", "/api/v1/purposes/{id}/versions/{version}", admin(), "/api/v1/purposes/marketing/versions/9");
    await call("GET", "/api/v1/purposes/{id}/versions/{version}", {}, "/api/v1/purposes/marketing/versions/1");
    await call("GET", "/api/v1/sites", admin());
    await call("GET", "/api/v1/sites", {});
  });

  it("recording and checking", async () => {
    const answers = [
      { purpose: "marketing", channel: "email", granted: true, proof: "form 1" },
      { purpose: "marketing", channel: "sms", granted: false },
    ];
    const { body } = await call("POST", "/api/v1/consents", { ...admin({ person: who, answers, source: "form", via: "forms/signup" }) });
    person = (body as { person: string }).person;
    await call("POST", "/api/v1/consents", admin({ person: { email: "x@example.com" }, answers: [{ purpose: "nope", channel: "email", granted: true }] }));
    await call("POST", "/api/v1/consents", admin({ person: { email: "contract@example.com", phone: "+905550000000" }, answers }));
    await call("POST", "/api/v1/consents", admin("{nope"));
    await call("POST", "/api/v1/consents", admin({ person: who, answers, pad: "x".repeat(300_000) }));
    await call("POST", "/api/v1/consents", {});
    await call("GET", "/api/v1/check", admin(), "/api/v1/check?purpose=marketing&channel=email&email=contract@example.com");
    await call("GET", "/api/v1/check", admin(), "/api/v1/check?purpose=marketing&channel=email&email=nobody@example.com");
    await call("GET", "/api/v1/check", admin(), "/api/v1/check?purpose=marketing&channel=fax&email=contract@example.com");
    await call("GET", "/api/v1/check", {}, "/api/v1/check?purpose=marketing&channel=email&email=contract@example.com");
    await call("POST", "/api/v1/check", admin({ purpose: "marketing", channel: "sms", people: [{ phone: "05551112233" }, { browser: "browser-none" }] }));
    await call("POST", "/api/v1/check", admin({ purpose: "marketing", channel: "sms", people: [] }));
    await call("POST", "/api/v1/check", admin("{nope"));
    await call("POST", "/api/v1/check", admin({ purpose: "marketing", channel: "sms", people: [], pad: "x".repeat(300_000) }));
    await call("POST", "/api/v1/check", {});
  });

  it("links, the banner and the preference page", async () => {
    const { body } = await call("POST", "/api/v1/links", admin({ person: who, site: "shop" }));
    token = (body as { token: string }).token;
    await call("POST", "/api/v1/links", admin({ person: { email: "nobody@example.com" }, site: "shop" }));
    await call("POST", "/api/v1/links", admin({ person: who, site: "shop", days: 0 }));
    await call("POST", "/api/v1/links", admin({ person: { email: "contract@example.com", phone: "+905550000000" }, site: "shop" }));
    await call("POST", "/api/v1/links", admin("{nope"));
    await call("POST", "/api/v1/links", admin({ pad: "x".repeat(300_000) }));
    await call("POST", "/api/v1/links", {});
    await call("GET", "/c/{site}.js", {}, "/c/shop.js");
    await call("GET", "/c/{site}.js", {}, "/c/nope.js");
    await call("GET", "/preferences/{site}", {}, `/preferences/shop?t=${token}`);
    await call("GET", "/preferences/{site}", {}, "/preferences/nope");
    await call("GET", "/api/v1/choices", {}, "/api/v1/choices?site=shop&browser=browser-contract");
    await call("GET", "/api/v1/choices", {}, `/api/v1/choices?site=shop&browser=browser-contract&token=${token}&lang=tr`);
    await call("GET", "/api/v1/choices", {}, "/api/v1/choices?site=shop&token=nope");
    await call("GET", "/api/v1/choices", {}, "/api/v1/choices?site=nope");
    await call("GET", "/api/v1/choices", {}, "/api/v1/choices?site=shop&browser=x");
    const answer = { site: "shop", browser: "browser-contract", answers: [{ purpose: "analytics", granted: true, version: 1 }] };
    await call("POST", "/api/v1/choices", fromPage(answer));
    await call(
      "POST",
      "/api/v1/choices",
      fromPage({ ...answer, from: "preferences", token, answers: [{ purpose: "marketing", channel: "email", granted: false }] }),
    );
    await call("POST", "/api/v1/choices", fromPage({ ...answer, answers: [{ purpose: "marketing", granted: false }] }));
    await call("POST", "/api/v1/choices", fromPage(answer, "https://evil.example"));
    await call("POST", "/api/v1/choices", fromPage({ ...answer, site: "nope" }));
    await call("POST", "/api/v1/choices", fromPage({ ...answer, browser: "x" }));
    await call("POST", "/api/v1/choices", fromPage("{nope"));
    await call("POST", "/api/v1/choices", fromPage({ ...answer, pad: "x".repeat(20_000) }));
  });

  it("rate-limits a site's pages", async () => {
    const limited = await startApp({ version, openapi: spec });
    const send = () =>
      fetch(`${limited.base}/api/v1/choices`, {
        method: "POST",
        ...fromPage({ site: "shop", browser: "browser-limit", answers: [{ purpose: "analytics", granted: true }] }),
      });
    for (let i = 0; i < 1200; i++) await send();
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    await limited.close();
  });

  it("İYS", async () => {
    await call("GET", "/api/v1/iys", admin());
    await call("GET", "/api/v1/iys", {});
    await call("POST", "/api/v1/iys/sync", admin());
    await call("POST", "/api/v1/iys/sync", {});
    await call("GET", "/api/v1/iys/outbox", admin(), "/api/v1/iys/outbox?state=sent&limit=5");
    await call("GET", "/api/v1/iys/outbox", admin(), "/api/v1/iys/outbox?state=lost");
    await call("GET", "/api/v1/iys/outbox", {});
    await call("POST", "/api/v1/iys/retry", admin());
    await call("POST", "/api/v1/iys/retry", {});
    await call("GET", "/api/v1/iys/lookup", admin(), "/api/v1/iys/lookup?channel=email&email=contract@example.com");
    await call("GET", "/api/v1/iys/lookup", admin(), "/api/v1/iys/lookup?channel=sms&email=contract@example.com");
    app.fake!.failNext(500, 3);
    await call("GET", "/api/v1/iys/lookup", admin(), "/api/v1/iys/lookup?channel=email&email=contract@example.com");
    await call("GET", "/api/v1/iys/lookup", {}, "/api/v1/iys/lookup?channel=email&email=contract@example.com");
    const off = await startApp({ version, openapi: spec });
    const res = await fetch(`${off.base}/api/v1/iys/sync`, { method: "POST", ...admin() });
    expect(res.status).toBe(409);
    const lookup = await fetch(`${off.base}/api/v1/iys/lookup?channel=email&email=a@example.com`, admin());
    expect(lookup.status).toBe(409);
    await off.close();
  });

  it("people, erasure and its log", async () => {
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?q=contract&limit=1");
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?limit=0");
    await call("GET", "/api/v1/people", {});
    await call("GET", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}`);
    await call("GET", "/api/v1/people/{id}", admin(), "/api/v1/people/missing");
    await call("GET", "/api/v1/people/{id}", {}, `/api/v1/people/${person}`);
    await call("DELETE", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}`);
    await call("DELETE", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}?reason=Request%2012`);
    await call("DELETE", "/api/v1/people/{id}", admin(), `/api/v1/people/${person}?reason=Request%2012`);
    await call("DELETE", "/api/v1/people/{id}", {}, `/api/v1/people/${person}?reason=Request%2012`);
    await call("GET", "/api/v1/deletions", admin(), "/api/v1/deletions?limit=1");
    await call("GET", "/api/v1/deletions", admin(), "/api/v1/deletions?cursor=nope");
    await call("GET", "/api/v1/deletions", {});
  });

  it("activity, checks, conflicts and the İYS log", async () => {
    await call("GET", "/api/v1/activity", admin(), "/api/v1/activity?days=7");
    await call("GET", "/api/v1/activity", admin(), "/api/v1/activity?days=0");
    await call("GET", "/api/v1/activity", {});
    await call("GET", "/api/v1/checks", admin());
    await call("GET", "/api/v1/checks", {});
    app.fake!.external({ recipient: "conflict@example.com", type: "EPOSTA", status: "RET", source: "HS_EORTAM", consentDate: "2026-11-08 13:00:00" });
    await fetch(`${base}/api/v1/consents`, {
      method: "POST",
      ...admin({ person: { email: "conflict@example.com" }, answers: [{ purpose: "marketing", channel: "email", granted: true }] }),
    });
    await fetch(`${base}/api/v1/iys/sync`, { method: "POST", ...admin() });
    await call("GET", "/api/v1/conflicts", admin(), "/api/v1/conflicts?limit=10");
    await call("GET", "/api/v1/conflicts", admin(), "/api/v1/conflicts?limit=0");
    await call("GET", "/api/v1/conflicts", {});
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?filter=conflicts");
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?filter=today");
    await call("GET", "/api/v1/people", admin(), "/api/v1/people?filter=other");
    await call("GET", "/api/v1/iys/log", admin(), "/api/v1/iys/log?limit=20");
    await call("GET", "/api/v1/iys/log", admin(), "/api/v1/iys/log?limit=0");
    await call("GET", "/api/v1/iys/log", {});
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});

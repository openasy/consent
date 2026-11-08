import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHOP, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

const json = async (res: Response) => (await res.json()) as any;
let n = 0;
const browser = () => `browser-${++n}-aaaaaaaa`;
const post = (path: string, body: unknown) => app.admin(path, { method: "POST", body: JSON.stringify(body) });

describe("the script", () => {
  it("is served per site with its purposes and texts, and says so for a site not in the file", async () => {
    const res = await fetch(`${app.base}/c/shop.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const text = await res.text();
    const config = JSON.parse(/OAC\.start\((.*)\);/.exec(text)![1]!);
    expect(config).toEqual({
      site: "shop",
      endpoint: `${app.base}/api/v1/choices`,
      language: null,
      privacy: `${SHOP}/privacy`,
      analytics: "analytics",
      preferences: true,
      purposes: [
        { id: "necessary", name: "Necessary", text: "The session.", version: 1, required: true, since: 1 },
        {
          id: "analytics",
          name: { en: "Measurement", tr: "Ölçüm" },
          text: { en: "Pages read.", tr: "Okunan sayfalar." },
          version: 1,
          required: false,
          since: 1,
        },
      ],
    });
    const missing = await fetch(`${app.base}/c/nope.js`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('no site named "nope"');
  });

  it("and the preference page that loads it", async () => {
    const res = await fetch(`${app.base}/preferences/shop?t=x`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('<script src="/c/shop.js" data-page="preferences"></script>');
    expect((await fetch(`${app.base}/preferences/nope`)).status).toBe(404);
  });
});

describe("the banner", () => {
  it("reads the site's purposes in the page's language", async () => {
    const res = await fetch(`${app.base}/api/v1/choices?site=shop&lang=tr&browser=${browser()}`, { headers: { origin: SHOP } });
    expect(res.headers.get("access-control-allow-origin")).toBe(SHOP);
    const body = await json(res);
    expect(body).toMatchObject({ site: "shop", language: "tr", person: null });
    expect(body.purposes.map((p: any) => [p.id, p.name, p.channels[0].status])).toEqual([
      ["necessary", "Necessary", "granted"],
      ["analytics", "Ölçüm", "none"],
    ]);
  });

  it("records answers from the site's pages, and only what changed", async () => {
    const b = browser();
    const answer = (granted: boolean) => app.page({ site: "shop", browser: b, answers: [{ purpose: "analytics", granted, version: 1 }] });
    expect(await json(await answer(true))).toEqual({ recorded: 1 });
    expect(await json(await answer(true))).toEqual({ recorded: 0 });
    expect(await json(await answer(false))).toEqual({ recorded: 1 });
    const check = await json(await app.admin(`/api/v1/check?purpose=analytics&channel=web&browser=${b}`));
    expect(check).toMatchObject({ allowed: false, status: "withdrawn", source: "banner" });
  });

  it("refuses other origins, message purposes without a link, and purposes the site does not ask", async () => {
    const b = browser();
    const other = await app.page({ site: "shop", browser: b, answers: [{ purpose: "analytics", granted: true }] }, "https://evil.example");
    expect(other.status).toBe(403);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await app.page({ site: "shop", browser: b, answers: [{ purpose: "marketing", granted: true }] })).status).toBe(401);
    expect((await app.page({ site: "shop", browser: b, answers: [{ purpose: "necessary", granted: false }] })).status).toBe(422);
    expect((await app.page({ site: "nope", browser: b, answers: [{ purpose: "analytics", granted: true }] })).status).toBe(404);
    expect((await app.page({ site: "shop", browser: "x", answers: [{ purpose: "analytics", granted: true }] })).status).toBe(422);
  });
});

describe("the preference page", () => {
  it("shows and changes the messages of the person a link names", async () => {
    const created = await post("/api/v1/consents", {
      person: { email: "ayse@example.com" },
      via: "forms/signup",
      source: "form",
      answers: [{ purpose: "newsletter", channel: "email", granted: true }],
    });
    expect(created.status).toBe(201);
    const link = await json(await post("/api/v1/links", { person: { email: "ayse@example.com" }, site: "shop", days: 30 }));
    expect(link.url).toBe(`${app.base}/preferences/shop?t=${link.token}`);
    const b = browser();
    const choices = await json(await fetch(`${app.base}/api/v1/choices?site=shop&browser=${b}&token=${encodeURIComponent(link.token)}`));
    expect(choices.person).toEqual({ emails: ["ayse@example.com"], phones: [] });
    expect(choices.purposes.map((p: any) => p.id)).toEqual(["necessary", "analytics", "marketing", "newsletter"]);
    expect(choices.purposes[3].channels).toEqual([{ channel: "email", status: "granted", allowed: true, version: 1, at: expect.any(String) }]);

    const res = await app.page({
      site: "shop",
      browser: b,
      from: "preferences",
      token: link.token,
      answers: [{ purpose: "newsletter", channel: "email", granted: false }],
    });
    expect(await json(res)).toEqual({ recorded: 1 });
    const check = await json(await app.admin("/api/v1/check?purpose=newsletter&channel=email&email=ayse@example.com"));
    expect(check).toMatchObject({ allowed: false, status: "withdrawn", source: "preferences" });
    // A phone number is not known for her, so SMS cannot be answered here.
    const sms = await app.page({
      site: "shop",
      browser: b,
      from: "preferences",
      token: link.token,
      answers: [{ purpose: "marketing", channel: "sms", granted: true }],
    });
    expect(sms.status).toBe(422);
  });

  it("refuses a link that is not one of ours or has run out", async () => {
    await post("/api/v1/consents", { person: { email: "old@example.com" }, answers: [{ purpose: "newsletter", channel: "email", granted: true }] });
    const link = await json(await post("/api/v1/links", { person: { email: "old@example.com" }, site: "shop", days: 1 }));
    expect((await fetch(`${app.base}/api/v1/choices?site=shop&token=${link.token}x`)).status).toBe(401);
    app.clock.advance(2 * 86_400_000);
    expect((await fetch(`${app.base}/api/v1/choices?site=shop&token=${link.token}`)).status).toBe(401);
  });
});

describe("the API", () => {
  it("asks for many people at once, for a campaign", async () => {
    await post("/api/v1/consents", { person: { email: "c1@example.com" }, answers: [{ purpose: "newsletter", channel: "email", granted: true }] });
    await post("/api/v1/consents", { person: { email: "c2@example.com" }, answers: [{ purpose: "newsletter", channel: "email", granted: false }] });
    const res = await json(
      await post("/api/v1/check", {
        purpose: "newsletter",
        channel: "email",
        people: [{ email: "c1@example.com" }, { email: "c2@example.com" }, { email: "c3@example.com" }],
      }),
    );
    expect(res.results.map((r: any) => [r.allowed, r.status])).toEqual([
      [true, "granted"],
      [false, "withdrawn"],
      [false, "none"],
    ]);
  });

  it("lists people, shows one with their history, and erases them on request", async () => {
    const { person } = await json(
      await post("/api/v1/consents", {
        person: { email: "erase@example.com", id: "u-9" },
        answers: [{ purpose: "newsletter", channel: "email", granted: true, proof: "form 12" }],
      }),
    );
    const list = await json(await app.admin("/api/v1/people?q=erase"));
    expect(list.people.map((p: any) => p.id)).toEqual([person]);
    const one = await json(await app.admin(`/api/v1/people/${person}`));
    expect(one.history[0]).toMatchObject({ purpose: "newsletter", granted: true, actor: "admin token", proof: "form 12", source: "api" });
    expect((await app.admin(`/api/v1/people/${person}`, { method: "DELETE" })).status).toBe(422);
    const erased = await app.admin(`/api/v1/people/${person}?reason=${encodeURIComponent("KVKK request 42")}`, { method: "DELETE" });
    expect(await json(erased)).toMatchObject({ person, reason: "KVKK request 42", answers: 1, identifiers: 2 });
    expect((await app.admin(`/api/v1/people/${person}`)).status).toBe(404);
    expect((await json(await app.admin("/api/v1/deletions"))).deletions[0]).toMatchObject({ person, actor: "admin token" });
  });

  it("needs a session or token, and says İYS is not set", async () => {
    expect((await fetch(`${app.base}/api/v1/people`)).status).toBe(401);
    expect((await fetch(`${app.base}/api/v1/check?purpose=newsletter&channel=email&email=a@example.com`)).status).toBe(401);
    expect((await app.admin("/api/v1/iys")).status).toBe(200);
    expect((await post("/api/v1/iys/sync", {})).status).toBe(409);
  });

  it("lists purposes with their versions and how many agreed", async () => {
    const { purposes } = await json(await app.admin("/api/v1/purposes"));
    expect(purposes.find((p: any) => p.id === "newsletter")).toMatchObject({
      current: 1,
      channels: ["email"],
      iys: false,
      versions: [{ version: 1, from: "2026-11-08" }],
    });
    expect(await json(await app.admin("/api/v1/purposes/newsletter/versions/1"))).toEqual({
      purpose: "newsletter",
      version: 1,
      text: "The monthly newsletter.",
    });
  });

  it("reports health and metrics", async () => {
    expect(await json(await fetch(`${app.base}/api/v1/version`))).toEqual({ product: "consent", version: "0.1.0" });
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="consent",version="0.1.0"} 1');
    expect(metrics).toContain("openasy_consent_purposes 4");
    expect(metrics).toContain('openasy_consent_iys_outbox{state="pending"} 0');
  });
});

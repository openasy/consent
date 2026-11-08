// İYS, both ways, against the fake İYS in iys-fake.ts. The real İYS was never reached from these tests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpIysClient, fromIysDate, IysError, toIysDate } from "./iys.ts";
import { startFakeIys, type FakeIys } from "./iys-fake.ts";
import { startApp } from "./test-app.ts";

describe("İYS dates", () => {
  it("are Türkiye's time, written as İYS writes them", () => {
    expect(toIysDate("2026-11-08T09:00:00.000Z")).toBe("2026-11-08 12:00:00");
    expect(fromIysDate("2026-11-08 12:00:00")).toBe("2026-11-08T09:00:00.000Z");
    expect(fromIysDate("2026-11-08 12:00")).toBe("2026-11-08T09:00:00.000Z");
    expect(fromIysDate("yesterday")).toBeNull();
  });
});

describe("the İYS client", () => {
  let fake: FakeIys;
  beforeEach(async () => {
    fake = await startFakeIys();
  });
  afterEach(() => fake.close());
  const client = (password = "api-pass") => createHttpIysClient({ url: fake.url, account: "123456", brand: "654321", username: "api-user", password });
  const consent = {
    recipient: "ayse@example.com",
    recipientType: "BIREYSEL" as const,
    type: "EPOSTA" as const,
    status: "ONAY" as const,
    source: "HS_WEB",
    consentDate: "2026-11-08 12:00:00",
  };

  it("signs in once, adds an answer, asks for it and lists the changes", async () => {
    const c = client();
    const { transactionId } = await c.add(consent);
    expect(transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await c.status({ recipient: "ayse@example.com", recipientType: "BIREYSEL", type: "EPOSTA" })).toMatchObject({ status: "ONAY", transactionId });
    expect(await c.status({ recipient: "ayse@example.com", recipientType: "BIREYSEL", type: "MESAJ" })).toBeNull();
    const first = await c.changes(null, 10);
    expect(first.list).toHaveLength(1);
    expect(await c.changes(first.after, 10)).toEqual({ after: "1", list: [] });
    expect(fake.requests.filter((r) => r === "POST /oauth2/token")).toHaveLength(1);
    expect(fake.requests).toContain("POST /sps/123456/brands/654321/consents");
  });

  it("signs in again when İYS ends the token early", async () => {
    const c = client();
    await c.add(consent);
    fake.expireToken();
    await c.add({ ...consent, status: "RET" });
    expect(fake.requests.filter((r) => r === "POST /oauth2/token")).toHaveLength(2);
  });

  it("tells a refused answer from İYS being away", async () => {
    const c = client();
    const refused = await c.add({ ...consent, recipient: "nobody" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(IysError);
    expect(refused).toMatchObject({ status: 400, permanent: true, message: "H175: Alıcı geçersiz." });
    fake.failNext(503);
    expect(await c.add(consent).catch((e: unknown) => e)).toMatchObject({ status: 503, permanent: false });
    expect(
      await client("wrong")
        .add(consent)
        .catch((e: unknown) => e),
    ).toMatchObject({ permanent: false, message: expect.stringMatching(/Signing in to İYS failed/) });
  });
});

describe("keeping İYS in step", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  beforeEach(async () => {
    app = await startApp({ iys: true });
  });
  afterEach(() => app.close());
  const ACTOR = "token:forms";
  const fake = () => app.fake!;
  const may = (channel: string, who: object) => app.consent.check({ purpose: "marketing", channel, people: [who] }).results[0]!;

  it("sends answers on the İYS purpose, in Türkiye's time, and nothing else", async () => {
    const { person } = app.consent.record(
      {
        person: { email: "ayse@example.com", phone: "0555 111 22 33" },
        answers: [
          { purpose: "marketing", channel: "email", granted: true },
          { purpose: "marketing", channel: "call", granted: false, iysSource: "HS_CAGRI_MERKEZI" },
          { purpose: "newsletter", channel: "email", granted: true },
        ],
      },
      ACTOR,
    );
    app.consent.record({ person: { browser: "browser-aaaa" }, answers: [{ purpose: "analytics", channel: "web", granted: true }] }, ACTOR);
    await app.sync.tick();
    expect(fake().records.map((r) => [r.recipient, r.type, r.status, r.source, r.consentDate])).toEqual([
      ["ayse@example.com", "EPOSTA", "ONAY", "HS_WEB", "2026-11-08 12:00:00"],
      ["+905551112233", "ARAMA", "RET", "HS_CAGRI_MERKEZI", "2026-11-08 12:00:00"],
    ]);
    expect(app.consent.person(person).iys.map((o) => [o.state, !!o.transactionId])).toEqual([
      ["sent", true],
      ["sent", true],
    ]);
    // İYS lists our own answers back; they are not recorded twice.
    expect(app.consent.person(person).history).toHaveLength(3);
    expect(app.sync.status()).toMatchObject({ configured: true, connected: true, sent: 2, pending: 0, failed: 0, error: null });
  });

  it("records answers İYS got from elsewhere, such as STOP to an SMS", async () => {
    const { person } = app.consent.record({ person: { phone: "+905551112233" }, answers: [{ purpose: "marketing", channel: "sms", granted: true }] }, ACTOR);
    await app.sync.tick();
    expect(may("sms", { phone: "05551112233" })).toMatchObject({ allowed: true });
    app.clock.advance(10 * 60_000);
    fake().external({
      recipient: "+905551112233",
      type: "MESAJ",
      status: "RET",
      source: "HS_MESAJ",
      consentDate: toIysDate(new Date(app.clock()).toISOString()),
    });
    fake().external({ recipient: "new@example.com", type: "EPOSTA", status: "ONAY", source: "HS_EORTAM", consentDate: "2026-11-08 12:05:00" });
    expect(await app.sync.tick()).toEqual({ recorded: 2, known: 0, skipped: 0 });
    expect(may("sms", { phone: "+905551112233" })).toMatchObject({ allowed: false, status: "withdrawn", source: "iys" });
    const history = app.consent.person(person).history;
    expect(history.map((a) => [a.source, a.granted, a.iysSource])).toEqual([
      ["iys", false, "HS_MESAJ"],
      ["api", true, null],
    ]);
    // Someone İYS knows and Consent did not is added, with the version in force when they answered.
    expect(may("email", { email: "new@example.com" })).toMatchObject({ allowed: true, version: 1, source: "iys" });
    // Answers from İYS are not sent back to it.
    expect(fake().records).toHaveLength(3);
  });

  it("keeps both answers when İYS and the record disagree, and the later one decides", async () => {
    app.consent.record({ person: { email: "b@example.com" }, answers: [{ purpose: "marketing", channel: "email", granted: true }] }, ACTOR);
    // A refusal İYS got an hour before the yes recorded here.
    fake().external({ recipient: "b@example.com", type: "EPOSTA", status: "RET", source: "HS_EORTAM", consentDate: "2026-11-08 11:00:00" });
    await app.sync.tick();
    expect(may("email", { email: "b@example.com" })).toMatchObject({ allowed: true, source: "api" });
    expect(app.consent.conflictList(10)).toMatchObject([
      { about: "b@example.com", channel: "email", local: { granted: true }, iys: { granted: false }, counts: "local" },
    ]);
    expect(app.consent.people(undefined, undefined, 10, "conflicts").items.map((p) => p.emails[0])).toEqual(["b@example.com"]);
    // And one given after it.
    fake().external({ recipient: "b@example.com", type: "EPOSTA", status: "RET", source: "HS_EORTAM", consentDate: "2026-11-08 12:30:00" });
    await app.sync.tick({ force: true });
    expect(may("email", { email: "b@example.com" })).toMatchObject({ allowed: false, source: "iys" });
    const { person } = may("email", { email: "b@example.com" });
    expect(app.consent.person(person!).history.map((a) => [a.source, a.granted])).toEqual([
      ["iys", false],
      ["api", true],
      ["iys", false],
    ]);
  });

  it("reads İYS's changes every few minutes, from where it stopped", async () => {
    await app.sync.tick();
    const reads = () => fake().requests.filter((r) => r.endsWith("/consents/changes")).length;
    expect(reads()).toBe(1);
    await app.sync.tick();
    expect(reads()).toBe(1);
    app.clock.advance(5 * 60_000);
    fake().external({ recipient: "c@example.com", type: "EPOSTA", status: "ONAY", source: "HS_WEB", consentDate: "2026-11-08 12:01:00" });
    expect(await app.sync.tick()).toEqual({ recorded: 1, known: 0, skipped: 0 });
    expect(app.db.prepare("SELECT value FROM settings WHERE key = 'iys_after'").get()).toEqual({ value: "1" });
  });

  it("tries again later when İYS is away, keeping each recipient's answers in order", async () => {
    const who = { email: "d@example.com" };
    app.consent.record({ person: who, answers: [{ purpose: "marketing", channel: "email", granted: true }] }, ACTOR);
    app.clock.advance(1000);
    app.consent.record({ person: who, answers: [{ purpose: "marketing", channel: "email", granted: false }] }, ACTOR);
    fake().failNext(503);
    await app.sync.tick();
    expect(app.sync.status()).toMatchObject({ pending: 2, sent: 0 });
    expect(app.sync.outbox("pending", 10).map((o) => [o.status, o.attempts])).toEqual([
      ["RET", 0],
      ["ONAY", 1],
    ]);
    app.clock.advance(61_000);
    await app.sync.tick();
    expect(fake().records.map((r) => r.status)).toEqual(["ONAY", "RET"]);
  });

  it("keeps an answer İYS refused as failed, with its message, until it is sent again", async () => {
    app.consent.record({ person: { email: "e@example.com" }, answers: [{ purpose: "marketing", channel: "email", granted: true }] }, ACTOR);
    fake().failNext(400);
    await app.sync.tick();
    expect(app.sync.outbox("failed", 10)).toMatchObject([{ state: "failed", error: "H500: Geçici hata." }]);
    expect(app.sync.retry()).toEqual({ retried: 1 });
    await app.sync.tick();
    expect(app.sync.status()).toMatchObject({ failed: 0, sent: 1 });
  });

  it("tells İYS no for every yes of a person erased on request, and keeps no address after", async () => {
    const { person } = app.consent.record(
      {
        person: { email: "f@example.com", phone: "+905559998877" },
        answers: [
          { purpose: "marketing", channel: "email", granted: true },
          { purpose: "marketing", channel: "sms", granted: true },
        ],
      },
      ACTOR,
    );
    await app.sync.tick();
    expect(app.consent.erase(person, "dpo@example.com", "Request 7")).toMatchObject({ iysRefusals: 2 });
    app.clock.advance(5 * 60_000);
    await app.sync.tick();
    expect(fake().records.map((r) => [r.recipient, r.type, r.status])).toEqual([
      ["f@example.com", "EPOSTA", "ONAY"],
      ["+905559998877", "MESAJ", "ONAY"],
      ["f@example.com", "EPOSTA", "RET"],
      ["+905559998877", "MESAJ", "RET"],
    ]);
    // Reading İYS back does not bring the person back, and the outbox keeps no address.
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM people").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM iys_outbox WHERE recipient != ''").get()).toEqual({ n: 0 });
  });

  it("asks İYS directly for a recipient's answer", async () => {
    fake().external({ recipient: "g@example.com", type: "EPOSTA", status: "ONAY", source: "HS_WEB", consentDate: "2026-11-01 10:00:00" });
    expect(await app.sync.lookup("g@example.com", "email")).toMatchObject({ found: true, status: "ONAY", consentDate: "2026-11-01T07:00:00.000Z" });
    expect(await app.sync.lookup("g@example.com", "sms")).toMatchObject({ found: false });
  });
});

describe("İYS without its credentials", () => {
  it("is set but not connected, and says which variables are missing", async () => {
    const fake = await startFakeIys();
    const app = await startApp({ file: undefined });
    const { parseConfig } = await import("./config.ts");
    const { FILE, iysBlock } = await import("./test-app.ts");
    const warnings = app.consent.setConfig(parseConfig(FILE.replace("{iys}", iysBlock(fake.url).replace("IYS_PASS", "MISSING_PASS"))));
    expect(warnings).toEqual(["iys: MISSING_PASS is not set, so İYS is not kept in step."]);
    expect(app.sync.status()).toMatchObject({ configured: true, connected: false, credentials: { password: { variable: "MISSING_PASS", set: false } } });
    expect(() => app.sync.need()).toThrow(/credentials are not set/);
    await app.close();
    await fake.close();
  });
});

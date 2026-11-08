import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { normalEmail, normalPhone } from "./consent.ts";
import { FILE, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
beforeEach(async () => {
  app = await startApp();
});
afterEach(() => app.close());

const ACTOR = "dpo@example.com";
const yes = (purpose: string, channel: string, over: object = {}) => ({ purpose, channel, granted: true, ...over });
const no = (purpose: string, channel: string, over: object = {}) => ({ purpose, channel, granted: false, ...over });
const may = (purpose: string, channel: string, who: object) => app.consent.check({ purpose, channel, people: [who] }).results[0]!;

describe("identifiers", () => {
  it("normalises emails and phone numbers as İYS takes them", () => {
    expect(normalEmail(" Ayse@Example.COM ")).toBe("ayse@example.com");
    expect(normalEmail("not an email")).toBeNull();
    expect(normalPhone("0555 111 22 33")).toBe("+905551112233");
    expect(normalPhone("905551112233")).toBe("+905551112233");
    expect(normalPhone("(555) 111-22-33")).toBe("+905551112233");
    expect(normalPhone("+49 30 1234567")).toBe("+49301234567");
    expect(normalPhone("12")).toBeNull();
  });
});

describe("may we reach this person", () => {
  it("only while their latest answer is yes", () => {
    expect(may("marketing", "email", { email: "a@example.com" })).toMatchObject({ allowed: false, status: "none", person: null });
    const { person } = app.consent.record({ person: { email: "A@example.com" }, answers: [yes("marketing", "email")] }, ACTOR);
    expect(may("marketing", "email", { email: "a@example.com" })).toMatchObject({
      allowed: true,
      status: "granted",
      version: 1,
      current: 1,
      person,
      source: "api",
    });
    // Each channel is its own answer.
    expect(may("marketing", "sms", { email: "a@example.com" })).toMatchObject({ allowed: false, status: "none" });
    app.clock.advance(60_000);
    app.consent.record({ person: { person }, answers: [no("marketing", "email")] }, ACTOR);
    expect(may("marketing", "email", { email: "a@example.com" })).toMatchObject({ allowed: false, status: "withdrawn" });
    // Both answers stay in the history, latest first.
    expect(app.consent.person(person).history.map((a) => [a.granted, a.actor])).toEqual([
      [false, ACTOR],
      [true, ACTOR],
    ]);
  });

  it("goes by when the answer was given, not when it was recorded", () => {
    const { person } = app.consent.record({ person: { email: "b@example.com" }, answers: [no("marketing", "email")] }, ACTOR);
    // An older yes imported afterwards does not undo the later no.
    app.consent.record({ person: { person }, source: "import", answers: [yes("marketing", "email", { at: "2026-01-02T10:00:00Z" })] }, ACTOR);
    expect(may("marketing", "email", { person })).toMatchObject({ allowed: false, status: "withdrawn" });
    expect(app.consent.person(person).history).toHaveLength(2);
  });

  it("says no when the identifiers name two different people", () => {
    app.consent.record({ person: { email: "c@example.com" }, answers: [yes("newsletter", "email")] }, ACTOR);
    app.consent.record({ person: { email: "d@example.com", phone: "05551112233" }, answers: [yes("marketing", "sms")] }, ACTOR);
    expect(may("newsletter", "email", { email: "c@example.com", phone: "+905551112233" })).toMatchObject({ allowed: false, person: null });
    expect(() => app.consent.record({ person: { email: "c@example.com", phone: "+905551112233" }, answers: [yes("newsletter", "email")] }, ACTOR)).toThrow(
      /two different people/,
    );
  });

  it("counts required purposes as always given, and refuses to record them", () => {
    expect(may("necessary", "web", { browser: "browser-0001" })).toMatchObject({ allowed: true, status: "granted" });
    expect(() => app.consent.record({ person: { browser: "browser-0001" }, answers: [no("necessary", "web")] }, ACTOR)).toThrow(/required by the site/);
  });

  it("refuses answers the file does not ask", () => {
    const who = { person: { email: "e@example.com" } };
    expect(() => app.consent.record({ ...who, answers: [yes("nope", "email")] }, ACTOR)).toThrow(/no purpose "nope"/);
    expect(() => app.consent.record({ ...who, answers: [yes("newsletter", "sms")] }, ACTOR)).toThrow(/asked on email, not sms/);
    expect(() => app.consent.record({ ...who, answers: [yes("marketing", "sms")] }, ACTOR)).toThrow(/needs the person's phone number/);
    expect(() => app.consent.record({ ...who, answers: [yes("marketing", "email", { version: 9 })] }, ACTOR)).toThrow(/no version 9/);
    expect(() => app.consent.record({ ...who, answers: [yes("marketing", "email", { at: "2027-01-01T00:00:00Z" })] }, ACTOR)).toThrow(/in the future/);
    expect(() => app.consent.record({ ...who, source: "banner", answers: [yes("marketing", "email")] }, ACTOR)).toThrow(/source is api, form or import/);
  });
});

describe("versions of a text", () => {
  const v2 = (renew: boolean) =>
    FILE.replace("{iys}", "").replace(
      "- { version: 1, text: The monthly newsletter. }",
      `- { version: 1, text: The monthly newsletter. }\n      - { version: 2, text: The weekly newsletter.${renew ? ", renew: true" : ""} }`,
    );

  it("keeps earlier consents tied to the version they were given for", () => {
    const { person } = app.consent.record({ person: { email: "f@example.com" }, answers: [yes("newsletter", "email")] }, ACTOR);
    app.consent.setConfig(parseConfig(v2(false)));
    expect(may("newsletter", "email", { person })).toMatchObject({ allowed: true, status: "granted", version: 1, current: 2 });
    expect(
      app.consent
        .purposeList()
        .find((p) => p.id === "newsletter")!
        .versions.map((v) => [v.version, v.granted]),
    ).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("asks again when the new version says renew", () => {
    const { person } = app.consent.record({ person: { email: "g@example.com" }, answers: [yes("newsletter", "email")] }, ACTOR);
    app.consent.setConfig(parseConfig(v2(true)));
    expect(may("newsletter", "email", { person })).toMatchObject({ allowed: false, status: "renew", version: 1, current: 2 });
    app.consent.record({ person: { person }, answers: [yes("newsletter", "email")] }, ACTOR);
    expect(may("newsletter", "email", { person })).toMatchObject({ allowed: true, version: 2 });
    expect(app.consent.purposeList().find((p) => p.id === "newsletter")!.byChannel).toEqual([{ channel: "email", granted: 1, renew: 0, withdrawn: 0 }]);
  });

  it("refuses a file that changes a version's text people already saw", () => {
    const changed = FILE.replace("{iys}", "").replace("The monthly newsletter.", "The daily newsletter.");
    expect(() => app.consent.setConfig(parseConfig(changed))).toThrow(/text of version 1 changed after it was applied.*add version 2/);
    expect(app.consent.textOf("newsletter", 1)).toBe("The monthly newsletter.");
  });

  it("warns, and allows nothing, on a purpose taken out of the file", () => {
    const { person } = app.consent.record({ person: { email: "h@example.com" }, answers: [yes("newsletter", "email")] }, ACTOR);
    const without = FILE.replace("{iys}", "").replace(/  - id: newsletter[\s\S]*?The monthly newsletter. }\n/, "");
    expect(app.consent.setConfig(parseConfig(without))).toEqual(["newsletter is no longer in the file: its answers are kept, and nothing is allowed on it."]);
    expect(app.consent.person(person).standing.find((s) => s.purpose === "newsletter")).toMatchObject({ status: "granted", allowed: false });
  });

  it("dates answers given before a version came into force to the version then in force", () => {
    const file = FILE.replace("{iys}", "").replace(
      '- { version: 1, from: 2025-01-01, text: "Offers by email, SMS and phone." }',
      '- { version: 1, from: 2025-01-01, text: "Offers by email, SMS and phone." }\n      - { version: 2, from: 2026-06-01, text: "Offers and news by email, SMS and phone." }',
    );
    app.consent.setConfig(parseConfig(file));
    const { answers } = app.consent.record(
      {
        person: { email: "i@example.com" },
        source: "import",
        answers: [yes("marketing", "email", { at: "2026-03-01T10:00:00Z" }), yes("marketing", "email", { at: "2026-07-01T10:00:00Z" })],
      },
      ACTOR,
    );
    expect(answers.map((a) => a.version)).toEqual([1, 2]);
  });
});

describe("the history", () => {
  it("cannot be changed or deleted, not even in the database", () => {
    app.consent.record({ person: { email: "j@example.com" }, answers: [yes("newsletter", "email")] }, ACTOR);
    expect(() => app.db.exec("UPDATE answers SET granted = 0")).toThrow(/never changed/);
    expect(() => app.db.exec("DELETE FROM answers")).toThrow(/only removed when a person is erased/);
    expect(() => app.db.exec("UPDATE texts SET text = 'x'")).toThrow(/never changed/);
  });

  it("is erased on the person's request, and the erasure is logged without them", () => {
    const { person } = app.consent.record({ person: { email: "k@example.com", phone: "05550000001" }, answers: [yes("newsletter", "email")] }, ACTOR);
    expect(() => app.consent.erase(person, ACTOR, "")).toThrow(/reason says why/);
    const log = app.consent.erase(person, ACTOR, "Request 2026-114 by email");
    expect(log).toMatchObject({ person, actor: ACTOR, reason: "Request 2026-114 by email", answers: 1, identifiers: 2, iysRefusals: 0 });
    expect(() => app.consent.person(person)).toThrow(/does not exist/);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM answers WHERE person = ?").get(person)).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM identifiers WHERE value = 'k@example.com'").get()).toEqual({ n: 0 });
    expect(JSON.stringify(app.consent.deletions(undefined, 10))).not.toContain("k@example.com");
    expect(() => app.db.exec("DELETE FROM deletions")).toThrow(/never deleted/);
    expect(() => app.consent.erase(person, ACTOR, "again")).toThrow(/does not exist/);
  });
});

describe("people", () => {
  it("are found by any identifier, newest first, a page at a time", () => {
    for (const n of [1, 2, 3]) {
      app.consent.record({ person: { email: `p${n}@example.com`, id: `u-${n}` }, answers: [yes("newsletter", "email")] }, ACTOR);
      app.clock.advance(1000);
    }
    const first = app.consent.people(undefined, undefined, 2);
    expect(first.items.map((p) => p.emails[0])).toEqual(["p3@example.com", "p2@example.com"]);
    expect(app.consent.people(undefined, first.nextCursor, 2).items.map((p) => p.ids[0])).toEqual(["u-1"]);
    expect(app.consent.people("P2@", undefined, 10).items.map((p) => p.emails[0])).toEqual(["p2@example.com"]);
    expect(app.consent.people(undefined, undefined, 10).items[0]).toMatchObject({ granted: 1, withdrawn: 0, browsers: 0 });
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, textHash, textIn, watchConfig } from "./config.ts";

const web = (id: string, extra = "") => `  - id: ${id}\n    name: ${id}\n    channels: [web]${extra}\n    versions: [{ version: 1, text: t }]\n`;
const msg = (id: string, channels = "[email]", extra = "") =>
  `  - id: ${id}\n    name: ${id}\n    channels: ${channels}${extra}\n    versions: [{ version: 1, text: t }]\n`;
const err = (text: string) => {
  try {
    parseConfig(text);
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
};

describe("the file", () => {
  it("reads the example in config/", () => {
    const c = parseConfig(readFileSync(new URL("../config/consent.yaml", import.meta.url), "utf8"));
    expect(c.purposes.map((p) => p.id)).toEqual(["necessary", "analytics", "marketing"]);
    expect(c.purposes[2]).toMatchObject({ channels: ["email", "sms", "call"], iys: true, versions: [{ version: 1, from: "2026-01-01", renew: false }] });
    expect(c.sites[0]).toMatchObject({ name: "shop", banner: ["necessary", "analytics"], preferences: ["marketing"], analytics: "analytics" });
    expect(c.iys).toBeNull();
  });

  it("is empty when empty", () => {
    expect(parseConfig("")).toEqual({ purposes: [], sites: [], iys: null });
  });

  it("gives sites every web purpose on the banner and every message purpose on the preference page by default", () => {
    const c = parseConfig(`purposes:\n${web("a")}${msg("b")}sites:\n  - { name: s, domains: [https://s.example] }\n`);
    expect(c.sites[0]).toMatchObject({ banner: ["a"], preferences: ["b"], analytics: null, language: null, domains: ["https://s.example"] });
  });

  it("reads İYS with secrets named, not given", () => {
    const c = parseConfig(
      `purposes:\n${msg("m", "[email, sms]", "\n    iys: true")}iys:\n  account: 123456\n  brand: "654321"\n  username: IYS_USER\n  password: IYS_PASS\n`,
    );
    expect(c.iys).toEqual({
      url: "https://api.iys.org.tr",
      account: "123456",
      brand: "654321",
      username: "IYS_USER",
      password: "IYS_PASS",
      recipientType: "BIREYSEL",
      pull: 5,
      source: "HS_WEB",
    });
    expect(err(`purposes:\n${msg("m", "[email]", "\n    iys: true")}iys: { account: 1, brand: 2, username: IYS_USER, password: hunter2 }\n`)).toMatch(
      /iys.password is the name of an environment variable/,
    );
  });

  it("says what to fix", () => {
    expect(err("purposes: [")).toMatch(/Not valid YAML/);
    expect(err("other: 1")).toMatch(/purposes:, sites: and iys:/);
    expect(err(`purposes:\n${web("a")}${web("a")}`)).toMatch(/a is in the file twice/);
    expect(err(`purposes:\n  - { id: a, name: a, channels: [fax], versions: [{ version: 1, text: t }] }`)).toMatch(
      /channels is a list of email, sms, call, web/,
    );
    expect(err(`purposes:\n  - { id: a, name: a, channels: [web, email], versions: [{ version: 1, text: t }] }`)).toMatch(/web is a purpose of its own/);
    expect(err(`purposes:\n${msg("a", "[email]", "\n    required: true")}`)).toMatch(/only for web purposes/);
    expect(err(`purposes:\n${web("a", "\n    iys: true")}`)).toMatch(/İYS does not keep cookies/);
    expect(err(`purposes:\n${msg("a", "[email]", "\n    iys: true")}${msg("b", "[email, sms]", "\n    iys: true")}`)).toMatch(
      /a and b both have iys: true on email/,
    );
    expect(err(`purposes:\n  - { id: a, name: a, channels: [web], versions: [{ version: 2, text: t }, { version: 1, text: u }] }`)).toMatch(
      /larger than the one before it/,
    );
    expect(err(`purposes:\n  - { id: a, name: a, channels: [web], versions: [{ version: 1, text: { tr: t } }] }`)).toMatch(/needs an en text/);
    expect(err(`purposes:\n  - { id: a, name: a, channels: [web], versions: [{ version: 1, text: t, from: soon }] }`)).toMatch(/from is a date/);
    expect(err(`purposes:\n${web("a")}sites:\n  - { name: s, domains: [http://s.example] }`)).toMatch(/origin with https/);
    expect(err(`purposes:\n${web("a")}sites:\n  - { name: s, domains: [https://s.example], banner: [b] }`)).toMatch(/no purpose b/);
    expect(err(`purposes:\n${web("a")}${msg("m")}sites:\n  - { name: s, domains: [https://s.example], banner: [m] }`)).toMatch(/m is a message purpose/);
    expect(err(`purposes:\n${web("a", "\n    required: true")}sites:\n  - { name: s, domains: [https://s.example], analytics: a }`)).toMatch(/nothing to ask/);
    expect(err(`purposes:\n${web("a")}iys: { account: 1, brand: 2, username: A, password: B }`)).toMatch(/no purpose has iys: true/);
  });
});

describe("texts", () => {
  it("picks the page's language, then English", () => {
    expect(textIn({ en: "Hi", tr: "Merhaba" }, "tr")).toBe("Merhaba");
    expect(textIn({ en: "Hi", tr: "Merhaba" }, "de")).toBe("Hi");
    expect(textIn("Hi", "tr")).toBe("Hi");
  });

  it("fingerprints a text whatever the order of its languages", () => {
    expect(textHash({ en: "a", tr: "b" })).toBe(textHash({ tr: "b", en: "a" }));
    expect(textHash("a")).toBe(textHash({ en: "a" }));
    expect(textHash("a")).not.toBe(textHash("a."));
  });
});

describe("watching the file", () => {
  it("applies changes and keeps the last good version on a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-"));
    const path = join(dir, "consent.yaml");
    writeFileSync(path, `purposes:\n${web("a")}`);
    const applied: string[][] = [];
    const w = watchConfig(path, (c) => (applied.push(c.purposes.map((p) => p.id)), []), { everyMs: 60_000 });
    expect(w.state).toMatchObject({ purposes: 1, error: null });
    writeFileSync(path, "purposes: [");
    w.read();
    expect(w.state.error).toMatch(/Not valid YAML/);
    writeFileSync(path, `purposes:\n${web("a")}${web("b")}`);
    w.read();
    expect(w.state).toMatchObject({ purposes: 2, error: null });
    expect(applied).toEqual([["a"], ["a", "b"]]);
    w.stop();
  });
});

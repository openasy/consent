// The record of consent: people and how they are known, every answer they gave in order, the purposes and texts they
// answered, and the one rule products ask about: a person may be reached on a channel for a purpose only while their
// latest answer for it is yes.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  CHANNELS,
  IYS_SOURCES,
  MESSAGE_CHANNELS,
  textHash,
  textIn,
  type Channel,
  type Config,
  type ConfigFileState,
  type Purpose,
  type Site,
  type Text,
  type Version,
} from "./config.ts";
import { IYS_TYPE } from "./iys.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden-origin"
  | "not-found"
  | "conflict"
  | "not-configured"
  | "rate-limited"
  | "payload-too-large"
  | "upstream-error"
  | "internal-error";

export class ConsentError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, detail: string, retryAfter?: number) {
    super(detail);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const bad = (detail: string) => new ConsentError(422, "invalid-body", detail);
const notFound = (what: string) => new ConsentError(404, "not-found", `${what} does not exist.`);

export interface Page<T> {
  items: T[];
  /** Opaque; pass it back as `cursor` for the next page. Absent on the last page (ADR 0024). */
  nextCursor?: string;
}

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw bad("cursor is not one this API returned.");
}

export function parseLimit(value: string | null, max = 500, fallback = 100): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`limit must be between 1 and ${max}.`);
  return n;
}

const DAY = 86_400_000;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- Identifiers

export type IdKind = "email" | "phone" | "id" | "browser";
export const ID_KINDS: IdKind[] = ["email", "phone", "id", "browser"];

/** Lowercased and trimmed, or null when it is not an email address. */
export function normalEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && /^[^@\s]{1,64}@[^@\s]+\.[^@\s.]{2,}$/.test(s) ? s : null;
}

/** In E.164, as İYS takes it: 0555 111 22 33 and 905551112233 become +905551112233. Null when it is not a number. */
export function normalPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.replace(/[\s().-]/g, "");
  if (/^0\d{10}$/.test(s)) s = `+90${s.slice(1)}`;
  else if (/^90\d{10}$/.test(s)) s = `+${s}`;
  else if (/^5\d{9}$/.test(s)) s = `+90${s}`;
  else if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

const SITE_ID = /^[^\s]{1,128}$/;
const BROWSER = /^[A-Za-z0-9_-]{8,64}$/;

/** Who an answer or question is about: one or more of an email, a phone, the site's own id, a browser, or our person id. */
export interface Who {
  person?: string;
  email?: string;
  phone?: string;
  id?: string;
  browser?: string;
}

export function parseWho(v: unknown, at = "person"): Who {
  if (!isObj(v)) throw bad(`${at} is a map with email, phone, id, browser or person.`);
  const extra = Object.keys(v).filter((k) => !["person", "email", "phone", "id", "browser"].includes(k));
  if (extra.length) throw bad(`${at}: unknown ${extra.join(", ")}; a person is named by email, phone, id, browser or person.`);
  const who: Who = {};
  if (v.email !== undefined) who.email = normalEmail(v.email) ?? fail(`${at}.email is not an email address.`);
  if (v.phone !== undefined) who.phone = normalPhone(v.phone) ?? fail(`${at}.phone is a phone number, such as +905551112233.`);
  if (v.id !== undefined) {
    if (typeof v.id !== "string" || !SITE_ID.test(v.id)) throw bad(`${at}.id is your own id for the person, 1 to 128 characters without spaces.`);
    who.id = v.id;
  }
  if (v.browser !== undefined) {
    if (typeof v.browser !== "string" || !BROWSER.test(v.browser)) throw bad(`${at}.browser is the banner's browser id, 8 to 64 letters, digits, _ and -.`);
    who.browser = v.browser;
  }
  if (v.person !== undefined) {
    if (typeof v.person !== "string" || !/^[0-9a-f-]{36}$/.test(v.person)) throw bad(`${at}.person is a person id this API returned.`);
    who.person = v.person;
  }
  if (!Object.keys(who).length) throw bad(`${at} names the person by email, phone, id, browser or person.`);
  return who;
}
function fail(detail: string): never {
  throw bad(detail);
}

// ---------------------------------------------------------------- Shapes

export const SOURCES = ["banner", "preferences", "api", "form", "import", "iys"] as const;
export type Source = (typeof SOURCES)[number];

export interface AnswerInput {
  purpose: string;
  channel: Channel;
  granted: boolean;
  /** The version of the text the person saw; by default the one in force when they answered. */
  version?: number;
  /** When they answered; now by default. */
  at?: string;
  /** Where İYS should be told it was given, such as HS_CAGRI_MERKEZI; the file's iys.source by default. */
  iysSource?: string;
  /** What shows the answer was given: a form's name, a call's reference. Never a copy of personal data. */
  proof?: string;
}

type Row = Record<string, any>;

export interface Answer {
  id: number;
  person: string;
  purpose: string;
  channel: Channel;
  version: number | null;
  granted: boolean;
  at: string;
  recordedAt: string;
  source: Source;
  via: string | null;
  actor: string | null;
  iysSource: string | null;
  proof: string | null;
}

const presentAnswer = (r: Row): Answer => ({
  id: r.id as number,
  person: r.person as string,
  purpose: r.purpose as string,
  channel: r.channel as Channel,
  version: (r.version as number | null) ?? null,
  granted: r.granted === 1,
  at: r.at as string,
  recordedAt: r.recorded_at as string,
  source: r.source as Source,
  via: (r.via as string | null) ?? null,
  actor: (r.actor as string | null) ?? null,
  iysSource: (r.iys_source as string | null) ?? null,
  proof: (r.proof as string | null) ?? null,
});

/** What the latest answer on a purpose and channel means now. */
export interface Standing {
  purpose: string;
  channel: Channel;
  /** granted: the latest answer is yes and still counts; withdrawn: it is no; renew: yes, to a text the file asks again for; none: never asked. */
  status: "granted" | "withdrawn" | "renew" | "none";
  allowed: boolean;
  version: number | null;
  /** The version people are asked now. */
  current: number | null;
  at: string | null;
  source: Source | null;
}

export interface ConsentOptions {
  /** Where IYS credentials and other secrets the file names are read; process.env in production. */
  env?: Record<string, string | undefined>;
  fileState?: () => ConfigFileState | null;
  /** Public requests (banner and preference page) a site may send a minute. */
  rateLimit?: number;
  clock?: () => number;
}

export function createConsent(db: DatabaseSync, { env = process.env, fileState = () => null, rateLimit = 1200, clock = Date.now }: ConsentOptions = {}) {
  let config: Config = { purposes: [], sites: [], iys: null };
  let purposes = new Map<string, Purpose>();
  let sites = new Map<string, Site>();
  const windows = new Map<string, { start: number; count: number }>();
  const listeners: Array<(c: Config) => void> = [];

  const now = () => new Date(clock()).toISOString();
  const all = <T = Row>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[];
  const one = <T = Row>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined;
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  // The key that signs preference-page links: made once, kept in the database.
  let linkKey = one<{ value: string }>("SELECT value FROM settings WHERE key = 'link_key'")?.value;
  if (!linkKey) {
    linkKey = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO settings (key, value) VALUES ('link_key', ?)").run(linkKey);
  }
  const key = Buffer.from(linkKey, "base64url");

  /** When each version came into force: its from date, or the day it was first applied. */
  const firstSeen = (purpose: string, version: number) =>
    one<{ first_seen: string }>("SELECT first_seen FROM texts WHERE purpose = ? AND version = ?", purpose, version)?.first_seen ?? null;

  /** The version in force at a time: the last one that had come into force by then, or the first. */
  function versionAt(p: Purpose, at: string): Version {
    let v = p.versions[0]!;
    for (const x of p.versions) {
      const from = x.from ?? firstSeen(p.id, x.version)?.slice(0, 10) ?? null;
      if (from !== null && from <= at.slice(0, 10)) v = x;
    }
    return v;
  }
  const currentOf = (p: Purpose) => p.versions.at(-1)!;

  function purposeOf(id: unknown, at = "purpose"): Purpose {
    const p = typeof id === "string" ? purposes.get(id) : undefined;
    if (!p) throw bad(`${at}: no purpose ${JSON.stringify(id)} in the file.`);
    return p;
  }
  function siteOf(name: string | null | undefined): Site {
    const s = name ? sites.get(name) : undefined;
    if (!s) throw notFound("The site");
    return s;
  }

  // ---------------------------------------------------------------- People

  function identifiersOf(person: string) {
    return all<{ kind: IdKind; value: string; added_at: string }>(
      "SELECT kind, value, added_at FROM identifiers WHERE person = ? ORDER BY added_at, kind, value",
      person,
    );
  }

  /** The person these identifiers name, or undefined; refuses identifiers that name two different people. */
  function find(who: Who): string | undefined {
    const found = new Set<string>();
    if (who.person) {
      if (!one("SELECT 1 FROM people WHERE id = ?", who.person)) throw notFound("The person");
      found.add(who.person);
    }
    for (const kind of ID_KINDS) {
      const value = who[kind];
      if (!value) continue;
      const row = one<{ person: string }>("SELECT person FROM identifiers WHERE kind = ? AND value = ?", kind, value);
      if (row) found.add(row.person);
    }
    if (found.size > 1) throw new ConsentError(409, "conflict", "These identifiers belong to two different people; name one of them.");
    return [...found][0];
  }

  /** The person these identifiers name, made if new, with the identifiers they did not have yet. Inside a transaction. */
  function ensure(who: Who): string {
    let person = find(who);
    if (!person) {
      person = randomUUID();
      db.prepare("INSERT INTO people (id, created_at) VALUES (?, ?)").run(person, now());
    }
    for (const kind of ID_KINDS) {
      const value = who[kind];
      if (value) db.prepare("INSERT OR IGNORE INTO identifiers (kind, value, person, added_at) VALUES (?, ?, ?, ?)").run(kind, value, person, now());
    }
    return person;
  }

  /** Where a channel reaches the person: the identifier given now, or the one added last. */
  function addressOf(person: string, channel: Channel, who: Who): string | null {
    const kind = channel === "email" ? "email" : channel === "web" ? null : "phone";
    if (!kind) return null;
    return (
      who[kind] ??
      one<{ value: string }>("SELECT value FROM identifiers WHERE person = ? AND kind = ? ORDER BY added_at DESC LIMIT 1", person, kind)?.value ??
      null
    );
  }

  const latestSql = `SELECT * FROM answers WHERE person = ? AND purpose = ? AND channel = ? ORDER BY at DESC, id DESC LIMIT 1`;
  const latest = (person: string, purpose: string, channel: Channel) => one(latestSql, person, purpose, channel);

  /** What a latest answer means today: a yes to a text the file has since asked again for no longer counts. */
  function standing(purpose: string, channel: Channel, row: Row | undefined): Standing {
    const p = purposes.get(purpose);
    const current = p ? currentOf(p).version : null;
    if (p?.required) return { purpose, channel, status: "granted", allowed: true, version: current, current, at: null, source: null };
    if (!row) return { purpose, channel, status: "none", allowed: false, version: null, current, at: null, source: null };
    const version = (row.version as number | null) ?? null;
    const renewed = !!p && p.versions.some((v) => v.renew && v.version > (version ?? 0));
    const status = row.granted !== 1 ? "withdrawn" : renewed ? "renew" : "granted";
    // A purpose no longer in the file is asked by no one, so nothing on it is allowed.
    return { purpose, channel, status, allowed: status === "granted" && !!p, version, current, at: row.at as string, source: row.source as Source };
  }

  // ---------------------------------------------------------------- Recording

  type Insert = {
    person: string;
    purpose: Purpose;
    channel: Channel;
    version: number | null;
    granted: boolean;
    at: string;
    source: Source;
    via?: string | null;
    actor?: string | null;
    iysSource?: string | null;
    iysTx?: string | null;
    proof?: string | null;
    address?: string | null;
  };

  /** Adds one answer to the history and, for the purpose kept in step with İYS, queues it for İYS. Inside a transaction. */
  function insert(a: Insert): number {
    const id = Number(
      db
        .prepare(
          `INSERT INTO answers (person, purpose, channel, version, granted, at, recorded_at, source, via, actor, iys_source, iys_tx, proof)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          a.person,
          a.purpose.id,
          a.channel,
          a.version,
          a.granted ? 1 : 0,
          a.at,
          now(),
          a.source,
          a.via ?? null,
          a.actor ?? null,
          a.iysSource ?? null,
          a.iysTx ?? null,
          a.proof ?? null,
        ).lastInsertRowid,
    );
    if (config.iys && a.purpose.iys && a.channel !== "web" && a.source !== "iys" && a.address) {
      db.prepare(`INSERT INTO iys_outbox (answer, person, recipient, type, status, source, consent_date, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        a.person,
        a.address,
        IYS_TYPE[a.channel],
        a.granted ? "ONAY" : "RET",
        a.iysSource ?? config.iys.source,
        a.at,
        now(),
      );
    }
    return id;
  }

  function parseAnswer(v: unknown, at: string): AnswerInput {
    if (!isObj(v)) throw bad(`${at} is a map with purpose, channel and granted.`);
    const extra = Object.keys(v).filter((k) => !["purpose", "channel", "granted", "version", "at", "iysSource", "proof"].includes(k));
    if (extra.length) throw bad(`${at}: unknown ${extra.join(", ")}.`);
    if (!(CHANNELS as readonly unknown[]).includes(v.channel)) throw bad(`${at}.channel is one of ${CHANNELS.join(", ")}.`);
    if (typeof v.granted !== "boolean") throw bad(`${at}.granted is true or false.`);
    if (v.version !== undefined && !Number.isInteger(v.version)) throw bad(`${at}.version is a version number of the purpose's text.`);
    if (v.at !== undefined && (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at)))) throw bad(`${at}.at is a time, such as 2026-11-08T10:00:00Z.`);
    if (v.iysSource !== undefined && !(IYS_SOURCES as readonly unknown[]).includes(v.iysSource))
      throw bad(`${at}.iysSource is one of ${IYS_SOURCES.join(", ")}.`);
    if (v.proof !== undefined && (typeof v.proof !== "string" || v.proof.length > 500)) throw bad(`${at}.proof is up to 500 characters.`);
    return v as unknown as AnswerInput;
  }

  /** Checks one answer against the file and gives the row to insert, without the person. */
  function resolve(a: AnswerInput, at: string, who: Who, person: string | undefined) {
    const p = purposeOf(a.purpose, `${at}.purpose`);
    if (!p.channels.includes(a.channel)) throw bad(`${at}.channel: ${p.id} is asked on ${p.channels.join(", ")}, not ${a.channel}.`);
    if (p.required) throw bad(`${at}: ${p.id} is required by the site; there is no answer to record.`);
    const when = a.at ? new Date(a.at).toISOString() : now();
    if (Date.parse(when) > clock() + 5 * 60_000) throw bad(`${at}.at is in the future.`);
    let version = versionAt(p, when).version;
    if (a.version !== undefined) {
      if (!p.versions.some((v) => v.version === a.version) && firstSeen(p.id, a.version) === null)
        throw bad(`${at}.version: ${p.id} has no version ${a.version}.`);
      version = a.version;
    }
    if (a.channel !== "web" && !(who[a.channel === "email" ? "email" : "phone"] || (person && addressOf(person, a.channel, who))))
      throw bad(`${at}: an answer on ${a.channel} needs the person's ${a.channel === "email" ? "email address" : "phone number"}.`);
    return { purpose: p, channel: a.channel, granted: a.granted, version, at: when, iysSource: a.iysSource ?? null, proof: a.proof ?? null };
  }

  /** Answers from the API: the products and your own applications. */
  function record(body: unknown, actor: string) {
    if (!isObj(body)) throw bad("The body is a map with person and answers.");
    const extra = Object.keys(body).filter((k) => !["person", "answers", "source", "via"].includes(k));
    if (extra.length) throw bad(`unknown ${extra.join(", ")}; the body takes person, answers, source and via.`);
    const who = parseWho(body.person);
    const source = body.source ?? "api";
    if (!["api", "form", "import"].includes(source as string)) throw bad("source is api, form or import; the banner and the preference page record their own.");
    if (body.via !== undefined && (typeof body.via !== "string" || !body.via.trim() || body.via.length > 128))
      throw bad("via names where the answers came from, such as forms/newsletter, up to 128 characters.");
    if (!Array.isArray(body.answers) || !body.answers.length || body.answers.length > 100) throw bad("answers is a list of 1 to 100 answers.");
    const inputs = body.answers.map((a, i) => parseAnswer(a, `answers[${i}]`));
    return tx(() => {
      const existing = find(who);
      const rows = inputs.map((a, i) => resolve(a, `answers[${i}]`, who, existing));
      const person = ensure(who);
      const ids = rows.map((r) =>
        insert({
          ...r,
          person,
          source: source as Source,
          via: (body.via as string | undefined)?.trim() ?? null,
          actor,
          address: addressOf(person, r.channel, who),
        }),
      );
      return {
        person,
        answers: ids.map((id) => presentAnswer(one("SELECT * FROM answers WHERE id = ?", id)!)),
        standing: rows.map((r) => standing(r.purpose.id, r.channel, latest(person, r.purpose.id, r.channel))),
      };
    });
  }

  /** "May we reach this person on this channel for this purpose": one recipient, or up to 1000 at once. */
  /** The latest checks, in memory only, for the Checks page: what was asked, by whom, and the answer. */
  const recentChecks: Array<{
    at: string;
    actor: string;
    purpose: string;
    channel: Channel;
    about: string;
    allowed: boolean;
    status: Standing["status"];
    version: number | null;
    since: string | null;
    source: Source | null;
  }> = [];
  const checkCounts = new Map<string, { day: string; asked: number; no: number }>();

  function check(body: unknown, actor = "") {
    if (!isObj(body)) throw bad("The body is a map with purpose, channel and people.");
    const p = purposeOf(body.purpose);
    const channel = body.channel as Channel;
    if (!(CHANNELS as readonly unknown[]).includes(channel)) throw bad(`channel is one of ${CHANNELS.join(", ")}.`);
    if (!p.channels.includes(channel)) throw bad(`channel: ${p.id} is asked on ${p.channels.join(", ")}, not ${channel}.`);
    if (!Array.isArray(body.people) || !body.people.length || body.people.length > 1000) throw bad("people is a list of 1 to 1000 people.");
    const results = body.people.map((raw, i) => {
      const who = parseWho(raw, `people[${i}]`);
      (body.people as unknown[])[i] = who;
      let person: string | undefined;
      try {
        person = find(who);
      } catch (err) {
        // One person named twice cannot be answered for; nobody is reached on a doubt.
        if (err instanceof ConsentError && err.code === "conflict") return { person: null, ...standing(p.id, channel, undefined), allowed: false };
        if (err instanceof ConsentError && err.code === "not-found") person = undefined;
        else throw err;
      }
      return { person: person ?? null, ...standing(p.id, channel, person ? latest(person, p.id, channel) : undefined) };
    });
    const day = now().slice(0, 10);
    const c = checkCounts.get(actor);
    const counts = c && c.day === day ? c : { day, asked: 0, no: 0 };
    counts.asked += results.length;
    counts.no += results.filter((r) => !r.allowed).length;
    checkCounts.set(actor, counts);
    (body.people as unknown[]).slice(0, 20).forEach((raw, i) => {
      const r = results[i]!;
      const who = raw as Who;
      recentChecks.unshift({
        at: now(),
        actor,
        purpose: p.id,
        channel,
        about: who.email ?? who.phone ?? who.id ?? (who.browser ? "browser" : (who.person ?? "")),
        allowed: r.allowed,
        status: r.status,
        version: r.version,
        since: r.at,
        source: r.source,
      });
    });
    recentChecks.length = Math.min(recentChecks.length, 200);
    return { purpose: p.id, channel, results };
  }

  // ---------------------------------------------------------------- Reading

  function stateOf(person: string): Standing[] {
    const out: Standing[] = [];
    const seen = new Set<string>();
    for (const p of purposes.values())
      for (const c of p.channels) {
        out.push(standing(p.id, c, latest(person, p.id, c)));
        seen.add(`${p.id} ${c}`);
      }
    // Purposes taken out of the file stay in the record, with nothing allowed on them.
    for (const r of all<{ purpose: string; channel: Channel }>(
      "SELECT DISTINCT purpose, channel FROM answers WHERE person = ? ORDER BY purpose, channel",
      person,
    ))
      if (!seen.has(`${r.purpose} ${r.channel}`)) out.push(standing(r.purpose, r.channel, latest(person, r.purpose, r.channel)));
    return out;
  }

  function presentPerson(id: string, created: string) {
    const ids = identifiersOf(id);
    const pick = (k: IdKind) => ids.filter((i) => i.kind === k).map((i) => i.value);
    const counts = one<{ granted: number; withdrawn: number; last: string | null }>(
      `SELECT SUM(granted) AS granted, SUM(1 - granted) AS withdrawn, MAX(at) AS last FROM (
         SELECT granted, at, ROW_NUMBER() OVER (PARTITION BY purpose, channel ORDER BY at DESC, id DESC) AS n FROM answers WHERE person = ?
       ) WHERE n = 1`,
      id,
    );
    return {
      id,
      createdAt: created,
      emails: pick("email"),
      phones: pick("phone"),
      ids: pick("id"),
      browsers: pick("browser").length,
      granted: counts?.granted ?? 0,
      withdrawn: counts?.withdrawn ?? 0,
      lastAnswerAt: counts?.last ?? null,
      latest: all(
        `SELECT purpose, channel, version, granted, at, source FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY purpose, channel ORDER BY at DESC, id DESC) AS n FROM answers WHERE person = ?
         ) WHERE n = 1 ORDER BY purpose, channel`,
        id,
      ).map((r) => ({
        purpose: r.purpose as string,
        channel: r.channel as Channel,
        version: (r.version as number | null) ?? null,
        granted: r.granted === 1,
        at: r.at as string,
        source: r.source as Source,
      })),
      conflict: conflicts(id).length > 0,
    };
  }

  /**
   * Where İYS and the record disagree for a person: on a purpose and channel, the latest answer from İYS and the latest
   * from anywhere else differ. Both are kept; the later one counts.
   */
  function conflicts(person: string) {
    return all(
      `SELECT l.purpose, l.channel, l.granted AS local_granted, l.at AS local_at, l.source AS local_source,
              y.granted AS iys_granted, y.at AS iys_at, y.iys_source AS iys_source
       FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY purpose, channel ORDER BY at DESC, id DESC) AS n FROM answers WHERE person = ? AND source != 'iys') l
       JOIN (SELECT *, ROW_NUMBER() OVER (PARTITION BY purpose, channel ORDER BY at DESC, id DESC) AS n FROM answers WHERE person = ? AND source = 'iys') y
         ON l.purpose = y.purpose AND l.channel = y.channel AND l.n = 1 AND y.n = 1
       WHERE l.granted != y.granted`,
      person,
      person,
    ).map((r) => ({
      purpose: r.purpose as string,
      channel: r.channel as Channel,
      local: { granted: r.local_granted === 1, at: r.local_at as string, source: r.local_source as Source },
      iys: { granted: r.iys_granted === 1, at: r.iys_at as string, source: (r.iys_source as string | null) ?? null },
      counts: (r.iys_at as string) > (r.local_at as string) ? ("iys" as const) : ("local" as const),
    }));
  }

  function people(q: string | undefined, cursor: string | undefined, limit: number, filter?: string): Page<ReturnType<typeof presentPerson>> {
    const offset = decodeCursor(cursor);
    const term = q?.trim().toLowerCase();
    if (filter !== undefined && filter !== "today" && filter !== "conflicts") throw bad("filter is today or conflicts.");
    const conds: string[] = [];
    const args: SQLInputValue[] = [];
    if (term) {
      conds.push("p.id IN (SELECT person FROM identifiers WHERE kind != 'browser' AND instr(lower(value), ?) > 0) OR p.id = ?");
      args.push(normalPhone(term) ?? term, term);
    }
    if (filter === "today") {
      conds.push("p.id IN (SELECT person FROM answers WHERE recorded_at >= ?)");
      args.push(`${now().slice(0, 10)}T00:00:00.000Z`);
    }
    if (filter === "conflicts")
      conds.push(
        "p.id IN (SELECT a.person FROM answers a WHERE a.source = 'iys' AND EXISTS (SELECT 1 FROM answers b WHERE b.person = a.person AND b.purpose = a.purpose AND b.channel = a.channel AND b.source != 'iys'))",
      );
    const where = conds.length ? `WHERE ${conds.map((c) => `(${c})`).join(" AND ")}` : "";
    let rows = all(
      `SELECT p.id, p.created_at FROM people p ${where} ORDER BY p.created_at DESC, p.id LIMIT ? OFFSET ?`,
      ...args,
      filter === "conflicts" ? 1000 : limit + 1,
      filter === "conflicts" ? 0 : offset,
    );
    if (filter === "conflicts") rows = rows.filter((r) => conflicts(r.id as string).length > 0).slice(offset, offset + limit + 1);
    const items = rows.slice(0, limit).map((r) => presentPerson(r.id as string, r.created_at as string));
    return { items, ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }) };
  }

  function person(id: string) {
    const row = one("SELECT id, created_at FROM people WHERE id = ?", id);
    if (!row) throw notFound("The person");
    return {
      ...presentPerson(id, row.created_at as string),
      standing: stateOf(id),
      conflicts: conflicts(id),
      history: all("SELECT * FROM answers WHERE person = ? ORDER BY at DESC, id DESC", id).map(presentAnswer),
      iys: all("SELECT * FROM iys_outbox WHERE person = ? ORDER BY id DESC LIMIT 100", id).map(presentOutbox),
    };
  }

  function presentOutbox(r: Row) {
    return {
      id: r.id as number,
      answer: (r.answer as number | null) ?? null,
      recipient: r.recipient as string,
      type: r.type as string,
      status: r.status as string,
      source: r.source as string,
      consentDate: r.consent_date as string,
      state: r.state as "pending" | "sent" | "failed",
      attempts: r.attempts as number,
      error: (r.error as string | null) ?? null,
      transactionId: (r.transaction_id as string | null) ?? null,
      sentAt: (r.sent_at as string | null) ?? null,
    };
  }

  /** The latest answer of every person, counted by purpose, channel and version. */
  function counts() {
    return all<{ purpose: string; channel: Channel; version: number | null; granted: number; n: number }>(
      `SELECT purpose, channel, version, granted, COUNT(*) AS n FROM (
         SELECT purpose, channel, version, granted, ROW_NUMBER() OVER (PARTITION BY person, purpose, channel ORDER BY at DESC, id DESC) AS rn FROM answers
       ) WHERE rn = 1 GROUP BY purpose, channel, version, granted`,
    );
  }

  function purposeList() {
    const c = counts();
    return [...purposes.values()].map((p) => {
      const mine = c.filter((r) => r.purpose === p.id);
      const renewFrom = Math.max(0, ...p.versions.filter((v) => v.renew).map((v) => v.version));
      return {
        id: p.id,
        name: p.name,
        channels: p.channels,
        required: p.required,
        iys: p.iys,
        current: currentOf(p).version,
        versions: p.versions.map((v) => ({
          version: v.version,
          text: v.text,
          from: v.from ?? firstSeen(p.id, v.version)?.slice(0, 10) ?? null,
          renew: v.renew,
          granted: mine.filter((r) => r.version === v.version && r.granted === 1).reduce((s, r) => s + r.n, 0),
        })),
        byChannel: p.channels.map((ch) => {
          const rows = mine.filter((r) => r.channel === ch);
          const yes = rows.filter((r) => r.granted === 1);
          return {
            channel: ch,
            granted: yes.filter((r) => (r.version ?? 0) >= renewFrom).reduce((s, r) => s + r.n, 0),
            renew: yes.filter((r) => (r.version ?? 0) < renewFrom).reduce((s, r) => s + r.n, 0),
            withdrawn: rows.filter((r) => r.granted === 0).reduce((s, r) => s + r.n, 0),
          };
        }),
        sites: [...sites.values()].filter((s) => s.banner.includes(p.id) || s.preferences.includes(p.id)).map((s) => s.name),
      };
    });
  }

  // ---------------------------------------------------------------- Erasure

  /** Erases a person on their request (KVKK Art. 7 and 11, GDPR Art. 17): their identifiers and their history. Logged. */
  function erase(id: string, actor: string, reason: unknown) {
    if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500)
      throw bad("reason says why the person is erased, such as their request's reference, 3 to 500 characters.");
    return tx(() => {
      if (!one("SELECT 1 FROM people WHERE id = ?", id)) throw notFound("The person");
      // İYS keeps its own record and has no erasure: it is told no for every channel the person had said yes to.
      let refusals = 0;
      if (config.iys)
        for (const s of stateOf(id)) {
          const p = purposes.get(s.purpose);
          if (!p?.iys || s.channel === "web" || s.status === "withdrawn" || s.status === "none") continue;
          const address = addressOf(id, s.channel, {});
          if (!address) continue;
          db.prepare(
            `INSERT INTO iys_outbox (answer, person, recipient, type, status, source, consent_date, next_at) VALUES (NULL, NULL, ?, ?, 'RET', ?, ?, ?)`,
          ).run(address, IYS_TYPE[s.channel], config.iys.source, now(), now());
          refusals++;
        }
      db.prepare("DELETE FROM iys_outbox WHERE person = ? AND state != 'sent'").run(id);
      db.prepare("UPDATE iys_outbox SET person = NULL, answer = NULL, recipient = '' WHERE person = ?").run(id);
      const answers = (one<{ n: number }>("SELECT COUNT(*) AS n FROM answers WHERE person = ?", id)?.n ?? 0) as number;
      const identifiers = (one<{ n: number }>("SELECT COUNT(*) AS n FROM identifiers WHERE person = ?", id)?.n ?? 0) as number;
      db.prepare("INSERT INTO erasing (person) VALUES (?)").run(id);
      db.prepare("DELETE FROM answers WHERE person = ?").run(id);
      db.prepare("DELETE FROM erasing WHERE person = ?").run(id);
      db.prepare("DELETE FROM people WHERE id = ?").run(id);
      const at = now();
      const logId = Number(
        db
          .prepare("INSERT INTO deletions (person, at, actor, reason, answers, identifiers, iys_refusals) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, at, actor, reason.trim(), answers, identifiers, refusals).lastInsertRowid,
      );
      return { id: logId, person: id, at, actor, reason: reason.trim(), answers, identifiers, iysRefusals: refusals };
    });
  }

  function deletions(cursor: string | undefined, limit: number) {
    const offset = decodeCursor(cursor);
    const rows = all("SELECT * FROM deletions ORDER BY id DESC LIMIT ? OFFSET ?", limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((r) => ({
        id: r.id as number,
        person: r.person as string,
        at: r.at as string,
        actor: r.actor as string,
        reason: r.reason as string,
        answers: r.answers as number,
        identifiers: r.identifiers as number,
        iysRefusals: r.iys_refusals as number,
      })),
      ...(rows.length > limit && { nextCursor: encodeCursor(offset + limit) }),
    };
  }

  // ---------------------------------------------------------------- Preference links

  /** A signed link to the preference page that shows this person's message purposes, for an email's footer. */
  function link(body: unknown, publicUrl: string) {
    if (!isObj(body)) throw bad("The body is a map with person and site.");
    const site = siteOf(body.site as string);
    const days = body.days ?? 180;
    if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 730) throw bad("days is 1 to 730.");
    const who = parseWho(body.person);
    const id = find(who);
    if (!id) throw notFound("The person");
    const exp = Math.floor(clock() / 1000) + (days as number) * 86_400;
    const payload = Buffer.from(JSON.stringify({ p: id, e: exp })).toString("base64url");
    const token = `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
    return { url: `${publicUrl}/preferences/${site.name}?t=${token}`, token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** The person a link names, or null when it is not one of ours, has run out or names someone erased. */
  function personOfToken(token: string | null | undefined): string | null {
    if (!token || token.length > 512) return null;
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const want = createHmac("sha256", key).update(payload).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const { p, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { p?: unknown; e?: unknown };
      if (typeof p !== "string" || typeof e !== "number" || e * 1000 < clock()) return null;
      return one("SELECT 1 FROM people WHERE id = ?", p) ? p : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- The banner and the preference page

  function limited(site: Site) {
    const t = clock();
    const w = windows.get(site.name);
    if (!w || t - w.start >= 60_000) return void windows.set(site.name, { start: t, count: 1 });
    if (++w.count > rateLimit) throw new ConsentError(429, "rate-limited", `${site.name} sent more than ${rateLimit} requests this minute.`, 60);
  }

  /** May this page's origin send for the site: one of its domains, or Consent's own preference page. */
  function originAllowed(site: Site, origin: string | undefined, publicUrl: string) {
    return !!origin && (site.domains.includes(origin) || origin === new URL(publicUrl).origin);
  }

  /** What the banner and the preference page show: the site's purposes, their texts, and this browser's or person's answers. */
  function choices(name: string, browser: string | null, token: string | null, language: string | null) {
    const site = siteOf(name);
    const lang = language && /^[a-z]{2}$/.test(language) ? language : site.language;
    if (browser !== null && !BROWSER.test(browser)) throw bad("browser is the banner's browser id, 8 to 64 letters, digits, _ and -.");
    const viaToken = personOfToken(token);
    if (token && !viaToken) throw new ConsentError(401, "invalid-token", "This preference link is not valid any more; ask for a new one.");
    const browserPerson = browser ? one<{ person: string }>("SELECT person FROM identifiers WHERE kind = 'browser' AND value = ?", browser)?.person : undefined;
    const ids = viaToken ? identifiersOf(viaToken) : [];
    const shown = [...site.banner, ...(viaToken ? site.preferences : [])];
    return {
      site: site.name,
      language: lang ?? null,
      privacy: site.privacy,
      person: viaToken
        ? { emails: ids.filter((i) => i.kind === "email").map((i) => i.value), phones: ids.filter((i) => i.kind === "phone").map((i) => i.value) }
        : null,
      purposes: shown.map((id) => {
        const p = purposes.get(id)!;
        const v = currentOf(p);
        const who = p.channels.includes("web") ? (viaToken ?? browserPerson) : viaToken;
        return {
          id: p.id,
          name: textIn(p.name, lang),
          text: textIn(v.text, lang),
          version: v.version,
          required: p.required,
          channels: p.channels.map((c) => {
            const s = standing(p.id, c, who ? latest(who, p.id, c) : undefined);
            return { channel: c, status: s.status, allowed: s.allowed, version: s.version, at: s.at };
          }),
        };
      }),
    };
  }

  /** Answers from the banner or the preference page. Only what changed is recorded. */
  function answer(body: unknown, origin: string | undefined, publicUrl: string) {
    if (!isObj(body)) throw bad("The body is a map with site, browser and answers.");
    const site = siteOf(body.site as string);
    if (!originAllowed(site, origin, publicUrl)) throw new ConsentError(403, "forbidden-origin", `Answers for ${site.name} come only from its domains.`);
    limited(site);
    const from = body.from ?? "banner";
    if (from !== "banner" && from !== "preferences") throw bad("from is banner or preferences.");
    const browser = body.browser;
    if (typeof browser !== "string" || !BROWSER.test(browser)) throw bad("browser is the banner's browser id, 8 to 64 letters, digits, _ and -.");
    const token = typeof body.token === "string" ? body.token : null;
    const viaToken = personOfToken(token);
    if (token && !viaToken) throw new ConsentError(401, "invalid-token", "This preference link is not valid any more; ask for a new one.");
    if (!Array.isArray(body.answers) || !body.answers.length || body.answers.length > 50) throw bad("answers is a list of 1 to 50 answers.");
    const inputs = body.answers.map((a, i) => {
      if (!isObj(a) || typeof a.purpose !== "string" || typeof a.granted !== "boolean") throw bad(`answers[${i}] is a map with purpose and granted.`);
      const p = purposeOf(a.purpose, `answers[${i}].purpose`);
      const web = p.channels.includes("web");
      if (web ? !site.banner.includes(p.id) : !site.preferences.includes(p.id)) throw bad(`answers[${i}]: ${site.name} does not ask ${p.id}.`);
      if (!web && !viaToken) throw new ConsentError(401, "invalid-token", `answers[${i}]: ${p.id} is changed only through a preference link.`);
      const channels = a.channel === undefined ? p.channels.filter((c) => c === "web" || !!viaToken) : [a.channel as Channel];
      const version = a.version === undefined ? undefined : (a.version as number);
      return channels.map((channel) => ({ purpose: p.id, channel, granted: a.granted as boolean, version }));
    });
    const flat = inputs.flat();
    return tx(() => {
      const browserPerson = one<{ person: string }>("SELECT person FROM identifiers WHERE kind = 'browser' AND value = ?", browser)?.person;
      // With a link the person is known; the browser joins them unless it already belongs to someone else.
      const person = viaToken ?? browserPerson ?? ensure({ browser });
      if (viaToken && !browserPerson)
        db.prepare("INSERT INTO identifiers (kind, value, person, added_at) VALUES ('browser', ?, ?, ?)").run(browser, viaToken, now());
      let recorded = 0;
      for (const [i, a] of flat.entries()) {
        const r = resolve(a, `answers[${i}]`, {}, person);
        const last = latest(person, r.purpose.id, r.channel);
        if (last && (last.granted === 1) === r.granted && last.version === r.version) continue;
        insert({ ...r, person, source: from, via: site.name, address: addressOf(person, r.channel, {}) });
        recorded++;
      }
      return { recorded };
    });
  }

  // ---------------------------------------------------------------- The file

  /** Applies a new file; refuses it whole when a version's text changed after it was first applied. */
  function setConfig(next: Config): string[] {
    const warnings: string[] = [];
    tx(() => {
      for (const p of next.purposes)
        for (const v of p.versions) {
          const hash = textHash(v.text);
          const seen = one<{ hash: string }>("SELECT hash FROM texts WHERE purpose = ? AND version = ?", p.id, v.version);
          if (seen && seen.hash !== hash)
            throw new Error(
              `purposes (${p.id}).versions (${v.version}): the text of version ${v.version} changed after it was applied, and people answered the text as it was. Put it back and add version ${p.versions.at(-1)!.version + 1} with the new text.`,
            );
          if (!seen)
            db.prepare("INSERT INTO texts (purpose, version, hash, text, first_seen) VALUES (?, ?, ?, ?, ?)").run(
              p.id,
              v.version,
              hash,
              JSON.stringify(v.text),
              now(),
            );
        }
    });
    for (const p of next.purposes) {
      const gone = all<{ version: number }>("SELECT version FROM texts WHERE purpose = ? ORDER BY version", p.id).filter(
        (r) => !p.versions.some((v) => v.version === r.version),
      );
      if (gone.length) warnings.push(`${p.id}: version ${gone.map((g) => g.version).join(", ")} is no longer in the file; answers to it keep its text.`);
    }
    const ids = new Set(next.purposes.map((p) => p.id));
    for (const r of all<{ purpose: string }>("SELECT DISTINCT purpose FROM texts"))
      if (!ids.has(r.purpose)) warnings.push(`${r.purpose} is no longer in the file: its answers are kept, and nothing is allowed on it.`);
    if (next.iys) for (const k of [next.iys.username, next.iys.password]) if (!env[k]) warnings.push(`iys: ${k} is not set, so İYS is not kept in step.`);
    config = next;
    purposes = new Map(next.purposes.map((p) => [p.id, p]));
    sites = new Map(next.sites.map((s) => [s.name, s]));
    for (const l of listeners) l(next);
    return warnings;
  }

  /** The text of a version as it was first applied, also for versions no longer in the file. */
  function textOf(purpose: string, version: number): Text | null {
    const r = one<{ text: string }>("SELECT text FROM texts WHERE purpose = ? AND version = ?", purpose, version);
    return r ? (JSON.parse(r.text) as Text) : null;
  }

  function summary(iys: unknown) {
    const day = new Date(clock() - DAY).toISOString();
    const n = (sql: string, ...args: SQLInputValue[]) => (one<{ n: number | null }>(sql, ...args)?.n ?? 0) as number;
    return {
      purposes: purposes.size,
      sites: sites.size,
      people: n("SELECT COUNT(*) AS n FROM people"),
      answers: n("SELECT COUNT(*) AS n FROM answers"),
      granted24h: n("SELECT COUNT(*) AS n FROM answers WHERE recorded_at > ? AND granted = 1", day),
      withdrawn24h: n("SELECT COUNT(*) AS n FROM answers WHERE recorded_at > ? AND granted = 0", day),
      deletions: n("SELECT COUNT(*) AS n FROM deletions"),
      file: fileState(),
      iys,
    };
  }

  /** Answers a day, where they came from, and the latest changes, for the overview. */
  function activity(days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw bad("days is 1 to 365.");
    const today = Math.floor(clock() / DAY) * DAY;
    const from = new Date(today - (days - 1) * DAY).toISOString();
    const byDay = new Map(
      all<{ day: string; granted: number; withdrawn: number }>(
        "SELECT substr(recorded_at, 1, 10) AS day, SUM(granted) AS granted, SUM(1 - granted) AS withdrawn FROM answers WHERE recorded_at >= ? GROUP BY day",
        from,
      ).map((r) => [r.day, r]),
    );
    const series = Array.from({ length: days }, (_, i) => {
      const day = new Date(today - (days - 1 - i) * DAY).toISOString().slice(0, 10);
      const r = byDay.get(day);
      return { day, granted: r?.granted ?? 0, withdrawn: r?.withdrawn ?? 0 };
    });
    const sources = all<{ source: Source; granted: number; withdrawn: number }>(
      "SELECT source, SUM(granted) AS granted, SUM(1 - granted) AS withdrawn FROM answers WHERE recorded_at >= ? GROUP BY source ORDER BY COUNT(*) DESC",
      from,
    );
    const recent = all("SELECT * FROM answers ORDER BY recorded_at DESC, id DESC LIMIT 12").map((r) => ({
      ...presentAnswer(r),
      about: labelOf(r.person as string),
    }));
    // Who may be reached now on each channel of each purpose: the latest answers that still count.
    const reach = purposeList().flatMap((p) => p.byChannel.map((c) => ({ purpose: p.id, channel: c.channel, granted: c.granted })));
    return { days, from, series, sources, recent, reach };
  }

  /** How a person is shown: their email, phone or id, never more than one. */
  const labelOf = (person: string) =>
    one<{ value: string }>(
      "SELECT value FROM identifiers WHERE person = ? AND kind != 'browser' ORDER BY CASE kind WHEN 'email' THEN 0 WHEN 'phone' THEN 1 ELSE 2 END, added_at LIMIT 1",
      person,
    )?.value ?? null;

  /** What went to İYS and what came from it, newest first. */
  function iysLog(limit: number) {
    const out = all("SELECT * FROM iys_outbox ORDER BY id DESC LIMIT ?", limit).map((r) => ({
      direction: "out" as const,
      at: ((r.sent_at as string | null) ?? (r.consent_date as string)) as string,
      recipient: r.recipient as string,
      type: r.type as string,
      status: r.status as string,
      state: r.state as "pending" | "sent" | "failed",
      note: (r.error as string | null) ?? null,
      person: (r.person as string | null) ?? null,
    }));
    const into = all("SELECT * FROM answers WHERE source = 'iys' ORDER BY recorded_at DESC, id DESC LIMIT ?", limit).map((r) => ({
      direction: "in" as const,
      at: r.recorded_at as string,
      recipient: addressOf(r.person as string, r.channel as Channel, {}) ?? "",
      type: IYS_TYPE[r.channel as Exclude<Channel, "web">],
      status: r.granted === 1 ? "ONAY" : "RET",
      state: "sent" as const,
      note: (r.iys_source as string | null) ?? null,
      person: r.person as string,
    }));
    return [...out, ...into].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** Everyone İYS and the record disagree about, with both answers and which one counts. */
  function conflictList(limit: number) {
    const ids = all<{ person: string }>(
      `SELECT DISTINCT a.person FROM answers a WHERE a.source = 'iys'
         AND EXISTS (SELECT 1 FROM answers b WHERE b.person = a.person AND b.purpose = a.purpose AND b.channel = a.channel AND b.source != 'iys') LIMIT 1000`,
    );
    return ids
      .flatMap(({ person }) => conflicts(person).map((c) => ({ person, about: labelOf(person), ...c })))
      .sort((a, b) => (b.iys.at > b.local.at ? b.iys.at : b.local.at).localeCompare(a.iys.at > a.local.at ? a.iys.at : a.local.at))
      .slice(0, limit);
  }

  function checks() {
    const day = now().slice(0, 10);
    return {
      recent: recentChecks.slice(0, 100),
      today: [...checkCounts.entries()].filter(([, c]) => c.day === day).map(([actor, c]) => ({ actor, asked: c.asked, no: c.no })),
    };
  }

  function siteList(publicUrl: string) {
    return [...sites.values()].map((s) => ({
      name: s.name,
      domains: s.domains,
      banner: s.banner,
      preferences: s.preferences,
      analytics: s.analytics,
      privacy: s.privacy,
      language: s.language,
      script: `${publicUrl}/c/${s.name}.js`,
      preferencePage: `${publicUrl}/preferences/${s.name}`,
      answers30d: (() => {
        const r = one<{ granted: number | null; withdrawn: number | null }>(
          "SELECT SUM(granted) AS granted, SUM(1 - granted) AS withdrawn FROM answers WHERE via = ? AND source IN ('banner', 'preferences') AND recorded_at >= ?",
          s.name,
          new Date(clock() - 30 * DAY).toISOString(),
        );
        return { granted: r?.granted ?? 0, withdrawn: r?.withdrawn ?? 0 };
      })(),
    }));
  }

  return {
    setConfig,
    config: () => config,
    purposes: () => [...purposes.values()],
    sites: () => [...sites.values()],
    site: (name: string) => sites.get(name),
    onConfig: (fn: (c: Config) => void) => void listeners.push(fn),
    record,
    check,
    checks,
    activity,
    iysLog,
    conflictList,
    people,
    person,
    purposeList,
    textOf,
    erase,
    deletions,
    link,
    choices,
    answer,
    summary,
    siteList,
    presentOutbox,
    gauges: () => ({
      purposes: purposes.size,
      people: (one<{ n: number }>("SELECT COUNT(*) AS n FROM people")?.n ?? 0) as number,
      answers: (one<{ n: number }>("SELECT COUNT(*) AS n FROM answers")?.n ?? 0) as number,
      outbox: Object.fromEntries(all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM iys_outbox GROUP BY state").map((r) => [r.state, r.n])),
    }),
    /** For the İYS sync: an answer İYS got from elsewhere, recorded unless it is one we sent or already have. */
    fromIys(r: { recipient: string; channel: Exclude<Channel, "web">; granted: boolean; at: string; iysSource: string | null; tx: string | null }) {
      const p = [...purposes.values()].find((x) => x.iys && x.channels.includes(r.channel));
      if (!p) return "skipped" as const;
      const address = r.channel === "email" ? normalEmail(r.recipient) : normalPhone(r.recipient);
      if (!address) return "skipped" as const;
      return tx(() => {
        if (r.tx && (one("SELECT 1 FROM iys_outbox WHERE transaction_id = ?", r.tx) || one("SELECT 1 FROM answers WHERE iys_tx = ?", r.tx)))
          return "known" as const;
        const who: Who = r.channel === "email" ? { email: address } : { phone: address };
        const existing = find(who);
        if (existing) {
          // The same answer at the same second, already recorded here: İYS listing back what we sent.
          const same = one(
            "SELECT 1 FROM answers WHERE person = ? AND purpose = ? AND channel = ? AND granted = ? AND substr(at, 1, 19) = ?",
            existing,
            p.id,
            r.channel,
            r.granted ? 1 : 0,
            r.at.slice(0, 19),
          );
          if (same) return "known" as const;
        }
        const person = ensure(who);
        insert({
          person,
          purpose: p,
          channel: r.channel,
          version: versionAt(p, r.at).version,
          granted: r.granted,
          at: r.at,
          source: "iys",
          via: "İYS",
          iysSource: r.iysSource,
          iysTx: r.tx,
        });
        return "recorded" as const;
      });
    },
    /** The message channels a purpose is kept in step with İYS on. */
    iysChannels: (p: Purpose) => (p.iys ? p.channels.filter((c): c is (typeof MESSAGE_CHANNELS)[number] => c !== "web") : []),
  };
}

export type Consent = ReturnType<typeof createConsent>;

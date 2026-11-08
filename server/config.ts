// Purposes, their versioned texts, the sites that show the banner, and İYS, from one YAML file (CONSENT_CONFIG). As
// with every OpenAsy product set in a file, the file is the only way in: no screen or API route adds, changes or
// removes a purpose. It is applied whole or not at all, read again within a minute of a change, and a file with a
// mistake leaves the last good version in place.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";

/** email, SMS and calls are the channels İYS knows; web is the site itself: cookies and storage in the browser. */
export const CHANNELS = ["email", "sms", "call", "web"] as const;
export type Channel = (typeof CHANNELS)[number];
export const MESSAGE_CHANNELS = ["email", "sms", "call"] as const satisfies readonly Channel[];
export const LANGUAGES = ["en", "tr", "de"] as const;
export type Language = (typeof LANGUAGES)[number];

/** A text in one language, or in several keyed by language; English is the fallback. */
export type Text = string | Partial<Record<Language, string>>;

export interface Version {
  version: number;
  /** The text people agree to. Once applied, a version's text cannot change: a new wording is a new version. */
  text: Text;
  /** The date this version came into force, for answers given before it was in the file (imports, İYS). */
  from: string | null;
  /** Consents given to earlier versions no longer count: people are asked again. */
  renew: boolean;
}

export interface Purpose {
  /** Unique in the file; the API and the products name the purpose by it. */
  id: string;
  name: Text;
  channels: Channel[];
  /** A web purpose the site cannot work without, such as the session cookie: shown on the banner, always on, never asked. */
  required: boolean;
  /** Answers on its email, SMS and call channels are the brand's commercial message consent, kept in step with İYS. */
  iys: boolean;
  /** Oldest first; the last is the one people are asked now. */
  versions: Version[];
}

export interface Site {
  /** Unique in the file; the script is served at /c/<name>.js. */
  name: string;
  /** The origins the script may send from. */
  domains: string[];
  /** The web purposes asked on the banner. */
  banner: string[];
  /** The message purposes people can change on the preference page, when the page knows who they are. */
  preferences: string[];
  /** The purpose whose answer starts and stops OpenAsy Analytics on the page (its openasy.consent()). */
  analytics: string | null;
  /** The site's privacy notice, linked from the banner. */
  privacy: string | null;
  /** The banner's language; by default the page's own <html lang>, then English. */
  language: Language | null;
}

export interface IysConfig {
  /** https://api.iys.org.tr, or the sandbox at https://api.sandbox.iys.org.tr. */
  url: string;
  /** The İYS number of the account (İYS kodu). */
  account: string;
  /** The brand's code in İYS (marka kodu). */
  brand: string;
  /** The environment variables that hold the API user and its password; never the values themselves. */
  username: string;
  password: string;
  /** BIREYSEL for people, TACIR for traders. */
  recipientType: "BIREYSEL" | "TACIR";
  /** Minutes between two reads of İYS's changes. */
  pull: number;
  /** The İYS source sent for answers that do not name one (HS_WEB unless set). */
  source: string;
}

export interface Config {
  purposes: Purpose[];
  sites: Site[];
  iys: IysConfig | null;
}

/** The sources İYS takes for where a consent was given. */
export const IYS_SOURCES = [
  "HS_FIZIKSEL_ORTAM",
  "HS_ISLAK_IMZA",
  "HS_WEB",
  "HS_CAGRI_MERKEZI",
  "HS_SOSYAL_MEDYA",
  "HS_EPOSTA",
  "HS_MESAJ",
  "HS_MOBIL",
  "HS_EORTAM",
  "HS_ETKINLIK",
  "HS_2015",
  "HS_ATM",
  "HS_KARAR",
] as const;

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PURPOSE_KEYS = ["id", "name", "channels", "required", "iys", "versions"];
const VERSION_KEYS = ["version", "text", "from", "renew"];
const SITE_KEYS = ["name", "domains", "banner", "preferences", "analytics", "privacy", "language"];
const IYS_KEYS = ["url", "account", "brand", "username", "password", "recipientType", "pull", "source"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function text(v: unknown, at: string, max: number): Text {
  if (typeof v === "string" && v.trim() && v.length <= max) return v.trim();
  if (isObj(v) && Object.keys(v).length && Object.keys(v).every((k) => (LANGUAGES as readonly string[]).includes(k))) {
    const out: Partial<Record<Language, string>> = {};
    for (const [k, s] of Object.entries(v)) {
      if (typeof s !== "string" || !s.trim() || s.length > max) throw new Error(`${at}.${k} is a text of up to ${max} characters.`);
      out[k as Language] = s.trim();
    }
    if (!out.en) throw new Error(`${at} needs an en text, the one shown when the page's language has none.`);
    return out;
  }
  throw new Error(`${at} is a text of up to ${max} characters, or a map of en, tr and de texts.`);
}

/** The text in a language, falling back to English. */
export function textIn(t: Text, lang: string | null | undefined): string {
  if (typeof t === "string") return t;
  return t[(lang ?? "en") as Language] ?? t.en ?? Object.values(t)[0] ?? "";
}

/** A stable fingerprint of a version's text, kept to notice a text changed after people agreed to it. */
export function textHash(t: Text): string {
  const norm = typeof t === "string" ? { en: t } : Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

function origin(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new Error(`${at} is an origin with https://, such as https://www.example.com (http:// only for localhost).`);
  return url.origin;
}

function minutes(v: unknown, at: string): number {
  const m = typeof v === "number" ? [String(v), String(v)] : typeof v === "string" ? /^(\d+)\s*m?$/.exec(v.trim()) : null;
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 1440) throw new Error(`${at} is 1 to 1440 minutes, such as 5m.`);
  return n;
}

function purposeOf(p: unknown, i: number, seen: Set<string>): Purpose {
  const at = `purposes[${i}]`;
  if (!isObj(p)) throw new Error(`${at} must be a map with id, name, channels and versions.`);
  const extra = Object.keys(p).filter((k) => !PURPOSE_KEYS.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; a purpose takes ${PURPOSE_KEYS.join(", ")}.`);
  if (typeof p.id !== "string" || !ID.test(p.id)) throw new Error(`${at}.id is required: up to 32 lowercase letters, digits and -.`);
  const id = p.id;
  if (seen.has(id)) throw new Error(`${at}.id: ${id} is in the file twice.`);
  seen.add(id);
  const where = `${at} (${id})`;
  const name = text(p.name, `${where}.name`, 80);
  if (!Array.isArray(p.channels) || !p.channels.length || p.channels.some((c) => !(CHANNELS as readonly unknown[]).includes(c)))
    throw new Error(`${where}.channels is a list of ${CHANNELS.join(", ")}.`);
  const channels = [...new Set(p.channels as Channel[])];
  const web = channels.includes("web");
  if (web && channels.length > 1) throw new Error(`${where}.channels: web is a purpose of its own; cookies and messages are asked apart.`);
  if (p.required !== undefined && typeof p.required !== "boolean") throw new Error(`${where}.required is true or false.`);
  if (p.required === true && !web) throw new Error(`${where}.required is only for web purposes the site cannot work without.`);
  if (p.iys !== undefined && typeof p.iys !== "boolean") throw new Error(`${where}.iys is true or false.`);
  if (p.iys === true && web) throw new Error(`${where}.iys is for email, sms and call; İYS does not keep cookies.`);
  if (!Array.isArray(p.versions) || !p.versions.length || p.versions.length > 100) throw new Error(`${where}.versions is a list of 1 to 100 versions.`);
  let last = 0;
  let lastFrom = "";
  const versions = p.versions.map((v, n): Version => {
    const vat = `${where}.versions[${n}]`;
    if (!isObj(v)) throw new Error(`${vat} must be a map with version and text.`);
    const vx = Object.keys(v).filter((k) => !VERSION_KEYS.includes(k));
    if (vx.length) throw new Error(`${vat}: unknown ${vx.join(", ")}; a version takes ${VERSION_KEYS.join(", ")}.`);
    if (!Number.isInteger(v.version) || (v.version as number) <= last || (v.version as number) > 10_000)
      throw new Error(`${vat}.version is a whole number larger than the one before it, oldest first.`);
    last = v.version as number;
    let from: string | null = null;
    if (v.from !== undefined) {
      const raw = v.from instanceof Date ? v.from.toISOString().slice(0, 10) : v.from;
      if (typeof raw !== "string" || !DATE.test(raw) || Number.isNaN(Date.parse(raw))) throw new Error(`${vat}.from is a date, such as 2026-01-31.`);
      if (raw < lastFrom) throw new Error(`${vat}.from is before the date of the version before it.`);
      from = lastFrom = raw;
    }
    if (v.renew !== undefined && typeof v.renew !== "boolean") throw new Error(`${vat}.renew is true or false.`);
    return { version: last, text: text(v.text, `${vat}.text`, 4000), from, renew: v.renew === true };
  });
  return { id, name, channels, required: p.required === true, iys: p.iys === true, versions };
}

/** Reads the file's text. Throws with the entry and field at fault, so one message says what to fix. */
export function parseConfig(text: string): Config {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) return { purposes: [], sites: [], iys: null };
  if (!isObj(doc) || Object.keys(doc).some((k) => !["purposes", "sites", "iys"].includes(k)))
    throw new Error("The file holds purposes:, sites: and iys:, and nothing else.");
  const rawPurposes = doc.purposes ?? [];
  if (!Array.isArray(rawPurposes) || rawPurposes.length > 200) throw new Error("purposes is a list of up to 200 purposes.");
  const ids = new Set<string>();
  const purposes = rawPurposes.map((p, i) => purposeOf(p, i, ids));
  for (const channel of MESSAGE_CHANNELS) {
    const iys = purposes.filter((p) => p.iys && p.channels.includes(channel));
    if (iys.length > 1)
      throw new Error(
        `purposes: ${iys.map((p) => p.id).join(" and ")} both have iys: true on ${channel}; İYS keeps one answer per channel, so one purpose holds it.`,
      );
  }
  const byId = new Map(purposes.map((p) => [p.id, p]));

  const rawSites = doc.sites ?? [];
  if (!Array.isArray(rawSites) || rawSites.length > 200) throw new Error("sites is a list of up to 200 sites.");
  const names = new Set<string>();
  const sites = rawSites.map((s, i): Site => {
    const at = `sites[${i}]`;
    if (!isObj(s)) throw new Error(`${at} must be a map with at least name and domains.`);
    const extra = Object.keys(s).filter((k) => !SITE_KEYS.includes(k));
    if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; a site takes ${SITE_KEYS.join(", ")}.`);
    if (typeof s.name !== "string" || !ID.test(s.name)) throw new Error(`${at}.name is required: up to 32 lowercase letters, digits and -.`);
    if (names.has(s.name)) throw new Error(`${at}.name: ${s.name} is in the file twice.`);
    names.add(s.name);
    const where = `${at} (${s.name})`;
    if (!Array.isArray(s.domains) || s.domains.length < 1 || s.domains.length > 20) throw new Error(`${where}.domains is a list of 1 to 20 origins.`);
    const domains = [...new Set(s.domains.map((d, n) => origin(d, `${where}.domains[${n}]`)))];
    const ref = (v: unknown, field: string, web: boolean): string[] => {
      if (v === undefined) return purposes.filter((p) => p.channels.includes("web") === web).map((p) => p.id);
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${where}.${field} is a list of purpose ids.`);
      for (const x of v as string[]) {
        const p = byId.get(x);
        if (!p) throw new Error(`${where}.${field}: no purpose ${x} in the file.`);
        if (p.channels.includes("web") !== web)
          throw new Error(`${where}.${field}: ${x} is ${web ? "a message purpose; the banner asks web purposes" : "a web purpose; the banner asks it"}.`);
      }
      return [...new Set(v as string[])];
    };
    const banner = ref(s.banner, "banner", true);
    const preferences = ref(s.preferences, "preferences", false);
    let analytics: string | null = null;
    if (s.analytics !== undefined) {
      if (typeof s.analytics !== "string" || !banner.includes(s.analytics)) throw new Error(`${where}.analytics is one of the purposes on its banner.`);
      if (byId.get(s.analytics)!.required) throw new Error(`${where}.analytics: ${s.analytics} is required, so there is nothing to ask.`);
      analytics = s.analytics;
    }
    let privacy: string | null = null;
    if (s.privacy !== undefined) {
      const url = typeof s.privacy === "string" ? URL.parse(s.privacy) : null;
      if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error(`${where}.privacy is the address of the site's privacy notice.`);
      privacy = url.href;
    }
    if (s.language !== undefined && !(LANGUAGES as readonly unknown[]).includes(s.language)) throw new Error(`${where}.language is en, tr or de.`);
    return { name: s.name, domains, banner, preferences, analytics, privacy, language: (s.language as Language | undefined) ?? null };
  });

  let iys: IysConfig | null = null;
  if (doc.iys !== undefined && doc.iys !== null) {
    const y = doc.iys;
    if (!isObj(y)) throw new Error("iys is a map with account, brand, username and password.");
    const extra = Object.keys(y).filter((k) => !IYS_KEYS.includes(k));
    if (extra.length) throw new Error(`iys: unknown ${extra.join(", ")}; it takes ${IYS_KEYS.join(", ")}.`);
    const code = (v: unknown, field: string) => {
      const s = typeof v === "number" ? String(v) : v;
      if (typeof s !== "string" || !/^\d{1,12}$/.test(s)) throw new Error(`iys.${field} is the number İYS gave, such as 123456.`);
      return s;
    };
    const env = (v: unknown, field: string) => {
      if (typeof v !== "string" || !ENV.test(v))
        throw new Error(`iys.${field} is the name of an environment variable, such as CONSENT_IYS_PASSWORD, never the value itself.`);
      return v;
    };
    const url = y.url === undefined ? URL.parse("https://api.iys.org.tr") : typeof y.url === "string" ? URL.parse(y.url) : null;
    const localUrl = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && localUrl))) throw new Error("iys.url is İYS's https:// address.");
    if (y.recipientType !== undefined && y.recipientType !== "BIREYSEL" && y.recipientType !== "TACIR")
      throw new Error("iys.recipientType is BIREYSEL or TACIR.");
    if (y.source !== undefined && !(IYS_SOURCES as readonly unknown[]).includes(y.source)) throw new Error(`iys.source is one of ${IYS_SOURCES.join(", ")}.`);
    if (!purposes.some((p) => p.iys)) throw new Error("iys is set, but no purpose has iys: true, so nothing would be kept in step.");
    iys = {
      url: url.origin + url.pathname.replace(/\/$/, ""),
      account: code(y.account, "account"),
      brand: code(y.brand, "brand"),
      username: env(y.username, "username"),
      password: env(y.password, "password"),
      recipientType: (y.recipientType as IysConfig["recipientType"] | undefined) ?? "BIREYSEL",
      pull: y.pull === undefined ? 5 : minutes(y.pull, "iys.pull"),
      source: (y.source as string | undefined) ?? "HS_WEB",
    };
  }
  return { purposes, sites, iys };
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  purposes: number;
  sites: number;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied leaves the
 * last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, purposes: 0, sites: 0, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let body: string;
    let stamp: string;
    try {
      const st = statSync(path);
      body = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(body).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      const config = parseConfig(body);
      state.warnings = apply(config);
      Object.assign(state, { appliedAt: new Date().toISOString(), purposes: config.purposes.length, sites: config.sites.length, error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}

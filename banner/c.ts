// The script a site's pages load from /c/<site>.js. It is built into one small file with no dependencies, and the
// server wraps it with the site's settings: `OAC.start({ site, endpoint, purposes, ... })`.
//
// It shows the cookie banner until the visitor has answered the current text of every purpose on it, keeps their
// answers in this browser and sends them to Consent, and opens the preference panel, where people change their mind.
// With a preference link (?openasy_consent=<token>, or the preference page's ?t=), the panel also shows the message
// purposes of the person the link names, by channel. Rejecting is one click, as accepting is.
//
// The page can read the answers: OpenAsyConsent.get("analytics"), OpenAsyConsent.on(fn), and the openasy:consent
// event on window. A site with `analytics:` in the file starts OpenAsy Analytics through its openasy.consent().

type Text = string | Record<string, string>;
type Channel = "email" | "sms" | "call" | "web";

export interface BannerPurpose {
  id: string;
  name: Text;
  text: Text;
  version: number;
  required: boolean;
  /** Answers to versions before this one no longer count: the banner asks again. */
  since?: number;
}

export interface Config {
  site: string;
  /** Consent's /api/v1/choices. */
  endpoint: string;
  language: string | null;
  privacy: string | null;
  /** The purpose whose answer starts and stops OpenAsy Analytics on the page. */
  analytics: string | null;
  /** Whether the site has message purposes a preference link can show. */
  preferences: boolean;
  purposes: BannerPurpose[];
}

interface Stored {
  /** The answer to each purpose, and the version of the text it was given to. */
  a: Record<string, { g: boolean; v: number }>;
}

/** What the server says about a purpose, for the preference panel. */
interface Choice {
  id: string;
  name: string;
  text: string;
  version: number;
  required: boolean;
  channels: Array<{ channel: Channel; status: "granted" | "withdrawn" | "renew" | "none"; allowed: boolean }>;
}

export interface Api {
  /** true or false once the visitor answered the purpose's current text, null before; required purposes are always true. */
  get(purpose: string): boolean | null;
  /** Opens the preference panel. */
  open(): void;
  /** Called with every purpose's answer whenever it changes; returns a function that stops it. */
  on(fn: (answers: Record<string, boolean | null>) => void): () => void;
}

const BROWSER = "openasy.consent.browser";
const CHOICES = "openasy.consent.choices";

const WORDS = {
  en: {
    title: "Your privacy choices",
    intro: "Choose what this site may store in your browser and measure. You can change it at any time.",
    accept: "Accept all",
    reject: "Reject all",
    choose: "Choose",
    save: "Save choices",
    always: "Always on",
    privacy: "Privacy notice",
    preferences: "Your preferences",
    messages: "Messages",
    site: "On this site",
    email: "Email",
    sms: "SMS",
    call: "Calls",
    saved: "Saved.",
    failed: "Not saved; try again.",
    expired: "This link has run out. Ask for a new one.",
    close: "Close",
  },
  tr: {
    title: "Gizlilik tercihleriniz",
    intro: "Bu sitenin tarayıcınızda neleri saklayabileceğini ve ölçebileceğini seçin. İstediğiniz zaman değiştirebilirsiniz.",
    accept: "Tümünü kabul et",
    reject: "Tümünü reddet",
    choose: "Seç",
    save: "Seçimleri kaydet",
    always: "Her zaman açık",
    privacy: "Aydınlatma metni",
    preferences: "Tercihleriniz",
    messages: "İletiler",
    site: "Bu sitede",
    email: "E-posta",
    sms: "SMS",
    call: "Arama",
    saved: "Kaydedildi.",
    failed: "Kaydedilemedi; yeniden deneyin.",
    expired: "Bu bağlantının süresi doldu. Yenisini isteyin.",
    close: "Kapat",
  },
  de: {
    title: "Ihre Datenschutzeinstellungen",
    intro: "Wählen Sie, was diese Website in Ihrem Browser speichern und messen darf. Sie können es jederzeit ändern.",
    accept: "Alle akzeptieren",
    reject: "Alle ablehnen",
    choose: "Auswählen",
    save: "Auswahl speichern",
    always: "Immer aktiv",
    privacy: "Datenschutzhinweis",
    preferences: "Ihre Einstellungen",
    messages: "Nachrichten",
    site: "Auf dieser Website",
    email: "E-Mail",
    sms: "SMS",
    call: "Anrufe",
    saved: "Gespeichert.",
    failed: "Nicht gespeichert; bitte erneut versuchen.",
    expired: "Dieser Link ist abgelaufen. Fordern Sie einen neuen an.",
    close: "Schließen",
  },
};
type Lang = keyof typeof WORDS;

const STYLE = `
.oac{--oac-bg:#fff;--oac-fg:#111827;--oac-muted:#4b5563;--oac-line:#e5e7eb;--oac-accent:#2563eb;--oac-on:#fff;
font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--oac-fg);box-sizing:border-box}
@media (prefers-color-scheme:dark){.oac{--oac-bg:#111827;--oac-fg:#f3f4f6;--oac-muted:#9ca3af;--oac-line:#374151;--oac-accent:#60a5fa;--oac-on:#0b0f17}}
.oac *{box-sizing:inherit}
.oac-bar{position:fixed;z-index:2147483646;left:16px;right:16px;bottom:16px;max-width:42rem;margin:0 auto;background:var(--oac-bg);
border:1px solid var(--oac-line);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:16px}
.oac-page{background:var(--oac-bg);border:1px solid var(--oac-line);border-radius:12px;padding:20px}
.oac h2{font-size:16px;margin:0 0 6px}.oac h3{font-size:13px;margin:14px 0 6px;color:var(--oac-muted);text-transform:uppercase;letter-spacing:.04em}
.oac p{margin:0 0 10px;color:var(--oac-muted)}
.oac-row{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--oac-line)}
.oac-row label{flex:1;cursor:pointer}.oac-row strong{display:block;color:var(--oac-fg)}.oac-row span{color:var(--oac-muted);font-size:13px;white-space:pre-line}
.oac-row input{margin-top:3px;width:18px;height:18px;accent-color:var(--oac-accent)}
.oac-ch{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px}.oac-ch label{flex:none;display:flex;gap:6px;align-items:center;font-size:13px}
.oac-ch input{margin:0}
.oac-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:center}
.oac button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--oac-accent);background:var(--oac-accent);color:var(--oac-on);cursor:pointer}
.oac button.oac-plain{background:transparent;color:var(--oac-accent)}
.oac a{color:var(--oac-accent)}.oac-note{font-size:13px;color:var(--oac-muted)}
`;

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // answers last for this page only
  }
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function textOf(t: Text, lang: string): string {
  return typeof t === "string" ? t : (t[lang] ?? t.en ?? Object.values(t)[0] ?? "");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

export function start(config: Config, { signal }: { signal?: AbortSignal } = {}): Api {
  const page = document.currentScript?.getAttribute("data-page") === "preferences" || !!document.getElementById("openasy-preferences");
  const lang: Lang = (() => {
    const pick = (config.language ?? document.documentElement.lang ?? navigator.language ?? "en").slice(0, 2).toLowerCase();
    return (pick in WORDS ? pick : "en") as Lang;
  })();
  const w = WORDS[lang];
  const query = new URLSearchParams(location.search);
  const token = query.get("openasy_consent") ?? (page ? query.get("t") : null) ?? document.currentScript?.getAttribute("data-token") ?? null;

  let browser = get(BROWSER);
  if (!browser || !/^[A-Za-z0-9_-]{8,64}$/.test(browser)) {
    browser = randomId();
    set(BROWSER, browser);
  }
  let stored: Stored = { a: {} };
  try {
    const raw = JSON.parse(get(CHOICES) ?? "null") as Stored | null;
    if (raw && typeof raw.a === "object") stored = raw;
  } catch {
    // asked again
  }
  const listeners: Array<(a: Record<string, boolean | null>) => void> = [];
  let bar: HTMLElement | null = null;

  function answerOf(p: BannerPurpose): boolean | null {
    if (p.required) return true;
    const a = stored.a[p.id];
    return a && a.v >= (p.since ?? 1) ? a.g : null;
  }
  const answers = () => Object.fromEntries(config.purposes.map((p) => [p.id, answerOf(p)]));

  /** Tells the page, and Analytics when the site has it wait for this purpose. */
  function announce(changed: string[]) {
    const all = answers();
    window.dispatchEvent(new CustomEvent("openasy:consent", { detail: all }));
    for (const fn of listeners) fn(all);
    const id = config.analytics;
    if (id && changed.includes(id) && all[id] !== null) {
      const oa = ((window as unknown as { openasy?: { consent?: (g: boolean) => void; q?: unknown[][] } }).openasy ??= { q: [] });
      if (typeof oa.consent === "function") oa.consent(all[id]!);
      else (oa.q ??= []).push(["consent", all[id]]);
    }
  }

  async function post(items: Array<{ purpose: string; granted: boolean; version?: number; channel?: Channel }>, from: "banner" | "preferences") {
    if (!items.length) return true;
    try {
      const res = await fetch(config.endpoint, {
        method: "POST",
        // text/plain needs no preflight; the server reads JSON either way.
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ site: config.site, browser, from, answers: items, ...(token && { token }) }),
        keepalive: true,
        credentials: "omit",
        signal,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Keeps the banner's answers here and sends them. Only what changed goes out. */
  function decide(choice: Record<string, boolean>, from: "banner" | "preferences") {
    const changed: string[] = [];
    const items: Array<{ purpose: string; granted: boolean; version: number }> = [];
    for (const p of config.purposes) {
      if (p.required || !(p.id in choice)) continue;
      const g = choice[p.id]!;
      const was = stored.a[p.id];
      if (!was || was.g !== g || was.v !== p.version) {
        changed.push(p.id);
        items.push({ purpose: p.id, granted: g, version: p.version });
      }
      stored.a[p.id] = { g, v: p.version };
    }
    set(CHOICES, JSON.stringify(stored));
    if (changed.length) announce(changed);
    return post(items, from);
  }

  function style() {
    if (document.getElementById("oac-style")) return;
    const s = el("style", { id: "oac-style" });
    s.textContent = STYLE;
    document.head.append(s);
  }

  function purposeRow(p: { id: string; name: string; text: string; required: boolean }, checked: boolean) {
    const id = `oac-${p.id}`;
    const input = el("input", { type: "checkbox", id, name: p.id });
    input.checked = checked || p.required;
    input.disabled = p.required;
    return el(
      "div",
      { class: "oac-row" },
      input,
      el("label", { for: id }, el("strong", {}, p.name, p.required ? ` (${w.always})` : ""), el("span", {}, p.text)),
    );
  }

  function showBanner() {
    if (bar || page || signal?.aborted) return;
    style();
    const list = el("div", { hidden: "" });
    for (const p of config.purposes)
      list.append(purposeRow({ id: p.id, name: textOf(p.name, lang), text: textOf(p.text, lang), required: p.required }, answerOf(p) === true));
    const all = (g: boolean) => Object.fromEntries(config.purposes.map((p) => [p.id, g]));
    const close = () => (bar?.remove(), (bar = null));
    const accept = el("button", { type: "button", "data-oac": "accept" }, w.accept);
    const reject = el("button", { type: "button", "data-oac": "reject" }, w.reject);
    const choose = el("button", { type: "button", class: "oac-plain", "data-oac": "choose" }, w.choose);
    const save = el("button", { type: "button", class: "oac-plain", "data-oac": "save", hidden: "" }, w.save);
    accept.onclick = () => (void decide(all(true), "banner"), close());
    reject.onclick = () => (void decide(all(false), "banner"), close());
    choose.onclick = () => (list.removeAttribute("hidden"), save.removeAttribute("hidden"), choose.setAttribute("hidden", ""));
    save.onclick = () => {
      const choice: Record<string, boolean> = {};
      for (const input of Array.from(list.querySelectorAll("input"))) choice[input.name] = input.checked;
      void decide(choice, "banner");
      close();
    };
    const actions = el("div", { class: "oac-actions" }, reject, accept, choose, save);
    if (config.privacy) actions.append(el("a", { href: config.privacy, target: "_blank", rel: "noopener" }, w.privacy));
    bar = el(
      "div",
      { class: "oac oac-bar", role: "dialog", "aria-label": w.title, "data-openasy-consent": "banner" },
      el("h2", {}, w.title),
      el("p", {}, w.intro),
      list,
      actions,
    );
    document.body.append(bar);
  }

  /** The preference panel: the banner's purposes, and with a link the person's messages by channel. */
  async function openPanel(into?: HTMLElement) {
    style();
    bar?.remove();
    bar = null;
    const box = el("div", {
      class: into ? "oac oac-page" : "oac oac-bar",
      role: into ? "region" : "dialog",
      "aria-label": w.preferences,
      "data-openasy-consent": "preferences",
    });
    box.append(el("h2", {}, w.preferences));
    const note = el("p", { class: "oac-note", "aria-live": "polite" });
    let server: Choice[] = [];
    if (token || config.preferences) {
      try {
        const q = new URLSearchParams({ site: config.site, browser: browser!, lang, ...(token && { token }) });
        const res = await fetch(`${config.endpoint}?${q}`, { credentials: "omit", signal });
        if (res.status === 401) note.textContent = w.expired;
        else if (res.ok) server = ((await res.json()) as { purposes: Choice[] }).purposes;
      } catch {
        // the banner's purposes are still shown from this browser
      }
    }
    const web = el("div");
    for (const p of config.purposes)
      web.append(purposeRow({ id: p.id, name: textOf(p.name, lang), text: textOf(p.text, lang), required: p.required }, answerOf(p) === true));
    box.append(el("h3", {}, w.site), web);
    const messages = server.filter((p) => !p.channels.some((c) => c.channel === "web"));
    const msgBox = el("div");
    for (const p of messages) {
      const ch = el("div", { class: "oac-ch" });
      for (const c of p.channels) {
        const input = el("input", { type: "checkbox", name: p.id, "data-channel": c.channel, "data-version": String(p.version) });
        input.checked = c.allowed;
        ch.append(el("label", {}, input, w[c.channel as "email" | "sms" | "call"]));
      }
      msgBox.append(el("div", { class: "oac-row" }, el("label", {}, el("strong", {}, p.name), el("span", {}, p.text), ch)));
    }
    if (messages.length) box.append(el("h3", {}, w.messages), msgBox);
    const save = el("button", { type: "button", "data-oac": "save" }, w.save);
    save.onclick = async () => {
      const choice: Record<string, boolean> = {};
      for (const input of Array.from(web.querySelectorAll("input"))) if (!input.disabled) choice[input.name] = input.checked;
      const items: Array<{ purpose: string; granted: boolean; version: number; channel: Channel }> = [];
      for (const input of Array.from(msgBox.querySelectorAll("input"))) {
        const p = messages.find((m) => m.id === input.name)!;
        const was = p.channels.find((c) => c.channel === input.dataset.channel)!;
        if (was.allowed !== input.checked) items.push({ purpose: p.id, granted: input.checked, version: p.version, channel: was.channel });
      }
      const ok = (await decide(choice, "preferences")) && (await post(items, "preferences"));
      for (const i of items) {
        const c = messages.find((m) => m.id === i.purpose)!.channels.find((x) => x.channel === i.channel)!;
        if (ok) c.allowed = i.granted;
      }
      note.textContent = ok ? w.saved : w.failed;
      if (ok && !into) setTimeout(() => box.remove(), 800);
    };
    const actions = el("div", { class: "oac-actions" }, save);
    if (!into) {
      const close = el("button", { type: "button", class: "oac-plain", "data-oac": "close" }, w.close);
      close.onclick = () => box.remove();
      actions.append(close);
    }
    if (config.privacy) actions.append(el("a", { href: config.privacy, target: "_blank", rel: "noopener" }, w.privacy));
    box.append(actions, note);
    (into ?? document.body).append(box);
  }

  const api: Api = {
    get: (purpose) => {
      const p = config.purposes.find((x) => x.id === purpose);
      return p ? answerOf(p) : null;
    },
    open: () => void openPanel(),
    on: (fn) => {
      listeners.push(fn);
      return () => void listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  (window as unknown as { OpenAsyConsent?: Api }).OpenAsyConsent = api;

  const ready = () => {
    const container = document.getElementById("openasy-preferences");
    if (container) return void openPanel(container);
    if (token) return void openPanel();
    if (config.purposes.some((p) => answerOf(p) === null)) showBanner();
    // Analytics on a site that asks first starts on every page the visitor has said yes.
    if (config.analytics && answerOf(config.purposes.find((p) => p.id === config.analytics)!) === true) announce([config.analytics]);
  };
  // Links and buttons the site marks open the panel: <a href="#" data-openasy-preferences>Cookie settings</a>.
  document.addEventListener(
    "click",
    (e) => {
      const t = (e.target as Element | null)?.closest?.("[data-openasy-preferences]");
      if (t) (e.preventDefault(), api.open());
    },
    { signal },
  );
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true, signal });
  else ready();
  return api;
}

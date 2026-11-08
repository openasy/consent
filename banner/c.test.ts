// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start, type Config } from "./c.ts";

const config: Config = {
  site: "shop",
  endpoint: "https://consent.example/api/v1/choices",
  language: null,
  privacy: "https://shop.example/privacy",
  analytics: "analytics",
  preferences: true,
  purposes: [
    { id: "necessary", name: "Necessary", text: "The session.", version: 1, required: true },
    { id: "analytics", name: { en: "Measurement", tr: "Ölçüm" }, text: { en: "Pages read.", tr: "Okunan sayfalar." }, version: 1, required: false },
  ],
};

let stop: AbortController;
let sent: Array<Record<string, any>>;
let served: unknown;

beforeEach(() => {
  stop = new AbortController();
  sent = [];
  served = { purposes: [] };
  localStorage.clear();
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  history.replaceState(null, "", "/");
  delete (window as { openasy?: unknown }).openasy;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") sent.push(JSON.parse(init.body as string));
      if (url.includes("token=expired")) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify(init?.method === "POST" ? { recorded: 1 } : served), { status: 200 });
    }),
  );
});
afterEach(() => (stop.abort(), vi.unstubAllGlobals()));

const bar = () => document.querySelector<HTMLElement>("[data-openasy-consent]");
const click = (what: string) => document.querySelector<HTMLButtonElement>(`[data-oac="${what}"]`)!.click();
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the banner", () => {
  it("asks until the visitor answers, rejecting as easily as accepting", async () => {
    const api = start(config, { signal: stop.signal });
    expect(bar()?.dataset.openasyConsent).toBe("banner");
    expect(bar()!.textContent).toContain("Reject all");
    expect(bar()!.textContent).toContain("Accept all");
    expect(api.get("analytics")).toBeNull();
    expect(api.get("necessary")).toBe(true);
    click("reject");
    await tick();
    expect(bar()).toBeNull();
    expect(api.get("analytics")).toBe(false);
    expect(sent).toEqual([
      { site: "shop", browser: expect.stringMatching(/^[0-9a-f]{32}$/), from: "banner", answers: [{ purpose: "analytics", granted: false, version: 1 }] },
    ]);
    // The next page does not ask again.
    stop.abort();
    stop = new AbortController();
    start(config, { signal: stop.signal });
    expect(bar()).toBeNull();
  });

  it("asks again when the text has a version that asks again", () => {
    start(config, { signal: stop.signal });
    click("accept");
    stop.abort();
    stop = new AbortController();
    const next = { ...config, purposes: [config.purposes[0]!, { ...config.purposes[1]!, version: 2 }] };
    expect(start(next, { signal: stop.signal }).get("analytics")).toBe(true);
    stop.abort();
    stop = new AbortController();
    const renew = { ...config, purposes: [config.purposes[0]!, { ...config.purposes[1]!, version: 2, since: 2 }] };
    expect(start(renew, { signal: stop.signal }).get("analytics")).toBeNull();
    expect(bar()?.dataset.openasyConsent).toBe("banner");
  });

  it("lets the visitor choose each purpose, in the page's language", () => {
    document.documentElement.lang = "tr";
    start(config, { signal: stop.signal });
    expect(bar()!.textContent).toContain("Tümünü reddet");
    click("choose");
    const box = document.querySelector<HTMLInputElement>('input[name="analytics"]')!;
    expect(box.closest(".oac-row")!.textContent).toContain("Ölçüm");
    expect(document.querySelector<HTMLInputElement>('input[name="necessary"]')!.disabled).toBe(true);
    box.checked = true;
    click("save");
    expect(sent[0]!.answers).toEqual([{ purpose: "analytics", granted: true, version: 1 }]);
  });

  it("starts and stops OpenAsy Analytics, before or after it loads", () => {
    const api = start(config, { signal: stop.signal });
    const events: unknown[] = [];
    window.addEventListener("openasy:consent", (e) => events.push((e as CustomEvent).detail), { signal: stop.signal });
    const seen: unknown[] = [];
    api.on((a) => seen.push(a));
    click("accept");
    // Analytics has not loaded: the call waits in its queue.
    expect((window as any).openasy.q).toEqual([["consent", true]]);
    expect(events).toEqual([{ necessary: true, analytics: true }]);
    expect(seen).toHaveLength(1);
    const consent = vi.fn();
    (window as any).openasy = { consent };
    api.open();
    return tick().then(() => {
      document.querySelector<HTMLInputElement>('input[name="analytics"]')!.checked = false;
      click("save");
      expect(consent).toHaveBeenCalledWith(false);
    });
  });
});

describe("the preference panel", () => {
  it("shows the messages of the person a link names, and sends what changed", async () => {
    history.replaceState(null, "", "/account?openasy_consent=tok123");
    served = {
      purposes: [
        {
          id: "analytics",
          name: "Measurement",
          text: "Pages read.",
          version: 1,
          required: false,
          channels: [{ channel: "web", status: "none", allowed: false }],
        },
        {
          id: "marketing",
          name: "Offers",
          text: "Offers.",
          version: 3,
          required: false,
          channels: [
            { channel: "email", status: "granted", allowed: true },
            { channel: "sms", status: "none", allowed: false },
          ],
        },
      ],
    };
    start(config, { signal: stop.signal });
    await tick();
    expect(bar()?.dataset.openasyConsent).toBe("preferences");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toContain("token=tok123");
    const sms = document.querySelector<HTMLInputElement>('input[name="marketing"][data-channel="sms"]')!;
    expect(document.querySelector<HTMLInputElement>('input[name="marketing"][data-channel="email"]')!.checked).toBe(true);
    sms.checked = true;
    click("save");
    await tick();
    await tick();
    expect(sent.at(-1)).toMatchObject({ from: "preferences", token: "tok123", answers: [{ purpose: "marketing", channel: "sms", granted: true, version: 3 }] });
  });

  it("is drawn inside the preference page, and says when a link ran out", async () => {
    history.replaceState(null, "", "/preferences/shop?t=expired");
    document.body.innerHTML = '<main id="openasy-preferences"></main>';
    start(config, { signal: stop.signal });
    await tick();
    await tick();
    const page = document.querySelector("#openasy-preferences [data-openasy-consent]");
    expect(page).not.toBeNull();
    expect(page!.textContent).toContain("This link has run out");
  });

  it("opens from any element marked data-openasy-preferences", async () => {
    start(config, { signal: stop.signal });
    click("accept");
    document.body.insertAdjacentHTML("beforeend", '<a href="#" data-openasy-preferences>Cookie settings</a>');
    document.querySelector<HTMLAnchorElement>("[data-openasy-preferences]")!.click();
    await tick();
    expect(bar()?.dataset.openasyConsent).toBe("preferences");
  });
});

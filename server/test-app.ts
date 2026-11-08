// Starts the app on a random port for tests, with a fake İYS when asked.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { createConsent } from "./consent.ts";
import { openDb } from "./db.ts";
import { startFakeIys, type FakeIys } from "./iys-fake.ts";
import { createSync } from "./sync.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const SHOP = "https://www.shop.example";

/** The file the tests start with; {iys} is replaced with the fake İYS's settings, or nothing. */
export const FILE = `
purposes:
  - id: necessary
    name: Necessary
    channels: [web]
    required: true
    versions:
      - { version: 1, text: The session. }
  - id: analytics
    name: { en: Measurement, tr: Ölçüm }
    channels: [web]
    versions:
      - { version: 1, text: { en: Pages read., tr: Okunan sayfalar. } }
  - id: marketing
    name: Offers
    channels: [email, sms, call]
    iys: true
    versions:
      - { version: 1, from: 2025-01-01, text: "Offers by email, SMS and phone." }
  - id: newsletter
    name: Newsletter
    channels: [email]
    versions:
      - { version: 1, text: The monthly newsletter. }
sites:
  - name: shop
    domains: [${SHOP}]
    analytics: analytics
    privacy: ${SHOP}/privacy
{iys}
`;

export const iysBlock = (url: string) => `iys:
  url: ${url}
  account: 123456
  brand: 654321
  username: IYS_USER
  password: IYS_PASS
  pull: 5m`;

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-11-08T09:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (iso: string) => void (t = Date.parse(iso)) });
}

export async function startApp(opts: Partial<AppOptions> & { version?: string; file?: string; iys?: boolean } = {}) {
  const db = openDb(":memory:");
  const { file, iys: withIys = false, version = "0.1.0", ...rest } = opts;
  const clock = fakeClock();
  const fake: FakeIys | null = withIys ? await startFakeIys({ username: "api-user", password: "api-pass" }) : null;
  const env = { IYS_USER: "api-user", IYS_PASS: "api-pass" };
  const consent = createConsent(db, { env, clock });
  const sync = createSync(db, consent, { env, clock });
  const text = (file ?? FILE).replace("{iys}", fake ? iysBlock(fake.url) : "");
  consent.setConfig(parseConfig(text));
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "consent", productName: "OpenAsy Consent", origin: base });
  handler = createApp({ db, consent, sync, auth, version, adminToken: ADMIN_TOKEN, publicUrl: base, banner: "var OAC={start:function(){}};", ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  /** Sends what the banner sends: text/plain, from the page's origin. */
  const page = (body: unknown, origin = SHOP) =>
    fetch(`${base}/api/v1/choices`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "text/plain;charset=UTF-8", ...(origin && { origin }) },
    });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fake?.close();
  };
  return { db, consent, sync, auth, base, admin, page, clock, fake, close };
}

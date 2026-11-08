// A client for İYS, Türkiye's İleti Yönetim Sistemi, through its REST API: a token from /oauth2/token with the API
// user's name and password, then under /sps/{account}/brands/{brand}: POST /consents adds one answer, POST
// /consents/status asks for a recipient's answer on a channel, and GET /consents/changes lists the answers İYS got
// from elsewhere (an SMS reply, the İYS site or app, a call to İYS), from a cursor on.
//
// The paths, fields and values follow İYS's published API description and its client libraries. This product was
// tested only against the fake İYS in iys-fake.ts, never against the real service: check it against your İYS
// account's sandbox before relying on it.
import type { Channel } from "./config.ts";

export type IysType = "EPOSTA" | "MESAJ" | "ARAMA";
export type IysStatus = "ONAY" | "RET";

export const IYS_TYPE: Record<Exclude<Channel, "web">, IysType> = { email: "EPOSTA", sms: "MESAJ", call: "ARAMA" };
export const CHANNEL_OF: Record<IysType, Exclude<Channel, "web">> = { EPOSTA: "email", MESAJ: "sms", ARAMA: "call" };

export interface IysConsent {
  /** An email address for EPOSTA, a phone number such as +905551112233 for MESAJ and ARAMA. */
  recipient: string;
  recipientType: "BIREYSEL" | "TACIR";
  type: IysType;
  status: IysStatus;
  /** Where the answer was given, such as HS_WEB or HS_MESAJ. */
  source: string;
  /** "YYYY-MM-DD HH:mm:ss", Türkiye's time. */
  consentDate: string;
}

export interface IysRecord extends IysConsent {
  /** When İYS recorded it. */
  creationDate?: string;
  transactionId?: string;
}

export interface IysClient {
  add(consent: IysConsent): Promise<{ transactionId: string; creationDate?: string }>;
  /** The answer İYS holds, or null when it holds none. */
  status(query: { recipient: string; recipientType: IysConsent["recipientType"]; type: IysType }): Promise<IysRecord | null>;
  /** Answers İYS recorded after the cursor, oldest first, and the cursor to ask from next. */
  changes(after: string | null, limit: number): Promise<{ after: string | null; list: IysRecord[] }>;
}

/** An answer from İYS that is not a success. permanent: sending the same again will not help. */
export class IysError extends Error {
  readonly status: number;
  readonly permanent: boolean;
  constructor(message: string, status: number, permanent: boolean) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

/** Türkiye has kept UTC+3 all year since 2016. */
const TR = 3 * 3_600_000;

/** An ISO time as İYS writes dates: "2026-11-08 15:04:05" in Türkiye's time. */
export function toIysDate(iso: string): string {
  return new Date(Date.parse(iso) + TR).toISOString().slice(0, 19).replace("T", " ");
}

/** İYS's "2026-11-08 15:04:05" (Türkiye's time) as an ISO time, or null when it is not one. */
export function fromIysDate(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(s.trim());
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}+03:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export interface HttpIysOptions {
  url: string;
  account: string;
  brand: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
  /** For tests. */
  clock?: () => number;
}

/** İYS's message from an error body, which holds `errors: [{ code, message }]` or a `message`. */
async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { errors?: Array<{ code?: string; message?: string }>; message?: string } | null;
  const first = body?.errors?.[0];
  return first ? [first.code, first.message].filter(Boolean).join(": ") : (body?.message ?? `İYS answered ${res.status}`);
}

export function createHttpIysClient({ url, account, brand, username, password, fetch: f = fetch, clock = Date.now }: HttpIysOptions): IysClient {
  const base = `${url}/sps/${encodeURIComponent(account)}/brands/${encodeURIComponent(brand)}`;
  let token: { value: string; until: number } | null = null;

  async function login(): Promise<string> {
    const res = await f(`${url}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username, password, grant_type: "password" }),
    });
    if (!res.ok) throw new IysError(`Signing in to İYS failed: ${await errorOf(res)}`, res.status, false);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new IysError("İYS sent no access_token.", res.status, false);
    // A minute early, so a token never runs out in the middle of a request.
    token = { value: body.access_token, until: clock() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000 };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const bearer = token && token.until > clock() ? token.value : await login();
      const res = await f(base + path, {
        method,
        headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      // A token İYS ended early: sign in again once.
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      return res;
    }
  }

  const fail = async (res: Response) => {
    // 4xx but 401, 408 and 429 mean the answer itself was refused; anything else may pass on another try.
    const permanent = res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status);
    return new IysError(await errorOf(res), res.status, permanent);
  };

  return {
    async add(consent) {
      const res = await call("POST", "/consents", consent);
      if (!res.ok) throw await fail(res);
      const body = (await res.json()) as { transactionId?: string; creationDate?: string };
      if (!body.transactionId) throw new IysError("İYS sent no transactionId.", res.status, false);
      return { transactionId: body.transactionId, creationDate: body.creationDate };
    },
    async status(query) {
      const res = await call("POST", "/consents/status", query);
      if (res.status === 404) return null;
      if (!res.ok) throw await fail(res);
      return (await res.json()) as IysRecord;
    },
    async changes(after, limit) {
      const q = new URLSearchParams({ limit: String(limit), ...(after && { after }) });
      const res = await call("GET", `/consents/changes?${q}`);
      if (!res.ok) throw await fail(res);
      const body = (await res.json()) as { after?: string | null; list?: IysRecord[] };
      return { after: body.after ?? after, list: Array.isArray(body.list) ? body.list : [] };
    },
  };
}

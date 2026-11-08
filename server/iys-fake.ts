// A fake İYS for the tests: the token, adding an answer, asking for one and the list of changes, as iys.ts calls them.
// It is what the İYS client was tested against; the real İYS was never reached.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IysConsent, IysRecord } from "./iys.ts";

export interface FakeIys {
  url: string;
  /** Every answer İYS holds, in the order it got them; changes lists them from a cursor. */
  records: IysRecord[];
  /** Requests as they came, "POST /sps/…/consents". */
  requests: string[];
  /** An answer given outside the product, such as STOP to an SMS, as İYS would list it. */
  external(consent: Omit<IysConsent, "recipientType"> & { recipientType?: IysConsent["recipientType"] }): IysRecord;
  /** The next n requests to the consent paths fail with this status. */
  failNext(status: number, n?: number): void;
  /** Ends the token İYS gave, so the next request is refused with 401. */
  expireToken(): void;
  close(): Promise<void>;
}

const VALID = /^(\+90\d{10}|[^@\s]+@[^@\s]+\.[^@\s]+)$/;

export async function startFakeIys({ account = "123456", brand = "654321", username = "api-user", password = "api-pass" } = {}): Promise<FakeIys> {
  const records: IysRecord[] = [];
  const requests: string[] = [];
  let tokens = new Set<string>();
  let failing: { status: number; n: number } | null = null;
  const base = `/sps/${account}/brands/${brand}`;

  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const error = (status: number, code: string, message: string) => send(status, { errors: [{ code, message }] });

    if (url.pathname === "/oauth2/token" && req.method === "POST") {
      const body = await read(req);
      if (body.username !== username || body.password !== password || body.grant_type !== "password")
        return error(401, "H174", "Kullanıcı adı veya şifre hatalı.");
      const token = randomUUID();
      tokens.add(token);
      return send(200, { access_token: token, refresh_token: randomUUID(), expires_in: 7200, refresh_expires_in: 14400, token_type: "bearer" });
    }
    if (!url.pathname.startsWith("/sps/")) return error(404, "H404", "Bulunamadı.");
    if (!url.pathname.startsWith(`${base}/`)) return error(403, "H103", "Marka bu hesaba ait değil.");
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !tokens.has(auth.slice(7))) return error(401, "H001", "Yetkisiz erişim.");
    if (failing && failing.n > 0) {
      failing.n--;
      return error(failing.status, "H500", "Geçici hata.");
    }
    const path = url.pathname.slice(base.length);

    if (path === "/consents" && req.method === "POST") {
      const c = (await read(req)) as unknown as IysConsent;
      if (typeof c.recipient !== "string" || !VALID.test(c.recipient)) return error(400, "H175", "Alıcı geçersiz.");
      if (!["EPOSTA", "MESAJ", "ARAMA"].includes(c.type) || !["ONAY", "RET"].includes(c.status)) return error(400, "H176", "Tür veya durum geçersiz.");
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c.consentDate ?? "")) return error(400, "H177", "İzin tarihi geçersiz.");
      if (c.type === "EPOSTA" && !c.recipient.includes("@")) return error(400, "H178", "EPOSTA için alıcı bir e-posta adresidir.");
      const rec: IysRecord = { ...c, transactionId: randomUUID(), creationDate: new Date().toISOString().slice(0, 19).replace("T", " ") };
      records.push(rec);
      return send(200, { transactionId: rec.transactionId, creationDate: rec.creationDate });
    }
    if (path === "/consents/status" && req.method === "POST") {
      const q = await read(req);
      const found = records.filter((r) => r.recipient === q.recipient && r.type === q.type && r.recipientType === q.recipientType).at(-1);
      return found ? send(200, found) : error(404, "H404", "İzin bulunamadı.");
    }
    if (path === "/consents/changes" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 999);
      const list = records.slice(after, after + limit);
      return send(200, { after: String(after + list.length), list });
    }
    error(404, "H404", "Bulunamadı.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    records,
    requests,
    external(c) {
      const rec: IysRecord = { recipientType: "BIREYSEL", ...c, transactionId: randomUUID(), creationDate: c.consentDate };
      records.push(rec);
      return rec;
    },
    failNext(status, n = 1) {
      failing = { status, n };
    },
    expireToken() {
      tokens = new Set();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Keeps İYS in step, both ways. Answers on the purpose that holds the brand's commercial message consent go to İYS
// from an outbox, in the order they were given, retried with a growing wait. Answers İYS got from elsewhere (an SMS
// reply, İYS's own site and app) are read from its list of changes every few minutes and added to the history with
// source iys. Nothing is overwritten: when the two disagree, both answers are kept and the later one decides.
import type { DatabaseSync } from "node:sqlite";
import type { IysConfig } from "./config.ts";
import { ConsentError, type Consent } from "./consent.ts";
import { CHANNEL_OF, createHttpIysClient, fromIysDate, IysError, toIysDate, type IysClient, type IysType } from "./iys.ts";
import { log } from "./log.ts";

export interface SyncOptions {
  env?: Record<string, string | undefined>;
  /** Makes the client for a file's iys settings; the HTTP client by default, a fake one in tests. */
  client?: (iys: IysConfig, env: Record<string, string | undefined>) => IysClient | null;
  clock?: () => number;
}

const BATCH = 50;
const PAGE = 500;
/** The longest wait between two tries of the same answer. */
const MAX_WAIT = 6 * 3_600_000;

export function httpClientFor(iys: IysConfig, env: Record<string, string | undefined>): IysClient | null {
  const username = env[iys.username];
  const password = env[iys.password];
  if (!username || !password) return null;
  return createHttpIysClient({ url: iys.url, account: iys.account, brand: iys.brand, username, password });
}

export function createSync(db: DatabaseSync, consent: Consent, { env = process.env, client: makeClient = httpClientFor, clock = Date.now }: SyncOptions = {}) {
  let client: IysClient | null = null;
  let settings: IysConfig | null = null;
  let running: Promise<void> | null = null;
  const state = { lastSendAt: null as string | null, lastPullAt: null as string | null, error: null as string | null };

  const setting = (k: string) => (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
  const save = (k: string, v: string) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);
  state.lastPullAt = setting("iys_last_pull");

  function configure() {
    const next = consent.config().iys;
    if (JSON.stringify(next) === JSON.stringify(settings) && client) return;
    settings = next;
    client = next ? makeClient(next, env) : null;
    // Another account or brand has its own list of changes.
    const scope = next ? `${next.url} ${next.account} ${next.brand}` : "";
    if (setting("iys_scope") !== scope) {
      save("iys_scope", scope);
      save("iys_after", "");
    }
  }
  consent.onConfig(configure);
  configure();

  const now = () => new Date(clock()).toISOString();

  async function send() {
    if (!client) return;
    // The oldest due answer of each recipient and channel only, so İYS gets them in the order they were given.
    const due = db
      .prepare(
        `SELECT * FROM iys_outbox o WHERE state = 'pending' AND next_at <= ?
           AND NOT EXISTS (SELECT 1 FROM iys_outbox p WHERE p.state = 'pending' AND p.recipient = o.recipient AND p.type = o.type AND p.id < o.id)
         ORDER BY id LIMIT ?`,
      )
      .all(now(), BATCH) as Array<Record<string, any>>;
    for (const row of due) {
      try {
        const r = await client.add({
          recipient: row.recipient as string,
          recipientType: settings!.recipientType,
          type: row.type as IysType,
          status: row.status as "ONAY" | "RET",
          source: row.source as string,
          consentDate: toIysDate(row.consent_date as string),
        });
        db.prepare("UPDATE iys_outbox SET state = 'sent', transaction_id = ?, sent_at = ?, error = NULL, attempts = attempts + 1 WHERE id = ?").run(
          r.transactionId,
          now(),
          row.id as number,
        );
        // An answer sent after its person was erased leaves no address behind.
        if (row.person === null) db.prepare("UPDATE iys_outbox SET recipient = '' WHERE id = ?").run(row.id as number);
        state.lastSendAt = now();
      } catch (err) {
        const attempts = (row.attempts as number) + 1;
        const message = (err as Error).message;
        if (err instanceof IysError && err.permanent) {
          db.prepare("UPDATE iys_outbox SET state = 'failed', attempts = ?, error = ? WHERE id = ?").run(attempts, message, row.id as number);
          log("warn", "İYS refused an answer", { outbox: row.id, error: message });
          continue;
        }
        const wait = Math.min(MAX_WAIT, 60_000 * 2 ** Math.min(attempts - 1, 12));
        db.prepare("UPDATE iys_outbox SET attempts = ?, error = ?, next_at = ? WHERE id = ?").run(
          attempts,
          message,
          new Date(clock() + wait).toISOString(),
          row.id as number,
        );
        state.error = message;
        // İYS is not answering: try again at the next round rather than for every row.
        break;
      }
    }
  }

  async function pull(force: boolean) {
    if (!client || !settings) return { recorded: 0, known: 0, skipped: 0 };
    const last = state.lastPullAt ? Date.parse(state.lastPullAt) : 0;
    if (!force && clock() - last < settings.pull * 60_000) return { recorded: 0, known: 0, skipped: 0 };
    const counts = { recorded: 0, known: 0, skipped: 0 };
    let after = setting("iys_after") || null;
    for (let page = 0; page < 20; page++) {
      const { after: next, list } = await client.changes(after, PAGE);
      for (const r of list) {
        const channel = CHANNEL_OF[r.type];
        const at = fromIysDate(r.consentDate) ?? fromIysDate(r.creationDate) ?? now();
        if (!channel || (r.status !== "ONAY" && r.status !== "RET")) {
          counts.skipped++;
          continue;
        }
        const out = consent.fromIys({
          recipient: r.recipient,
          channel,
          granted: r.status === "ONAY",
          at,
          iysSource: r.source ?? null,
          tx: r.transactionId ?? null,
        });
        counts[out === "recorded" ? "recorded" : out === "known" ? "known" : "skipped"]++;
      }
      if (next !== null && next !== undefined) save("iys_after", next);
      if (!list.length || next === after) break;
      after = next ?? null;
    }
    state.lastPullAt = now();
    save("iys_last_pull", state.lastPullAt);
    if (counts.recorded) log("info", "answers read from İYS", counts);
    return counts;
  }

  /** One round: send what is due, then read İYS's changes when it is time. Rounds never overlap. */
  async function tick({ force = false } = {}) {
    configure();
    if (running) return running.then(() => ({ recorded: 0, known: 0, skipped: 0 }));
    let result = { recorded: 0, known: 0, skipped: 0 };
    running = (async () => {
      try {
        await send();
        result = await pull(force);
        // Answers İYS sent us could have been queued behind our own; send what is due again.
        await send();
        state.error = null;
      } catch (err) {
        state.error = (err as Error).message;
        log("warn", "İYS sync failed; it is tried again at the next round", { error: state.error });
      } finally {
        running = null;
      }
    })();
    await running;
    return result;
  }

  function status() {
    const counts = Object.fromEntries(
      (db.prepare("SELECT state, COUNT(*) AS n FROM iys_outbox GROUP BY state").all() as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]),
    );
    return {
      configured: !!settings,
      connected: !!client,
      account: settings?.account ?? null,
      brand: settings?.brand ?? null,
      url: settings?.url ?? null,
      pullMinutes: settings?.pull ?? null,
      credentials: settings
        ? { username: { variable: settings.username, set: !!env[settings.username] }, password: { variable: settings.password, set: !!env[settings.password] } }
        : null,
      pending: counts.pending ?? 0,
      failed: counts.failed ?? 0,
      sent: counts.sent ?? 0,
      lastSendAt: state.lastSendAt,
      lastPullAt: state.lastPullAt,
      error: state.error,
    };
  }

  function outbox(stateFilter: string | undefined, limit: number) {
    if (stateFilter && !["pending", "sent", "failed"].includes(stateFilter)) throw new ConsentError(422, "invalid-body", "state is pending, sent or failed.");
    const rows = (
      stateFilter
        ? db.prepare("SELECT * FROM iys_outbox WHERE state = ? ORDER BY id DESC LIMIT ?").all(stateFilter, limit)
        : db.prepare("SELECT * FROM iys_outbox ORDER BY id DESC LIMIT ?").all(limit)
    ) as Array<Record<string, any>>;
    return rows.map(consent.presentOutbox);
  }

  /** Sends failed answers again, such as after fixing the brand code in the file. */
  function retry() {
    const r = db.prepare("UPDATE iys_outbox SET state = 'pending', next_at = ?, error = NULL WHERE state = 'failed'").run(now());
    return { retried: Number(r.changes) };
  }

  function need(): IysClient {
    if (!settings) throw new ConsentError(409, "not-configured", "İYS is not set in the file.");
    if (!client) throw new ConsentError(409, "not-configured", `İYS's credentials are not set: ${settings.username} and ${settings.password}.`);
    return client;
  }

  /** What İYS itself holds for a recipient on a channel, asked now. */
  async function lookup(recipient: string, channel: "email" | "sms" | "call") {
    const c = need();
    try {
      const r = await c.status({
        recipient,
        recipientType: settings!.recipientType,
        type: channel === "email" ? "EPOSTA" : channel === "sms" ? "MESAJ" : "ARAMA",
      });
      return r
        ? {
            found: true,
            status: r.status,
            source: r.source ?? null,
            consentDate: fromIysDate(r.consentDate),
            creationDate: fromIysDate(r.creationDate),
            transactionId: r.transactionId ?? null,
          }
        : { found: false, status: null, source: null, consentDate: null, creationDate: null, transactionId: null };
    } catch (err) {
      throw new ConsentError(502, "upstream-error", `İYS: ${(err as Error).message}`);
    }
  }

  return { tick, status, outbox, retry, lookup, need };
}

export type Sync = ReturnType<typeof createSync>;

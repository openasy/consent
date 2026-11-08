import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- A person is known by one or more identifiers: an email address, a phone number, the site's own id, or a browser.
   CREATE TABLE people (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
   CREATE TABLE identifiers (
     kind TEXT NOT NULL CHECK (kind IN ('email', 'phone', 'id', 'browser')),
     value TEXT NOT NULL,
     person TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
     added_at TEXT NOT NULL,
     PRIMARY KEY (kind, value)
   ) WITHOUT ROWID;
   CREATE INDEX identifiers_person ON identifiers (person);
   -- Every version of every purpose's text, as first applied. A version's text never changes once people saw it.
   CREATE TABLE texts (
     purpose TEXT NOT NULL,
     version INTEGER NOT NULL,
     hash TEXT NOT NULL,
     text TEXT NOT NULL,
     first_seen TEXT NOT NULL,
     PRIMARY KEY (purpose, version)
   );
   CREATE TRIGGER texts_fixed BEFORE UPDATE ON texts BEGIN SELECT RAISE(ABORT, 'a version''s text is never changed'); END;
   CREATE TRIGGER texts_kept BEFORE DELETE ON texts BEGIN SELECT RAISE(ABORT, 'a version''s text is never deleted'); END;
   -- The history: every answer anyone gave, in the order it was recorded. Nobody edits it; the latest answer by time
   -- given decides. Only erasing a person on their request removes their rows, and that is logged in deletions.
   CREATE TABLE answers (
     id INTEGER PRIMARY KEY,
     person TEXT NOT NULL,
     purpose TEXT NOT NULL,
     channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'call', 'web')),
     version INTEGER,
     granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
     at TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('banner', 'preferences', 'api', 'form', 'import', 'iys')),
     via TEXT,
     actor TEXT,
     iys_source TEXT,
     iys_tx TEXT,
     proof TEXT
   );
   CREATE INDEX answers_latest ON answers (person, purpose, channel, at DESC, id DESC);
   CREATE INDEX answers_purpose ON answers (purpose, channel);
   CREATE UNIQUE INDEX answers_iys_tx ON answers (iys_tx) WHERE iys_tx IS NOT NULL;
   CREATE TABLE erasing (person TEXT PRIMARY KEY);
   CREATE TRIGGER answers_fixed BEFORE UPDATE ON answers BEGIN SELECT RAISE(ABORT, 'consent history is never changed'); END;
   CREATE TRIGGER answers_kept BEFORE DELETE ON answers WHEN NOT EXISTS (SELECT 1 FROM erasing WHERE person = OLD.person)
     BEGIN SELECT RAISE(ABORT, 'consent history is only removed when a person is erased on request'); END;
   -- Who was erased, when, by whom and why; the person's identifiers are not kept.
   CREATE TABLE deletions (
     id INTEGER PRIMARY KEY,
     person TEXT NOT NULL,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     reason TEXT NOT NULL,
     answers INTEGER NOT NULL,
     identifiers INTEGER NOT NULL,
     iys_refusals INTEGER NOT NULL
   );
   CREATE TRIGGER deletions_fixed BEFORE UPDATE ON deletions BEGIN SELECT RAISE(ABORT, 'the deletion log is never changed'); END;
   CREATE TRIGGER deletions_kept BEFORE DELETE ON deletions BEGIN SELECT RAISE(ABORT, 'the deletion log is never deleted'); END;
   -- Answers on their way to İYS. A row is sent, retried with a growing wait, or failed with İYS's message.
   CREATE TABLE iys_outbox (
     id INTEGER PRIMARY KEY,
     answer INTEGER,
     person TEXT,
     recipient TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('EPOSTA', 'MESAJ', 'ARAMA')),
     status TEXT NOT NULL CHECK (status IN ('ONAY', 'RET')),
     source TEXT NOT NULL,
     consent_date TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed')),
     attempts INTEGER NOT NULL DEFAULT 0,
     next_at TEXT NOT NULL,
     error TEXT,
     transaction_id TEXT,
     sent_at TEXT
   );
   CREATE INDEX iys_outbox_due ON iys_outbox (state, next_at);
   CREATE INDEX iys_outbox_person ON iys_outbox (person);
   CREATE INDEX iys_outbox_tx ON iys_outbox (transaction_id) WHERE transaction_id IS NOT NULL;`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

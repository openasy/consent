// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export type Channel = "email" | "sms" | "call" | "web";
export type Text = string | Partial<Record<"en" | "tr" | "de", string>>;
export type Source = "banner" | "preferences" | "api" | "form" | "import" | "iys";

/** The file and whether it is applied; null before it was first read. */
export type ConfigFile = {
  path: string;
  appliedAt: string | null;
  purposes: number;
  sites: number;
  error: string | null;
  warnings: string[];
} | null;

export interface IysStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  brand: string | null;
  url: string | null;
  pullMinutes: number | null;
  credentials: { username: { variable: string; set: boolean }; password: { variable: string; set: boolean } } | null;
  pending: number;
  failed: number;
  sent: number;
  lastSendAt: string | null;
  lastPullAt: string | null;
  error: string | null;
}

export interface Summary {
  purposes: number;
  sites: number;
  people: number;
  answers: number;
  granted24h: number;
  withdrawn24h: number;
  deletions: number;
  file: ConfigFile;
  iys: IysStatus;
}

export interface Purpose {
  id: string;
  name: Text;
  channels: Channel[];
  required: boolean;
  iys: boolean;
  current: number;
  versions: Array<{ version: number; text: Text; from: string | null; renew: boolean; granted: number }>;
  byChannel: Array<{ channel: Channel; granted: number; renew: number; withdrawn: number }>;
  sites: string[];
}

export interface Site {
  name: string;
  domains: string[];
  banner: string[];
  preferences: string[];
  analytics: string | null;
  privacy: string | null;
  language: string | null;
  script: string;
  preferencePage: string;
  answers30d: { granted: number; withdrawn: number };
}

export interface Standing {
  purpose: string;
  channel: Channel;
  status: "granted" | "withdrawn" | "renew" | "none";
  allowed: boolean;
  version: number | null;
  current: number | null;
  at: string | null;
  source: Source | null;
}

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

export interface Latest {
  purpose: string;
  channel: Channel;
  version: number | null;
  granted: boolean;
  at: string;
  source: Source;
}

export interface PersonSummary {
  id: string;
  createdAt: string;
  emails: string[];
  phones: string[];
  ids: string[];
  browsers: number;
  granted: number;
  withdrawn: number;
  lastAnswerAt: string | null;
  latest: Latest[];
  conflict: boolean;
}

export interface Conflict {
  purpose: string;
  channel: Channel;
  local: { granted: boolean; at: string; source: Source };
  iys: { granted: boolean; at: string; source: string | null };
  counts: "local" | "iys";
}

export interface Outbox {
  id: number;
  answer: number | null;
  recipient: string;
  type: string;
  status: "ONAY" | "RET";
  source: string;
  consentDate: string;
  state: "pending" | "sent" | "failed";
  attempts: number;
  error: string | null;
  transactionId: string | null;
  sentAt: string | null;
}

export interface Person extends PersonSummary {
  standing: Standing[];
  conflicts: Conflict[];
  history: Answer[];
  iys: Outbox[];
}

export interface Activity {
  days: number;
  from: string;
  series: Array<{ day: string; granted: number; withdrawn: number }>;
  sources: Array<{ source: Source; granted: number; withdrawn: number }>;
  recent: Array<Answer & { about: string | null }>;
  reach: Array<{ purpose: string; channel: Channel; granted: number }>;
}

export interface IysLogEntry {
  direction: "out" | "in";
  at: string;
  recipient: string;
  type: string;
  status: string;
  state: "pending" | "sent" | "failed";
  note: string | null;
  person: string | null;
}

export interface Checks {
  recent: Array<{
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
  }>;
  today: Array<{ actor: string; asked: number; no: number }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

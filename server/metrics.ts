// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Purposes in the file. */
  purposes: number;
  people: number;
  /** Answers in the history. */
  answers: number;
  /** Answers on their way to İYS, by state: pending, sent, failed. */
  outbox: Record<string, number>;
  /** 1 when the file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="consent",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_consent_purposes Purposes in the file.",
    "# TYPE openasy_consent_purposes gauge",
    `openasy_consent_purposes ${g.purposes}`,
    "# HELP openasy_consent_people People with a record.",
    "# TYPE openasy_consent_people gauge",
    `openasy_consent_people ${g.people}`,
    "# HELP openasy_consent_answers Answers in the history.",
    "# TYPE openasy_consent_answers gauge",
    `openasy_consent_answers ${g.answers}`,
    "# HELP openasy_consent_iys_outbox Answers for İYS, by state.",
    "# TYPE openasy_consent_iys_outbox gauge",
    ...["pending", "sent", "failed"].map((s) => `openasy_consent_iys_outbox{state="${s}"} ${g.outbox[s] ?? 0}`),
    "# HELP openasy_consent_config_error 1 when the file could not be applied and its last good version is in use.",
    "# TYPE openasy_consent_config_error gauge",
    `openasy_consent_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}

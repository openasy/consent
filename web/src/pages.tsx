// Purposes, İYS, the banner and preference page, the checks the products make, and the file.
import {
  Badge,
  BarList,
  Button,
  Callout,
  DataTable,
  EmptyState,
  IconButton,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  SegmentedControl,
  StatusBadge,
  Switch,
  Tabs,
  useAgo,
  type Column,
} from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { ArrowDownLeft, ArrowUpRight, Copy, Globe, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Checks, Conflict, IysLogEntry, IysStatus, Outbox, Purpose, Site, Summary } from "./api.ts";
import { channelName, Code, fmt, purposeName, sourceName, time, useLoad, useText, type Call } from "./common.tsx";
import { useT } from "./i18n.ts";

// ---------------------------------------------------------------- Purposes

export function PurposesPage({ purposes, sites }: { purposes: Purpose[]; sites: Site[] }) {
  const t = useT();
  const text = useText();
  const [id, setId] = useState(purposes[0]?.id ?? "");
  const p = purposes.find((x) => x.id === id) ?? purposes[0];
  const [picked, setPicked] = useState<number | null>(null);
  if (!p) return <EmptyState title={t("purposes.none")} />;
  const v = p.versions.find((x) => x.version === picked) ?? p.versions.at(-1)!;
  const total = p.versions.reduce((n, x) => n + x.granted, 0);
  const newest = [...p.versions].reverse();
  const cols: Column<Purpose["versions"][number]>[] = [
    { id: "v", header: t("purposes.version"), cell: (x) => <Badge mono>v{x.version}</Badge> },
    { id: "from", header: t("purposes.from"), cell: (x) => <span className="text-xs whitespace-nowrap">{x.from ?? "–"}</span> },
    {
      id: "agreed",
      header: t("purposes.latestYes"),
      align: "right",
      sortValue: (x) => x.granted,
      cell: (x) => (
        <span className="font-mono text-xs tabular-nums">
          {fmt(x.granted)}
          {total > 0 && ` · ${Math.round((x.granted / total) * 100)}%`}
        </span>
      ),
    },
    {
      id: "state",
      header: t("purposes.state"),
      cell: (x) =>
        x.version === p.current ? (
          <StatusBadge tone="success">{t("purposes.shownNow")}</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">{t("purposes.earlier")}</StatusBadge>
        ),
    },
    { id: "renew", header: t("purposes.asksAgain"), cell: (x) => (x.renew ? <Badge tone="warning">{t("purposes.renew")}</Badge> : "") },
  ];
  return (
    <>
      <PageHeader title={t("purposes.title")} description={t("purposes.description")} />
      <div className="grid gap-2.5 xl:grid-cols-[240px_minmax(0,1fr)]">
        <Panel flush aria-label={t("purposes.title")}>
          <ul className="consent-list flex flex-col py-1">
            {purposes.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => (setId(x.id), setPicked(null))}
                  aria-current={x.id === p.id ? "true" : undefined}
                  className={`flex w-full flex-col px-3 py-1.5 text-start ${x.id === p.id ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-canvas"}`}
                >
                  <span className="truncate text-sm font-medium">{text(x.name)}</span>
                  <span className="text-2xs text-fg-muted">
                    v{x.current} · {x.channels.map((c) => channelName(t, c)).join(", ")}
                    {x.iys && " · İYS"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <div className="flex min-w-0 flex-col gap-2.5">
          <KpiGrid minWidth={150}>
            {p.byChannel.map((c) => (
              <KpiCard
                key={c.channel}
                label={t("purposes.agreedBy", { channel: channelName(t, c.channel) })}
                value={p.required ? t("purposes.always") : fmt(c.granted)}
                unit={p.required ? undefined : t("purposes.people")}
                delta={c.renew ? { label: t("purposes.renewCount", { count: c.renew }), intent: "neutral" } : undefined}
              />
            ))}
            {!p.required && <KpiCard label={t("purposes.refused")} value={fmt(p.byChannel.reduce((n, c) => n + c.withdrawn, 0))} unit={t("purposes.people")} />}
          </KpiGrid>
          <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px]">
            <Panel aria-label={t("purposes.text")} title={t("purposes.textOf", { purpose: text(p.name) })} description={t("purposes.textDetail")}>
              <div className="flex flex-col gap-3">
                {p.versions.length > 1 && (
                  <SegmentedControl<string>
                    label={t("purposes.version")}
                    value={String(v.version)}
                    onChange={(x) => setPicked(Number(x))}
                    options={newest.slice(0, 6).map((x) => ({ value: String(x.version), label: `v${x.version}` }))}
                  />
                )}
                <blockquote className="consent-text max-w-[68ch] border-s-2 border-accent ps-3 text-sm leading-relaxed text-fg">{text(v.text)}</blockquote>
                <p className="text-xs text-fg-muted">{t("purposes.versionDetail", { version: v.version, from: v.from ?? "–", count: v.granted })}</p>
              </div>
            </Panel>
            <Panel title={t("purposes.about")}>
              <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
                <dt className="text-fg-muted">{t("purposes.key")}</dt>
                <dd className="font-mono text-fg">{p.id}</dd>
                <dt className="text-fg-muted">{t("purposes.channels")}</dt>
                <dd className="text-fg">{p.channels.map((c) => channelName(t, c)).join(", ")}</dd>
                <dt className="text-fg-muted">İYS</dt>
                <dd className="text-fg">
                  {p.iys
                    ? t("purposes.iysYes", { types: p.channels.map((c) => ({ email: "EPOSTA", sms: "MESAJ", call: "ARAMA", web: "" })[c]).join(", ") })
                    : t("purposes.iysNo")}
                </dd>
                <dt className="text-fg-muted">{t("purposes.sites")}</dt>
                <dd className="text-fg">{p.sites.length ? p.sites.join(", ") : "–"}</dd>
                {p.required && (
                  <>
                    <dt className="text-fg-muted">{t("purposes.requiredLabel")}</dt>
                    <dd className="text-fg">{t("purposes.required")}</dd>
                  </>
                )}
              </dl>
              {sites.length === 0 && <p className="mt-3 text-2xs text-fg-muted">{t("purposes.noSites")}</p>}
            </Panel>
          </div>
          <Panel flush title={t("purposes.versions")}>
            <DataTable
              label={t("purposes.versions")}
              columns={cols}
              rows={newest}
              getRowId={(x) => String(x.version)}
              onRowClick={(x) => setPicked(x.version)}
              activeRowId={String(v.version)}
              minWidth={560}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- İYS

export function IysPage({ call, purposes, onChange }: { call: Call; purposes: Purpose[]; onChange: () => void }) {
  const t = useT();
  const text = useText();
  const ago = useAgo();
  const { can } = useAuth();
  const [tab, setTab] = useState<"log" | "conflicts" | "errors">("log");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const status = useLoad<IysStatus>(call, "/api/v1/iys", version);
  const log = useLoad<{ log: IysLogEntry[] }>(call, "/api/v1/iys/log?limit=200", version);
  const conflicts = useLoad<{ conflicts: Array<Conflict & { person: string; about: string | null }> }>(call, "/api/v1/conflicts?limit=200", version);
  const failed = useLoad<{ outbox: Outbox[] }>(call, "/api/v1/iys/outbox?state=failed&limit=200", version);
  const refresh = () => (setVersion((v) => v + 1), onChange());
  const act = async (path: string, done: (r: any) => string) => {
    setBusy(true);
    try {
      setNote(done(await call(path, { method: "POST" })));
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  if (status && !status.configured)
    return (
      <>
        <PageHeader title="İYS" description={t("iys.description")} meta={<StatusBadge tone="neutral">{t("iys.notSet")}</StatusBadge>} />
        <Panel title={t("iys.setTitle")} description={t("iys.setDetail")}>
          <Code>{`iys:
  account: 123456              # your İYS number
  brand: 654321                # the brand's code in İYS
  username: CONSENT_IYS_USERNAME
  password: CONSENT_IYS_PASSWORD
  # url: https://api.sandbox.iys.org.tr`}</Code>
        </Panel>
      </>
    );
  const cols: Column<IysLogEntry>[] = [
    { id: "at", header: t("iys.when"), cell: (r) => <span className="text-xs whitespace-nowrap">{time(r.at)}</span> },
    {
      id: "dir",
      header: t("iys.direction"),
      cell: (r) => (
        <span className="flex items-center gap-1 text-xs">
          {r.direction === "out" ? (
            <ArrowUpRight aria-hidden className="size-3.5 text-fg-muted" />
          ) : (
            <ArrowDownLeft aria-hidden className="size-3.5 text-fg-muted" />
          )}
          {r.direction === "out" ? t("iys.toIys") : t("iys.fromIys")}
        </span>
      ),
    },
    { id: "recipient", header: t("iys.recipient"), mono: true, cell: (r) => <span className="consent-wrap text-xs">{r.recipient || t("iys.erased")}</span> },
    { id: "type", header: t("iys.type"), cell: (r) => <Badge mono>{r.type}</Badge> },
    { id: "status", header: t("iys.status"), cell: (r) => <StatusBadge tone={r.status === "ONAY" ? "success" : "danger"}>{r.status}</StatusBadge> },
    {
      id: "result",
      header: t("iys.result"),
      cell: (r) => (
        <span className="flex flex-col">
          <StatusBadge tone={r.state === "sent" ? "success" : r.state === "failed" ? "danger" : "neutral"}>{t(`iys.state.${r.state}`)}</StatusBadge>
          {r.note && <span className="consent-wrap text-2xs text-fg-muted">{r.note}</span>}
        </span>
      ),
    },
  ];
  const conflictRows = conflicts?.conflicts ?? [];
  const failedRows = failed?.outbox ?? [];
  return (
    <>
      <PageHeader
        title="İYS"
        description={t("iys.description")}
        meta={
          status && (
            <StatusBadge tone={status.connected && !status.error ? "success" : "danger"}>
              {status.connected ? t("iys.connected") : t("iys.notConnected")}
            </StatusBadge>
          )
        }
        actions={
          can("admin") &&
          status?.connected && (
            <Button icon={<RefreshCw />} disabled={busy} onClick={() => void act("/api/v1/iys/sync", (r) => t("iys.synced", { count: r.read.recorded }))}>
              {t("iys.syncNow")}
            </Button>
          )
        }
      />
      {note && (
        <div role="status" className="rounded-md bg-subtle px-3 py-2 text-sm text-fg">
          {note}
        </div>
      )}
      {status?.error && (
        <Callout tone="danger" title={t("iys.lastError")}>
          {status.error}
        </Callout>
      )}
      {status && !status.connected && status.credentials && (
        <Callout tone="warning" title={t("iys.credentials")}>
          {t("iys.credentialsDetail", { username: status.credentials.username.variable, password: status.credentials.password.variable })}
        </Callout>
      )}
      <KpiGrid minWidth={160}>
        <KpiCard
          label={t("iys.sent")}
          value={fmt(status?.sent ?? 0)}
          icon={ArrowUpRight}
          delta={{ label: t("iys.waiting", { count: status?.pending ?? 0 }), intent: "neutral" }}
        />
        <KpiCard
          label={t("iys.read")}
          value={ago(status?.lastPullAt)}
          icon={ArrowDownLeft}
          delta={{ label: t("iys.every", { minutes: status?.pullMinutes ?? 5 }), intent: "neutral" }}
        />
        <KpiCard label={t("iys.disagreed")} value={String(conflictRows.length)} delta={{ label: t("iys.laterWins"), intent: "neutral" }} />
        <KpiCard label={t("iys.rejected")} value={String(status?.failed ?? 0)} tone={status?.failed ? "danger" : undefined} />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Panel flush aria-label={t("iys.sync")}>
          <div className="px-3 pt-2">
            <Tabs
              label={t("iys.sync")}
              value={tab}
              onChange={setTab}
              items={[
                { value: "log", label: t("iys.log") },
                { value: "conflicts", label: t("iys.disagreed"), count: conflictRows.length },
                { value: "errors", label: t("iys.rejected"), count: failedRows.length },
              ]}
              className="border-b-0"
            />
          </div>
          <div className="border-t border-line">
            {tab === "log" && (
              <DataTable
                label={t("iys.log")}
                columns={cols}
                rows={log?.log ?? []}
                loading={log === undefined}
                getRowId={(r) => `${r.direction}-${r.at}-${r.recipient}-${r.type}-${r.status}`}
                minWidth={760}
                pageSize={50}
                empty={<EmptyState title={t("iys.logEmpty")} />}
              />
            )}
            {tab === "conflicts" && (
              <DataTable
                label={t("iys.disagreed")}
                rows={conflictRows}
                getRowId={(r) => `${r.person}-${r.purpose}-${r.channel}`}
                minWidth={760}
                empty={<EmptyState title={t("iys.noConflicts")} />}
                columns={[
                  {
                    id: "person",
                    header: t("people.person"),
                    cell: (r) => (
                      <a href={`/people/${r.person}`} className="consent-wrap font-medium">
                        {r.about ?? r.person}
                      </a>
                    ),
                  },
                  { id: "channel", header: t("person.channel"), cell: (r) => `${purposeName(purposes, r.purpose, text)}, ${channelName(t, r.channel)}` },
                  {
                    id: "local",
                    header: t("iys.here"),
                    cell: (r) => (
                      <span className="text-xs">{`${r.local.granted ? t("answer.yes") : t("answer.no")} · ${sourceName(t, r.local.source)} · ${time(r.local.at)}`}</span>
                    ),
                  },
                  {
                    id: "iys",
                    header: t("iys.inIys"),
                    cell: (r) => (
                      <span className="text-xs">{`${r.iys.granted ? t("answer.yes") : t("answer.no")} · ${r.iys.source ?? "İYS"} · ${time(r.iys.at)}`}</span>
                    ),
                  },
                  {
                    id: "counts",
                    header: t("iys.countsNow"),
                    cell: (r) => <Badge tone="info">{r.counts === "iys" ? t("iys.iysLater") : t("iys.localLater")}</Badge>,
                  },
                ]}
              />
            )}
            {tab === "errors" &&
              (failedRows.length ? (
                <div className="flex flex-col gap-2 px-3 py-3">
                  {failedRows.map((o) => (
                    <Callout key={o.id} tone="danger" title={o.error ?? t("iys.state.failed")}>
                      {t("iys.failedDetail", { recipient: o.recipient, type: o.type, status: o.status, at: time(o.consentDate) })}
                    </Callout>
                  ))}
                  {can("admin") && (
                    <div>
                      <Button
                        size="sm"
                        icon={<RefreshCw />}
                        disabled={busy}
                        onClick={() => void act("/api/v1/iys/retry", (r) => t("iys.retried", { count: r.retried }))}
                      >
                        {t("iys.retry")}
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <EmptyState title={t("iys.noFailed")} />
              ))}
          </div>
        </Panel>
        <Panel title={t("iys.account")} description={t("iys.fromFile")}>
          <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
            <dt className="text-fg-muted">{t("iys.accountNo")}</dt>
            <dd className="font-mono text-fg">{status?.account ?? "–"}</dd>
            <dt className="text-fg-muted">{t("iys.brand")}</dt>
            <dd className="font-mono text-fg">{status?.brand ?? "–"}</dd>
            <dt className="text-fg-muted">{t("iys.address")}</dt>
            <dd className="consent-wrap font-mono text-fg">{status?.url ?? "–"}</dd>
            <dt className="text-fg-muted">{t("iys.reads")}</dt>
            <dd className="text-fg">{t("iys.every", { minutes: status?.pullMinutes ?? 5 })}</dd>
            <dt className="text-fg-muted">{t("iys.lastSent")}</dt>
            <dd className="text-fg">{ago(status?.lastSendAt)}</dd>
            <dt className="text-fg-muted">{t("iys.secrets")}</dt>
            <dd className="font-mono text-fg">
              {status?.credentials ? `${status.credentials.username.variable}, ${status.credentials.password.variable}` : "–"}
            </dd>
          </dl>
          <p className="mt-3 border-t border-line pt-2.5 text-2xs text-fg-muted">{t("iys.rule")}</p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Banner and page

export function SitesPage({ sites, purposes }: { sites: Site[]; purposes: Purpose[] }) {
  const t = useT();
  const text = useText();
  const [name, setName] = useState(sites[0]?.name ?? "");
  const [view, setView] = useState<"banner" | "page">("banner");
  const [copied, setCopied] = useState(false);
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const s = sites.find((x) => x.name === name) ?? sites[0];
  if (!s) return <EmptyState title={t("sites.none")}>{t("sites.noneDetail")}</EmptyState>;
  const banner = s.banner.map((id) => purposes.find((p) => p.id === id)).filter((p): p is Purpose => !!p);
  const messages = s.preferences.map((id) => purposes.find((p) => p.id === id)).filter((p): p is Purpose => !!p);
  const textNow = (p: Purpose) => text(p.versions.find((v) => v.version === p.current)?.text);
  const tag = `<script src="${s.script}" defer></script>`;
  const total = s.answers30d.granted + s.answers30d.withdrawn;
  const host = s.domains[0]?.replace(/^https?:\/\//, "") ?? s.name;
  return (
    <>
      <PageHeader title={t("sites.title")} description={t("sites.description")} />
      <div className="flex flex-wrap items-end gap-2">
        {sites.length > 1 && (
          <SegmentedControl<string>
            label={t("sites.site")}
            value={s.name}
            onChange={(v) => (setName(v), setCopied(false))}
            options={sites.slice(0, 6).map((x) => ({ value: x.name, label: x.name }))}
          />
        )}
        <SegmentedControl<"banner" | "page">
          label={t("sites.preview")}
          value={view}
          onChange={setView}
          options={[
            { value: "banner", label: t("sites.banner") },
            { value: "page", label: t("sites.page") },
          ]}
        />
      </div>
      <KpiGrid minWidth={160}>
        <KpiCard label={t("sites.answers")} value={fmt(total)} unit={t("sites.days30")} />
        <KpiCard label={t("sites.yes")} value={total ? `${Math.round((s.answers30d.granted / total) * 100)}%` : "–"} />
        <KpiCard label={t("sites.no")} value={total ? `${Math.round((s.answers30d.withdrawn / total) * 100)}%` : "–"} />
        <KpiCard
          label={t("sites.analytics")}
          value={s.analytics ? t("sites.waitsForYes") : t("sites.notLinked")}
          delta={s.analytics ? { label: purposeName(purposes, s.analytics, text), intent: "neutral" } : undefined}
        />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Panel flush aria-label={t("sites.preview")}>
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs text-fg-muted">
            <Globe aria-hidden className="size-3.5" />
            <span className="truncate font-mono">{view === "page" ? s.preferencePage : `https://${host}/`}</span>
          </div>
          {view === "banner" ? (
            <div className="relative h-[360px] overflow-hidden bg-canvas">
              <div aria-hidden className="absolute inset-0 flex flex-col gap-3 p-6 opacity-50">
                <div className="h-5 w-24 rounded bg-subtle" />
                <div className="grid grid-cols-3 gap-3">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-32 rounded-lg bg-subtle" />
                  ))}
                </div>
              </div>
              <div
                role="dialog"
                aria-label={t("sites.banner")}
                className="absolute inset-x-6 bottom-6 flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-modal"
              >
                <span className="text-sm font-semibold text-fg">{t("sites.bannerTitle")}</span>
                <p className="text-xs text-fg-muted">{t("sites.bannerIntro")}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm">{t("sites.rejectAll")}</Button>
                  <Button size="sm">{t("sites.acceptAll")}</Button>
                  <Button size="sm" variant="ghost">
                    {t("sites.choose")}
                  </Button>
                </div>
                <span className="text-2xs text-fg-muted">{t("sites.equal")}</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <span className="text-base font-semibold text-fg">{t("sites.pageTitle")}</span>
              <p className="text-xs text-fg-muted">{t("sites.pageIntro")}</p>
              <div className="flex max-w-xl flex-col gap-3">
                {banner.map((p) => (
                  <Switch
                    key={p.id}
                    label={text(p.name)}
                    description={textNow(p)}
                    checked={p.required || !!prefs[p.id]}
                    disabled={p.required}
                    onCheckedChange={(v) => setPrefs({ ...prefs, [p.id]: v })}
                  />
                ))}
                {messages.flatMap((p) =>
                  p.channels.map((c) => (
                    <Switch
                      key={`${p.id}-${c}`}
                      label={`${text(p.name)}: ${channelName(t, c)}`}
                      description={`${textNow(p)} (v${p.current})`}
                      checked={!!prefs[`${p.id}-${c}`]}
                      onCheckedChange={(v) => setPrefs({ ...prefs, [`${p.id}-${c}`]: v })}
                    />
                  )),
                )}
              </div>
              <p className="text-2xs text-fg-muted">{t("sites.pageNote")}</p>
            </div>
          )}
        </Panel>
        <div className="flex flex-col gap-2.5">
          <Panel title={t("sites.install")} description={t("sites.installDetail")}>
            <div className="flex flex-col gap-2">
              <span className="flex items-start gap-1 rounded-md bg-canvas px-2 py-1.5">
                <code className="min-w-0 grow font-mono text-2xs break-all text-fg">{tag}</code>
                <IconButton label={t("sites.copy")} size="xs" onClick={() => void navigator.clipboard?.writeText(tag).then(() => setCopied(true))}>
                  <Copy className="size-3.5" />
                </IconButton>
              </span>
              {copied && (
                <p role="status" className="text-xs text-success">
                  {t("sites.copied")}
                </p>
              )}
              <Code>{`<a href="#" data-openasy-preferences>${t("sites.linkText")}</a>`}</Code>
            </div>
          </Panel>
          <Panel title={t("sites.onSite")}>
            <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-xs">
              <dt className="text-fg-muted">{t("sites.domains")}</dt>
              <dd className="consent-wrap text-fg">{s.domains.join(", ")}</dd>
              <dt className="text-fg-muted">{t("sites.banner")}</dt>
              <dd className="text-fg">{banner.map((p) => text(p.name)).join(", ") || "–"}</dd>
              <dt className="text-fg-muted">{t("sites.page")}</dt>
              <dd className="text-fg">{messages.map((p) => text(p.name)).join(", ") || "–"}</dd>
              <dt className="text-fg-muted">{t("sites.asksAgain")}</dt>
              <dd className="text-fg">{t("sites.asksAgainValue")}</dd>
              <dt className="text-fg-muted">{t("sites.language")}</dt>
              <dd className="text-fg">{s.language ?? t("sites.pageLanguage")}</dd>
              <dt className="text-fg-muted">{t("sites.privacy")}</dt>
              <dd className="consent-wrap text-fg">{s.privacy ?? "–"}</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Checks

export function ChecksPage({ call, purposes }: { call: Call; purposes: Purpose[] }) {
  const t = useT();
  const text = useText();
  const checks = useLoad<Checks>(call, "/api/v1/checks");
  const [who, setWho] = useState("all");
  const rows = (checks?.recent ?? []).filter((c) => who === "all" || c.actor === who);
  const asked = checks?.today.reduce((n, c) => n + c.asked, 0) ?? 0;
  const no = checks?.today.reduce((n, c) => n + c.no, 0) ?? 0;
  const callers = [...new Set((checks?.recent ?? []).map((c) => c.actor))].slice(0, 5);
  const cols: Column<Checks["recent"][number]>[] = [
    { id: "at", header: t("iys.when"), mono: true, cell: (c) => <span className="text-xs whitespace-nowrap">{time(c.at)}</span> },
    { id: "actor", header: t("checks.askedBy"), cell: (c) => <Badge>{c.actor}</Badge> },
    { id: "about", header: t("checks.about"), cell: (c) => <span className="consent-wrap font-medium">{c.about}</span> },
    {
      id: "asked",
      header: t("checks.mayWe"),
      cell: (c) => <span className="text-xs">{`${purposeName(purposes, c.purpose, text)}, ${channelName(t, c.channel)}`}</span>,
    },
    {
      id: "answer",
      header: t("checks.answer"),
      cell: (c) => <StatusBadge tone={c.allowed ? "success" : "danger"}>{c.allowed ? t("answer.yes") : t("answer.no")}</StatusBadge>,
    },
    {
      id: "why",
      header: t("checks.because"),
      cell: (c) => (
        <span className="text-xs text-fg-muted">
          {c.status === "none"
            ? t("checks.neverAsked")
            : t(`checks.why.${c.status}`, { version: c.version ?? "–", at: time(c.since), source: c.source ? sourceName(t, c.source) : "" })}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={t("checks.title")} description={t("checks.description")} />
      <KpiGrid minWidth={160}>
        <KpiCard label={t("checks.today")} value={fmt(asked)} />
        <KpiCard label={t("checks.answeredNo")} value={fmt(no)} unit={asked ? `${Math.round((no / asked) * 1000) / 10}%` : undefined} />
      </KpiGrid>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Panel flush aria-label={t("checks.latest")}>
          {callers.length > 1 && (
            <div className="px-3 py-2">
              <SegmentedControl<string>
                label={t("checks.askedBy")}
                value={who}
                onChange={setWho}
                options={[{ value: "all", label: t("checks.everyone") }, ...callers.map((c) => ({ value: c, label: c }))]}
              />
            </div>
          )}
          <div className="border-t border-line">
            <DataTable
              label={t("checks.latest")}
              columns={cols}
              rows={rows}
              loading={checks === undefined}
              getRowId={(c) => `${c.at}-${c.actor}-${c.about}-${c.purpose}-${c.channel}`}
              minWidth={820}
              pageSize={50}
              empty={<EmptyState title={t("checks.none")}>{t("checks.noneDetail")}</EmptyState>}
            />
          </div>
        </Panel>
        <Panel title={t("checks.byCaller")} description={t("checks.todayShort")}>
          {checks?.today.length ? (
            <BarList label={t("checks.byCaller")} items={checks.today.map((c) => ({ id: c.actor, label: c.actor, value: c.asked }))} />
          ) : (
            <EmptyState title={t("common.nothingYet")} />
          )}
          <p className="mt-3 text-xs text-fg-muted">{t("checks.note")}</p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Setup

function FileState({ summary }: { summary?: Summary }) {
  const t = useT();
  const ago = useAgo();
  const file = summary?.file;
  if (!file) return null;
  return (
    <>
      {file.error ? (
        <Callout tone="danger" title={t("file.notApplied")}>
          {file.error}
        </Callout>
      ) : (
        <p className="text-xs text-fg-muted">{t("file.applied", { path: file.path, ago: ago(file.appliedAt), purposes: file.purposes, sites: file.sites })}</p>
      )}
      {file.warnings.map((w) => (
        <Callout key={w} tone="warning" title={t("file.warning")}>
          {w}
        </Callout>
      ))}
    </>
  );
}

export function SetupPage({ summary }: { summary?: Summary }) {
  const t = useT();
  const origin = window.location.origin;
  return (
    <>
      <PageHeader title={t("setup.title")} description={t("setup.description")} />
      <FileState summary={summary} />
      <Panel title={t("setup.step1")} description={t("setup.step1Detail", { path: summary?.file?.path ?? "/config/consent.yaml" })}>
        <Code>{`purposes:
  - id: analytics
    name: { en: Measurement, tr: Ölçüm }
    channels: [web]
    versions:
      - version: 1
        text: Which pages are read, kept by us and nowhere else.
  - id: marketing
    name: Offers and news
    channels: [email, sms, call]
    iys: true
    versions:
      - version: 1
        text: Offers and news from us by email, SMS and phone.
sites:
  - name: shop
    domains: [https://www.example.com]
    analytics: analytics`}</Code>
      </Panel>
      <Panel title={t("setup.step2")} description={t("setup.step2Detail")}>
        <Code>{`<script src="${origin}/c/shop.js" defer></script>`}</Code>
      </Panel>
      <Panel title={t("setup.step3")} description={t("setup.step3Detail")}>
        <Code>{`curl -s ${origin}/api/v1/check -H "authorization: Bearer $TOKEN" -G \\
  -d purpose=marketing -d channel=sms -d phone=+905551112233

curl -s -X POST ${origin}/api/v1/consents -H "authorization: Bearer $TOKEN" -d '{
  "person": { "email": "ayse@example.com" }, "source": "form", "via": "forms/newsletter",
  "answers": [{ "purpose": "marketing", "channel": "email", "granted": true }]
}'`}</Code>
      </Panel>
      <Panel title={t("setup.step4")} description={t("setup.step4Detail")}>
        <Code>{`curl -s -X POST ${origin}/api/v1/links -H "authorization: Bearer $TOKEN" \\
  -d '{ "person": { "email": "ayse@example.com" }, "site": "shop" }'`}</Code>
      </Panel>
    </>
  );
}

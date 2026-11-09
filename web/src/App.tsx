import {
  AppShell,
  Avatar,
  BarList,
  BrandProvider,
  Button,
  Callout,
  DataTable,
  Dialog,
  DonutChart,
  EmptyState,
  KpiCard,
  KpiGrid,
  navigate,
  PageHeader,
  Panel,
  PRODUCT_IDS,
  SearchInput,
  SegmentedControl,
  SelectField,
  StatusBadge,
  Tabs,
  TextField,
  TimeSeriesChart,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type Column,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { Cookie, FileDown, KeyRound, LayoutDashboard, ListChecks, LogIn, LogOut, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Activity, Channel, Person, PersonSummary, ProductLink, Purpose, Site, Summary } from "./api.ts";
import { AnswerBadge, channelName, fmt, purposeName, shortDay, sourceName, time, useApi, useLoad, useText, type Call } from "./common.tsx";
import { useT, setViewerLocale } from "./i18n.ts";
import { ChecksPage, IysPage, PurposesPage, SetupPage, SitesPage } from "./pages.tsx";
import { search } from "./search.ts";

const PAGES = ["people", "purposes", "iys", "sites", "checks", "setup", "account", "members", "signin", "tokens", "about"] as const;
type Route = { page: "overview" | (typeof PAGES)[number] } | { page: "person"; id: string };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "people" && id) return { page: "person", id: decodeURIComponent(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

/** The purpose kept in step with İYS, which the overview and the people list show by channel. */
const iysPurpose = (purposes: Purpose[]) => purposes.find((p) => p.iys) ?? purposes.find((p) => !p.channels.includes("web"));
/** The web purpose people are asked on the banner most: the first site's analytics purpose, or the first one asked. */
const webPurpose = (purposes: Purpose[], sites: Site[]) =>
  purposes.find((p) => p.id === sites[0]?.analytics) ?? purposes.find((p) => p.channels.includes("web") && !p.required);

// ---------------------------------------------------------------- Overview

function OverviewPage({ call, summary, purposes }: { call: Call; summary?: Summary; purposes: Purpose[] }) {
  const t = useT();
  const text = useText();
  const a = useLoad<Activity>(call, "/api/v1/activity?days=30", summary?.answers);
  const main = iysPurpose(purposes);
  const reach = (c: Channel) => a?.reach.find((r) => r.purpose === main?.id && r.channel === c)?.granted ?? 0;
  const week = a?.series.slice(-7).reduce((n, d) => n + d.withdrawn, 0) ?? 0;
  const people = summary?.people ?? 0;
  const share = (n: number) => (people ? `${Math.round((n / people) * 1000) / 10}%` : undefined);
  const banner = a?.sources.find((s) => s.source === "banner");
  const iys = summary?.iys;
  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      <KpiGrid minWidth={170}>
        <KpiCard label={t("overview.people")} value={fmt(people)} icon={Users} />
        {main?.channels.includes("email") && (
          <KpiCard
            label={t("overview.mayEmail")}
            value={fmt(reach("email"))}
            unit={share(reach("email"))}
            delta={{ label: text(main.name), intent: "neutral" }}
          />
        )}
        {main?.channels.includes("sms") && (
          <KpiCard label={t("overview.maySms")} value={fmt(reach("sms"))} unit={share(reach("sms"))} delta={{ label: text(main.name), intent: "neutral" }} />
        )}
        <KpiCard
          label={t("overview.refusals")}
          value={fmt(week)}
          tone={week ? "warning" : undefined}
          delta={{ label: t("overview.last7"), intent: "neutral" }}
        />
        <KpiCard
          label="İYS"
          value={!iys?.configured ? t("iys.notSet") : iys.connected && !iys.error ? t("iys.inStep") : t("iys.notConnected")}
          tone={!iys?.configured ? undefined : iys.connected && !iys.error && !iys.failed ? "success" : "danger"}
          delta={iys?.configured ? { label: t("overview.iysDetail", { pending: iys.pending, failed: iys.failed }), intent: "neutral" } : undefined}
        />
      </KpiGrid>
      {summary?.file?.error && (
        <Callout tone="danger" title={t("file.notApplied")}>
          {summary.file.error}
        </Callout>
      )}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Panel title={t("overview.perDay")} description={t("overview.perDayDetail")}>
          {a ? (
            <TimeSeriesChart
              label={t("overview.perDay")}
              labels={a.series.map((d) => shortDay(d.day))}
              height={200}
              area
              xTicks={6}
              format={(v) => fmt(Math.round(v))}
              series={[
                { id: "yes", name: t("answer.yes"), data: a.series.map((d) => d.granted), color: "var(--oa-success)" },
                { id: "no", name: t("answer.no"), data: a.series.map((d) => d.withdrawn), color: "var(--oa-danger)" },
              ]}
            />
          ) : (
            <EmptyState title={a === null ? t("common.failed") : t("common.loading")} />
          )}
        </Panel>
        <Panel title={t("overview.banner")} description={t("overview.bannerDetail")}>
          {banner && banner.granted + banner.withdrawn > 0 ? (
            <DonutChart
              label={t("overview.banner")}
              caption={t("overview.answers")}
              size={132}
              slices={[
                { id: "yes", name: t("answer.yes"), value: banner.granted, color: "var(--oa-success)" },
                { id: "no", name: t("answer.no"), value: banner.withdrawn, color: "var(--oa-danger)" },
              ]}
            />
          ) : (
            <EmptyState title={t("overview.noBanner")}>{t("overview.noBannerDetail")}</EmptyState>
          )}
        </Panel>
      </div>
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title={t("overview.sources")} description={t("overview.perDayDetail")}>
          {a?.sources.length ? (
            <BarList
              label={t("overview.sources")}
              items={a.sources.map((s) => ({ id: s.source, label: sourceName(t, s.source), value: s.granted + s.withdrawn }))}
            />
          ) : (
            <EmptyState title={t("common.nothingYet")} />
          )}
        </Panel>
        <Panel title={t("overview.latest")} flush>
          {a?.recent.length ? (
            <ol aria-label={t("overview.latest")} className="consent-list flex flex-col">
              {a.recent.map((r) => (
                <li key={r.id} className="flex items-start gap-2 border-b border-subtle px-3 py-2 last:border-0">
                  <Avatar name={r.about ?? "?"} size="sm" className="size-5" />
                  <a href={`/people/${r.person}`} className="flex min-w-0 grow flex-col">
                    <span className="consent-wrap text-sm text-fg">{r.about ?? t("people.browserOnly")}</span>
                    <span className={r.granted ? "text-xs text-fg-muted" : "text-xs text-danger-text"}>
                      {t("overview.change", {
                        purpose: purposeName(purposes, r.purpose, text),
                        channel: channelName(t, r.channel),
                        answer: r.granted ? t("answer.yes") : t("answer.no"),
                        source: sourceName(t, r.source),
                      })}
                    </span>
                  </a>
                  <span className="shrink-0 font-mono text-2xs text-fg-muted">{time(r.recordedAt)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title={t("common.nothingYet")}>{t("overview.nothingDetail")}</EmptyState>
          )}
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- People

function RecordDialog({
  open,
  person,
  purposes,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  person: Person;
  purposes: Purpose[];
  onOpenChange: (o: boolean) => void;
  onDone: (message: string) => void;
}) {
  const t = useT();
  const text = useText();
  const call = useApi();
  const asked = purposes.filter((p) => !p.required);
  const [purpose, setPurpose] = useState(asked[0]?.id ?? "");
  const [channel, setChannel] = useState<Channel>("email");
  const [granted, setGranted] = useState<"yes" | "no">("no");
  const [how, setHow] = useState("");
  const [error, setError] = useState<string | null>(null);
  const p = asked.find((x) => x.id === purpose) ?? asked[0];
  if (!p) return null;
  const ch = p.channels.includes(channel) ? channel : p.channels[0]!;
  const submit = async () => {
    setError(null);
    try {
      await call("/api/v1/consents", {
        method: "POST",
        body: JSON.stringify({
          person: { person: person.id },
          via: "consent",
          answers: [{ purpose: p.id, channel: ch, granted: granted === "yes", proof: how.trim() }],
        }),
      });
      onDone(t("record.done", { purpose: text(p.name), channel: channelName(t, ch), answer: granted === "yes" ? t("answer.yes") : t("answer.no") }));
      setHow("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("record.title")}
      description={t("record.description")}
      onSubmit={(e) => {
        e.preventDefault();
        if (how.trim()) void submit();
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!how.trim()}>
            {t("record.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t("record.purpose")}
          value={p.id}
          onChange={(e) => setPurpose(e.target.value)}
          options={asked.map((x) => ({ value: x.id, label: text(x.name) }))}
        />
        <SelectField
          label={t("record.channel")}
          value={ch}
          onChange={(e) => setChannel(e.target.value as Channel)}
          options={p.channels.map((c) => ({ value: c, label: channelName(t, c) }))}
        />
      </div>
      <SegmentedControl<"yes" | "no">
        label={t("record.answer")}
        value={granted}
        onChange={setGranted}
        options={[
          { value: "yes", label: t("record.agreed") },
          { value: "no", label: t("record.refused") },
        ]}
      />
      <TextField label={t("record.how")} value={how} maxLength={500} onChange={(e) => setHow(e.target.value)} placeholder={t("record.howPlaceholder")} />
      <p className="text-xs text-fg-muted">
        {t("record.version", { version: p.current, purpose: text(p.name) })}
        {p.iys && ch !== "web" ? ` ${t("record.toIys")}` : ""}
      </p>
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </Dialog>
  );
}

function EraseDialog({ open, person, onOpenChange, onDone }: { open: boolean; person: Person; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const t = useT();
  const call = useApi();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("erase.title")}
      description={t("erase.description")}
      iconTone="warning"
      onSubmit={(e) => {
        e.preventDefault();
        void call(`/api/v1/people/${person.id}?${new URLSearchParams({ reason: reason.trim() })}`, { method: "DELETE" }).then(onDone, (err: Error) =>
          setError(err.message),
        );
      }}
      footer={
        <>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="danger" disabled={reason.trim().length < 3}>
            {t("erase.submit")}
          </Button>
        </>
      }
    >
      <TextField
        label={t("erase.reason")}
        value={reason}
        maxLength={500}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("erase.reasonPlaceholder")}
      />
      {error && <p className="text-xs text-danger-text">{error}</p>}
    </Dialog>
  );
}

function PersonPanel({
  id,
  purposes,
  version,
  onChanged,
}: {
  id: string;
  purposes: Purpose[];
  version: number;
  onChanged: (message: string, gone?: boolean) => void;
}) {
  const t = useT();
  const text = useText();
  const call = useApi();
  const { can } = useAuth();
  const person = useLoad<Person>(call, `/api/v1/people/${id}`, version);
  const [recording, setRecording] = useState(false);
  const [erasing, setErasing] = useState(false);
  if (person === undefined) return <Panel aria-label={t("person.record")}>{t("common.loading")}</Panel>;
  if (person === null) return <Panel aria-label={t("person.record")}>{t("person.gone")}</Panel>;
  const answered = person.standing.filter((s) => s.status !== "none" || purposes.find((p) => p.id === s.purpose)?.required === false);
  const byPurpose = [...new Set(answered.filter((s) => s.status !== "none").map((s) => s.purpose))];
  const name = person.emails[0] ?? person.phones[0] ?? person.ids[0] ?? t("people.browserOnly");
  const exportRecord = () => {
    const blob = new Blob([JSON.stringify(person, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `consent-${person.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    onChanged(t("person.exported"));
  };
  return (
    <Panel
      aria-label={t("person.record")}
      title={<span className="consent-wrap">{name}</span>}
      description={[...person.emails, ...person.phones, ...person.ids.map((i) => `id ${i}`)].filter((x) => x !== name).join(" · ") || undefined}
      actions={person.conflicts.length > 0 ? <StatusBadge tone="warning">{t("people.disagreed")}</StatusBadge> : undefined}
    >
      <div className="flex flex-col gap-3">
        {byPurpose.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <caption className="sr-only">{t("person.latest")}</caption>
              <thead className="text-fg-muted">
                <tr>
                  <th className="py-1 pe-2 font-semibold">{t("person.purpose")}</th>
                  <th className="py-1 pe-2 font-semibold">{t("person.channel")}</th>
                  <th className="py-1 font-semibold">{t("person.latestAnswer")}</th>
                </tr>
              </thead>
              <tbody>
                {byPurpose.flatMap((pid) =>
                  person.standing
                    .filter((s) => s.purpose === pid)
                    .map((s, i) => (
                      <tr key={`${s.purpose}-${s.channel}`} className={i === 0 ? "border-t border-line" : undefined}>
                        <td className="py-1 pe-2 align-top">{i === 0 ? purposeName(purposes, s.purpose, text) : ""}</td>
                        <td className="py-1 pe-2 align-top">{channelName(t, s.channel)}</td>
                        <td className="py-1 align-top">
                          <span className="flex flex-col items-start gap-0.5">
                            <AnswerBadge granted={s.status === "none" ? null : s.status !== "withdrawn"} version={s.version} status={s.status} />
                            {s.at && (
                              <span className="text-2xs text-fg-muted">
                                {s.source && sourceName(t, s.source)} · {time(s.at)}
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">{t("person.noAnswers")}</p>
        )}
        {person.conflicts.map((c) => (
          <Callout
            key={`${c.purpose}-${c.channel}`}
            tone="warning"
            title={t("person.conflict", { purpose: purposeName(purposes, c.purpose, text), channel: channelName(t, c.channel) })}
          >
            {t("person.conflictDetail", {
              local: c.local.granted ? t("answer.yes") : t("answer.no"),
              localAt: time(c.local.at),
              iys: c.iys.granted ? t("answer.yes") : t("answer.no"),
              iysAt: time(c.iys.at),
              counts: c.counts === "iys" ? "İYS" : t("person.here"),
            })}
          </Callout>
        ))}
        <section className="flex flex-col gap-1.5 border-t border-line pt-2.5">
          <h3 className="text-xs font-semibold text-fg-muted">{t("person.history")}</h3>
          <ol aria-label={t("person.history")} className="consent-list flex flex-col gap-2">
            {person.history.map((h) => (
              <li key={h.id} className="flex gap-2 text-xs">
                <span className={`mt-1 size-2 shrink-0 rounded-full ${h.granted ? "bg-success" : "bg-danger"}`} aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="text-fg">
                    {t("person.entry", {
                      purpose: purposeName(purposes, h.purpose, text),
                      channel: channelName(t, h.channel),
                      answer: h.granted ? t("answer.yes") : t("answer.no"),
                      version: h.version ?? "–",
                    })}
                  </span>
                  <span className="consent-wrap text-2xs text-fg-muted">
                    {[time(h.at), sourceName(t, h.source), h.via, h.iysSource, h.proof, h.actor && t("person.by", { actor: h.actor })]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-2xs text-fg-muted">{t("person.kept")}</p>
        </section>
        <div className="flex flex-wrap gap-1.5">
          {can("editor") && (
            <Button size="sm" icon={<Plus />} onClick={() => setRecording(true)}>
              {t("person.recordAnswer")}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<FileDown />} onClick={exportRecord}>
            {t("person.export")}
          </Button>
          {can("admin") && (
            <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setErasing(true)}>
              {t("person.erase")}
            </Button>
          )}
        </div>
      </div>
      <RecordDialog
        key={person.id}
        open={recording}
        person={person}
        purposes={purposes}
        onOpenChange={setRecording}
        onDone={(m) => (setRecording(false), onChanged(m))}
      />
      <EraseDialog open={erasing} person={person} onOpenChange={setErasing} onDone={() => (setErasing(false), onChanged(t("erase.done"), true))} />
    </Panel>
  );
}

function PeoplePage({ call, purposes, sites, selected }: { call: Call; purposes: Purpose[]; sites: Site[]; selected?: string }) {
  const t = useT();
  const text = useText();
  const [tab, setTab] = useState<"all" | "today" | "conflicts">("all");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({ limit: "200", ...(q && { q }), ...(tab !== "all" && { filter: tab }) });
  const list = useLoad<{ people: PersonSummary[]; nextCursor?: string }>(call, `/api/v1/people?${params}`, version);
  const rows = list?.people ?? [];
  const active = selected ?? rows[0]?.id;
  const main = iysPurpose(purposes);
  const web = webPurpose(purposes, sites);
  const latest = (p: PersonSummary, purpose: string | undefined, c: Channel) => {
    const l = p.latest.find((x) => x.purpose === purpose && x.channel === c);
    return <AnswerBadge granted={l?.granted ?? null} version={l?.version} />;
  };
  const cols: Column<PersonSummary>[] = [
    {
      id: "person",
      header: t("people.person"),
      width: "30%",
      cell: (p) => {
        const name = p.emails[0] ?? p.phones[0] ?? p.ids[0] ?? t("people.browserOnly");
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={name} size="sm" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-2xs text-fg-muted">{[...p.phones, ...p.ids].filter((x) => x !== name).join(" · ")}</span>
            </span>
          </span>
        );
      },
    },
    ...(main?.channels ?? [])
      .filter((c) => c !== "web")
      .map((c) => ({
        id: c,
        header: channelName(t, c),
        description: `${text(main!.name)}, ${channelName(t, c)}`,
        cell: (p: PersonSummary) => latest(p, main!.id, c),
      })),
    ...(web ? [{ id: "web", header: text(web.name), description: text(web.name), cell: (p: PersonSummary) => latest(p, web.id, "web") }] : []),
    {
      id: "changed",
      header: t("people.lastChange"),
      sortValue: (p) => p.lastAnswerAt ?? "",
      cell: (p) => <span className="text-xs whitespace-nowrap">{time(p.lastAnswerAt)}</span>,
    },
    {
      id: "iys",
      header: "İYS",
      cell: (p) => (p.conflict ? <StatusBadge tone="warning">{t("people.disagreed")}</StatusBadge> : <span className="text-xs text-fg-muted">–</span>),
    },
  ];
  return (
    <>
      <PageHeader title={t("people.title")} description={t("people.description")} />
      {notice && (
        <div role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
          {notice}
        </div>
      )}
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel flush aria-label={t("people.all")}>
          <div className="flex flex-wrap items-end justify-between gap-2 px-3 pt-2">
            <Tabs
              label={t("people.show")}
              value={tab}
              onChange={setTab}
              items={[
                { value: "all", label: t("people.everyone") },
                { value: "today", label: t("people.today") },
                { value: "conflicts", label: t("people.disagreedTab") },
              ]}
              className="border-b-0"
            />
            <SearchInput
              label={t("people.search")}
              placeholder={t("people.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-64 pb-1.5"
            />
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("people.title")}
              columns={cols}
              rows={rows}
              loading={list === undefined}
              getRowId={(p) => p.id}
              onRowClick={(p) => navigate(`/people/${p.id}`)}
              activeRowId={active}
              minWidth={860}
              pageSize={50}
              empty={<EmptyState title={t("people.none")}>{t("people.noneDetail")}</EmptyState>}
            />
          </div>
        </Panel>
        {active ? (
          <PersonPanel
            key={active}
            id={active}
            purposes={purposes}
            version={version}
            onChanged={(m, gone) => {
              setNotice(m);
              setVersion((v) => v + 1);
              if (gone) navigate("/people");
            }}
          />
        ) : (
          <Panel aria-label={t("person.record")}>
            <EmptyState title={t("people.pick")} />
          </Panel>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Shell

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function SettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("settings.adminsOnly")}>{t("settings.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`settings.${page}`)}
        description={t(`settings.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("settings.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [summary, setSummary] = useState<Summary>();
  const [purposes, setPurposes] = useState<Purpose[]>();
  const [sites, setSites] = useState<Site[]>([]);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();
  const onSearch = useMemo(() => search(call, msg), [call, msg]);

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "consent" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Summary>("/api/v1/summary").then(setSummary, () => {});
    void call<{ purposes: Purpose[] }>("/api/v1/purposes").then(
      (r) => setPurposes(r.purposes),
      () => {},
    );
    void call<{ sites: Site[] }>("/api/v1/sites").then(
      (r) => setSites(r.sites),
      () => {},
    );
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "people", label: msg("nav.people"), icon: Users },
    { id: "purposes", label: msg("nav.purposes"), icon: ListChecks, count: summary?.purposes },
    { id: "iys", label: "İYS", icon: RefreshCw, count: summary?.iys.failed || undefined },
    { id: "sites", label: msg("nav.sites"), icon: Cookie, count: summary?.sites },
    { id: "checks", label: msg("nav.checks"), icon: ShieldCheck },
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "person" ? "people" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const list = purposes ?? [];
  const empty = purposes !== undefined && purposes.length === 0 && ["overview", "people", "purposes", "sites"].includes(route.page);

  return (
    <AppShell
      product="consent"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      setup
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {empty ? (
        <SetupPage summary={summary} />
      ) : route.page === "overview" ? (
        <OverviewPage call={call} summary={summary} purposes={list} />
      ) : route.page === "people" || route.page === "person" ? (
        <PeoplePage call={call} purposes={list} sites={sites} selected={route.page === "person" ? route.id : undefined} />
      ) : route.page === "purposes" ? (
        <PurposesPage purposes={list} sites={sites} />
      ) : route.page === "iys" ? (
        <IysPage call={call} purposes={list} onChange={reload} />
      ) : route.page === "sites" ? (
        <SitesPage sites={sites} purposes={list} />
      ) : route.page === "checks" ? (
        <ChecksPage call={call} purposes={list} />
      ) : route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <SettingsPage page={route.page} />
      ) : (
        <SetupPage summary={summary} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Consent">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}

// What the pages share: data loading with the session, names in the page's language, and formatting.
import { StatusBadge, useLocalePreference } from "@openasy/ui";
import { useAuth } from "@openasy/auth/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Channel, type Purpose, type Source, type Text } from "./api.ts";
import { useT, type T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path, again whenever `key` changes; undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null, key: unknown = 0) {
  const [data, setData] = useState<R | null>();
  useEffect(() => {
    if (!path) return;
    let live = true;
    setData(undefined);
    void call<R>(path).then(
      (d) => live && setData(d),
      () => live && setData(null),
    );
    return () => void (live = false);
  }, [call, path, key]);
  return data;
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className="m-0 overflow-x-auto rounded-md bg-subtle px-2.5 py-2 font-mono text-xs text-fg">{children}</pre>;
}

/** A purpose's name or text in the page's language, English when it has none. */
export function useText() {
  const [locale] = useLocalePreference();
  const lang = locale.slice(0, 2);
  return useCallback(
    (t: Text | undefined | null) => (t == null ? "" : typeof t === "string" ? t : (t[lang as "en"] ?? t.en ?? Object.values(t)[0] ?? "")),
    [lang],
  );
}

export function channelName(t: T, c: Channel) {
  return t(`channel.${c}`);
}

export function purposeName(purposes: Purpose[], id: string, text: (t: Text) => string) {
  const p = purposes.find((x) => x.id === id);
  return p ? text(p.name) : id;
}

export const fmt = (n: number) => n.toLocaleString();
export const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");
export const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** The latest answer: yes or no, and the version of the text it was given to. */
export function AnswerBadge({ granted, version, status }: { granted?: boolean | null; version?: number | null; status?: string }) {
  const t = useT();
  if (status === "none" || granted === undefined || granted === null) return <span className="text-xs text-fg-muted">{t("answer.notAsked")}</span>;
  if (status === "renew")
    return (
      <StatusBadge tone="warning">
        {t("answer.renew")} · v{version}
      </StatusBadge>
    );
  return (
    <StatusBadge tone={granted ? "success" : "danger"}>
      {granted ? t("answer.yes") : t("answer.no")}
      {version != null && ` · v${version}`}
    </StatusBadge>
  );
}

export function sourceName(t: T, source: Source) {
  return t(`source.${source}`);
}

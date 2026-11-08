// What the search window (Cmd+K) finds in Consent: people by part of their email, phone number or id, and purposes.
import type { SearchFn, SearchResult } from "@openasy/ui";
import { ListChecks, UserRound } from "lucide-react";
import type { PersonSummary, Purpose } from "./api.ts";
import type { T } from "./i18n.ts";

type Call = <R>(path: string, init?: RequestInit) => Promise<R>;

export function search(call: Call, t: T): SearchFn {
  return async (q, signal) => {
    const [people, purposes] = await Promise.all([
      q.length >= 2 ? call<{ people: PersonSummary[] }>(`/api/v1/people?${new URLSearchParams({ q, limit: "8" })}`, { signal }).catch(() => null) : null,
      call<{ purposes: Purpose[] }>("/api/v1/purposes", { signal }).catch(() => null),
    ]);
    const found: SearchResult[] = (people?.people ?? []).map((p) => ({
      id: `person:${p.id}`,
      label: p.emails[0] ?? p.phones[0] ?? p.ids[0] ?? p.id,
      detail: t("search.personDetail", { granted: p.granted, withdrawn: p.withdrawn }),
      kind: t("search.person"),
      icon: UserRound,
      mono: true,
      href: `/people/${p.id}`,
    }));
    const named: SearchResult[] = (purposes?.purposes ?? [])
      .filter((p) => p.id.includes(q.toLowerCase()) || JSON.stringify(p.name).toLowerCase().includes(q.toLowerCase()))
      .slice(0, 6)
      .map((p) => ({
        id: `purpose:${p.id}`,
        label: typeof p.name === "string" ? p.name : (p.name.en ?? p.id),
        detail: p.id,
        kind: t("search.purpose"),
        icon: ListChecks,
        href: "/purposes",
      }));
    return [...found, ...named];
  };
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, Loader2, RefreshCw, Search, Terminal, X as XIcon } from "lucide-react";
import { Input } from "../ui/components";
import { SegmentedControl } from "../ui/components/SegmentedControl.jsx";
import { SearchableSelect } from "../ui/components/SearchableSelect.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { showToast } from "../ui/components/Toast.jsx";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { getSessions } from "../lib/sessions-api";
import { formatCompactNumber, formatUsdCurrency } from "../lib/format";
import { useCurrency } from "../hooks/useCurrency";
import { isMockEnabled } from "../lib/mock-data";

const IS_LOCAL_HOST =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

const SOURCE_FILTERS = [
  { id: "all", label: () => copy("sessions.filter.source_all") },
  { id: "claude", label: () => "Claude Code" },
  { id: "codex", label: () => "Codex" },
];

const DATE_RANGES = [
  { id: "all", days: 0, label: () => copy("sessions.filter.range_all") },
  { id: "7d", days: 7, label: () => copy("sessions.filter.range_7d") },
  { id: "30d", days: 30, label: () => copy("sessions.filter.range_30d") },
  { id: "90d", days: 90, label: () => copy("sessions.filter.range_90d") },
];

// Translate a range chip into the backend's `from` (YYYY-MM-DD, inclusive).
// The session browser already filters by day server-side, so narrowing the
// range also widens the effective window inside the 500-row cap.
function rangeToFrom(rangeId) {
  const days = DATE_RANGES.find((range) => range.id === rangeId)?.days || 0;
  if (!days) return "";
  const from = new Date();
  // Inclusive range: "7d" is today plus the previous six calendar days.
  from.setDate(from.getDate() - (days - 1));
  return from.toISOString().slice(0, 10);
}

function formatWhen(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const totalMinutes = Math.round(n / 60000);
  if (totalMinutes < 60) return copy("sessions.duration.minutes", { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return copy("sessions.duration.hours", { hours, minutes });
}

async function copyToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Fallback for insecure contexts / older browsers.
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}

function SessionRow({ session }) {
  const { currency, rate } = useCurrency();
  const provider = String(session.source || "").toUpperCase();
  const duration = formatDuration(session.duration_ms);
  const command = session.resume_command;
  const projectLabel = session.project_key || copy("sessions.project.unknown");
  const title = session.title || projectLabel;
  const showProjectInMeta = Boolean(session.title && session.project_key);

  const handleCopy = async () => {
    if (!command) return;
    try {
      await copyToClipboard(command);
      showToast({ title: copy("sessions.resume.copied") });
    } catch {
      showToast({ title: copy("sessions.resume.copy_failed") });
    }
  };

  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-oai-gray-400 dark:text-oai-gray-500">
          <ProviderIcon provider={provider} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-oai-black dark:text-white">
              {title}
            </span>
            {session.first_pass ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                {copy("sessions.badge.first_pass")}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {showProjectInMeta ? (
              <>
                <span className="truncate">{projectLabel}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span className="truncate">{session.model || copy("sessions.model.unknown")}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatWhen(session.started_at)}</span>
            {duration ? (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{duration}</span>
              </>
            ) : null}
          </div>
          {session.project_ref ? (
            <div className="mt-0.5 truncate font-mono text-[11px] text-oai-gray-400 dark:text-oai-gray-500">
              {session.project_ref}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex items-start gap-5 pl-[30px] sm:pl-0">
        <dl className="flex items-start gap-6 text-right">
          <div className="flex w-16 flex-col-reverse">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.tokens")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{formatCompactNumber(session.total_tokens)}</dd>
          </div>
          <div className="flex w-16 flex-col-reverse">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.cost")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{formatUsdCurrency(session.cost_usd, { currency, rate })}</dd>
          </div>
          <div className="hidden w-10 flex-col-reverse sm:flex">
            <dt className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{copy("sessions.col.edits")}</dt>
            <dd className="tabular-nums text-sm font-medium text-oai-black dark:text-white">{formatCompactNumber(session.edit_turns)}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={handleCopy}
          disabled={!command}
          title={command || copy("sessions.resume.unavailable")}
          aria-label={command ? copy("sessions.resume.copy_aria", { command }) : copy("sessions.resume.unavailable")}
          className={cn(
            "-mt-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500",
            command
              ? "text-oai-gray-500 hover:bg-oai-gray-100 hover:text-oai-black dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
              : "cursor-not-allowed text-oai-gray-300 dark:text-oai-gray-600",
          )}
        >
          <Terminal className="h-3.5 w-3.5" aria-hidden />
          <span className="hidden sm:inline">{copy("sessions.resume.copy")}</span>
        </button>
      </div>
    </li>
  );
}

export function SessionsPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [rangeFilter, setRangeFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const requestIdRef = useRef(0);

  const load = async (refresh = false, rangeId = rangeFilter) => {
    const requestId = ++requestIdRef.current;
    if (refresh) setRefreshing(true);
    else setIsLoading(true);
    setError(null);
    try {
      const result = await getSessions({ limit: 500, from: rangeToFrom(rangeId), refresh });
      // A cold scan can take several seconds. If the user changes ranges while
      // it is running, never let the older response overwrite the newer range.
      if (requestId === requestIdRef.current) setData(result);
    } catch (err) {
      if (requestId === requestIdRef.current) setError(err?.message || String(err));
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        setRefreshing(false);
      }
    }
  };

  // Switching the date range re-queries so the 500-row window covers the
  // selected span, rather than trimming an already-truncated list client-side.
  const handleRangeChange = (rangeId) => {
    if (rangeId === rangeFilter) return;
    setRangeFilter(rangeId);
    void load(false, rangeId);
  };

  useEffect(() => {
    if (IS_LOCAL_HOST || isMockEnabled()) void load(false);
    else setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allSessions = data?.sessions || [];
  // Distinct project names present in the loaded sessions, for the project
  // filter dropdown. Keyed by project_key (what the row filter matches on).
  const projectOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const row of allSessions) {
      const key = row.project_key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ value: key, label: key });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [allSessions]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allSessions.filter((row) => {
      if (sourceFilter !== "all" && row.source !== sourceFilter) return false;
      if (projectFilter !== "all" && row.project_key !== projectFilter) return false;
      if (!q) return true;
      const haystack = `${row.title || ""} ${row.project_key || ""} ${row.model || ""} ${row.project_ref || ""} ${row.session_id || ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [allSessions, sourceFilter, projectFilter, searchQuery]);

  const anyFilter = sourceFilter !== "all" || rangeFilter !== "all" || projectFilter !== "all" || searchQuery.trim() !== "";

  // Sessions read local Claude/Codex logs from the machine running the CLI;
  // there is no cloud source. On the deployed web app, surface the local-only
  // notice instead of an empty list.
  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
        <LocalOnlyNotice />
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-8 flex flex-row items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="mb-3 text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
                {copy("nav.sessions")}
              </h1>
              <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 sm:text-base">
                {copy("sessions.page.subtitle")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing || isLoading}
              aria-label={copy("sessions.page.refresh")}
              title={copy("sessions.page.refresh")}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-oai-gray-200 text-oai-gray-600 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-white"
            >
              <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden />
            </button>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2 pt-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
            <SegmentedControl
              ariaLabel={copy("sessions.filter.source_aria")}
              options={SOURCE_FILTERS.map((option) => ({ id: option.id, label: option.label() }))}
              value={sourceFilter}
              onChange={setSourceFilter}
            />

            <SegmentedControl
              className="pl-2"
              ariaLabel={copy("sessions.filter.range_aria")}
              leading={<Calendar className="h-3.5 w-3.5 shrink-0 text-oai-gray-400" aria-hidden />}
              options={DATE_RANGES.map((option) => ({ id: option.id, label: option.label() }))}
              value={rangeFilter}
              onChange={handleRangeChange}
              disabled={refreshing || isLoading}
            />

            <SearchableSelect
              options={projectOptions}
              value={projectFilter}
              onChange={setProjectFilter}
              allLabel={copy("sessions.filter.project_all")}
              searchPlaceholder={copy("sessions.filter.project_search")}
              emptyLabel={copy("sessions.filter.project_empty")}
              ariaLabel={copy("sessions.filter.project_aria")}
              disabled={refreshing || isLoading}
            />

            <div className="relative w-72 max-w-full">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" aria-hidden />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && searchQuery) {
                    event.preventDefault();
                    setSearchQuery("");
                  }
                }}
                aria-label={copy("sessions.action.search_aria")}
                placeholder={copy("sessions.search.placeholder")}
                className="h-8 pl-9 pr-8 !border-oai-gray-200 dark:!border-oai-gray-800 focus:!border-oai-gray-400 focus:!ring-oai-gray-400/20 dark:focus:!border-oai-gray-500 dark:focus:!ring-oai-gray-500/20 [&::-webkit-search-cancel-button]:appearance-none"
              />
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setSearchQuery("")}
                aria-label={copy("sessions.action.search_clear")}
                aria-hidden={!searchQuery}
                tabIndex={searchQuery ? 0 : -1}
                className={cn(
                  "absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-oai-gray-400 transition duration-150 ease-out hover:bg-oai-gray-100 hover:text-oai-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-400/40 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-200",
                  searchQuery ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0",
                )}
              >
                <XIcon className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            <span role="status" aria-live="polite" className="ml-auto shrink-0 tabular-nums text-oai-gray-500 dark:text-oai-gray-400">
              {copy("sessions.filter.result_count", { filtered: filtered.length, total: allSessions.length })}
            </span>
          </div>

          {error ? (
            <p className="mb-4 text-sm text-red-500 dark:text-red-400">{copy("shared.error.prefix", { error })}</p>
          ) : null}

          {isLoading ? (
            <div className="flex items-center gap-2 py-16 text-sm text-oai-gray-500 dark:text-oai-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {copy("sessions.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-oai-gray-200 py-16 text-center dark:border-oai-gray-800">
              <p className="text-sm font-medium text-oai-black dark:text-white">
                {anyFilter ? copy("sessions.empty.filtered_title") : copy("sessions.empty.title")}
              </p>
              <p className="mt-1 text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {anyFilter ? copy("sessions.empty.filtered_body") : copy("sessions.empty.body")}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-oai-gray-200/70 dark:divide-oai-gray-800/70">
              {filtered.map((session) => (
                <SessionRow key={session.session_hash} session={session} />
              ))}
            </ul>
          )}

          <p className="mt-6 text-xs text-oai-gray-400 dark:text-oai-gray-500">
            {copy("sessions.privacy")}
          </p>
        </div>
      </main>
    </div>
  );
}

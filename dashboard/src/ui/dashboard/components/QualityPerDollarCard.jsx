import React from "react";
import { Card } from "../../components";
import { copy } from "../../../lib/copy";
import { useQualityPerDollarPref } from "../../../hooks/use-quality-per-dollar-pref.js";
import { useQualityPerDollar } from "../../../hooks/use-quality-per-dollar";

function money(n) {
  if (n == null) return "—";
  if (n === 0) return "$0";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function compactTokens(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function pct(rate) {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function qpd(value) {
  return value == null ? "—" : value.toFixed(value < 10 ? 2 : 1);
}

function Row({ row }) {
  return (
    <tr className="border-t border-oai-gray-100 dark:border-oai-gray-800/60">
      <td className="py-1.5 pr-2 font-mono text-[11px] text-oai-gray-700 dark:text-oai-gray-300 truncate max-w-[140px]" title={row.key}>
        {row.key}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums text-oai-gray-600 dark:text-oai-gray-400">{money(row.cost_usd)}</td>
      <td className="py-1.5 px-2 text-right tabular-nums text-oai-gray-600 dark:text-oai-gray-400">
        {row.accepted}/{row.outcomes}
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums text-oai-gray-600 dark:text-oai-gray-400">{pct(row.acceptance_rate)}</td>
      <td className="py-1.5 pl-2 text-right tabular-nums font-medium text-oai-black dark:text-oai-white">{qpd(row.quality_per_dollar)}</td>
    </tr>
  );
}

/**
 * Opt-in quality-per-dollar / Effective-Tokens card.
 *
 * Renders ONLY when both (a) the Labs toggle is on AND (b) the outcomes sidecar
 * actually has data (available && rows). Otherwise returns null so the
 * dashboard looks exactly as it does today. See GitHub issue 229.
 */
export function QualityPerDollarCard({ from, to, deviceId = null }) {
  const { enabled } = useQualityPerDollarPref();
  const { data, loading } = useQualityPerDollar({ enabled, from, to, deviceId });

  if (!enabled) return null;
  const models = (data && data.available && Array.isArray(data.by_model) ? data.by_model : []).filter(
    (r) => r.outcomes > 0,
  );
  if (!models.length) return null; // toggle on but no data → render nothing new

  const top = models.slice(0, 6);
  const totals = data.totals || {};
  const subtitle = `${copy("qpd.card.subtitle")}${loading ? ` ${copy("qpd.card.updating")}` : ""}`;

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-oai-black dark:text-oai-white">{copy("qpd.card.title")}</h3>
        <span className="text-[10px] uppercase tracking-wide text-oai-gray-400 dark:text-oai-gray-500">{copy("qpd.card.badge")}</span>
      </div>
      <p className="mb-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">{subtitle}</p>

      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-oai-gray-400 dark:text-oai-gray-500">
            <th className="pb-1 pr-2 text-left font-medium">{copy("qpd.card.col_model")}</th>
            <th className="pb-1 px-2 text-right font-medium">{copy("qpd.card.col_cost")}</th>
            <th className="pb-1 px-2 text-right font-medium">{copy("qpd.card.col_accepted")}</th>
            <th className="pb-1 px-2 text-right font-medium">{copy("qpd.card.col_rate")}</th>
            <th className="pb-1 pl-2 text-right font-medium" title={copy("qpd.card.qpd_tooltip")}>{copy("qpd.card.col_qpd")}</th>
          </tr>
        </thead>
        <tbody>
          {top.map((row) => (
            <Row key={row.key} row={row} />
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex items-center justify-between border-t border-oai-gray-200 dark:border-oai-gray-800 pt-2 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
        <span>
          {copy("qpd.card.totals", {
            accepted: totals.accepted ?? 0,
            outcomes: totals.outcomes ?? 0,
            cost: money(totals.cost_usd),
          })}
        </span>
        <span title={copy("qpd.card.et_tooltip")}>
          {copy("qpd.card.et", {
            tokens: compactTokens(totals.effective_tokens),
            rate: pct(totals.acceptance_rate),
          })}
        </span>
      </div>
    </Card>
  );
}

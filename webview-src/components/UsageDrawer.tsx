import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCost, formatTokens } from "../lib/format";
import { rpc, type SessionStats } from "../lib/rpc";

/**
 * Aggregate per-project model rows into one row per model — the server emits
 * duplicates when the same model was used across directories (verified live
 * via scripts/stats-probe.mjs).
 */
function aggregateModels(rows: SessionStats["models"]): SessionStats["models"] {
  const byKey = new Map<string, SessionStats["models"][number]>();
  for (const r of rows) {
    const cur = byKey.get(r.model);
    if (!cur) {
      byKey.set(r.model, { ...r });
      continue;
    }
    cur.steps += r.steps;
    cur.cost += r.cost;
    cur.tokens.input += r.tokens.input;
    cur.tokens.output += r.tokens.output;
    cur.tokens.reasoning += r.tokens.reasoning;
    cur.tokens.cacheRead += r.tokens.cacheRead;
    cur.tokens.cacheWrite += r.tokens.cacheWrite;
  }
  return [...byKey.values()].sort((a, b) => b.cost - a.cost);
}

/** Last ~6 weeks of activity, rendered as pure-CSS bars (no chart lib). */
function ActivityBars({ activity }: { activity: SessionStats["activity"] }) {
  const recent = useMemo(() => activity.slice(-42), [activity]);
  if (recent.length === 0) return null;
  const max = Math.max(1, ...recent.map((a) => a.steps));
  return (
    <div className="usage-bars" role="img" aria-label="Daily activity">
      {recent.map((a) => (
        <span
          key={a.date}
          className="usage-bar"
          style={{ height: `${Math.max((a.steps / max) * 100, 4)}%` }}
          title={`${a.date}: ${a.steps.toLocaleString()} steps`}
        />
      ))}
    </div>
  );
}

/**
 * Usage & stats drawer: global token/cost totals, streak, activity bars,
 * per-model spend and tool reliability. Backed by the server-side
 * session.stats aggregate (all projects) — read-only, no session required.
 */
export function UsageDrawer({ onClose }: { onClose(): void }) {
  const [stats, setStats] = useState<SessionStats | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setStats(await rpc.call<SessionStats>("session.stats"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const models = useMemo(
    () => (stats ? aggregateModels(stats.models) : []),
    [stats],
  );
  const tokenTotal = stats
    ? stats.tokens.input +
      stats.tokens.output +
      stats.tokens.reasoning +
      stats.tokens.cacheRead +
      stats.tokens.cacheWrite
    : 0;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label="Usage and stats"
      >
        <header className="drawer-head">
          <span className="drawer-title">Usage &amp; stats</span>
          <button type="button" className="iconbtn" onClick={onClose}>
            ×
          </button>
        </header>
        {error && <div className="composer-error">{error}</div>}
        <div className="drawer-list">
          {!stats && !error && <div className="drawer-empty">Loading…</div>}
          {stats && (
            <>
              <div className="usage-grid">
                <div className="usage-cell">
                  <span className="usage-num">
                    {stats.sessions.toLocaleString()}
                  </span>
                  <span className="usage-label">sessions</span>
                </div>
                <div className="usage-cell">
                  <span className="usage-num">
                    {stats.prompts.toLocaleString()}
                  </span>
                  <span className="usage-label">prompts</span>
                </div>
                <div className="usage-cell">
                  <span className="usage-num">
                    {stats.steps.toLocaleString()}
                  </span>
                  <span className="usage-label">steps</span>
                </div>
                <div className="usage-cell">
                  <span className="usage-num">{formatCost(stats.cost)}</span>
                  <span className="usage-label">total cost</span>
                </div>
                <div className="usage-cell">
                  <span className="usage-num">
                    {stats.streak.toLocaleString()}
                  </span>
                  <span className="usage-label">day streak</span>
                </div>
                <div className="usage-cell">
                  <span className="usage-num">
                    {stats.activeDays.toLocaleString()}
                  </span>
                  <span className="usage-label">active days</span>
                </div>
              </div>

              <ActivityBars activity={stats.activity} />

              <div className="usage-section">tokens</div>
              <div className="usage-row">
                <span>input</span>
                <span>{formatTokens(stats.tokens.input)}</span>
              </div>
              <div className="usage-row">
                <span>output</span>
                <span>{formatTokens(stats.tokens.output)}</span>
              </div>
              {stats.tokens.reasoning > 0 && (
                <div className="usage-row">
                  <span>reasoning</span>
                  <span>{formatTokens(stats.tokens.reasoning)}</span>
                </div>
              )}
              {(stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0) && (
                <div className="usage-row">
                  <span>cache (read + write)</span>
                  <span>
                    {formatTokens(
                      stats.tokens.cacheRead + stats.tokens.cacheWrite,
                    )}
                  </span>
                </div>
              )}
              <div className="usage-row strong">
                <span>total</span>
                <span>{formatTokens(tokenTotal)}</span>
              </div>
              {stats.tools.mode !== "none" && (
                <>
                  <div className="usage-section">tool calls</div>
                  <div className="usage-row">
                    <span>total</span>
                    <span>{stats.tools.totals.calls.toLocaleString()}</span>
                  </div>
                  <div className="usage-row">
                    <span>reliability</span>
                    <span>
                      {stats.tools.totals.calls > 0
                        ? `${Math.round(
                            (stats.tools.totals.succeeded /
                              stats.tools.totals.calls) *
                              100,
                          )}% succeeded`
                        : "—"}
                    </span>
                  </div>
                  {(stats.tools.totals.failed > 0 ||
                    stats.tools.totals.unfinished > 0) && (
                    <div className="usage-row">
                      <span>failed / unfinished</span>
                      <span>
                        {stats.tools.totals.failed.toLocaleString()} /{" "}
                        {stats.tools.totals.unfinished.toLocaleString()}
                      </span>
                    </div>
                  )}
                  {stats.tools.mode === "detail" &&
                    [...stats.tools.usage]
                      .sort((a, b) => b.calls - a.calls)
                      .slice(0, 8)
                      .map((t) => (
                        <div key={t.name} className="usage-row">
                          <span>{t.name}</span>
                          <span>
                            {t.calls.toLocaleString()}
                            {t.calls > 0
                              ? ` · ${Math.round((t.succeeded / t.calls) * 100)}%`
                              : ""}
                          </span>
                        </div>
                      ))}
                </>
              )}

              {models.length > 0 && (
                <>
                  <div className="usage-section">by model</div>
                  {models.map((m) => (
                    <div key={m.model} className="usage-row">
                      <span className="usage-model" title={m.model}>
                        {m.model}
                      </span>
                      <span>
                        {formatCost(m.cost)} ·{" "}
                        {formatTokens(
                          m.tokens.input +
                            m.tokens.output +
                            m.tokens.reasoning +
                            m.tokens.cacheRead +
                            m.tokens.cacheWrite,
                        )}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

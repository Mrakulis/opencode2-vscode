import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCost, formatTokens } from "../lib/format";
import { rpc, type SessionStats, type SessionSummary } from "../lib/rpc";

export type UsageScope = "total" | "project" | "session";

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

function normalizeDir(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase().replace(/\\/g, "/");
}

function isInProject(sessionDir: string, workspaceDir: string): boolean {
  const a = normalizeDir(sessionDir);
  const b = normalizeDir(workspaceDir);
  return a === b || a.startsWith(b + "/");
}

function statsFromSessions(
  sessions: SessionSummary[],
  workspaceDir?: string,
): SessionStats {
  const filtered = workspaceDir
    ? sessions.filter((s) => isInProject(s.location.directory, workspaceDir))
    : sessions;
  let cost = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  const byModel = new Map<string, SessionStats["models"][number]>();
  let subagents = 0;
  for (const s of filtered) {
    cost += s.cost ?? 0;
    input += s.tokens.input ?? 0;
    output += s.tokens.output ?? 0;
    reasoning += s.tokens.reasoning ?? 0;
    cacheRead += s.tokens.cache.read ?? 0;
    cacheWrite += s.tokens.cache.write ?? 0;
    if (s.parentID) subagents += 1;
    if (s.model) {
      const key = `${s.model.providerID}/${s.model.id}`;
      const cur = byModel.get(key);
      const tok = {
        input: s.tokens.input ?? 0,
        output: s.tokens.output ?? 0,
        reasoning: s.tokens.reasoning ?? 0,
        cacheRead: s.tokens.cache.read ?? 0,
        cacheWrite: s.tokens.cache.write ?? 0,
      };
      if (!cur) {
        byModel.set(key, { model: key, steps: 1, cost: s.cost ?? 0, tokens: tok });
      } else {
        cur.steps += 1;
        cur.cost += s.cost ?? 0;
        cur.tokens.input += tok.input;
        cur.tokens.output += tok.output;
        cur.tokens.reasoning += tok.reasoning;
        cur.tokens.cacheRead += tok.cacheRead;
        cur.tokens.cacheWrite += tok.cacheWrite;
      }
    }
  }
  return {
    sessions: filtered.length,
    subagents,
    prompts: filtered.length,
    steps: filtered.length,
    cost,
    activeDays: 0,
    streak: 0,
    tokens: { input, output, reasoning, cacheRead, cacheWrite },
    tools: { mode: "none" },
    activity: [],
    models: [...byModel.values()].sort((a, b) => b.cost - a.cost),
  };
}

function statsForSession(s: SessionSummary): SessionStats {
  const tokens = {
    input: s.tokens.input ?? 0,
    output: s.tokens.output ?? 0,
    reasoning: s.tokens.reasoning ?? 0,
    cacheRead: s.tokens.cache.read ?? 0,
    cacheWrite: s.tokens.cache.write ?? 0,
  };
  const modelKey = s.model ? `${s.model.providerID}/${s.model.id}` : undefined;
  return {
    sessions: 1,
    subagents: 0,
    prompts: 1,
    steps: 1,
    cost: s.cost ?? 0,
    activeDays: 0,
    streak: 0,
    tokens,
    tools: { mode: "none" },
    activity: [],
    models: modelKey
      ? [{ model: modelKey, steps: 1, cost: s.cost ?? 0, tokens }]
      : [],
  };
}

interface Props {
  onClose(): void;
  workspaceDir?: string;
  activeId?: string;
}

export function UsageDrawer({ onClose, workspaceDir, activeId }: Props) {
  const [scope, setScope] = useState<UsageScope>("total");
  const [stats, setStats] = useState<SessionStats | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  // cache per scope so switching is instant after first load
  const [cache, setCache] = useState<Partial<Record<UsageScope, SessionStats>>>({});

  const load = useCallback(async () => {
    setError(undefined);
    // serve from cache if present
    if (cache[scope]) {
      setStats(cache[scope]);
      return;
    }
    setLoading(true);
    try {
      let next: SessionStats | undefined;
      if (scope === "total") {
        next = await rpc.call<SessionStats>("session.stats");
      } else if (scope === "project") {
        // Try server-scoped stats via Project.ID first for richer data (tools/activity)
        let projectId: string | undefined;
        try {
          const cur = await rpc.call<Record<string, unknown>>("project.current", workspaceDir ? { directory: workspaceDir } : {});
          const id = cur?.id;
          if (typeof id === "string" && id.length > 0) projectId = id;
          // some servers return { data: { id } } wrapper
          if (!projectId && typeof (cur as { data?: unknown })?.data === "object") {
            const inner = (cur as { data: Record<string, unknown> }).data;
            if (typeof inner.id === "string") projectId = inner.id;
          }
        } catch {
          // ignore — fallback to client aggregation
        }
        if (projectId) {
          try {
            next = await rpc.call<SessionStats>("session.stats", { project: projectId });
          } catch {
            // fallback below
          }
        }
        if (!next) {
          // Client-side fallback: aggregate sessions filtered to workspaceDir
          const all = await rpc
            .call<SessionSummary[]>("session.list", { allProjects: true })
            .catch(() => [] as SessionSummary[]);
          next = statsFromSessions(all, workspaceDir);
        }
      } else if (scope === "session") {
        if (!activeId) {
          setError("No active session — select a session first.");
          setStats(undefined);
          setLoading(false);
          return;
        }
        // Find active session from list
        const all = await rpc
          .call<SessionSummary[]>("session.list", { allProjects: true })
          .catch(() => [] as SessionSummary[]);
        const found = all.find((s) => s.id === activeId);
        if (!found) {
          setError("Active session not found.");
          setStats(undefined);
          setLoading(false);
          return;
        }
        next = statsForSession(found);
      }
      if (next) {
        setStats(next);
        setCache((prev) => ({ ...prev, [scope]: next }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStats(undefined);
    } finally {
      setLoading(false);
    }
  }, [scope, workspaceDir, activeId, cache]);

  useEffect(() => {
    void load();
  }, [load]);

  // reset cache when workspace/session changes invalidate project/session scopes
  useEffect(() => {
    setCache((prev) => {
      const next = { ...prev };
      delete next.project;
      delete next.session;
      return next;
    });
  }, [workspaceDir, activeId]);

  const models = useMemo(() => {
    if (!stats) return [];
    const agg = aggregateModels(stats.models);
    // Only show models that actually consumed tokens (drawer was showing every catalog entry)
    return agg.filter((m) => {
      const total =
        m.tokens.input +
        m.tokens.output +
        m.tokens.reasoning +
        m.tokens.cacheRead +
        m.tokens.cacheWrite;
      return total > 0;
    });
  }, [stats]);
  const tokenTotal = stats
    ? stats.tokens.input +
      stats.tokens.output +
      stats.tokens.reasoning +
      stats.tokens.cacheRead +
      stats.tokens.cacheWrite
    : 0;

  const projectLabel = workspaceDir
    ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() ?? workspaceDir
    : "Project";

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
        <div className="usage-scope">
          <span className="oc2-pop-filters" role="group" aria-label="Usage scope">
            {(["total", "project", "session"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`oc2-pop-fchip${scope === k ? " on" : ""}`}
                aria-pressed={scope === k}
                onClick={() => setScope(k)}
                disabled={k === "session" && !activeId}
                title={
                  k === "session" && !activeId
                    ? "No active session"
                    : k === "project" && !workspaceDir
                      ? "No workspace folder"
                      : undefined
                }
              >
                {k === "total" ? "Total" : k === "project" ? projectLabel : "Session"}
              </button>
            ))}
          </span>
          {scope === "project" && workspaceDir && (
            <span className="usage-scope-hint" title={workspaceDir}>
              {workspaceDir}
            </span>
          )}
          {scope === "session" && activeId && (
            <span className="usage-scope-hint" title={activeId}>
              {activeId.slice(0, 8)}…
            </span>
          )}
        </div>
        {error && <div className="composer-error">{error}</div>}
        <div className="drawer-list">
          {loading && !stats && !error && <div className="drawer-empty">Loading…</div>}
          {!loading && !stats && !error && <div className="drawer-empty">No data</div>}
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
                {scope === "total" ? (
                  <>
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
                  </>
                ) : (
                  <div className="usage-cell">
                    <span className="usage-num">—</span>
                    <span className="usage-label" title="Global only">
                      {scope === "project" ? "project" : "session"} scope
                    </span>
                  </div>
                )}
              </div>

              {scope === "total" && <ActivityBars activity={stats.activity} />}
              {scope !== "total" && stats.activity.length === 0 && (
                <div className="usage-hint">Activity &amp; streak are global totals only.</div>
              )}

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
              {stats.tools.mode !== "none" ? (
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
              ) : scope !== "total" ? (
                <div className="usage-hint">Tool calls are global totals only.</div>
              ) : null}

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

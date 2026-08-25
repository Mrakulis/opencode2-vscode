import { formatCost, formatTokens } from "../lib/format";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

interface Props {
  connected: boolean;
  busy?: boolean;
  cost?: number;
  tokens?: TokenUsage;
  ctxPct: number | null;
  ctxLimit?: number;
}

/** Full token counter: input / output / reasoning / cache, plus cost + context. */
export function StatusStrip({
  connected,
  busy = false,
  cost,
  tokens,
  ctxPct,
  ctxLimit,
}: Props) {
  const total =
    tokens &&
    formatTokens(
      tokens.input +
        tokens.output +
        tokens.reasoning +
        tokens.cache.read +
        tokens.cache.write,
    );

  return (
    <footer className="strip">
      <span
        className={`dot ${connected ? "ok" : "off"}${busy ? " busy" : ""}`}
        title={busy ? "Agent is working…" : connected ? "Connected" : "Offline"}
      />
      {!connected && (
        <span className="micro" title="Not connected to the OpenCode service">
          offline
        </span>
      )}
      {tokens && (
        <>
          <span className="micro stat" title="prompt (input) tokens">
            ↑{formatTokens(tokens.input)}
          </span>
          <span className="micro stat" title="completion (output) tokens">
            ↓{formatTokens(tokens.output)}
          </span>
          {tokens.reasoning > 0 && (
            <span className="micro stat" title="reasoning tokens">
              ✻{formatTokens(tokens.reasoning)}
            </span>
          )}
          {(tokens.cache.read > 0 || tokens.cache.write > 0) && (
            <span
              className="micro stat"
              title={`cached: ${formatTokens(tokens.cache.read)} read · ${formatTokens(tokens.cache.write)} written`}
            >
              ⟲{formatTokens(tokens.cache.read + tokens.cache.write)}
            </span>
          )}
          <span className="micro total" title="total tokens">
            = {total}
          </span>
        </>
      )}
      {cost !== undefined && (
        <span className="micro" title="session cost">
          {formatCost(cost)}
        </span>
      )}
      {ctxPct !== null && (
        <>
          <span
            className="meter"
            title={
              ctxLimit
                ? `context ${ctxPct}% of ${ctxLimit.toLocaleString()} tokens`
                : `context ${ctxPct}%`
            }
          >
            <span
              className={`fill${(ctxPct ?? 0) >= 80 ? " hot" : ""}`}
              style={{ width: `${Math.max(ctxPct, 3)}%` }}
            />
          </span>
          <span
            className="micro"
            title={
              ctxLimit
                ? `${ctxLimit.toLocaleString()} context window`
                : undefined
            }
          >
            {ctxPct}%{ctxLimit ? ` · ${Math.round(ctxLimit / 1000)}k` : ""}
          </span>
        </>
      )}
      <span className="spacer" />
    </footer>
  );
}

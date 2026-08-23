import { formatCost, formatTokens } from "../lib/format";

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

interface Props {
  connected: boolean;
  cost?: number;
  tokens?: TokenUsage;
  ctxPct: number | null;
}

/** Full token counter: input / output / reasoning / cache, plus cost + context. */
export function StatusStrip({ connected, cost, tokens, ctxPct }: Props) {
  const total =
    tokens &&
    formatTokens(tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write);

  return (
    <footer className="strip">
      <span className={`dot ${connected ? "ok" : "off"}`} />
      {tokens && (
        <>
          <span className="micro stat" title="prompt (input) tokens">↑{formatTokens(tokens.input)}</span>
          <span className="micro stat" title="completion (output) tokens">↓{formatTokens(tokens.output)}</span>
          {tokens.reasoning > 0 && (
            <span className="micro stat" title="reasoning tokens">✻{formatTokens(tokens.reasoning)}</span>
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
      {cost !== undefined && <span className="micro" title="session cost">{formatCost(cost)}</span>}
      {ctxPct !== null && (
        <>
          <span className="meter" title={`context ${ctxPct}%`}>
            <span
              className={`fill${(ctxPct ?? 0) >= 80 ? " hot" : ""}`}
              style={{ width: `${Math.max(ctxPct, 3)}%` }}
            />
          </span>
          <span className="micro">{ctxPct}%</span>
        </>
      )}
      <span className="spacer" />
    </footer>
  );
}

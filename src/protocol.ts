/**
 * Single shared contract for host <-> webview messages.
 * Both tsconfigs include this file; keep it dependency-free.
 */

// ---- resolved configuration ------------------------------------------------

export type Density = "compact" | "comfortable";
export type ShowReasoning = "hide" | "collapsed" | "expanded";
export type SendKey = "enter" | "ctrlEnter";
export type PermissionMode = "askFirst" | "autoAllow" | "deny";

export interface ModelPrefs {
  /** `"providerID/modelID"` keys hidden from the picker. */
  hidden: string[];
  /** Starred keys, pinned to the picker top. */
  favorites: string[];
  /** `"providerID/modelID"` applied to new sessions; empty = server default. */
  default: string;
}

export interface UiPrefs {
  density: Density;
  accentTint?: string;
  sounds: boolean;
  showReasoning: ShowReasoning;
  expandShellTools: boolean;
  expandEditTools: boolean;
  fullShellOutput: boolean;
  messageStats: boolean;
  sendKey: SendKey;
}

export interface ResolvedConfig {
  ui: UiPrefs;
  models: ModelPrefs;
  permissions: { mode: PermissionMode };
}

/** Settings keys the webview may mutate through `settings.update`. */
export const SETTING_KEYS = [
  "models.hidden",
  "models.favorites",
  "models.default",
  "ui.density",
  "ui.sounds",
  "ui.showReasoning",
  "ui.expandShellTools",
  "ui.expandEditTools",
  "ui.fullShellOutput",
  "ui.messageStats",
  "composer.sendKey",
  "permissions.mode",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

/** Host -> Webview */
export type InboundMessage =
  | { type: "ready"; config: ResolvedConfig }
  | { type: "connection"; state: "connected" | "connecting" | "error"; detail?: string }
  | { type: "resync" }
  | { type: "event"; event: unknown }
  | { type: "selectSession"; id: string }
  | { type: "question"; text: string; options: string[]; recommended?: string; hasOther?: boolean }
  | { type: "error"; message: string };

export interface RpcRequest {
  type: "rpc";
  /** monotonic per-webview id */
  id: number;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  type: "rpcResult";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Webview -> Host */
export type OutboundMessage =
  | RpcRequest
  | { type: "hello" };

/** Anything that can arrive on the webview->host channel. */
export type WireMessage = InboundMessage | OutboundMessage;

/**
 * Every host capability exposed to the webview. Params are validated on the
 * host side (rpc.ts) — the wire is a trust boundary.
 */
export type RpcMethod =
  // sessions
  | "session.list"
  | "session.create"
  | "session.remove"
  | "session.rename"
  | "session.fork"
  // conversation
  | "messages.list"
  | "prompt.send"
  | "prompt.interrupt"
  | "session.compact"
  // pickers
  | "models.list"
  | "models.default"
  | "agents.list"
  | "model.switch"
  | "agent.switch"
  // permissions
  | "permissions.pending"
  | "permission.reply"
  // providers & mcp
  | "providers.list"
  | "providers.authCli"
  | "mcp.list"
  | "mcp.add"
  | "mcp.remove"
  | "mcp.connect"
  | "mcp.disconnect"
  | "mcp.resources"
  // misc
  | "files.find"
  | "transcript.copy"
  | "ui.activeSession"
  | "settings.update"
  | "settings.open"
  | "workspace.directory"
  | "file.open"
  | "diff.open"
  | "image.save";

export function isInbound(value: unknown): value is InboundMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type: unknown }).type === "string"
  );
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  return isInbound(value) && (value as { type: string }).type === "rpc";
}

/** Result of checking a settings mutation from the wire. */
export type SettingCheck = { ok: true } | { ok: false; reason: string };

/** Validate one settings update arriving over the wire. */
export function validateSettingValue(key: SettingKey, value: unknown): SettingCheck {
  const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  switch (key) {
    case "models.hidden":
    case "models.favorites":
      return isStrArr(value) ? { ok: true } : { ok: false, reason: `${key} must be a string array` };
    case "models.default":
      return typeof value === "string" ? { ok: true } : { ok: false, reason: "must be a string" };
    case "ui.density":
      return value === "compact" || value === "comfortable"
        ? { ok: true }
        : { ok: false, reason: "density must be compact|comfortable" };
    case "ui.showReasoning":
      return value === "hide" || value === "collapsed" || value === "expanded"
        ? { ok: true }
        : { ok: false, reason: "showReasoning must be hide|collapsed|expanded" };
    case "composer.sendKey":
      return value === "enter" || value === "ctrlEnter"
        ? { ok: true }
        : { ok: false, reason: "sendKey must be enter|ctrlEnter" };
    case "ui.sounds":
    case "ui.expandShellTools":
    case "ui.expandEditTools":
    case "ui.fullShellOutput":
    case "ui.messageStats":
      return typeof value === "boolean" ? { ok: true } : { ok: false, reason: `${key} must be boolean` };
    case "permissions.mode":
      return value === "askFirst" || value === "autoAllow" || value === "deny"
        ? { ok: true }
        : { ok: false, reason: "permissions.mode must be askFirst|autoAllow|deny" };
  }
}

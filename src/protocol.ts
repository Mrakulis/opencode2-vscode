/**
 * Single shared contract for host <-> webview messages.
 * Both tsconfigs include this file; keep it dependency-free.
 */

// ---- resolved configuration ------------------------------------------------

export type Density = "compact" | "comfortable";
/**
 * Built-in theme ids: our two first-party themes plus OpenCode-flavored
 * presets (canonical published palettes). Selected via `opencode2.ui.theme`
 * and applied as `[data-theme="<id>"]`.
 */
export const THEME_IDS = [
  "dark",
  "light",
  "tokyonight",
  "gruvbox",
  "nord",
  "catppuccin",
] as const;
export type ThemeName = (typeof THEME_IDS)[number];
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
  theme: ThemeName;
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
  "ui.theme",
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
  | {
      type: "connection";
      state: "connected" | "connecting" | "error";
      detail?: string;
    }
  | { type: "resync" }
  | { type: "event"; event: unknown }
  | { type: "selectSession"; id: string }
  | { type: "form"; form: WireForm }
  | { type: "error"; message: string };

/**
 * Dependency-free shape of an agent form request (mirrors V2 `FormInfo`).
 * Fields are kept loose (`WireFormField`) because the server union is wide;
 * the webview renders what it knows and ignores the rest.
 */
export interface WireFormField {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  type?: string;
  options?: Array<{ label?: string; value?: string | number | boolean }>;
  default?: string | number | boolean;
  placeholder?: string;
}
export interface WireForm {
  id: string;
  sessionID: string;
  title: string;
  fields: WireFormField[];
}

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
export type OutboundMessage = RpcRequest | { type: "hello" };

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
  // commands & skills
  | "commands.list"
  | "skills.list"
  | "session.command"
  | "session.skill"
  // forms
  | "forms.pending"
  | "form.reply"
  | "form.cancel"
  // session parity
  | "session.export"
  | "session.import"
  | "session.move"
  | "session.revert.stage"
  | "session.revert.clear"
  | "session.revert.commit"
  | "session.context"
  | "inbox.list"
  | "inbox.cancel"
  | "inbox.steer"
  | "inbox.queue"
  // instructions
  | "instructions.list"
  | "instructions.put"
  | "instructions.remove"
  // saved permissions
  | "permissions.saved"
  | "permissions.saved.remove"
  // provider connect
  | "integration.get"
  | "integration.connectKey"
  | "integration.oauthConnect"
  | "integration.oauthStatus"
  | "integration.oauthComplete"
  | "integration.oauthCancel"
  | "integration.commandConnect"
  // credentials
  | "credentials.update"
  | "credentials.remove"
  // environment surfaces
  | "plugins.list"
  | "websearch.providers"
  // vcs & worktrees
  | "vcs.info"
  | "vcs.diff"
  | "worktree.list"
  | "worktree.create"
  | "worktree.remove"
  | "worktree.refresh"
  // providers & mcp
  | "providers.list"
  | "providers.authCli"
  | "mcp.list"
  | "mcp.add"
  | "mcp.remove"
  | "mcp.connect"
  | "mcp.disconnect"
  // misc
  | "files.find"
  | "transcript.copy"
  | "ui.activeSession"
  | "settings.update"
  | "settings.open"
  | "workspace.directory"
  | "project.current"
  | "dialog.saveText"
  | "dialog.openText"
  | "pick.folder"
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
export function validateSettingValue(
  key: SettingKey,
  value: unknown,
): SettingCheck {
  const isStrArr = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  switch (key) {
    case "models.hidden":
    case "models.favorites":
      return isStrArr(value)
        ? { ok: true }
        : { ok: false, reason: `${key} must be a string array` };
    case "models.default":
      return typeof value === "string"
        ? { ok: true }
        : { ok: false, reason: "must be a string" };
    case "ui.density":
      return value === "compact" || value === "comfortable"
        ? { ok: true }
        : { ok: false, reason: "density must be compact|comfortable" };
    case "ui.theme":
      return typeof value === "string" &&
        (THEME_IDS as readonly string[]).includes(value)
        ? { ok: true }
        : { ok: false, reason: `theme must be one of ${THEME_IDS.join("|")}` };
    case "ui.showReasoning":
      return value === "hide" || value === "collapsed" || value === "expanded"
        ? { ok: true }
        : {
            ok: false,
            reason: "showReasoning must be hide|collapsed|expanded",
          };
    case "composer.sendKey":
      return value === "enter" || value === "ctrlEnter"
        ? { ok: true }
        : { ok: false, reason: "sendKey must be enter|ctrlEnter" };
    case "ui.sounds":
    case "ui.expandShellTools":
    case "ui.expandEditTools":
    case "ui.fullShellOutput":
    case "ui.messageStats":
      return typeof value === "boolean"
        ? { ok: true }
        : { ok: false, reason: `${key} must be boolean` };
    case "permissions.mode":
      return value === "askFirst" || value === "autoAllow" || value === "deny"
        ? { ok: true }
        : {
            ok: false,
            reason: "permissions.mode must be askFirst|autoAllow|deny",
          };
  }
}

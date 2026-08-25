import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Catches React render errors and shows a recovery UI instead of a blank
 *  window. The "Reload" button re-requests state from the extension host. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[OpenCode 2] render error:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="empty">
          <h2>Something went wrong</h2>
          <code className="err-detail">{this.state.error.message}</code>
          <button
            type="button"
            className="primary"
            style={{ marginTop: "var(--oc2-space-2)" }}
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

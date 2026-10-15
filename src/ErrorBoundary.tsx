import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null; failures: number };

// After this many consecutive crashes, "Try again" stops re-rendering the
// same children: a deterministic render error would otherwise loop forever
// (clear error, render, crash, clear error, ...). The fallback escalates
// to a full reload instead, which is the only recovery that resets module
// and hook state.
export const MAX_ERROR_RETRIES = 3;

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, failures: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // There is no frontend log-file sink; the console is the same channel
    // the bug-report flow starts from, and the collected report includes
    // the backend log. Record the crash and component stack there instead
    // of letting it vanish.
    console.error("vidcord crashed:", error, info.componentStack);
    this.setState((previous) => ({ failures: previous.failures + 1 }));
  }

  componentDidUpdate(_previousProps: Props, previousState: State): void {
    // A retry that renders without crashing breaks the consecutive-failure
    // streak, so a later unrelated crash starts from a clean count instead
    // of escalating immediately.
    if (previousState.error !== null && this.state.error === null && this.state.failures !== 0) {
      this.setState({ failures: 0 });
    }
  }

  private handleRetry = (): void => {
    if (this.state.failures >= MAX_ERROR_RETRIES) {
      this.reload();
      return;
    }
    this.setState({ error: null });
  };

  private reload = (): void => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    if (this.state.error) {
      const exhausted = this.state.failures >= MAX_ERROR_RETRIES;
      return (
        <div
          style={{
            padding: "24px",
            fontFamily: "monospace",
            color: "var(--error)",
            background: "var(--bg)",
            minHeight: "100vh",
          }}
        >
          <h2 style={{ marginBottom: "12px" }}>Something went wrong</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "13px", opacity: 0.85 }}>
            {this.state.error.message}
          </pre>
          {exhausted && (
            <p style={{ marginTop: "12px", fontSize: "13px" }}>
              Retrying keeps failing, so the app needs to reload instead.
            </p>
          )}
          <button
            onClick={exhausted ? this.reload : this.handleRetry}
            style={{ marginTop: "16px", cursor: "pointer" }}
          >
            {exhausted ? "Reload app" : "Try again"}
          </button>
          {!exhausted && (
            <button
              onClick={this.reload}
              style={{ marginTop: "16px", marginLeft: "8px", cursor: "pointer" }}
            >
              Reload app
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

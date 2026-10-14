import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // There is no frontend log-file sink; the console is the same channel
    // the bug-report flow starts from, and the collected report includes
    // the backend log. Record the crash and component stack there instead
    // of letting it vanish.
    console.error("vidcord crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
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
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: "16px", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

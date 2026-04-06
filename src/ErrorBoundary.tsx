import React from "react";

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "24px",
            fontFamily: "monospace",
            color: "#e85353",
            background: "#1a1a1a",
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

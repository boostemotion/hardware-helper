import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

type BoundaryState = { error: Error | null };

class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染失败", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <div style={{ minHeight: "100vh", padding: 32, background: "#0b1220", color: "#e5e7eb", fontFamily: "system-ui, sans-serif" }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>界面出错了</h1>
          <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.6 }}>
            数据仍然保存在本地 SQLite 中，刷新页面即可继续。
          </p>
          <pre style={{ padding: 16, borderRadius: 8, background: "#111827", color: "#fb7185", fontSize: 13, whiteSpace: "pre-wrap" }}>
            {error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

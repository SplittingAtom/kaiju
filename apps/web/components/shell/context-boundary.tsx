"use client";

import { Component, type ReactNode } from "react";
import { writeContextView } from "../../lib/chat/context-viewer";
import styles from "./context-viewer.module.css";

/**
 * Around the Context panel's text and gauge (KOBE-841): should they ever fail to render, the
 * panel says so and offers the Raw view (remembered, then shown again) instead of the error
 * taking the page down with it.
 */
export class ContextBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean; readonly attempt: number }
> {
  override state = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  private readonly showRaw = () => {
    writeContextView("raw");
    this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return <ContextAttempt key={this.state.attempt}>{this.props.children}</ContextAttempt>;
    }
    return (
      <div className={styles.error} role="alert">
        <span>This context could not be shown formatted.</span>
        <button type="button" className={styles.smallButton} onClick={this.showRaw}>
          Show it raw
        </button>
      </div>
    );
  }
}

/** A keyed wrapper, so each attempt mounts the panel afresh (it reads the remembered view). */
function ContextAttempt({ children }: { readonly children: ReactNode }) {
  return <>{children}</>;
}

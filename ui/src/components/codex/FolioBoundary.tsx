import { Component, type ErrorInfo, type ReactNode } from "react";
import { FolioError, resetErroredQueries } from "#/components/codex/FolioError";
import { useWorkspaceStore } from "#/store/workspace";

interface Props {
  /** Active tab path; key this boundary on it so a new tab resets the error. */
  path: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Backstop error boundary around the folio render. Any error thrown while
 * rendering a folio (e.g. an unexpected query throw) is caught here and shown
 * as a recovery panel, so a single bad tab can never unmount the whole app.
 *
 * The panel reports the actual error and offers RETRY: transient failures
 * (a query that threw through throwOnError, a bad selection during a content
 * remount) must not masquerade as a missing file or latch until a full
 * reload. Retry resets every errored query first so re-rendering the children
 * does not immediately re-throw the same persisted error. Keyed on the active
 * path in TabContent, so switching/fixing tabs also resets it.
 */
export class FolioBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      `FolioBoundary caught a folio render error for ${this.props.path}:`,
      error,
      info.componentStack,
    );
  }

  private handleRetry = () => {
    resetErroredQueries();
    this.setState({ error: null });
  };

  private handleClose = () => {
    const { activeTabId, closeTab } = useWorkspaceStore.getState();
    if (activeTabId) closeTab(activeTabId);
  };

  render() {
    if (this.state.error) {
      return (
        <FolioError
          path={this.props.path}
          error={this.state.error}
          onRetry={this.handleRetry}
          onClose={this.handleClose}
        />
      );
    }
    return this.props.children;
  }
}

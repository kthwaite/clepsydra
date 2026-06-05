import { Component, type ReactNode } from "react";
import { FolioNotFound } from "#/components/codex/FolioNotFound";
import { useWorkspaceStore } from "#/store/workspace";

interface Props {
  /** Active tab path; key this boundary on it so a new tab resets the error. */
  path: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Backstop error boundary around the folio render. Any error thrown while
 * rendering a folio (e.g. an unexpected query throw) is caught here and shown
 * as the recovery panel, so a single bad tab can never unmount the whole app.
 * Keyed on the active path in TabContent, so switching/fixing tabs resets it.
 */
export class FolioBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  private handleClose = () => {
    const { activeTabId, closeTab } = useWorkspaceStore.getState();
    if (activeTabId) closeTab(activeTabId);
  };

  render() {
    if (this.state.hasError) {
      return <FolioNotFound path={this.props.path} onClose={this.handleClose} />;
    }
    return this.props.children;
  }
}

import { Component, type ReactNode } from "react";
import { FileCard } from "./FileCard";

/**
 * A file's view that failed (its code would not load, it threw while drawing): the panel shows why,
 * in place of the view, and the rest of the window stays. Without it React takes the whole window down.
 */
export class ViewBoundary extends Component<{ path: string; rel: string | null; text: (message: string) => string; children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { message: e instanceof Error ? e.message : String(e) };
  }

  componentDidCatch(e: unknown) {
    console.error(`the view of ${this.props.path} failed`, e);
  }

  render() {
    if (this.state.message === null) return this.props.children;
    return <FileCard path={this.props.path} rel={this.props.rel} text={this.props.text(this.state.message)} />;
  }
}

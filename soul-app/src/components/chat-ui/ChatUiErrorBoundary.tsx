import React from 'react';

/** One publication fails into its default text; a new key mounts a new boundary. */
export class ChatUiErrorBoundary extends React.Component<{
  children: React.ReactNode; fallback: React.ReactNode;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

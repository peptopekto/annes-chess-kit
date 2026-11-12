import { TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, EmptyState } from './ui'

/**
 * Keeps a crash inside one page from blanking the whole app (sidebar included): the page shows what
 * went wrong and how to recover. Going to another page (`resetKey` changes) clears the error.
 */
interface Props { children: ReactNode; resetKey: string }
interface State { error: Error | null; resetKey: string; component?: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed:', error, info.componentStack)
    this.setState({ component: info.componentStack ?? undefined })
    // Into the log file (userdata/app.log), so the cause can be found later.
    fetch('/api/client-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(error?.message ?? error), stack: error?.stack ?? '', component: info.componentStack ?? '', url: location.hash }),
    }).catch(() => {})
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <EmptyState icon={<TriangleAlert className="text-mistake" />} title="This page hit a problem"
          action={<div className="flex gap-2">
            <Button variant="primary" onClick={() => this.setState({ error: null })}>Try again</Button>
            <Button variant="ghost" onClick={() => location.reload()}>Reload the app</Button>
          </div>}>
          {this.state.error.message || 'Something went wrong while showing this page.'} The rest of the app still works – pick another page on the left.
        </EmptyState>
        <details className="mt-4 text-xs text-ink-500">
          <summary className="cursor-pointer">Technical details (also saved in userdata/app.log)</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-white/[0.03] p-3 whitespace-pre-wrap select-text">
            {`${this.state.error.stack ?? this.state.error.message}\n${this.state.component ?? ''}`}
          </pre>
        </details>
      </div>
    )
  }
}

import React from "react";

interface State {
    error: Error | null;
}

/**
 * Last-line-of-defence error boundary for the taskpane. Office's task
 * pane process kills the entire frame on uncaught React errors, leaving
 * the user with a blank white panel. Catching here lets us surface the
 * error and offer a "reload" affordance.
 */
export default class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    State
> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo): void {
        // eslint-disable-next-line no-console
        console.error("[mike-addin] Uncaught render error", error, info);
    }

    render(): React.ReactNode {
        if (this.state.error) {
            return (
                <div className="p-4 text-sm text-gray-700">
                    <p className="font-medium mb-2">Something went wrong.</p>
                    <pre className="whitespace-pre-wrap text-xs bg-gray-50 p-2 rounded border border-gray-200">
                        {this.state.error.message}
                    </pre>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="mt-3 px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded"
                    >
                        Reload pane
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

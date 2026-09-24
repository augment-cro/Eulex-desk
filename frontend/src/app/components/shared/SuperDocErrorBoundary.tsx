"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
    children: React.ReactNode;
    /** Optional reset key — kad se promijeni, boundary resetira state. */
    resetKey?: string | number;
}

/** Prevedeni stringovi — class komponenta ne može zvati hookove, pa ih
 *  funkcijski wrapper (`SuperDocErrorBoundary` ispod) prosljeđuje kao props. */
interface InnerProps extends Props {
    title: string;
    body: string;
    retryLabel: string;
}

interface State {
    error: Error | null;
}

/**
 * Hvata render error-e iz SuperDoc-a (najčešće `InvalidStateError` zbog
 * mount-time race condition-a u SuperDoc 1.34/1.35) i pokazuje fallback
 * UI umjesto da next.js generička "Something went wrong" stranica padne
 * preko cijelog projekta — chat, Explorer i ostalo ostaju funkcionalni
 * pa korisnik može nastaviti raditi dok mu mi resync-amo dokument.
 *
 * `resetKey` (npr. `documentId:versionId:refetchKey`) okida ponovni
 * pokušaj kad parent promijeni tab/verziju.
 */
class SuperDocErrorBoundaryInner extends React.Component<InnerProps, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error(
            "[SuperDocErrorBoundary] caught render error",
            error,
            info.componentStack,
        );
    }

    componentDidUpdate(prevProps: InnerProps) {
        if (
            this.state.error &&
            prevProps.resetKey !== this.props.resetKey
        ) {
            this.setState({ error: null });
        }
    }

    handleReset = () => {
        this.setState({ error: null });
    };

    render() {
        if (this.state.error) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted p-6 text-center">
                    <AlertTriangle className="h-8 w-8 text-warning" />
                    <div className="max-w-md">
                        <p className="text-sm font-medium text-foreground">
                            {this.props.title}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {this.props.body}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={this.handleReset}
                        className="inline-flex items-center gap-1.5 rounded-md border border-primary bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                    >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {this.props.retryLabel}
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

export function SuperDocErrorBoundary(props: Props) {
    const t = useTranslations("superDoc.errorBoundary");
    return (
        <SuperDocErrorBoundaryInner
            {...props}
            title={t("title")}
            body={t("body")}
            retryLabel={t("retry")}
        />
    );
}

"use client";

import type { ComponentProps } from "react";
import { DocxView } from "./DocxView";
import { isSuperDocEnabled, SuperDocView } from "./SuperDocView";
import { SuperDocErrorBoundary } from "./SuperDocErrorBoundary";

type Props = ComponentProps<typeof DocxView>;

/**
 * Picks SuperDoc or docx-preview based on NEXT_PUBLIC_USE_SUPERDOC.
 *
 * SuperDoc-vje renderiranje umotavamo u error boundary koji hvata
 * `InvalidStateError` i ostale runtime exception-e iz SuperDoc 1.34/1.35
 * (poznati mount-time race condition na editor.doc getter-u). Bez ovog,
 * jedna instabilna mount-trakija propada cijelu stranicu preko Next.js
 * default error UI-a; s boundary-jem dokument-panel postaje izoliran i
 * korisnik može nastaviti rad s chatom.
 *
 * `resetKey` je triplet documentId:versionId:refetchKey — bilo koja
 * promjena okida boundary reset pa korisnik može probati otvoriti istu
 * stvar ponovno (ili novi tab) bez page refresha.
 */
export function DocxViewer(props: Props) {
    if (isSuperDocEnabled()) {
        const resetKey = `${props.documentId}:${props.versionId ?? ""}:${
            props.refetchKey ?? 0
        }`;
        return (
            <SuperDocErrorBoundary resetKey={resetKey}>
                <SuperDocView {...props} />
            </SuperDocErrorBoundary>
        );
    }
    return <DocxView {...props} />;
}

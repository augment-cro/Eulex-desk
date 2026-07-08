"use client";

import { MikeIcon } from "@/components/chat/mike-icon";

/**
 * Veliki polu-prozirni overlay s Mike kompasom koji se vrti.
 *
 * Tri točke korištenja:
 *   1. `loading.tsx` route segmente — Next.js App Router automatski
 *      prikazuje ovaj overlay tijekom navigacije (Suspense boundary).
 *   2. Inline u stranicama (npr. ProjectPage) kad async akcija traje
 *      duže od ~150ms PRIJE samog router.push poziva.
 *   3. Bilo gdje gdje korisnik klikne CTA pa se ne događa ništa vidljivo
 *      — overlay vraća jasnu povratnu informaciju "radi se".
 *
 * Polu-providan bijeli sloj + blur drži stari sadržaj prepoznatljivim
 * (manje vizualne dezorijentacije nego puni sivi ekran).
 */
export function FullscreenLoader({
    label,
    size = 96,
    /** Kad je true, koristi pozicija fixed (puni viewport). Inače absolute. */
    fixed = true,
}: {
    label?: string;
    size?: number;
    fixed?: boolean;
}) {
    return (
        <div
            className={`${fixed ? "fixed" : "absolute"} inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/70 backdrop-blur-sm`}
            aria-busy="true"
            aria-live="polite"
            role="status"
            data-fullscreen-loader="true"
        >
            <MikeIcon spin mike size={size} />
            {label && (
                <p className="text-sm font-medium text-foreground">{label}</p>
            )}
        </div>
    );
}

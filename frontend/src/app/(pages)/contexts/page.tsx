import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ContextsList } from "@/app/components/contexts/ContextsList";

// ContextsList calls useSearchParams(), so it must sit inside a Suspense
// boundary — otherwise App Router prerendering fails with a CSR bailout.
export default function ContextsPage() {
    // Feature dormant without a configured contexts service — the page
    // does not exist (the sidebar hides its nav entry too).
    if (!process.env.NEXT_PUBLIC_CONTEXTS_URL?.trim()) notFound();
    return (
        <Suspense>
            <ContextsList />
        </Suspense>
    );
}

import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

// max.eulex.ai / app.eulex.ai are the app surface only — marketing lives on
// eulex.ai (/desk). The root redirects straight into the product;
// unauthenticated visitors fall through /assistant → /login.
//
// Exception: Supabase Auth falls back to the project Site URL (this root)
// whenever a requested redirect target is not on its allowlist, e.g.
// `https://max.eulex.ai/?token_hash=…&type=email` or `/?code=…`. Forward
// such auth params to the callback route instead of dropping them, so a
// magic link / OAuth code still signs the user in (or shows a real error).
export default async function RootPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>;
}) {
    const params = await searchParams;
    if (params.token_hash || params.code || params.error) {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (typeof value === "string") qs.set(key, value);
        }
        redirect(`/auth/supabase-callback?${qs.toString()}`);
    }
    redirect("/assistant");
}

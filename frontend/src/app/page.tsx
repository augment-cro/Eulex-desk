import { redirect } from "next/navigation";

// max.eulex.ai is the app surface only — marketing lives on eulex.ai (/desk).
// The root redirects straight into the product; unauthenticated visitors fall
// through /assistant → /login.
export default function RootPage() {
    redirect("/assistant");
}

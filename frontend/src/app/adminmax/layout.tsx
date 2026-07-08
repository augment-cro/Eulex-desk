import type { Metadata } from "next";
import NewUsersBadge from "./components/NewUsersBadge";

// Standalone admin shell. We deliberately do NOT include the user
// AppHeader / sidebar / Providers context here — /adminmax must stay
// usable when no end-user is signed in, and it must look visually
// distinct from the main product so admins never confuse the two.

export const metadata: Metadata = {
    title: "AdminMax · Eulex Desk",
    robots: { index: false, follow: false },
};

export default function AdminMaxLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    return (
        <div className="min-h-screen bg-background text-foreground">
            {/* AdminMax-only zoom: bumps the whole admin shell up a notch
                proportionally. rem-based Tailwind text sizes are root-relative,
                so a wrapper font-size wouldn't scale them — zoom does. */}
            <div className="mx-auto max-w-7xl px-6 py-6 [zoom:1.15]">{children}</div>
            {/* "New users since last look" — persistent corner badge on
                every admin page (hides itself on /adminmax/login). */}
            <NewUsersBadge />
        </div>
    );
}

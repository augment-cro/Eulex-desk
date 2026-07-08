"use client";

import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { Analytics } from "@/app/components/shared/Analytics";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ThemeProvider
            attribute="data-theme"
            themes={["paper", "dark", "mike", "mike-dark"]}
            defaultTheme="paper"
            enableSystem={false}
        >
            <AuthProvider>
                <UserProfileProvider>
                    <Analytics />
                    {children}
                </UserProfileProvider>
            </AuthProvider>
        </ThemeProvider>
    );
}

import React from "react";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import ErrorBoundary from "./components/ErrorBoundary";
import Login from "./components/Login";
import MainLayout from "./components/MainLayout";
import {
    I18nProvider,
    useSyncLocaleFromProfile,
    useTranslation,
} from "./i18n/I18nProvider";

function AppContent() {
    const { isAuthenticated, loading } = useAuth();
    const t = useTranslation();
    // Pull `preferred_language` from the user profile once we have a JWT
    // — that's the only way the add-in learns about a language switch
    // the user made in Eulex Desk on the web (cookies don't cross the
    // Office.js sandbox boundary).
    useSyncLocaleFromProfile(isAuthenticated);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-screen bg-white">
                <div className="text-center">
                    <div className="w-8 h-8 border-2 border-mike-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                    <p className="text-xs text-gray-500">{t("common.loading")}</p>
                </div>
            </div>
        );
    }

    return isAuthenticated ? <MainLayout /> : <Login />;
}

export default function App() {
    return (
        <ErrorBoundary>
            <I18nProvider>
                <AuthProvider>
                    <AppContent />
                </AuthProvider>
            </I18nProvider>
        </ErrorBoundary>
    );
}

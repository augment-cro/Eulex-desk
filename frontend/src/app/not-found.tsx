import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function NotFound() {
    const t = await getTranslations("notFoundPage");

    return (
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
            <div className="text-center max-w-md">
                <h1 className="text-3xl font-eb-garamond font-light text-foreground mb-3">
                    {t("title")}
                </h1>
                <p className="text-[0.9375rem] text-muted-foreground leading-relaxed mb-8">
                    {t("description")}
                </p>

                <Link
                    href="/"
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 transition-colors"
                >
                    {t("goHome")}
                </Link>
            </div>
        </div>
    );
}

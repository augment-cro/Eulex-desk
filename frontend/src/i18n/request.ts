import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export const locales = ["en", "hr"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "hr";

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const raw = cookieStore.get("NEXT_LOCALE")?.value;
    const locale: Locale =
        raw && locales.includes(raw as Locale)
            ? (raw as Locale)
            : defaultLocale;

    return {
        locale,
        messages: (await import(`../../messages/${locale}.json`)).default,
    };
});

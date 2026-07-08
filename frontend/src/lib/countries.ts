/**
 * Country list used by the profile country picker.
 *
 * Scope: EU + EEA + UK + Switzerland + ex-Yugoslavia + a curated set of
 * jurisdictions our users actually pick at checkout. Stripe's
 * automatic_tax only needs the ISO-3166-1 alpha-2 code; the names here
 * exist for the dropdown label only and are localised via next-intl
 * keys (account.profile.countries.<code>) when present, falling back
 * to the English label below.
 *
 * Keep the list short on purpose — a ~250-country drop-down adds noise
 * for no benefit (we don't ship physical goods). If a real user ever
 * needs a country that isn't here, add it: the backend column accepts
 * any ISO-2 string.
 */

export type Country = {
    /** ISO-3166-1 alpha-2 code, upper-case. Persisted as-is. */
    code: string;
    /** English label used as a fallback when no localised name exists. */
    label: string;
};

export const COUNTRIES: ReadonlyArray<Country> = [
    { code: "HR", label: "Croatia" },
    { code: "AT", label: "Austria" },
    { code: "BE", label: "Belgium" },
    { code: "BA", label: "Bosnia and Herzegovina" },
    { code: "BG", label: "Bulgaria" },
    { code: "CY", label: "Cyprus" },
    { code: "CZ", label: "Czech Republic" },
    { code: "DK", label: "Denmark" },
    { code: "EE", label: "Estonia" },
    { code: "FI", label: "Finland" },
    { code: "FR", label: "France" },
    { code: "DE", label: "Germany" },
    { code: "GR", label: "Greece" },
    { code: "HU", label: "Hungary" },
    { code: "IS", label: "Iceland" },
    { code: "IE", label: "Ireland" },
    { code: "IT", label: "Italy" },
    { code: "XK", label: "Kosovo" },
    { code: "LV", label: "Latvia" },
    { code: "LI", label: "Liechtenstein" },
    { code: "LT", label: "Lithuania" },
    { code: "LU", label: "Luxembourg" },
    { code: "MT", label: "Malta" },
    { code: "MD", label: "Moldova" },
    { code: "ME", label: "Montenegro" },
    { code: "NL", label: "Netherlands" },
    { code: "MK", label: "North Macedonia" },
    { code: "NO", label: "Norway" },
    { code: "PL", label: "Poland" },
    { code: "PT", label: "Portugal" },
    { code: "RO", label: "Romania" },
    { code: "RS", label: "Serbia" },
    { code: "SK", label: "Slovakia" },
    { code: "SI", label: "Slovenia" },
    { code: "ES", label: "Spain" },
    { code: "SE", label: "Sweden" },
    { code: "CH", label: "Switzerland" },
    { code: "TR", label: "Turkey" },
    { code: "UA", label: "Ukraine" },
    { code: "GB", label: "United Kingdom" },
    { code: "US", label: "United States" },
    { code: "CA", label: "Canada" },
    { code: "AU", label: "Australia" },
    { code: "NZ", label: "New Zealand" },
    { code: "AE", label: "United Arab Emirates" },
    { code: "JP", label: "Japan" },
    { code: "SG", label: "Singapore" },
];

/**
 * Lookup helper for callers that have a code and want a human label.
 * Returns the ISO-2 code itself when the country is not in the table
 * — better than dropping the value silently in the UI.
 */
export function countryLabel(code: string | null | undefined): string {
    if (!code) return "";
    const upper = code.toUpperCase();
    return COUNTRIES.find((c) => c.code === upper)?.label ?? upper;
}

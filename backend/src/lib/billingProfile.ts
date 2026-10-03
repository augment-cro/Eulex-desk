/**
 * Company billing details the core already keeps on the profile
 * (tracker #35: organisation on user_profiles; VAT id and address on
 * user_tier_state), shaped for offline-payment quotes. The billing
 * provider validates them; the core only prefills and saves them back.
 */
import { query } from "./db";
import { normaliseVatNumber } from "./stripe";

export interface CompanyDetails {
    name: string;
    oib: string;
    street: string;
    postalCode: string;
    city: string;
}

export interface StoredBilling {
    email: string | null;
    stripeCustomerId: string | null;
    /** ISO-2 billing country the user chose (Settings / checkout), or null. */
    country: string | null;
    company: Partial<CompanyDetails>;
}

/** "HR12345678901" / "123 456 789 01" → "12345678901"; else null. */
export function oibFromVat(raw: string | null | undefined): string | null {
    const compact = (raw ?? "").replace(/[\s.-]/g, "").toUpperCase().replace(/^HR/, "");
    return /^\d{11}$/.test(compact) ? compact : null;
}

export async function loadStoredBilling(userId: string): Promise<StoredBilling | null> {
    const r = await query<{
        email: string | null;
        organisation: string | null;
        vat_number: string | null;
        address_line1: string | null;
        address_city: string | null;
        address_postal_code: string | null;
        stripe_customer_id: string | null;
        country: string | null;
    }>(
        `SELECT u.email, p.organisation, s.vat_number, s.address_line1, s.address_city,
                s.address_postal_code, s.stripe_customer_id, s.country
           FROM public.users u
           LEFT JOIN public.user_profiles p ON p.user_id = u.id
           LEFT JOIN public.user_tier_state s ON s.user_id = u.id
          WHERE u.id = $1`,
        [userId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
        email: row.email,
        stripeCustomerId: row.stripe_customer_id,
        country: row.country?.trim().toUpperCase() || null,
        company: {
            name: row.organisation?.trim() || undefined,
            oib: oibFromVat(row.vat_number) ?? undefined,
            street: row.address_line1?.trim() || undefined,
            postalCode: row.address_postal_code?.trim() || undefined,
            city: row.address_city?.trim() || undefined,
        },
    };
}

/** Read the company block from a request body (strings only, trimmed). */
export function companyFromBody(raw: unknown): CompanyDetails {
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    return {
        name: s(c.name, 200),
        oib: s(c.oib, 40),
        street: s(c.street, 200),
        postalCode: s(c.postalCode, 20),
        city: s(c.city, 120),
    };
}

/**
 * Save an accepted company block back to the profile so Settings and the
 * card checkout show the same data. Best-effort.
 */
export async function persistCompany(userId: string, c: CompanyDetails): Promise<void> {
    try {
        await query(
            `INSERT INTO public.user_tier_state
                (user_id, vat_number, address_line1, address_city, address_postal_code, country, active_tier_synced_at)
             VALUES ($1, $2, $3, $4, $5, 'HR', now())
             ON CONFLICT (user_id) DO UPDATE SET
                vat_number = EXCLUDED.vat_number,
                address_line1 = EXCLUDED.address_line1,
                address_city = EXCLUDED.address_city,
                address_postal_code = EXCLUDED.address_postal_code,
                country = COALESCE(public.user_tier_state.country, 'HR')`,
            [userId, normaliseVatNumber(c.oib), c.street, c.city, c.postalCode.replace(/\s/g, "")],
        );
        await query(
            `INSERT INTO public.user_profiles (user_id, organisation)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET organisation = EXCLUDED.organisation`,
            [userId, c.name],
        );
    } catch (err) {
        console.warn(
            `[billing] saving company details for user=${userId} failed (non-fatal):`,
            err instanceof Error ? err.message : err,
        );
    }
}

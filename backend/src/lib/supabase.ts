/**
 * Compatibility shim — `createServerSupabase()` now returns an object
 * whose `.from()` method delegates to the dbShim query builder.
 *
 * This keeps all existing call sites like `db.from("table").select().eq()`
 * working without modification. Over time, modules should import `from`
 * directly from `../lib/dbShim` and this file can be deleted.
 *
 * @deprecated Import `from` from `./dbShim` for new code.
 */

import { from, QueryBuilder } from "./dbShim";

interface CompatClient {
  from: (table: string) => QueryBuilder;
}

export function createServerSupabase(): CompatClient {
  return { from };
}

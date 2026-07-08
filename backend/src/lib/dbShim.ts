/**
 * Supabase-compatible query builder shim for MikeOSS.
 *
 * Translates Supabase-style `.from().select().eq()` chains into
 * parameterized pg SQL queries. This allows gradual migration of
 * existing route files without rewriting every query at once.
 *
 * Usage:
 *   import { from } from '../lib/dbShim';
 *   const { data, error } = await from('projects').select('*').eq('user_id', userId);
 *
 * @module dbShim
 */

import { getPool } from './db';

// Response shape matching Supabase client conventions
interface ShimResult<T = any> {
  data: T | null;
  error: Error | null;
  count: number | null;
}

/**
 * The `pg` driver doesn't automatically JSON.stringify plain objects/arrays
 * for jsonb columns — it sends them via `.toString()` which produces
 * `[object Object]`, causing "invalid input syntax for type json".
 * This helper serialises non-primitive values so Postgres receives valid JSON.
 */
function pgValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * Start a query builder chain for the given table.
 * Drop-in replacement for `supabase.from(tableName)`.
 */
export function from(table: string): QueryBuilder {
  return new QueryBuilder(table);
}

type WhereClause = {
  sql: string;
  value: unknown;
  type: 'simple' | 'in' | 'contains' | 'is_null' | 'is_not_null' | 'like' | 'ilike' | 'gte' | 'lte' | 'gt' | 'lt';
};

type OrderClause = { col: string; ascending: boolean; nullsFirst?: boolean };

export class QueryBuilder {
  private _table: string;
  private _operation: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private _selects = '*';
  private _wheres: WhereClause[] = [];
  private _orRaw: string | null = null;
  private _orders: OrderClause[] = [];
  private _limitVal?: number;
  private _offsetVal?: number;
  private _single = false;
  private _maybeSingle = false;
  private _countMode: 'exact' | null = null;
  private _headOnly = false;
  private _insertData?: Record<string, unknown> | Record<string, unknown>[];
  private _insertSelect?: string;
  private _updateData?: Record<string, unknown>;
  private _upsertConflict?: string;
  private _returning = true;

  constructor(table: string) {
    this._table = table;
  }

  // ─── SELECT ────────────────────────────────────────────
  select(cols: string = '*', opts?: { count?: 'exact'; head?: boolean }): this {
    // When chained after insert/update/upsert/delete, don't change operation
    if (this._operation !== 'select') {
      this._insertSelect = cols;
    } else {
      this._operation = 'select';
      this._selects = cols;
    }
    if (opts?.count) this._countMode = opts.count;
    if (opts?.head) this._headOnly = true;
    return this;
  }

  // ─── INSERT ────────────────────────────────────────────
  insert(data: Record<string, unknown> | Record<string, unknown>[]): this {
    this._operation = 'insert';
    this._insertData = data;
    return this;
  }

  // ─── UPDATE ────────────────────────────────────────────
  update(data: Record<string, unknown>): this {
    this._operation = 'update';
    this._updateData = data;
    return this;
  }

  // ─── UPSERT ────────────────────────────────────────────
  upsert(data: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }): this {
    this._operation = 'upsert';
    this._insertData = data;
    this._upsertConflict = opts?.onConflict;
    return this;
  }

  // ─── DELETE ────────────────────────────────────────────
  delete(): this {
    this._operation = 'delete';
    return this;
  }

  // ─── WHERE CLAUSES ────────────────────────────────────
  eq(col: string, val: unknown): this {
    this._wheres.push({ sql: `"${col}" = `, value: val, type: 'simple' });
    return this;
  }

  neq(col: string, val: unknown): this {
    this._wheres.push({ sql: `"${col}" != `, value: val, type: 'simple' });
    return this;
  }

  gt(col: string, val: unknown): this {
    this._wheres.push({ sql: `"${col}" > `, value: val, type: 'gt' });
    return this;
  }

  gte(col: string, val: unknown): this {
    this._wheres.push({ sql: `"${col}" >= `, value: val, type: 'gte' });
    return this;
  }

  lt(col: string, val: unknown): this {
    this._wheres.push({ sql: `"${col}" < `, value: val, type: 'lt' });
    return this;
  }

  lte(col: string, val: unknown): this {
    this._wheres.push({ sql: `"${col}" <= `, value: val, type: 'lte' });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this._wheres.push({ sql: `"${col}" = ANY(`, value: vals, type: 'in' });
    return this;
  }

  contains(col: string, val: unknown): this {
    this._wheres.push({ sql: `"${col}" @> `, value: JSON.stringify(val), type: 'contains' });
    return this;
  }

  like(col: string, pattern: string): this {
    this._wheres.push({ sql: `"${col}" LIKE `, value: pattern, type: 'like' });
    return this;
  }

  ilike(col: string, pattern: string): this {
    this._wheres.push({ sql: `"${col}" ILIKE `, value: pattern, type: 'ilike' });
    return this;
  }

  is(col: string, val: null | boolean): this {
    if (val === null) {
      this._wheres.push({ sql: `"${col}" IS NULL`, value: null, type: 'is_null' });
    } else {
      this._wheres.push({ sql: `"${col}" = `, value: val, type: 'simple' });
    }
    return this;
  }

  not(col: string, operator: string, val: unknown): this {
    if (operator === 'is' && val === null) {
      this._wheres.push({ sql: `"${col}" IS NOT NULL`, value: null, type: 'is_not_null' });
    } else if (operator === 'eq') {
      this._wheres.push({ sql: `"${col}" != `, value: val, type: 'simple' });
    }
    return this;
  }

  /**
   * PostgREST-style OR filter.
   * Parses simple `col.op.val` expressions separated by commas.
   * Supports: eq, neq, in, is, gt, gte, lt, lte, ilike, like
   */
  or(filter: string): this {
    this._orRaw = filter;
    return this;
  }

  /**
   * PostgREST-style filter (col, op, val). Maps to WHERE clause.
   */
  filter(col: string, op: string, val: unknown): this {
    switch (op) {
      case 'eq': return this.eq(col, val);
      case 'neq': return this.neq(col, val);
      case 'gt': return this.gt(col, val);
      case 'gte': return this.gte(col, val);
      case 'lt': return this.lt(col, val);
      case 'lte': return this.lte(col, val);
      case 'like': return this.like(col, val as string);
      case 'ilike': return this.ilike(col, val as string);
      case 'is': return this.is(col, val as null | boolean);
      default: return this.eq(col, val);
    }
  }

  // ─── ORDER / LIMIT ────────────────────────────────────
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this._orders.push({ col, ascending: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst });
    return this;
  }

  limit(n: number): this {
    this._limitVal = n;
    return this;
  }

  range(from: number, to: number): this {
    this._offsetVal = from;
    this._limitVal = to - from + 1;
    return this;
  }

  single(): this {
    this._single = true;
    this._limitVal = 1;
    return this;
  }

  maybeSingle(): this {
    this._maybeSingle = true;
    this._limitVal = 1;
    return this;
  }

  // ─── EXECUTE ──────────────────────────────────────────
  async then<TResult1 = ShimResult, TResult2 = never>(
    onfulfilled?: ((value: ShimResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    try {
      const result = await this._execute();
      return onfulfilled ? onfulfilled(result) : (result as any);
    } catch (err) {
      if (onrejected) return onrejected(err);
      throw err;
    }
  }

  private async _execute(): Promise<ShimResult> {
    const pool = await getPool();

    try {
      switch (this._operation) {
        case 'select':
          return await this._executeSelect(pool);
        case 'insert':
          return await this._executeInsert(pool);
        case 'update':
          return await this._executeUpdate(pool);
        case 'upsert':
          return await this._executeUpsert(pool);
        case 'delete':
          return await this._executeDelete(pool);
        default:
          return { data: null, error: new Error(`Unknown operation: ${this._operation}`), count: null };
      }
    } catch (err) {
      console.error(`[dbShim] ${this._operation} on "${this._table}" failed:`, (err as Error).message);
      return { data: null, error: err as Error, count: null };
    }
  }

  private _buildWhere(startIdx: number = 1): { clause: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    let idx = startIdx;

    // Standard AND clauses
    for (const w of this._wheres) {
      if (w.type === 'is_null' || w.type === 'is_not_null') {
        parts.push(w.sql);
      } else if (w.type === 'in') {
        parts.push(`${w.sql}$${idx})`);
        params.push(w.value);
        idx++;
      } else {
        parts.push(`${w.sql}$${idx}`);
        params.push(w.value);
        idx++;
      }
    }

    // PostgREST-style OR clause: "col.op.val,col.op.(val1,val2)"
    if (this._orRaw) {
      const orParts: string[] = [];
      // Split on commas that are NOT inside parentheses
      const segments = this._orRaw.match(/[^,]+\([^)]*\)|[^,]+/g) ?? [];
      for (const seg of segments) {
        const trimmed = seg.trim();
        // Parse "col.op.val" pattern
        const dotIdx1 = trimmed.indexOf('.');
        if (dotIdx1 === -1) continue;
        const col = trimmed.slice(0, dotIdx1);
        const rest = trimmed.slice(dotIdx1 + 1);
        const dotIdx2 = rest.indexOf('.');
        if (dotIdx2 === -1) continue;
        const op = rest.slice(0, dotIdx2);
        const val = rest.slice(dotIdx2 + 1);

        switch (op) {
          case 'eq':
            orParts.push(`"${col}" = $${idx}`);
            params.push(val);
            idx++;
            break;
          case 'neq':
            orParts.push(`"${col}" != $${idx}`);
            params.push(val);
            idx++;
            break;
          case 'in': {
            // Parse "(val1,val2,...)" format
            const inner = val.replace(/^\(|\)$/g, '');
            const vals = inner.split(',').map(v => v.trim());
            orParts.push(`"${col}" = ANY($${idx})`);
            params.push(vals);
            idx++;
            break;
          }
          case 'is':
            if (val === 'null') orParts.push(`"${col}" IS NULL`);
            else if (val === 'true') orParts.push(`"${col}" IS TRUE`);
            else if (val === 'false') orParts.push(`"${col}" IS FALSE`);
            break;
          case 'gt':
            orParts.push(`"${col}" > $${idx}`);
            params.push(val);
            idx++;
            break;
          case 'gte':
            orParts.push(`"${col}" >= $${idx}`);
            params.push(val);
            idx++;
            break;
          case 'lt':
            orParts.push(`"${col}" < $${idx}`);
            params.push(val);
            idx++;
            break;
          case 'lte':
            orParts.push(`"${col}" <= $${idx}`);
            params.push(val);
            idx++;
            break;
          case 'ilike':
            orParts.push(`"${col}" ILIKE $${idx}`);
            params.push(val);
            idx++;
            break;
          default:
            orParts.push(`"${col}" = $${idx}`);
            params.push(val);
            idx++;
        }
      }
      if (orParts.length > 0) {
        parts.push(`(${orParts.join(' OR ')})`);
      }
    }

    if (parts.length === 0) return { clause: '', params: [] };
    return { clause: 'WHERE ' + parts.join(' AND '), params };
  }

  private _buildOrderBy(): string {
    if (this._orders.length === 0) return '';
    const clauses = this._orders.map((o) => {
      let s = `"${o.col}" ${o.ascending ? 'ASC' : 'DESC'}`;
      if (o.nullsFirst === true) s += ' NULLS FIRST';
      else if (o.nullsFirst === false) s += ' NULLS LAST';
      return s;
    });
    return 'ORDER BY ' + clauses.join(', ');
  }

  private async _executeSelect(pool: InstanceType<typeof import('pg').Pool>): Promise<ShimResult> {
    const selectCols = this._headOnly ? 'count(*)::int' : this._selects;
    const { clause, params } = this._buildWhere();
    const orderBy = this._buildOrderBy();
    const limit = this._limitVal != null ? `LIMIT ${this._limitVal}` : '';
    const offset = this._offsetVal != null ? `OFFSET ${this._offsetVal}` : '';

    const sql = `SELECT ${selectCols} FROM "${this._table}" ${clause} ${orderBy} ${limit} ${offset}`.trim();
    const result = await pool.query(sql, params);

    if (this._headOnly) {
      return { data: null, error: null, count: result.rows[0]?.count ?? 0 };
    }

    if (this._countMode === 'exact') {
      // Run a separate COUNT query
      const countSql = `SELECT count(*)::int FROM "${this._table}" ${clause}`.trim();
      const countResult = await pool.query(countSql, params);
      const count = countResult.rows[0]?.count ?? 0;

      if (this._single || this._maybeSingle) {
        const row = result.rows[0] ?? null;
        if (this._single && !row) {
          return { data: null, error: new Error('Row not found'), count };
        }
        return { data: row, error: null, count };
      }
      return { data: result.rows, error: null, count };
    }

    if (this._single || this._maybeSingle) {
      const row = result.rows[0] ?? null;
      if (this._single && !row) {
        return { data: null, error: new Error('Row not found'), count: null };
      }
      return { data: row, error: null, count: null };
    }

    return { data: result.rows, error: null, count: null };
  }

  private async _executeInsert(pool: InstanceType<typeof import('pg').Pool>): Promise<ShimResult> {
    if (!this._insertData) {
      return { data: null, error: new Error('No data to insert'), count: null };
    }

    const rows = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
    if (rows.length === 0) {
      return { data: [], error: null, count: 0 };
    }

    const cols = Object.keys(rows[0]);
    const colNames = cols.map((c) => `"${c}"`).join(', ');

    const allParams: unknown[] = [];
    const valueSets: string[] = [];

    for (const row of rows) {
      const placeholders = cols.map((c, i) => `$${allParams.length + i + 1}`);
      valueSets.push(`(${placeholders.join(', ')})`);
      cols.forEach((c) => allParams.push(pgValue(row[c])));
    }

    const returningCols = this._insertSelect || '*';
    const returning = this._returning ? `RETURNING ${returningCols}` : '';
    const sql = `INSERT INTO "${this._table}" (${colNames}) VALUES ${valueSets.join(', ')} ${returning}`;
    const result = await pool.query(sql, allParams);

    const data = this._single || this._maybeSingle ? result.rows[0] ?? null : result.rows;
    return { data, error: null, count: result.rowCount };
  }

  private async _executeUpdate(pool: InstanceType<typeof import('pg').Pool>): Promise<ShimResult> {
    if (!this._updateData) {
      return { data: null, error: new Error('No data to update'), count: null };
    }

    const cols = Object.keys(this._updateData);
    const setClauses = cols.map((c, i) => `"${c}" = $${i + 1}`);
    const setParams = cols.map((c) => pgValue(this._updateData![c]));

    const { clause, params: whereParams } = this._buildWhere(setParams.length + 1);
    const allParams = [...setParams, ...whereParams];

    const retCols = this._insertSelect || '*';
    const returning = this._returning ? `RETURNING ${retCols}` : '';
    const sql = `UPDATE "${this._table}" SET ${setClauses.join(', ')} ${clause} ${returning}`;
    const result = await pool.query(sql, allParams);

    const data = this._single || this._maybeSingle ? result.rows[0] ?? null : result.rows;
    return { data, error: null, count: result.rowCount };
  }

  private async _executeUpsert(pool: InstanceType<typeof import('pg').Pool>): Promise<ShimResult> {
    if (!this._insertData) {
      return { data: null, error: new Error('No data to upsert'), count: null };
    }

    const rows = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
    if (rows.length === 0) {
      return { data: [], error: null, count: 0 };
    }

    const cols = Object.keys(rows[0]);
    const colNames = cols.map((c) => `"${c}"`).join(', ');
    const conflict = this._upsertConflict ? `"${this._upsertConflict}"` : cols[0] ? `"${cols[0]}"` : 'id';

    const allParams: unknown[] = [];
    const valueSets: string[] = [];

    for (const row of rows) {
      const placeholders = cols.map((_, i) => `$${allParams.length + i + 1}`);
      valueSets.push(`(${placeholders.join(', ')})`);
      cols.forEach((c) => allParams.push(pgValue(row[c])));
    }

    const updateCols = cols
      .filter((c) => c !== this._upsertConflict)
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');

    const retCols = this._insertSelect || '*';
    const sql = `INSERT INTO "${this._table}" (${colNames}) VALUES ${valueSets.join(', ')} ON CONFLICT (${conflict}) DO UPDATE SET ${updateCols} RETURNING ${retCols}`;
    const result = await pool.query(sql, allParams);

    const data = this._single || this._maybeSingle ? result.rows[0] ?? null : result.rows;
    return { data, error: null, count: result.rowCount };
  }

  private async _executeDelete(pool: InstanceType<typeof import('pg').Pool>): Promise<ShimResult> {
    const { clause, params } = this._buildWhere();
    const retColsDel = this._insertSelect || '*';
    const returning = this._returning ? `RETURNING ${retColsDel}` : '';
    const sql = `DELETE FROM "${this._table}" ${clause} ${returning}`;
    const result = await pool.query(sql, params);

    const data = this._single || this._maybeSingle ? result.rows[0] ?? null : result.rows;
    return { data, error: null, count: result.rowCount };
  }
}

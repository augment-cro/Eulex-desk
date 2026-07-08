/**
 * Database connection module for MikeOSS.
 *
 * Production: Uses Cloud SQL Connector with IAM authentication (passwordless).
 * Development: Uses standard pg connection string.
 *
 * @module db
 */

import pg from 'pg';
import {
  Connector,
  AuthTypes,
  IpAddressTypes,
} from '@google-cloud/cloud-sql-connector';

const { Pool } = pg;

let pool: InstanceType<typeof Pool> | null = null;
let connector: Connector | null = null;

/**
 * Returns a shared pg Pool instance.
 * On first call, initializes either a Cloud SQL Connector pool (production)
 * or a standard pg pool (development) based on environment variables.
 */
export async function getPool(): Promise<InstanceType<typeof Pool>> {
  if (pool) return pool;

  const instanceConnectionName = process.env.CLOUD_SQL_CONNECTION_NAME;

  if (instanceConnectionName) {
    // Production: Cloud SQL Connector → IAM auth → mike_app role
    // No password needed — auth via SA identity
    //
    // DB_IP_TYPE controls whether the connector dials Cloud SQL via its
    // PUBLIC IP (default, no VPC required) or PRIVATE IP (via VPC peering).
    // When the backend runs behind a Serverless VPC Access connector with
    // egress=all-traffic we must use PRIVATE; the public 3307 endpoint is
    // unreachable through Cloud NAT.
    const ipType =
      (process.env.DB_IP_TYPE ?? 'PUBLIC').toUpperCase() === 'PRIVATE'
        ? IpAddressTypes.PRIVATE
        : IpAddressTypes.PUBLIC;

    connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName,
      authType: AuthTypes.IAM,
      ipType,
    });
    pool = new Pool({
      ...clientOpts,
      user: process.env.DB_IAM_USER, // e.g. mike-backend@<gcp-project>.iam
      database: process.env.DB_NAME ?? 'mike',
      max: 10,
    });
    console.log(`[db] Cloud SQL Connector init (ipType=${ipType})`);
  } else {
    // Development: standard connection string
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgresql://localhost:5432/mike',
      max: 10,
    });
  }

  // Test connection on first init
  try {
    const client = await pool.connect();
    console.log('[db] Connected to PostgreSQL');
    client.release();
  } catch (err) {
    console.error('[db] Failed to connect to PostgreSQL:', err);
    throw err;
  }

  return pool;
}

/**
 * Execute a parameterized query using the shared pool.
 * Convenience wrapper around pool.query().
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = await getPool();
  return p.query<T>(text, params);
}

/**
 * Get a single client from the pool for transaction support.
 * Remember to call client.release() when done.
 */
export async function getClient(): Promise<pg.PoolClient> {
  const p = await getPool();
  return p.connect();
}

/**
 * Graceful shutdown — close pool and connector.
 * Call this on SIGTERM/SIGINT.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (connector) {
    connector.close();
    connector = null;
  }
  console.log('[db] Pool closed');
}

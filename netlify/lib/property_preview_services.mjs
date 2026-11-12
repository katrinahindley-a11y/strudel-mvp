import pg from 'pg';

const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';
const TARGET = 'england-wales-property-test';
let pool;

function getPool() {
  const value = process.env.CCOD_TEST_DATABASE_URL;
  if (!value) throw Error('Preview test connection is not configured');
  const connection = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(connection.protocol) || connection.hostname !== HOST || decodeURIComponent(connection.pathname) !== '/neondb') throw Error('Preview test endpoint mismatch');
  for (const key of ['host', 'hostaddr', 'service', 'dbname', 'database', 'port', 'user', 'password', 'options']) {
    if (connection.searchParams.has(key)) throw Error('Unsupported preview connection override');
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl', 'uselibpqcompat']) connection.searchParams.delete(key);
  pool ||= new pg.Pool({ connectionString: connection.toString(), ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 5000, statement_timeout: 10000 });
  return pool;
}

export function db() {
  return {
    async query(sql, parameters) {
      const client = await getPool().connect();
      let transaction = false;
      try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        transaction = true;
        const guard = await client.query('SELECT target_name FROM ccod_import.target_guard WHERE id = 1');
        if (guard.rows.length !== 1 || guard.rows[0].target_name !== TARGET) throw Error('Preview test marker mismatch');
        const result = await client.query(sql, parameters);
        await client.query('COMMIT');
        transaction = false;
        return result;
      } catch (error) {
        if (transaction) { try { await client.query('ROLLBACK'); } catch {} }
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

export async function companiesHouse(value) {
  const key = process.env.COMPANIES_HOUSE_API_KEY;
  if (!key) throw Error('Companies House API key is not configured for this preview');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'api.company-information.service.gov.uk' || url.username || url.password || !/^\/company\/(?:[0-9]{8}|[A-Z]{2}[0-9]{6})(?:\/charges)?$/.test(url.pathname)) throw Error('Unsupported Companies House endpoint');
  let response;
  try {
    response = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), Accept: 'application/json' }, signal: AbortSignal.timeout(7000), redirect: 'error' });
  } catch {
    throw Error('Companies House request failed or timed out');
  }
  if (!response.ok) throw Error('Companies House returned HTTP ' + response.status);
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid JSON object');
    return data;
  } catch {
    throw Error('Companies House returned an invalid JSON object');
  }
}

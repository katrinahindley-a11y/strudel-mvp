import pg from 'pg';

const PREVIEW = 'deploy-preview-5--strudelproperty.netlify.app';
const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';
const TARGET = 'england-wales-property-test';
let pool;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export default async (request) => {
  const url = new URL(request.url);
  if (url.hostname !== PREVIEW) return reply({ error: 'PR5 preview only' }, 404);
  if (request.method !== 'GET') return reply({ error: 'GET required' }, 405);
  const title = (url.searchParams.get('title') || '').trim();
  if (title.length > 50 || (title && !/^[A-Za-z0-9-]+$/.test(title))) return reply({ error: 'Enter a title number of at most 50 letters, digits or hyphens' }, 400);
  let client;
  let transaction = false;
  try {
    const value = process.env.CCOD_TEST_DATABASE_URL;
    if (!value) return reply({ error: 'Set CCOD_TEST_DATABASE_URL for Netlify Functions on this preview, then redeploy. Do not change DATABASE_URL.' }, 503);
    const connection = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(connection.protocol) || connection.hostname !== HOST || decodeURIComponent(connection.pathname) !== '/neondb') return reply({ error: 'Test connection target does not match the approved endpoint and database' }, 503);
    for (const key of ['host', 'hostaddr', 'service', 'dbname', 'database', 'port', 'user', 'password', 'options']) {
      if (connection.searchParams.has(key)) return reply({ error: 'Unsupported connection override in test URL' }, 503);
    }
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl', 'uselibpqcompat']) connection.searchParams.delete(key);
    pool ||= new pg.Pool({ connectionString: connection.toString(), ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 5000, statement_timeout: 10000 });
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    const guard = await client.query('SELECT target_name FROM ccod_import.target_guard WHERE id = 1');
    if (guard.rows.length !== 1 || guard.rows[0].target_name !== TARGET) {
      await client.query('ROLLBACK');
      transaction = false;
      return reply({ error: 'Test database marker is missing or incorrect' }, 503);
    }
    const count = await client.query("SELECT (SELECT count(*)::int FROM public.property_titles WHERE source_dataset = 'CCOD') AS titles, (SELECT count(*)::int FROM public.property_proprietors) AS proprietors, (SELECT count(*)::int FROM public.property_charge_matches) AS charge_matches");
    const result = await client.query(`
      SELECT t.title_number, t.property_address, t.postcode, t.tenure,
             t.source_dataset, t.source_snapshot_month,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'position', p.proprietor_position, 'name', p.proprietor_name,
               'registration_number_raw', p.registration_number_raw,
               'company_number_candidate', p.company_number_candidate,
               'company_match_status', p.company_match_status
             ) ORDER BY p.proprietor_position)
             FROM public.property_proprietors p WHERE p.title_number = t.title_number), '[]'::jsonb) AS proprietors
      FROM public.property_titles t
      WHERE t.source_dataset = 'CCOD' AND ($1::text = '' OR t.title_number = $1)
      ORDER BY t.imported_at DESC, t.title_number
      LIMIT 20
    `, [title]);
    await client.query('COMMIT');
    transaction = false;
    return reply({ target: TARGET, scope: 'PR5 test branch only; no Mayfair postcode restriction; not production search', counts: count.rows[0], title: title || null, items: result.rows });
  } catch (error) {
    if (client && transaction) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('PR5 property read test failed', error?.name || 'Error');
    return reply({ error: 'Test read failed. Check preview configuration and function logs; no credentials are returned.' }, 503);
  } finally {
    if (client) client.release();
  }
};

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
  const query = (url.searchParams.get('q') || '').trim();
  const tenure = (url.searchParams.get('tenure') || '').trim();
  const pageText = url.searchParams.get('page') || '1';
  const page = Number(pageText);
  const pageSize = 20;
  if (query.length > 150) return reply({ error: 'Search text must be 150 characters or fewer' }, 400);
  if (tenure && !['Freehold', 'Leasehold'].includes(tenure)) return reply({ error: 'Invalid tenure' }, 400);
  if (!/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 10000) return reply({ error: 'page must be between 1 and 10000' }, 400);
  let client;
  let transaction = false;
  try {
    const value = process.env.CCOD_TEST_DATABASE_URL;
    if (!value) return reply({ error: 'CCOD_TEST_DATABASE_URL must be configured for this preview’s Netlify Functions. Do not change DATABASE_URL.' }, 503);
    const connection = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(connection.protocol) || connection.hostname !== HOST || decodeURIComponent(connection.pathname) !== '/neondb') return reply({ error: 'Test database endpoint does not match the approved target' }, 503);
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
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const parameters = [tenure, query, `%${escaped}%`, `%${escaped.replace(/\s/g, '')}%`];
    const filter = `t.source_dataset = 'CCOD'
      AND ($1::text = '' OR t.tenure = $1)
      AND ($2::text = '' OR t.property_address ILIKE $3 OR t.title_number ILIKE $3
        OR REPLACE(t.postcode, ' ', '') ILIKE $4
        OR EXISTS (SELECT 1 FROM public.property_proprietors p WHERE p.title_number = t.title_number
          AND (p.proprietor_name ILIKE $3 OR p.company_number_candidate ILIKE $3)))`;
    const count = await client.query(`SELECT count(*)::int AS total_results FROM public.property_titles t WHERE ${filter}`, parameters);
    const result = await client.query(`
      SELECT t.title_number, t.property_address, t.postcode, t.district, t.county, t.region,
             t.tenure, t.price_paid, t.date_proprietor_added, t.multiple_address_indicator,
             t.additional_proprietor_indicator, t.source_dataset, t.source_snapshot_month,
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'position', p.proprietor_position, 'name', p.proprietor_name,
               'registration_number_raw', p.registration_number_raw,
               'company_number_candidate', p.company_number_candidate,
               'category', p.proprietorship_category, 'matched_company_id', p.matched_company_id,
               'company_match_status', p.company_match_status
             ) ORDER BY p.proprietor_position) FROM public.property_proprietors p
             WHERE p.title_number = t.title_number), '[]'::jsonb) AS proprietors
      FROM public.property_titles t WHERE ${filter}
      ORDER BY t.property_address NULLS LAST, t.title_number LIMIT $5 OFFSET $6
    `, [...parameters, pageSize, (page - 1) * pageSize]);
    await client.query('COMMIT');
    transaction = false;
    const total = count.rows[0].total_results;
    return reply({ target: TARGET, area: 'Limited CCOD test dataset; not full national coverage', coverage: 'UK corporate ownership dataset only', query, tenure: tenure || null, page, page_size: pageSize, total_results: total, total_pages: Math.ceil(total / pageSize), items: result.rows });
  } catch (error) {
    if (client && transaction) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('PR5 branded property search failed', error?.name || 'Error');
    return reply({ error: 'Preview property search failed. Check the test connection and function logs; no credentials are returned.' }, 503);
  } finally {
    if (client) client.release();
  }
};

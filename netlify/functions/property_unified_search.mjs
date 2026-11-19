import pg from 'pg';
import { companiesHouse } from './shared.mjs';

const ALLOWED_HOSTS = new Set([
  'strudelproperty.netlify.app',
  'deploy-preview-5--strudelproperty.netlify.app'
]);
const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';
const TARGET = 'england-wales-property-test';
let pool;

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function isCompanyNumber(value) {
  return /^[0-9]{8}$/.test(value) || /^(OC|SC|NI|FC|IP|LP|SL)[0-9A-Z]{5,8}$/i.test(value);
}

function isChargeReference(value) {
  return /^[A-Za-z0-9-]{1,50}$/.test(value) && /\d/.test(value);
}

function propertyFilter(companyNumber) {
  return `t.source_dataset = 'CCOD'
    AND EXISTS (
      SELECT 1 FROM ccod_import.refresh_membership m
      WHERE m.title_number = t.title_number
        AND m.managed_high_value = true
        AND m.active = true
    )
    AND EXISTS (
      SELECT 1 FROM public.property_proprietors p
      WHERE p.title_number = t.title_number
        AND p.company_number_candidate = $1
    )`;
}

async function linkedProperties(client, companyNumber) {
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
    FROM public.property_titles t
    WHERE ${propertyFilter(companyNumber)}
    ORDER BY t.property_address NULLS LAST, t.title_number
    LIMIT 50
  `, [companyNumber]);
  return result.rows.map(row => ({ ...row, association_type: 'Company-level property association' }));
}

export default async (request) => {
  const url = new URL(request.url);
  if (!ALLOWED_HOSTS.has(url.hostname)) return reply({ error: 'Unified property search is not enabled on this hostname' }, 404);
  if (request.method !== 'GET') return reply({ error: 'GET required' }, 405);

  const company = (url.searchParams.get('company') || '').trim().toUpperCase();
  const companyName = (url.searchParams.get('company_name') || '').trim();
  const lender = (url.searchParams.get('lender') || '').trim();
  const charge = (url.searchParams.get('charge') || '').trim();

  if ([company, companyName, lender, charge].filter(Boolean).length !== 1) {
    return reply({ error: 'Provide exactly one of company, company_name, lender or charge' }, 400);
  }
  if (company && !isCompanyNumber(company)) return reply({ error: 'Invalid company number' }, 400);
  if (charge && !isChargeReference(charge)) return reply({ error: 'Invalid charge reference' }, 400);
  if ((companyName || lender) && (companyName.length > 150 || lender.length > 150)) {
    return reply({ error: 'Search text must be 150 characters or fewer' }, 400);
  }

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

    if (companyName) {
      const search = await companiesHouse(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=10`);
      await client.query('COMMIT');
      transaction = false;
      return reply({ mode: 'company_name', query: companyName, companies: Array.isArray(search.items) ? search.items : [], charges: [], properties: [] });
    }

    let borrower = null;
    let charges = [];

    if (company) {
      const companyRow = await client.query('SELECT id, company_number, name, company_status FROM public.companies WHERE company_number = $1', [company]);
      borrower = companyRow.rows[0] || { company_number: company, name: null, company_status: null };
      const chargeData = await companiesHouse(`https://api.company-information.service.gov.uk/company/${encodeURIComponent(company)}/charges`);
      charges = (Array.isArray(chargeData.items) ? chargeData.items : []).map(item => ({ ...item, borrower }));
    }

    if (lender) {
      const pattern = `%${lender.replace(/[\\%_]/g, '\\$&')}%`;
      const rows = await client.query(`
        SELECT ch.external_charge_id, ch.created_on, ch.delivered_on, ch.status, ch.satisfied_on,
               ch.description, ch.persons_entitled_raw, ch.raw_data,
               c.company_number, c.name AS company_name, c.company_status
        FROM public.charges ch
        JOIN public.companies c ON c.id = ch.company_id
        WHERE ch.persons_entitled_raw ILIKE $1
        ORDER BY ch.created_on DESC NULLS LAST
        LIMIT 20
      `, [pattern]);
      charges = rows.rows.map(row => {
        const borrowerCompany = { company_number: row.company_number, name: row.company_name, company_status: row.company_status };
        const raw = row.raw_data || {};
        return { ...raw, external_charge_id: row.external_charge_id, borrower: borrowerCompany };
      });
    }

    if (charge) {
      const rows = await client.query(`
        SELECT ch.external_charge_id, ch.created_on, ch.delivered_on, ch.status, ch.satisfied_on,
               ch.description, ch.persons_entitled_raw, ch.raw_data,
               c.company_number, c.name AS company_name, c.company_status
        FROM public.charges ch
        JOIN public.companies c ON c.id = ch.company_id
        WHERE ch.external_charge_id ILIKE $1
        LIMIT 20
      `, [`%${charge}%`]);
      charges = rows.rows.map(row => {
        const borrowerCompany = { company_number: row.company_number, name: row.company_name, company_status: row.company_status };
        const raw = row.raw_data || {};
        return { ...raw, external_charge_id: row.external_charge_id, borrower: borrowerCompany };
      });
    }

    const properties = borrower?.company_number ? await linkedProperties(client, borrower.company_number) : [];
    await client.query('COMMIT');
    transaction = false;

    return reply({
      mode: company ? 'company_number' : lender ? 'lender' : 'charge_reference',
      query: company || lender || charge,
      companies: [],
      charges,
      properties,
      disclaimer: 'Companies House charges are company-level records. Property links are company-level associations and are not Land Registry mortgage verification.'
    });
  } catch (error) {
    if (client && transaction) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('Unified property search failed', error?.name || 'Error');
    return reply({ error: 'Unified property search failed. Check the test connection and function logs; no credentials are returned.' }, 503);
  } finally {
    if (client) client.release();
  }
};

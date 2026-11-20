import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw Error('GITHUB_ACTIONS_ONLY');
  const url = new URL(process.env.CHARGE_CI_DATABASE_URL || '');
  if (url.protocol !== 'postgresql:' || url.hostname !== 'localhost' || url.port !== '5432' || url.pathname !== '/neondb' || url.username !== 'charge_ci' || url.search || url.hash) throw Error('DISPOSABLE_DATABASE_REQUIRED');
  globalThis.fetch = async () => { throw Error('NETWORK_REQUESTS_DISABLED'); };
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  const temp = await mkdtemp(join(tmpdir(), 'charge-pipeline-ci-'));
  try {
    const client = await pool.connect();
    try {
      const existing = await client.query("SELECT to_regclass('public.companies') AS existing");
      if (existing.rows[0].existing !== null) throw Error('EMPTY_DISPOSABLE_DATABASE_REQUIRED');
      await client.query(`CREATE SCHEMA ccod_import;
        CREATE TABLE ccod_import.target_guard (id integer PRIMARY KEY, target_name text NOT NULL);
        INSERT INTO ccod_import.target_guard VALUES (1, 'england-wales-property-test');
        CREATE TABLE public.property_titles (title_number text PRIMARY KEY, source_dataset text, price_paid numeric);
        CREATE TABLE public.property_proprietors (title_number text, company_number_candidate text, proprietor_name text);
        CREATE TABLE ccod_import.refresh_membership (title_number text, managed_high_value boolean, active boolean);
        CREATE TABLE public.companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_number text UNIQUE NOT NULL,
          name text NOT NULL, normalized_name text NOT NULL, company_status text, company_type text,
          incorporation_date date, dissolution_date date, sic_codes text[], registered_address jsonb, postcode text,
          last_fetched_at timestamptz, raw_data jsonb, updated_at timestamptz DEFAULT now());
        CREATE TABLE public.charges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES public.companies(id),
          external_charge_id text NOT NULL, created_on date, delivered_on date, status text, satisfied_on date,
          description text, persons_entitled_raw jsonb, raw_data jsonb, last_fetched_at timestamptz,
          updated_at timestamptz DEFAULT now(), UNIQUE(company_id, external_charge_id));
        INSERT INTO public.property_titles VALUES ('SYNTH1', 'CCOD', 6000000), ('SYNTH2', 'CCOD', 7000000);
        INSERT INTO public.property_proprietors VALUES ('SYNTH1', '00000000', 'SYNTHETIC TEST ONLY'), ('SYNTH2', '00000001', 'SYNTHETIC ZERO ONLY');
        INSERT INTO ccod_import.refresh_membership VALUES ('SYNTH1', true, true), ('SYNTH2', true, true);`);
      for (const file of ['migrations/draft_company_charge_scan_tracking.sql', 'migrations/draft_company_charge_publication_tracking.sql']) {
        await client.query(await readFile(file, 'utf8'));
      }
    } finally { client.release(); }
    await mkdir(join(temp, 'lib'));
    const original = "const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';";
    for (const file of ['collect_company_charges.mjs', 'stage_company_charge_scan.mjs', 'publish_company_charge_scan.mjs']) {
      let source = await readFile('scripts/lib/' + file, 'utf8');
      if (file !== 'collect_company_charges.mjs') {
        assert.equal(source.split(original).length, 2, 'Host guard template changed; refusing adaptation');
        source = source.replace(original, "const HOST = 'localhost';");
      }
      await writeFile(join(temp, 'lib', file), source);
    }
    const { stageCompanyChargeScan: stage } = await import(pathToFileURL(join(temp, 'lib/stage_company_charge_scan.mjs')));
    const { publishCompanyChargeScan: publish } = await import(pathToFileURL(join(temp, 'lib/publish_company_charge_scan.mjs')));
    const response = (number, kind = 'normal') => async path => {
      const parsed = new URL(path, 'https://synthetic.invalid');
      if (parsed.pathname === '/company/' + number) return { company_number: number, company_name: number === '00000001' ? 'SYNTHETIC ZERO ONLY' : 'SYNTHETIC TEST ONLY' };
      assert.equal(parsed.pathname, '/company/' + number + '/charges');
      const start = Number(parsed.searchParams.get('start_index'));
      if (number === '00000001') return { items: [], total_count: 0, start_index: start };
      const charge = { charge_number: 1, charge_code: 'SYNTHETIC-CHARGE-1', status: kind === 'changed' ? 'satisfied' : 'outstanding',
        persons_entitled: [{ name: 'SYNTHETIC TEST LENDER' }], particulars: { description: 'Synthetic land registered under title SYNTH1.' } };
      return { items: start === 0 ? [charge] : [], total_count: kind === 'incomplete' ? 2 : 1, start_index: start };
    };
    const first = await stage({ companyNumber: '00000000', pool, request: response('00000000'), apply: true });
    await publish({ companyNumber: '00000000', scanId: first.scanId, pool, apply: true });
    const initial = await pool.query('SELECT id, status, last_fetched_at FROM public.charges');
    assert.equal(initial.rowCount, 1); assert.equal(initial.rows[0].status, 'outstanding');
    await publish({ companyNumber: '00000000', scanId: first.scanId, pool, apply: true });
    const repeated = await pool.query('SELECT id, last_fetched_at FROM public.charges');
    assert.equal(repeated.rowCount, 1); assert.equal(repeated.rows[0].id, initial.rows[0].id);
    assert.equal(repeated.rows[0].last_fetched_at.getTime(), initial.rows[0].last_fetched_at.getTime());
    const second = await stage({ companyNumber: '00000000', pool, request: response('00000000', 'changed'), apply: true });
    const failingPool = { async connect() {
      const c = await pool.connect();
      return { connectionParameters: c.connectionParameters, release: destroy => c.release(destroy),
        query: (sql, args) => { if (sql.includes('SET last_published_scan_id')) throw Error('INJECTED_PUBLICATION_FAILURE'); return c.query(sql, args); } };
    } };
    await assert.rejects(publish({ companyNumber: '00000000', scanId: second.scanId, pool: failingPool, apply: true }), /CHARGE_PUBLICATION_FAILED/);
    const afterFailure = await pool.query("SELECT ch.status, st.last_published_scan_id FROM public.charges ch JOIN public.companies c ON c.id = ch.company_id JOIN ccod_import.company_charge_scan_state st ON st.company_number = c.company_number");
    assert.equal(afterFailure.rows[0].status, 'outstanding'); assert.equal(afterFailure.rows[0].last_published_scan_id, first.scanId);
    await publish({ companyNumber: '00000000', scanId: second.scanId, pool, apply: true });
    assert.equal((await pool.query('SELECT status FROM public.charges')).rows[0].status, 'satisfied');
    await assert.rejects(stage({ companyNumber: '00000000', pool, request: response('00000000', 'incomplete'), apply: true }), /CHARGE_SCAN_FAILED/);
    const preserved = await pool.query("SELECT status, last_successful_scan_id, last_published_scan_id FROM ccod_import.company_charge_scan_state WHERE company_number = '00000000'");
    assert.equal(preserved.rows[0].status, 'failed'); assert.equal(preserved.rows[0].last_successful_scan_id, second.scanId); assert.equal(preserved.rows[0].last_published_scan_id, second.scanId);
    const zero = await stage({ companyNumber: '00000001', pool, request: response('00000001'), apply: true });
    await publish({ companyNumber: '00000001', scanId: zero.scanId, pool, apply: true });
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM public.charges ch JOIN public.companies c ON c.id = ch.company_id WHERE c.company_number = '00000001'")).rows[0].count, 0);
    await pool.query(`DELETE FROM ccod_import.company_charge_scan_state;
      DELETE FROM ccod_import.company_charge_scans;
      DELETE FROM public.charges; DELETE FROM public.companies;
      DELETE FROM public.property_proprietors; DELETE FROM ccod_import.refresh_membership; DELETE FROM public.property_titles;`);
    const cleanup = await pool.query(`SELECT (SELECT count(*) FROM public.charges) + (SELECT count(*) FROM public.companies)
      + (SELECT count(*) FROM ccod_import.company_charge_scans) + (SELECT count(*) FROM ccod_import.company_charge_scan_state) AS remaining`);
    assert.equal(Number(cleanup.rows[0].remaining), 0);
    console.log(JSON.stringify({ passed: true, database: 'disposable_postgres', api: 'synthetic_only',
      hostAdaptation: 'temporary copies only; application sources unchanged',
      checks: ['staging', 'publication', 'repeat_id_stability', 'source_timestamp', 'real_transaction_rollback', 'status_update', 'incomplete_scan_preservation', 'zero_charges', 'fixture_cleanup'] }));
  } finally { await pool.end(); await rm(temp, { recursive: true, force: true }); }
}
main().catch(() => { console.error(JSON.stringify({ passed: false, error: 'CHARGE_PIPELINE_INTEGRATION_FAILED' })); process.exitCode = 1; });

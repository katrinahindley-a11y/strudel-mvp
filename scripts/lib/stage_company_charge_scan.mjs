import { randomUUID } from 'node:crypto';
import { collectCompanyCharges } from './collect_company_charges.mjs';
import { safeChargeScanDiagnostic } from './charge_scan_diagnostics.mjs';

const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';
const TARGET = 'england-wales-property-test';
const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function assertScope(client, companyNumber) {
  const guard = await client.query('SELECT target_name FROM ccod_import.target_guard WHERE id = 1');
  if (guard.rows.length !== 1 || guard.rows[0].target_name !== TARGET) throw Error('TARGET_GUARD_FAILED');
  const scope = await client.query(`SELECT DISTINCT p.proprietor_name
    FROM public.property_proprietors p JOIN public.property_titles t ON t.title_number = p.title_number
    WHERE p.company_number_candidate = $1 AND t.source_dataset = 'CCOD' AND t.price_paid > 5000000
      AND EXISTS (SELECT 1 FROM ccod_import.refresh_membership m WHERE m.title_number = t.title_number
                  AND m.managed_high_value = true AND m.active = true)`, [companyNumber]);
  if (!scope.rows.length) throw Error('COMPANY_OUTSIDE_APPROVED_SCOPE');
  return scope.rows.map(row => normalize(row.proprietor_name));
}

export async function stageCompanyChargeScan({ companyNumber, pool, request, apply = false, maxPages = 10 }) {
  if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber || '')) throw Error('INVALID_COMPANY_NUMBER');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw Error('INVALID_PAGE_BUDGET');
  if (apply !== true) return { mode: 'dry_run', companyNumber, maxPages, executed: false };
  if (typeof request !== 'function' || !pool || typeof pool.connect !== 'function') throw Error('MISSING_DEPENDENCY');
  const client = await pool.connect();
  const token = randomUUID();
  let locked = false, started = false, transaction = false, destroy = false;
  try {
    if (client.connectionParameters?.host !== HOST || client.connectionParameters?.database !== 'neondb') throw Error('UNAPPROVED_DATABASE_ENDPOINT');
    const names = await assertScope(client, companyNumber);
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended('ccod-charge-scan:' || $1, 0)) AS acquired", [companyNumber]);
    if (!lock.rows[0]?.acquired) throw Error('COMPANY_SCAN_ALREADY_RUNNING');
    locked = true;
    await client.query(`INSERT INTO ccod_import.company_charge_scan_state
      (company_number, status, attempt_token, attempts, last_attempted_at, updated_at)
      VALUES ($1, 'running', $2, 1, now(), now())
      ON CONFLICT (company_number) DO UPDATE SET status = 'running', attempt_token = EXCLUDED.attempt_token,
        attempts = ccod_import.company_charge_scan_state.attempts + 1,
        last_attempted_at = now(), last_error_code = NULL, updated_at = now()`, [companyNumber, token]);
    started = true;
    const company = await request('/company/' + companyNumber);
    if (company?.company_number !== companyNumber || !company.company_name) throw Error('COMPANY_IDENTITY_MISMATCH');
    if (!names.includes(normalize(company.company_name))) throw Error('PROPRIETOR_NAME_REQUIRES_REVIEW');
    const scan = await collectCompanyCharges(companyNumber, request, { maxPages });
    if (scan.scanComplete !== true) throw Error('INCOMPLETE_CHARGE_SCAN');
    await client.query('BEGIN'); transaction = true;
    await assertScope(client, companyNumber);
    await client.query(`INSERT INTO ccod_import.company_charge_scans
      (id, company_number, company_profile, charges, records_seen, pages_fetched, identity_status)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, 'name_consistent_unverified')`,
      [token, companyNumber, JSON.stringify(company), JSON.stringify(scan.charges), scan.charges.length, scan.pagesFetched]);
    const saved = await client.query(`UPDATE ccod_import.company_charge_scan_state
      SET status = 'complete', last_successful_scan_id = $2, last_successful_at = now(),
          last_successful_charge_count = $3, last_error_code = NULL, updated_at = now()
      WHERE company_number = $1 AND attempt_token = $2`, [companyNumber, token, scan.charges.length]);
    if (saved.rowCount !== 1) throw Error('SCAN_OWNERSHIP_LOST');
    await client.query('COMMIT'); transaction = false;
    return { mode: 'staged', companyNumber, scanId: token, charges: scan.charges.length,
      pagesFetched: scan.pagesFetched, identityStatus: 'name_consistent_unverified', publishedToSearch: false };
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); transaction = false; } catch { destroy = true; }
    }
    const code = safeChargeScanDiagnostic(error);
    if (started && !destroy) {
      try {
        await client.query(`UPDATE ccod_import.company_charge_scan_state
          SET status = 'failed', last_error_code = $3, updated_at = now()
          WHERE company_number = $1 AND attempt_token = $2`, [companyNumber, token, code]);
      } catch { destroy = true; }
    }
    throw Error(code);
  } finally {
    if (locked && !destroy) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended('ccod-charge-scan:' || $1, 0))", [companyNumber]); }
      catch { destroy = true; }
    }
    client.release(destroy);
  }
}

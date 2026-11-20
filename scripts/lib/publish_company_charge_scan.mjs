const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';
const normalize = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const identifiers = charge => [charge?.charge_number, charge?.charge_code, charge?.links?.self]
  .filter(value => value !== undefined && value !== null && String(value) !== '').map(String);

export function planChargePublication(charges, existing) {
  if (!Array.isArray(charges) || !Array.isArray(existing)) throw Error('INVALID_CHARGE_SNAPSHOT');
  const used = new Set(); const incoming = new Set(); const outputIds = new Set();
  const plan = charges.map(charge => {
    const aliases = identifiers(charge);
    if (!aliases.length) throw Error('MISSING_CHARGE_IDENTIFIER');
    if (aliases.some(id => incoming.has(id))) throw Error('DUPLICATE_INCOMING_CHARGE');
    aliases.forEach(id => incoming.add(id));
    const matches = existing.map((row, index) => ({ row, index })).filter(({ row }) =>
      [String(row.external_charge_id), ...identifiers(row.raw_data)].some(id => aliases.includes(id)));
    if (matches.length > 1 || (matches.length === 1 && used.has(matches[0].index))) throw Error('AMBIGUOUS_STORED_CHARGE');
    const externalId = matches.length ? String(matches[0].row.external_charge_id) : aliases[0];
    if (outputIds.has(externalId)) throw Error('DUPLICATE_OUTPUT_IDENTIFIER');
    outputIds.add(externalId);
    if (matches.length) used.add(matches[0].index);
    return { externalId, charge };
  });
  if (used.size !== existing.length) throw Error('STORED_CHARGES_MISSING_FROM_SNAPSHOT_REVIEW_REQUIRED');
  return plan;
}

export async function publishCompanyChargeScan({ companyNumber, scanId, pool, apply = false }) {
  if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber || '')) throw Error('INVALID_COMPANY_NUMBER');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId || '')) throw Error('INVALID_SCAN_ID');
  if (apply !== true) return { mode: 'dry_run', executed: false, companyNumber, scanId };
  const client = await pool.connect();
  let transaction = false, destroy = false;
  try {
    if (client.connectionParameters?.host !== HOST || client.connectionParameters?.database !== 'neondb') throw Error('UNAPPROVED_DATABASE_ENDPOINT');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); transaction = true;
    const guard = await client.query('SELECT target_name FROM ccod_import.target_guard WHERE id = 1');
    if (guard.rows.length !== 1 || guard.rows[0].target_name !== 'england-wales-property-test') throw Error('TARGET_GUARD_FAILED');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ccod-charge-scan:' || $1, 0))", [companyNumber]);
    const selected = await client.query(`SELECT s.* FROM ccod_import.company_charge_scans s
      JOIN ccod_import.company_charge_scan_state st ON st.company_number = s.company_number
      WHERE s.company_number = $1 AND s.id = $2 AND st.last_successful_scan_id = s.id
        AND st.status = 'complete' AND s.completed_at >= now() - interval '24 hours'
        AND s.identity_status = 'name_consistent_unverified'
      FOR UPDATE OF st`, [companyNumber, scanId]);
    if (selected.rows.length !== 1) throw Error('SCAN_NOT_CURRENT_COMPLETE_OR_FRESH');
    const snapshot = selected.rows[0]; const company = snapshot.company_profile;
    if (company?.company_number !== companyNumber || !company.company_name || !Array.isArray(snapshot.charges) || snapshot.charges.length !== snapshot.records_seen) throw Error('INVALID_CHARGE_SNAPSHOT');
    const scope = await client.query(`SELECT DISTINCT p.proprietor_name FROM public.property_proprietors p
      JOIN public.property_titles t ON t.title_number = p.title_number
      WHERE p.company_number_candidate = $1 AND t.source_dataset = 'CCOD' AND t.price_paid > 5000000
        AND EXISTS (SELECT 1 FROM ccod_import.refresh_membership m WHERE m.title_number = t.title_number
                    AND m.managed_high_value = true AND m.active = true)`, [companyNumber]);
    if (!scope.rows.some(row => normalize(row.proprietor_name) === normalize(company.company_name))) throw Error('PROPRIETOR_NAME_REQUIRES_REVIEW');
    const address = company.registered_office_address || {};
    const saved = await client.query(`INSERT INTO public.companies
      (company_number, name, normalized_name, company_status, company_type, incorporation_date,
       dissolution_date, sic_codes, registered_address, postcode, last_fetched_at, raw_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb)
      ON CONFLICT (company_number) DO UPDATE SET name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name,
        company_status = EXCLUDED.company_status, company_type = EXCLUDED.company_type,
        incorporation_date = EXCLUDED.incorporation_date, dissolution_date = EXCLUDED.dissolution_date,
        sic_codes = EXCLUDED.sic_codes, registered_address = EXCLUDED.registered_address, postcode = EXCLUDED.postcode,
        last_fetched_at = EXCLUDED.last_fetched_at, raw_data = EXCLUDED.raw_data, updated_at = now() RETURNING id`,
      [companyNumber, company.company_name, company.company_name.toLowerCase(), company.company_status || null,
       company.type || null, company.date_of_creation || null, company.date_of_cessation || null, company.sic_codes || [],
       JSON.stringify(address), address.postal_code || null, snapshot.completed_at, JSON.stringify(company)]);
    const companyId = saved.rows[0].id;
    const existing = await client.query('SELECT external_charge_id, raw_data FROM public.charges WHERE company_id = $1 FOR UPDATE', [companyId]);
    const plan = planChargePublication(snapshot.charges, existing.rows);
    for (const { externalId, charge } of plan) {
      await client.query(`INSERT INTO public.charges
        (company_id, external_charge_id, created_on, delivered_on, status, satisfied_on, description,
         persons_entitled_raw, raw_data, last_fetched_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
        ON CONFLICT (company_id, external_charge_id) DO UPDATE SET created_on = EXCLUDED.created_on,
          delivered_on = EXCLUDED.delivered_on, status = EXCLUDED.status, satisfied_on = EXCLUDED.satisfied_on,
          description = EXCLUDED.description, persons_entitled_raw = EXCLUDED.persons_entitled_raw,
          raw_data = EXCLUDED.raw_data, last_fetched_at = EXCLUDED.last_fetched_at, updated_at = now()`,
        [companyId, externalId, charge.created_on || null, charge.delivered_on || null, charge.status || null,
         charge.satisfied_on || null, charge.particulars?.description || charge.description || null,
         JSON.stringify(charge.persons_entitled || []), JSON.stringify(charge), snapshot.completed_at]);
    }
    const marker = await client.query(`UPDATE ccod_import.company_charge_scan_state
      SET last_published_scan_id = $2, last_published_at = now(), updated_at = now()
      WHERE company_number = $1 AND last_successful_scan_id = $2 AND status = 'complete'`, [companyNumber, scanId]);
    if (marker.rowCount !== 1) throw Error('PUBLICATION_OWNERSHIP_LOST');
    await client.query('COMMIT'); transaction = false;
    return { mode: 'published', companyNumber, scanId, charges: plan.length, identityStatus: 'name_consistent_unverified' };
  } catch (error) {
    if (transaction) { try { await client.query('ROLLBACK'); } catch { destroy = true; } }
    const allowed = ['UNAPPROVED_DATABASE_ENDPOINT', 'TARGET_GUARD_FAILED', 'SCAN_NOT_CURRENT_COMPLETE_OR_FRESH',
      'INVALID_CHARGE_SNAPSHOT', 'PROPRIETOR_NAME_REQUIRES_REVIEW', 'MISSING_CHARGE_IDENTIFIER',
      'DUPLICATE_INCOMING_CHARGE', 'AMBIGUOUS_STORED_CHARGE', 'DUPLICATE_OUTPUT_IDENTIFIER',
      'STORED_CHARGES_MISSING_FROM_SNAPSHOT_REVIEW_REQUIRED', 'PUBLICATION_OWNERSHIP_LOST'];
    throw Error(allowed.includes(error.message) ? error.message : 'CHARGE_PUBLICATION_FAILED');
  } finally { client.release(destroy); }
}

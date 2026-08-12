import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(express.json());
app.use(express.static(__dirname));

function chHeaders() {
  if (!process.env.COMPANIES_HOUSE_API_KEY) throw new Error('COMPANIES_HOUSE_API_KEY is not configured');
  return { Authorization: `Basic ${Buffer.from(`${process.env.COMPANIES_HOUSE_API_KEY}:`).toString('base64')}` };
}

async function chGet(url) {
  const response = await fetch(url, { headers: chHeaders() });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || body.message || `Companies House returned ${response.status}`);
  return body;
}

async function upsertCompany(company) {
  const address = company.registered_office_address || {};
  const result = await pool.query(`
    INSERT INTO companies
      (company_number, name, normalized_name, company_status, company_type, incorporation_date, dissolution_date, sic_codes, registered_address, postcode, source_updated_at, last_fetched_at, raw_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)
    ON CONFLICT (company_number) DO UPDATE SET
      name=EXCLUDED.name, normalized_name=EXCLUDED.normalized_name,
      company_status=EXCLUDED.company_status, company_type=EXCLUDED.company_type,
      incorporation_date=EXCLUDED.incorporation_date, dissolution_date=EXCLUDED.dissolution_date,
      sic_codes=EXCLUDED.sic_codes, registered_address=EXCLUDED.registered_address,
      postcode=EXCLUDED.postcode, source_updated_at=EXCLUDED.source_updated_at,
      last_fetched_at=NOW(), raw_data=EXCLUDED.raw_data, updated_at=NOW()
    RETURNING *`, [
      company.company_number, company.company_name, company.company_name.toLowerCase(), company.company_status,
      company.type, company.date_of_creation || null, company.date_of_cessation || null,
      company.sic_codes || [], address, address.postal_code || null, company.last_accounts?.made_up_to || null, company
    ]);
  return result.rows[0];
}

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const data = await chGet(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(q)}&items_per_page=20`);
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/companies/:number', async (req, res) => {
  const number = req.params.number.toUpperCase();
  try {
    const [company, officers, charges] = await Promise.all([
      chGet(`https://api.company-information.service.gov.uk/company/${number}`),
      chGet(`https://api.company-information.service.gov.uk/company/${number}/officers`),
      chGet(`https://api.company-information.service.gov.uk/company/${number}/charges`)
    ]);
    const stored = await upsertCompany(company);
    for (const officer of officers.items || []) {
      await pool.query(`INSERT INTO officers (name, normalized_name, address, raw_data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [officer.name, officer.name.toLowerCase(), officer.address || {}, officer]);
    }
    res.json({ company, stored_id: stored.id, officers: officers.items || [], charges: charges.items || [] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/lead-lists/default/members', async (req, res) => {
  try {
    const { company_number } = req.body;
    const company = await pool.query('SELECT id FROM companies WHERE company_number=$1', [company_number]);
    if (!company.rowCount) return res.status(404).json({ error: 'Import the company profile before saving it to a lead list.' });
    let list = await pool.query("SELECT id FROM lead_lists WHERE name='Default Strudel Leads' LIMIT 1");
    if (!list.rowCount) list = await pool.query("INSERT INTO lead_lists (name, description) VALUES ('Default Strudel Leads','Initial Strudel lead list') RETURNING id");
    await pool.query('INSERT INTO lead_list_members (lead_list_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [list.rows[0].id, company.rows[0].id]);
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/health', async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });
app.listen(port, () => console.log(`Strudel running on port ${port}`));

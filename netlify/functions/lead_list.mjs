import { db, json, errorResponse } from './shared.mjs';

export default async (request) => {
  try {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
    const { company_number } = await request.json();
    if (!company_number) return json({ error: 'company_number is required' }, 400);

    const company = await db().query('SELECT id FROM companies WHERE company_number=$1', [company_number]);
    if (!company.rowCount) return json({ error: 'Import the company profile before saving it to a lead list' }, 404);

    let list = await db().query("SELECT id FROM lead_lists WHERE name='Default Strudel Leads' LIMIT 1");
    if (!list.rowCount) {
      list = await db().query("INSERT INTO lead_lists (name, description) VALUES ('Default Strudel Leads','Initial Strudel lead list') RETURNING id");
    }

    await db().query(
      'INSERT INTO lead_list_members (lead_list_id, company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [list.rows[0].id, company.rows[0].id]
    );

    return json({ ok: true, lead_list_id: list.rows[0].id });
  } catch (error) {
    return errorResponse(error);
  }
};

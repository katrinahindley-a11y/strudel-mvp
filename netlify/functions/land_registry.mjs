import { db, json, errorResponse } from './shared.mjs';

export default async (request) => {
  try {
    const number = new URL(request.url)
      .searchParams
      .get('number')
      ?.trim()
      .toUpperCase();

    if (!number) {
      return json({ error: 'A company number is required' }, 400);
    }

    const result = await db().query(
      `SELECT
         title_number,
         proprietor_name,
         tenure,
         address,
         postcode,
         price_paid,
         proprietorship_date,
         snapshot_date
       FROM land_registry_company_titles
       WHERE company_number = $1
       ORDER BY address NULLS LAST, title_number`,
      [number]
    );

    return json({
      source: 'HM Land Registry CCOD',
      coverage: 'Registered corporate titles in England and Wales',
      lastUpdated: result.rows[0]?.snapshot_date || null,
      total: result.rowCount,
      properties: result.rows.map((row) => ({
        titleNumber: row.title_number,
        proprietorName: row.proprietor_name,
        tenure: row.tenure,
        address: row.address,
        postcode: row.postcode,
        pricePaid: row.price_paid,
        proprietorshipDate: row.proprietorship_date
      }))
    });
  } catch (error) {
    return errorResponse(error);
  }
};

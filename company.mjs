import { companiesHouse, db, json, errorResponse } from './shared.mjs';

export default async (request) => {
  try {
    const number = new URL(request.url).searchParams.get('number')?.trim().toUpperCase();
    if (!number) return json({ error: 'A company number is required' }, 400);

    const [company, officers, charges] = await Promise.all([
      companiesHouse(`https://api.company-information.service.gov.uk/company/${encodeURIComponent(number)}`),
      companiesHouse(`https://api.company-information.service.gov.uk/company/${encodeURIComponent(number)}/officers`),
      companiesHouse(`https://api.company-information.service.gov.uk/company/${encodeURIComponent(number)}/charges`)
    ]);

    const address = company.registered_office_address || {};
    const saved = await db().query(`
      INSERT INTO companies
        (company_number, name, normalized_name, company_status, company_type,
         incorporation_date, dissolution_date, sic_codes, registered_address,
         postcode, last_fetched_at, raw_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)
      ON CONFLICT (company_number) DO UPDATE SET
        name=EXCLUDED.name,
        normalized_name=EXCLUDED.normalized_name,
        company_status=EXCLUDED.company_status,
        company_type=EXCLUDED.company_type,
        incorporation_date=EXCLUDED.incorporation_date,
        dissolution_date=EXCLUDED.dissolution_date,
        sic_codes=EXCLUDED.sic_codes,
        registered_address=EXCLUDED.registered_address,
        postcode=EXCLUDED.postcode,
        last_fetched_at=NOW(),
        raw_data=EXCLUDED.raw_data,
        updated_at=NOW()
      RETURNING id`, [
        company.company_number,
        company.company_name,
        company.company_name.toLowerCase(),
        company.company_status || null,
        company.type || null,
        company.date_of_creation || null,
        company.date_of_cessation || null,
        company.sic_codes || [],
        address,
        address.postal_code || null,
        company
      ]);

    return json({ company, officers: officers.items || [], charges: charges.items || [], stored_id: saved.rows[0].id });
  } catch (error) {
    return errorResponse(error);
  }
};

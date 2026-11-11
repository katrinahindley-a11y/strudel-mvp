import { db, companiesHouse, json } from './shared.mjs';

export default async (request) => {
  if (request.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'GET required' }),
      {
        status: 405,
        headers: {
          'content-type': 'application/json',
          'allow': 'GET'
        }
      }
    );
  }

  try {
    const url = new URL(request.url);

    const title = (url.searchParams.get('title') || '')
      .trim()
      .toUpperCase();

    const companyNumber = (url.searchParams.get('company') || '')
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9]{1,20}$/.test(title)) {
      return json({ error: 'A valid title number is required' }, 400);
    }

    if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber)) {
      return json(
        { error: 'A valid company-number candidate is required' },
        400
      );
    }

    const ownerResult = await db().query(
      `
        SELECT
          p.proprietor_name,
          p.company_match_status,
          t.property_address
        FROM property_proprietors p
        JOIN property_titles t
          ON t.title_number = p.title_number
        WHERE p.title_number = $1
          AND p.company_number_candidate = $2
      `,
      [title, companyNumber]
    );

    if (!ownerResult.rowCount) {
      return json(
        { error: 'This company candidate is not linked to this imported title' },
        404
      );
    }

    const company = await companiesHouse(
      `https://api.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}`
    );

    const charges = [];
    let startIndex = 0;
    let complete = false;

    // A limit protects this on-demand request from very large portfolios.
    for (let page = 0; page < 20; page += 1) {
      const endpoint = new URL(
        `https://api.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}/charges`
      );

      endpoint.searchParams.set('items_per_page', '100');
      endpoint.searchParams.set('start_index', String(startIndex));

      const result = await companiesHouse(endpoint.toString());

      if (!Array.isArray(result.items)) {
        throw Error('Unexpected Companies House charge response');
      }

      const items = result.items;

      if (
        result.start_index !== undefined &&
        Number(result.start_index) !== startIndex
      ) {
        throw Error('Unexpected charge pagination response');
      }

      charges.push(...items);
      startIndex += items.length;

      const hasTotal =
        result.total_count !== undefined &&
        result.total_count !== null &&
        Number.isFinite(Number(result.total_count));

      if (
        hasTotal &&
        startIndex >= Number(result.total_count)
      ) {
        complete = true;
        break;
      }

      if (items.length === 0) {
        // Without a total, an empty final page completes the scan.
        complete = !hasTotal;
        break;
      }
    }

    // The validated title is alphanumeric, so it is safe in this regex.
    const titlePattern = new RegExp(
      `(^|[^A-Z0-9])${title}([^A-Z0-9]|$)`,
      'i'
    );

    const uniqueCharges = new Map();

    for (const charge of charges) {
      const key =
        charge.charge_code ||
        charge.links?.self ||
        String(charge.charge_number || '');

      if (!key) {
        throw Error('Charge record has no stable identifier');
      }

      uniqueCharges.set(key, charge);
    }

    const matchedCharges = [];

    for (const charge of uniqueCharges.values()) {
      const description =
        charge.particulars?.description ||
        charge.description ||
        '';

      if (!titlePattern.test(description)) continue;

      const personsEntitled = Array.isArray(charge.persons_entitled)
        ? charge.persons_entitled.map(person =>
            typeof person === 'string'
              ? person
              : person.name || person.description || 'Unnamed party'
          )
        : [];

      matchedCharges.push({
        charge_number: charge.charge_number || null,
        charge_code: charge.charge_code || null,
        status: charge.status || null,
        created_on: charge.created_on || null,
        delivered_on: charge.delivered_on || null,
        satisfied_on: charge.satisfied_on || null,
        persons_entitled: personsEntitled,
        description,
        match_method: 'title_number',
        review_status: 'unreviewed',
        land_registry_verified: false,
        contains_fixed_charge:
          charge.particulars?.contains_fixed_charge ?? null,
        contains_floating_charge:
          charge.particulars?.contains_floating_charge ?? null,
        source_url: charge.links?.self || null
      });
    }

    const response = json({
      title_number: title,
      property_address: ownerResult.rows[0].property_address,
      proprietor_names: ownerResult.rows.map(row => row.proprietor_name),
      company_number: company.company_number,
      company_name: company.company_name,
      company_identity_status:
        'Candidate looked up; ownership identity not automatically verified',
      checked_at: new Date().toISOString(),
      scan_complete: complete,
      company_charges_scanned: uniqueCharges.size,
      title_matched_charge_count: matchedCharges.length,
      matched_charges: matchedCharges,
      note: complete
        ? 'Explicit title-number mentions only. No match does not prove the property is uncharged.'
        : 'Incomplete scan. Do not interpret these results as a complete charge check.'
    });

    response.headers.set('Cache-Control', 'no-store');

    return response;
  } catch (error) {
    console.error('Property charge check failed:', error);

    return json(
      {
        error:
          'Unable to complete the property charge check. Check the function logs.'
      },
      502
    );
  }
};

import { companiesHouse, json, errorResponse } from './shared.mjs';

const API_BASE = 'https://api.company-information.service.gov.uk';
const CHARGES_PAGE_SIZE = 100;
const MAX_CHARGE_PAGES = 100;

async function fetchAllCharges(companyNumber) {
  const encodedNumber = encodeURIComponent(companyNumber);
  const allCharges = [];
  const seenCharges = new Set();

  let startIndex = 0;
  let expectedTotal = null;

  for (let page = 0; page < MAX_CHARGE_PAGES; page += 1) {
    const url = new URL(
      `${API_BASE}/company/${encodedNumber}/charges`
    );

    url.searchParams.set('items_per_page', String(CHARGES_PAGE_SIZE));
    url.searchParams.set('start_index', String(startIndex));

    const data = await companiesHouse(url.toString());

    if (!Array.isArray(data.items)) {
      throw new Error(
        'Companies House returned an invalid charges response.'
      );
    }

    const items = data.items;

    if (
      data.total_count !== undefined &&
      data.total_count !== null
    ) {
      const reportedTotal = Number(data.total_count);

      if (
        Number.isInteger(reportedTotal) &&
        reportedTotal >= 0
      ) {
        expectedTotal = reportedTotal;
      }
    }

    let addedCount = 0;

    for (const charge of items) {
      const key = String(
        charge.links?.self ??
        charge.charge_code ??
        charge.charge_number ??
        JSON.stringify(charge)
      );

      if (!seenCharges.has(key)) {
        seenCharges.add(key);
        allCharges.push(charge);
        addedCount += 1;
      }
    }

    if (
      expectedTotal !== null &&
      allCharges.length >= expectedTotal
    ) {
      return allCharges;
    }

    if (items.length === 0) {
      if (
        expectedTotal !== null &&
        allCharges.length < expectedTotal
      ) {
        throw new Error(
          `Incomplete charges response: received ${allCharges.length} ` +
          `of ${expectedTotal} reported charges.`
        );
      }

      return allCharges;
    }

    if (addedCount === 0) {
      throw new Error(
        'Charge pagination returned a repeated page. ' +
        'Stopped to avoid an endless loop.'
      );
    }

    startIndex += items.length;
  }

  throw new Error(
    'Charge pagination reached its safety limit. ' +
    'The full charge list could not be retrieved.'
  );
}

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

    const encodedNumber = encodeURIComponent(number);

    const [company, officers, charges] = await Promise.all([
      companiesHouse(
        `${API_BASE}/company/${encodedNumber}`
      ),
      companiesHouse(
        `${API_BASE}/company/${encodedNumber}/officers`
      ),
      fetchAllCharges(number)
    ]);

    return json({
      company,
      officers: officers.items || [],
      charges
    });
  } catch (error) {
    return errorResponse(error);
  }
};
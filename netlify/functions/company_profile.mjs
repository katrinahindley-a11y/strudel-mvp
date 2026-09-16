import { companiesHouse, json, errorResponse } from './shared.mjs';

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

    const [company, officers, charges] = await Promise.all([
      companiesHouse(
        `https://api.company-information.service.gov.uk/company/${encodeURIComponent(number)}`
      ),
      companiesHouse(
        `https://api.company-information.service.gov.uk/company/${encodeURIComponent(number)}/officers`
      ),
      companiesHouse(
        `https://api.company-information.service.gov.uk/company/${encodeURIComponent(number)}/charges`
      )
    ]);

    return json({
      company,
      officers: officers.items || [],
      charges: charges.items || []
    });
  } catch (error) {
    return errorResponse(error);
  }
};

import { companiesHouse, errorResponse, json } from './shared.mjs';

const allowedHosts = new Set(['strudelproperty.netlify.app']);

export default async (request) => {
  try {
    if (!allowedHosts.has(new URL(request.url).hostname)) {
      return json({ error: 'Charge search is not enabled on this hostname' }, 404);
    }

    const params = new URL(request.url).searchParams;
    const company = params.get('company')?.trim().toUpperCase();
    const charge = params.get('charge')?.trim();

    if (!company || !/^[0-9A-Z]{1,20}$/.test(company)) {
      return json({ error: 'A valid Companies House company number is required' }, 400);
    }

    if (charge && !/^[A-Za-z0-9-]{1,50}$/.test(charge)) {
      return json({ error: 'Invalid charge reference' }, 400);
    }

    const data = await companiesHouse(
      `https://api.company-information.service.gov.uk/company/${encodeURIComponent(company)}/charges`
    );

    const items = Array.isArray(data.items) ? data.items : [];
    const matched = charge
      ? items.filter((item) => {
          const reference = item.charge_number || item.charge_code || '';
          return String(reference).toLowerCase() === charge.toLowerCase();
        })
      : items;

    return json({
      company_number: company,
      company_charges_scanned: items.length,
      total_count: data.total_count ?? items.length,
      matched_charges: matched,
      charge_reference: charge || null,
      source: 'Companies House Public Data API',
      checked_at: new Date().toISOString(),
      disclaimer: 'Companies House charge data is not Land Registry mortgage verification. A charge match does not establish loan amount, repayment date, or current priority.'
    });
  } catch (error) {
    return errorResponse(error);
  }
};

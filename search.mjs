import { companiesHouse, json, errorResponse } from './shared.mjs';

export default async (request) => {
  try {
    const q = new URL(request.url).searchParams.get('q')?.trim();
    if (!q) return json({ items: [] });
    const url = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(q)}&items_per_page=20`;
    return json(await companiesHouse(url));
  } catch (error) {
    return errorResponse(error);
  }
};

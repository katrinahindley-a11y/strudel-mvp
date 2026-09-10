import { companiesHouse, json, errorResponse } from './shared.mjs';

const ITEMS_PER_PAGE = 35;

export default async (request) => {
  try {
    const url = new URL(request.url);
    const officerId = url.searchParams.get('officer_id')?.trim();

    if (!officerId) {
      return errorResponse(new Error('Missing officer_id parameter'));
    }

    const endpoint = new URL(
      `https://api.company-information.service.gov.uk/officers/${encodeURIComponent(officerId)}/appointments`
    );
    endpoint.searchParams.set('items_per_page', String(ITEMS_PER_PAGE));

    const result = await companiesHouse(endpoint.toString());

    return json({
      officer_id: officerId,
      items: result.items || [],
      total_results: result.total_results ?? 0,
      active_count: result.active_count ?? 0,
      resigned_count: result.resigned_count ?? 0,
      items_per_page: result.items_per_page ?? ITEMS_PER_PAGE,
      start_index: result.start_index ?? 0
    });
  } catch (error) {
    return errorResponse(error);
  }
};
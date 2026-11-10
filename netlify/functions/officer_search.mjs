import { companiesHouse, json, errorResponse } from './shared.mjs';

const ITEMS_PER_PAGE = 20;

export default async (request) => {
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.trim();
    const pageParam = url.searchParams.get('page');

    if (!q) {
      return json({
        items: [],
        total_results: 0,
        page_number: 1,
        items_per_page: ITEMS_PER_PAGE,
        start_index: 0
      });
    }

    const parsedPage = Number(pageParam || 1);
    const page = Number.isInteger(parsedPage) && parsedPage > 0
      ? parsedPage
      : 1;
    const startIndex = (page - 1) * ITEMS_PER_PAGE;

    const endpoint = new URL(
      'https://api.company-information.service.gov.uk/search/officers'
    );
    endpoint.searchParams.set('q', q);
    endpoint.searchParams.set('items_per_page', String(ITEMS_PER_PAGE));
    endpoint.searchParams.set('start_index', String(startIndex));

    const result = await companiesHouse(endpoint.toString());

    return json({
      items: result.items || [],
      total_results: result.total_results ?? 0,
      page_number: result.page_number ?? page,
      items_per_page: result.items_per_page ?? ITEMS_PER_PAGE,
      start_index: result.start_index ?? startIndex
    });
  } catch (error) {
    return errorResponse(error);
  }
};
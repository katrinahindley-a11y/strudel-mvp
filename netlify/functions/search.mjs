import { companiesHouse, json, errorResponse } from './shared.mjs';

const ITEMS_PER_PAGE = 20;

export default async (request) => {
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.trim();
    const pageParam = url.searchParams.get('page');

    if (!q) {
      return json({ items: [], total_results: 0, page_number: 1, items_per_page: ITEMS_PER_PAGE, start_index: 1 });
    }

    let page = 1;
    if (pageParam) {
      const parsed = Number(pageParam);
      if (!Number.isFinite(parsed) || parsed < 1) {
        page = 1;
      } else {
        page = parsed;
      }
    }

    const startIndex = (page - 1) * ITEMS_PER_PAGE + 1;

    const chUrl = new URL('https://api.company-information.service.gov.uk/search/companies');
    chUrl.searchParams.set('q', q);
    chUrl.searchParams.set('items_per_page', String(ITEMS_PER_PAGE));
    chUrl.searchParams.set('start_index', String(startIndex));

    const result = await companiesHouse(chUrl.toString());

    // Ensure the response always has the pagination fields we expect
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

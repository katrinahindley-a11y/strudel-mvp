const ITEMS_PER_PAGE = 35;

export default async (request) => {
  try {
    const url = new URL(request.url);
    const officerId = url.searchParams.get('officer_id')?.trim();

    if (!officerId) {
      return new Response(
        JSON.stringify({ error: 'Missing officer_id parameter' }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' }
        }
      );
    }

    const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
    if (!apiKey) {
      throw new Error('COMPANIES_HOUSE_API_KEY is not configured');
    }

    const auth = Buffer.from(`${apiKey}:`).toString('base64');

    const endpoint = new URL(
      `https://api.company-information.service.gov.uk/officers/${encodeURIComponent(officerId)}/appointments`
    );
    endpoint.searchParams.set('items_per_page', String(ITEMS_PER_PAGE));

    const response = await fetch(endpoint.toString(), {
      headers: {
        Authorization: `Basic ${auth}`
      }
    });

    const body = await response.text();
    let data = null;

    if (body) {
      try {
        data = JSON.parse(body);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const message =
        data?.error ||
        data?.message ||
        (body ? body.slice(0, 300) : '') ||
        `Companies House returned ${response.status}`;

      throw new Error(message);
    }

    if (data === null) {
      throw new Error(
        `Companies House returned an empty or non-JSON response (${response.status})`
      );
    }

    return new Response(
      JSON.stringify({
        officer_id: officerId,
        items: data.items || [],
        total_results: data.total_results ?? 0,
        active_count: data.active_count ?? 0,
        resigned_count: data.resigned_count ?? 0,
        items_per_page: data.items_per_page ?? ITEMS_PER_PAGE,
        start_index: data.start_index ?? 0
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }
    );
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ error: error.message || 'Unexpected error' }),
      {
        status: 500,
        headers: { 'content-type': 'application/json' }
      }
    );
  }
};

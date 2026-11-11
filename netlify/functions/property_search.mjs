import { db, json } from './shared.mjs';

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

    const query = (url.searchParams.get('q') || '').trim();
    const tenure = (url.searchParams.get('tenure') || '').trim();
    const pageText = url.searchParams.get('page') || '1';
    const page = Number(pageText);
    const pageSize = 20;

    if (
      !/^\d+$/.test(pageText) ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 10000
    ) {
      return json({ error: 'page must be between 1 and 10000' }, 400);
    }

    if (query.length > 150) {
      return json({ error: 'Search text must be 150 characters or fewer' }, 400);
    }

    if (tenure && !['Freehold', 'Leasehold'].includes(tenure)) {
      return json(
        { error: 'tenure must be Freehold or Leasehold' },
        400
      );
    }

    // Escape LIKE wildcards so the search text is treated literally.
    const escapedQuery = query.replace(/[\\%_]/g, '\\$&');
    const searchPattern = `%${escapedQuery}%`;
    const compactPattern =
      `%${escapedQuery.replace(/\s/g, '')}%`;

    const filter = `
      t.source_dataset = 'CCOD'
      AND REPLACE(UPPER(t.postcode), ' ', '')
          ~ '^W1[JKS][0-9][A-Z]{2}$'
      AND ($1 = '' OR t.tenure = $1)
      AND (
        $2 = ''
        OR t.property_address ILIKE $3
        OR t.title_number ILIKE $3
        OR REPLACE(t.postcode, ' ', '') ILIKE $4
        OR EXISTS (
          SELECT 1
          FROM property_proprietors search_owner
          WHERE search_owner.title_number = t.title_number
            AND (
              search_owner.proprietor_name ILIKE $3
              OR search_owner.company_number_candidate ILIKE $3
            )
        )
      )
    `;

    const parameters = [
      tenure,
      query,
      searchPattern,
      compactPattern
    ];

    const countResult = await db().query(
      `
        SELECT COUNT(*)::int AS total_results
        FROM property_titles t
        WHERE ${filter}
      `,
      parameters
    );

    const result = await db().query(
      `
        SELECT
          t.title_number,
          t.property_address,
          t.postcode,
          t.district,
          t.county,
          t.region,
          t.tenure,
          t.price_paid,
          t.date_proprietor_added,
          t.multiple_address_indicator,
          t.additional_proprietor_indicator,
          t.source_dataset,
          t.source_snapshot_month,
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'position', p.proprietor_position,
                  'name', p.proprietor_name,
                  'registration_number_raw',
                    p.registration_number_raw,
                  'company_number_candidate',
                    p.company_number_candidate,
                  'category', p.proprietorship_category,
                  'matched_company_id', p.matched_company_id,
                  'company_match_status', p.company_match_status
                )
                ORDER BY p.proprietor_position
              )
              FROM property_proprietors p
              WHERE p.title_number = t.title_number
            ),
            '[]'::jsonb
          ) AS proprietors
        FROM property_titles t
        WHERE ${filter}
        ORDER BY
          t.property_address NULLS LAST,
          t.title_number
        LIMIT $5 OFFSET $6
      `,
      [
        ...parameters,
        pageSize,
        (page - 1) * pageSize
      ]
    );

    const totalResults = countResult.rows[0].total_results;

    const response = json({
      area: 'Mayfair postcode pilot: W1J, W1K, W1S',
      coverage: 'UK corporate ownership dataset only',
      query,
      tenure: tenure || null,
      page,
      page_size: pageSize,
      total_results: totalResults,
      total_pages: Math.ceil(totalResults / pageSize),
      items: result.rows
    });

    response.headers.set('Cache-Control', 'no-store');

    return response;
  } catch (error) {
    console.error('Property search failed:', error);

    return json(
      { error: 'Property search is unavailable. Check the function logs.' },
      500
    );
  }
};

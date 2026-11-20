import { db } from '../lib/property_preview_services.mjs';
import { parseLenderSearch, securedPartyNames } from '../lib/security_lender_matching.mjs';

const ALLOWED_HOSTS = new Set(['strudelproperty.netlify.app', 'deploy-preview-5--strudelproperty.netlify.app', 'deploy-preview-10--strudelproperty.netlify.app']);

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export default async request => {
  const url = new URL(request.url);
  if (!ALLOWED_HOSTS.has(url.hostname)) return reply({ error: 'Security lender search is not enabled on this hostname.' }, 404);
  if (request.method !== 'GET') return reply({ error: 'GET required' }, 405);
  let search;
  try { search = parseLenderSearch(url.searchParams); } catch (error) { return reply({ error: error.message }, 400); }
  const { lender, status, page, pageSize, tenure } = search;
  try {
    const result = await db().query(`
      WITH matching_charges AS (
        SELECT ch.company_id, ch.external_charge_id,
               COALESCE(ch.status, ch.raw_data->>'status') AS status,
               COALESCE(ch.raw_data->>'created_on', ch.created_on::text) AS created_on,
               COALESCE(ch.raw_data->>'delivered_on', ch.delivered_on::text) AS delivered_on,
               COALESCE(ch.raw_data->>'satisfied_on', ch.satisfied_on::text) AS satisfied_on,
               ch.persons_entitled_raw, ch.raw_data,
               COALESCE(NULLIF(ch.raw_data #>> '{particulars,description}', ''), NULLIF(ch.description, ''), ch.raw_data->>'description', '') AS particulars
        FROM public.charges ch
        WHERE (
          strpos(lower(COALESCE(ch.persons_entitled_raw, '')), lower($1)) > 0
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(ch.raw_data->'persons_entitled') = 'array'
                   THEN ch.raw_data->'persons_entitled' ELSE '[]'::jsonb END
            ) party
            WHERE strpos(lower(COALESCE(party->>'name', party->>'description', CASE WHEN jsonb_typeof(party) = 'string' THEN party #>> '{}' END, '')), lower($1)) > 0
          )
        )
        AND ($2 = 'all' OR COALESCE(ch.status, ch.raw_data->>'status') = $2)
      ), matches AS (
        SELECT DISTINCT t.title_number, ch.external_charge_id, c.company_number, c.name AS company_name,
               ch.status, ch.created_on, ch.delivered_on, ch.satisfied_on,
               ch.persons_entitled_raw, ch.raw_data, ch.particulars
        FROM matching_charges ch
        JOIN public.companies c ON c.id = ch.company_id
        JOIN public.property_proprietors p ON p.company_number_candidate = c.company_number
        JOIN public.property_titles t ON t.title_number = p.title_number
        WHERE t.source_dataset = 'CCOD' AND t.price_paid > 5000000
          AND ($3 = '' OR t.tenure = $3)
          AND EXISTS (SELECT 1 FROM ccod_import.refresh_membership m
                      WHERE m.title_number = t.title_number AND m.managed_high_value = true AND m.active = true)
          AND upper(t.title_number) = ANY(regexp_split_to_array(upper(ch.particulars), '[^A-Z0-9]+'))
      ), grouped AS (
        SELECT title_number, jsonb_agg(jsonb_build_object(
          'external_charge_id', external_charge_id, 'status', status,
          'created_on', created_on, 'delivered_on', delivered_on, 'satisfied_on', satisfied_on,
          'persons_entitled', raw_data->'persons_entitled', 'persons_entitled_raw', persons_entitled_raw,
          'description', particulars,
          'borrower', jsonb_build_object('company_number', company_number, 'name', company_name),
          'match_method', 'title_number', 'review_status', 'unreviewed', 'land_registry_verified', false
        ) ORDER BY created_on DESC NULLS LAST, external_charge_id) AS matched_charges
        FROM matches GROUP BY title_number
      ), paged AS (
        SELECT t.*, g.matched_charges,
               COALESCE((SELECT jsonb_agg(jsonb_build_object(
                 'position', p.proprietor_position, 'name', p.proprietor_name,
                 'registration_number_raw', p.registration_number_raw,
                 'company_number_candidate', p.company_number_candidate,
                 'category', p.proprietorship_category, 'matched_company_id', p.matched_company_id,
                 'company_match_status', p.company_match_status
               ) ORDER BY p.proprietor_position) FROM public.property_proprietors p
                 WHERE p.title_number = t.title_number), '[]'::jsonb) AS proprietors
        FROM grouped g JOIN public.property_titles t ON t.title_number = g.title_number
        ORDER BY t.property_address NULLS LAST, t.title_number
        LIMIT $4 OFFSET $5
      )
      SELECT (SELECT count(*) FROM grouped)::integer AS total_results,
             COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY property_address NULLS LAST, title_number) FROM paged), '[]'::jsonb) AS items
    `, [lender, status, tenure, pageSize, (page - 1) * pageSize]);
    const row = result.rows[0];
    const items = (row.items || []).map(item => ({
      ...item, association_type: 'Explicit title-number match; unreviewed',
      matched_charges: (item.matched_charges || []).map(charge => ({
        ...charge, persons_entitled: securedPartyNames(charge.persons_entitled)
      }))
    }));
    return reply({
      mode: 'security_lender', lender, status, page, page_size: pageSize,
      total_results: row.total_results, total_pages: Math.ceil(row.total_results / pageSize), items,
      coverage: 'Stored charges only. On-demand property checks are not automatically indexed. Results are not a complete lender portfolio.',
      note: 'Recorded price paid above £5 million, not current valuation. Explicit Companies House title-number mentions only; proprietor company-number candidates may be unverified. Not Land Registry mortgage verification. No match does not prove a property is uncharged.'
    });
  } catch (error) {
    console.error('Security lender property search failed', error?.name || 'Error');
    return reply({ error: 'Unable to search stored security lender records. Please retry; if the issue persists, check the function logs.' }, 503);
  }
};

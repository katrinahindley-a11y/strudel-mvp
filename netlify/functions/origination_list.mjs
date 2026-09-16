import { db, json, errorResponse } from './shared.mjs';

export default async (request) => {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;

    // Optional filters
    const borrowingVelocityBand = params.get('borrowing_velocity_band') || null;
    const refinanceLikelihoodBand = params.get('refinance_likelihood_band') || null;
    const businessType = params.get('business_type') || null;
    const ownsUkProperty = params.get('owns_uk_property'); // 'true' | 'false' | null
    const search = params.get('search') || '';
    const limit = Math.min(Number(params.get('limit')) || 50, 500);
    const offset = Number(params.get('offset')) || 0;

    // Build WHERE clauses
    const conditions = [];
    const values = [];

    if (borrowingVelocityBand) {
      conditions.push(`borrowing_velocity_band = $${values.length + 1}`);
      values.push(borrowingVelocityBand);
    }

    if (refinanceLikelihoodBand) {
      conditions.push(`refinance_likelihood_band = $${values.length + 1}`);
      values.push(refinanceLikelihoodBand);
    }

    if (businessType) {
      conditions.push(`business_type = $${values.length + 1}`);
      values.push(businessType);
    }

    if (ownsUkProperty === 'true' || ownsUkProperty === 'false') {
      conditions.push(`owns_uk_property = $${values.length + 1}`);
      values.push(ownsUkProperty === 'true');
    }

    if (search.trim()) {
      const s = `%${search.trim().toLowerCase()}%`;
      conditions.push(`(LOWER(company_name) LIKE $${values.length + 1} OR LOWER(company_number) LIKE $${values.length + 1})`);
      values.push(s);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM origination_companies
      ${whereClause}
    `;
    const countResult = await db().query(countQuery, values);
    const total = Number(countResult.rows[0]?.total ?? 0);

    // Data query
    const dataQuery = `
      SELECT
        company_number,
        company_name,
        charge_count,
        borrowing_velocity_band,
        refinance_likelihood_band,
        most_recent_lender_name,
        lender_count,
        title_count,
        owns_uk_property,
        business_type
      FROM origination_companies
      ${whereClause}
      ORDER BY
        refinance_likelihood_band DESC,
        borrowing_velocity_band DESC,
        charge_count DESC,
        company_name
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `;

    const dataValues = [
      ...values,
      limit,
      offset
    ];

    const result = await db().query(dataQuery, dataValues);

    return json({
      total,
      limit,
      offset,
      companies: result.rows.map(row => ({
        companyNumber: row.company_number,
        companyName: row.company_name,
        chargeCount: row.charge_count ?? 0,
        borrowingVelocityBand: row.borrowing_velocity_band ?? 'Unknown',
        refinanceLikelihoodBand: row.refinance_likelihood_band ?? 'Unknown',
        mostRecentLender: row.most_recent_lender_name ?? null,
        lenderCount: row.lender_count ?? 0,
        titleCount: row.title_count ?? 0,
        ownsUkProperty: row.owns_uk_property ?? false,
        businessType: row.business_type ?? 'Unknown'
      }))
    });
  } catch (error) {
    return errorResponse(error);
  }
};

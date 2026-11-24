const safeCodes = new Set([
  'COMPANY_PROFILE_NOT_FOUND',
  'TARGET_GUARD_FAILED', 'COMPANY_OUTSIDE_APPROVED_SCOPE', 'COMPANY_SCAN_ALREADY_RUNNING',
  'UNAPPROVED_DATABASE_ENDPOINT', 'COMPANY_IDENTITY_MISMATCH', 'PROPRIETOR_NAME_REQUIRES_REVIEW',
  'INCOMPLETE_CHARGE_SCAN', 'SCAN_OWNERSHIP_LOST',
  'REQUEST_BUDGET_EXHAUSTED', 'COMPANIES_HOUSE_RATE_LIMITED_STOP',
  'COMPANIES_HOUSE_AUTHENTICATION_FAILED', 'COMPANIES_HOUSE_HTTP_FAILURE',
  'COMPANIES_HOUSE_REQUEST_FAILED', 'COMPANIES_HOUSE_INVALID_JSON',
  'UNAPPROVED_API_ENDPOINT', 'INVALID_API_PARAMETERS'
]);

const collectorCodes = new Map([
  ['Invalid charges page', 'CHARGE_PAGE_INVALID'],
  ['Unexpected charge pagination', 'CHARGE_PAGINATION_INVALID'],
  ['Charge total availability changed during scan', 'CHARGE_TOTAL_AVAILABILITY_CHANGED'],
  ['Invalid charge total', 'CHARGE_TOTAL_INVALID'],
  ['Charge total changed during scan; retry from the beginning', 'CHARGE_TOTAL_CHANGED'],
  ['Invalid charge record', 'CHARGE_RECORD_INVALID'],
  ['Charge has no stable identifier', 'CHARGE_IDENTIFIER_MISSING'],
  ['Duplicate charge encountered across scan; retry from the beginning', 'CHARGE_DUPLICATE_RECORD'],
  ['Charge count exceeds reported total', 'CHARGE_COUNT_EXCEEDS_TOTAL'],
  ['Charges ended before the reported total', 'CHARGE_PAGE_ENDED_EARLY'],
  ['Charge page budget exhausted; scan is incomplete', 'CHARGE_PAGE_BUDGET_EXHAUSTED']
]);

export function safeChargeScanDiagnostic(error) {
  const message = error?.message;
  if (typeof message !== 'string') return 'CHARGE_SCAN_FAILED';
  if (safeCodes.has(message)) return message;
  return collectorCodes.get(message) || 'CHARGE_SCAN_FAILED';
}

export async function collectCompanyCharges(companyNumber, request, options = {}) {
  if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber)) throw Error('Invalid company-number candidate');
  if (typeof request !== 'function') throw Error('A rate-limited request function is required');
  const { maxPages = 100, itemsPerPage = 100, onPage = async () => {} } = options;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw Error('Invalid page budget');
  if (!Number.isInteger(itemsPerPage) || itemsPerPage < 1 || itemsPerPage > 100) throw Error('Invalid page size');
  const charges = new Map();
  let startIndex = 0;
  let expectedTotal = null;
  let totalKnown = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ items_per_page: String(itemsPerPage), start_index: String(startIndex) });
    const result = await request('/company/' + encodeURIComponent(companyNumber) + '/charges?' + params);
    if (!result || !Array.isArray(result.items) || result.items.length > itemsPerPage) throw Error('Invalid charges page');
    if (result.start_index !== undefined && Number(result.start_index) !== startIndex) throw Error('Unexpected charge pagination');
    const hasTotal = result.total_count !== undefined && result.total_count !== null;
    if (totalKnown === null) totalKnown = hasTotal;
    if (hasTotal !== totalKnown) throw Error('Charge total availability changed during scan');
    if (hasTotal) {
      const total = Number(result.total_count);
      if (!Number.isSafeInteger(total) || total < 0) throw Error('Invalid charge total');
      if (expectedTotal !== null && expectedTotal !== total) throw Error('Charge total changed during scan; retry from the beginning');
      expectedTotal = total;
    }
    for (const charge of result.items) {
      if (!charge || typeof charge !== 'object' || Array.isArray(charge)) throw Error('Invalid charge record');
      const code = charge.charge_code;
      const self = charge.links?.self;
      const number = charge.charge_number;
      const key = code ? 'code:' + code : self ? 'self:' + self : number !== undefined && number !== null && String(number) !== '' ? 'number:' + number : null;
      if (!key) throw Error('Charge has no stable identifier');
      if (charges.has(key)) throw Error('Duplicate charge encountered across scan; retry from the beginning');
      charges.set(key, charge);
    }
    startIndex += result.items.length;
    if (expectedTotal !== null && startIndex > expectedTotal) throw Error('Charge count exceeds reported total');
    const complete = expectedTotal !== null ? startIndex === expectedTotal : result.items.length === 0;
    await onPage({ page: page + 1, nextStartIndex: startIndex, recordsSeen: charges.size, reportedTotal: expectedTotal, complete });
    if (complete) return { companyNumber, charges: [...charges.values()], scanComplete: true, pagesFetched: page + 1, reportedTotal: expectedTotal };
    if (result.items.length === 0) throw Error('Charges ended before the reported total');
  }
  throw Error('Charge page budget exhausted; scan is incomplete');
}

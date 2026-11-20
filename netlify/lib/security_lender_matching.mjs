export function titleMentioned(description, title) {
  const value = String(title || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,20}$/.test(value)) return false;
  return String(description || '').toUpperCase().split(/[^A-Z0-9]+/).includes(value);
}

export function securedPartyNames(parties) {
  if (!Array.isArray(parties)) return [];
  return parties.map(p => typeof p === 'string' ? p : p?.name || p?.description || '').filter(Boolean);
}

export function parseLenderSearch(params) {
  const lender = (params.get('lender') || '').trim();
  const status = params.get('status') || 'outstanding';
  const pageValue = params.get('page') || '1';
  const tenure = params.get('tenure') || '';
  if (lender.length < 2 || lender.length > 150) throw Error('Enter a lender name between 2 and 150 characters.');
  if (!['outstanding', 'satisfied', 'all'].includes(status)) throw Error('Invalid charge status.');
  if (!/^[1-9][0-9]{0,5}$/.test(pageValue)) throw Error('Invalid page number.');
  if (!['', 'Freehold', 'Leasehold'].includes(tenure)) throw Error('Invalid tenure.');
  return { lender, status, page: Number(pageValue), pageSize: 20, tenure };
}

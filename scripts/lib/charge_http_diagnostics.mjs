export function createChargeHttpDiagnostics(companyNumber, fetchFn = fetch) {
  if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber || '')) throw Error('INVALID_COMPANY_NUMBER');
  let details = {};
  return {
    async fetchFn(input, init) {
      details = {};
      const response = await fetchFn(input, init);
      try {
        const url = new URL(input);
        const base = '/company/' + companyNumber;
        const requestCategory = url.pathname === base ? 'company_profile' : url.pathname === base + '/charges' ? 'charges' : null;
        if (url.origin === 'https://api.company-information.service.gov.uk' && !url.username && !url.password && !url.hash && requestCategory && response.ok === false && Number.isInteger(response.status) && response.status >= 400 && response.status <= 599) {
          details = { httpStatus: response.status, requestCategory };
        }
      } catch {}
      return response;
    },
    failureDetails: () => ({ ...details })
  };
}

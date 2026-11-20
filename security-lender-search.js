(() => {
  'use strict';
  const form = el('filters');
  const companyLabel = form.querySelector('input[value="company"]').closest('label');
  const lenderLabel = node('label');
  const radio = node('input');
  radio.type = 'radio'; radio.name = 'search_mode'; radio.value = 'security_lender';
  lenderLabel.append(radio, document.createTextNode(' Security lender'));
  companyLabel.before(lenderLabel);

  const statusGroup = node('div');
  const statusLabel = node('label', 'Charge status'); statusLabel.htmlFor = 'charge_status';
  const statusSelect = node('select'); statusSelect.id = 'charge_status';
  for (const [value, text] of [['outstanding', 'Outstanding'], ['satisfied', 'Satisfied'], ['all', 'All statuses']]) {
    const option = node('option', text); option.value = value; statusSelect.append(option);
  }
  statusGroup.append(statusLabel, statusSelect); el('submit').before(statusGroup);
  const help = node('p', undefined, 'muted'); help.id = 'search_help';
  form.after(help); el('query').setAttribute('aria-describedby', help.id);
  const styles = node('style');
  styles.textContent = '[hidden]{display:none!important}.mode{flex-wrap:wrap}.mode input{width:auto}.mode{max-width:100%;box-sizing:border-box}';
  document.head.append(styles);

  let submitted = null;
  const originalRunSearch = runSearch;
  const mode = () => form.querySelector('input[name="search_mode"]:checked').value;
  function clearResults() {
    if (controller) controller.abort();
    controller = null; submitted = null; page = 1; totalPages = 0;
    el('submit').disabled = false; el('results').replaceChildren();
    el('error').hidden = true; el('status').textContent = '';
    el('pagination').hidden = true; el('page').textContent = '';
    el('prev').disabled = true; el('next').disabled = true;
  }
  function updateMode() {
    const current = mode();
    statusGroup.hidden = current !== 'security_lender';
    statusSelect.disabled = current !== 'security_lender';
    el('tenure').disabled = current === 'company';
    el('tenure').parentElement.hidden = current === 'company';
    const settings = {
      property: ['Address, postcode, title or owner', 'e.g. Hanover Square, W1S or LN48675', 'Search property records in the current dataset.'],
      security_lender: ['Security lender name', 'e.g. HSBC or HSBC Private Bank', 'Search stored charges for explicit title-number matches to properties with recorded price paid above £5 million. Coverage is incomplete; on-demand checks are not automatically indexed.'],
      company: ['Company name, company number or charge reference', 'e.g. Nautilina Limited or 15372161', 'Search companies and their charges. Company-level property associations are not proof that a charge covers each property.']
    }[current];
    form.querySelector('label[for="query"]').textContent = settings[0];
    el('query').placeholder = ''; help.textContent = settings[2];
    el('query').minLength = current === 'security_lender' ? 2 : 0;
    el('query').required = current !== 'property';
  }
  async function loadLender(target) {
    if (!submitted || submitted.mode !== 'security_lender') return;
    if (controller) controller.abort();
    const current = new AbortController(); controller = current;
    const search = { ...submitted };
    el('results').replaceChildren(); el('error').hidden = true;
    el('status').textContent = 'Finding title-matched security lender properties…';
    el('submit').disabled = true; el('pagination').hidden = true;
    el('prev').disabled = true; el('next').disabled = true;
    try {
      const params = new URLSearchParams({ lender: search.query, status: search.status, tenure: search.tenure, page: String(target) });
      const data = await fetchJson('/.netlify/functions/property_security_lender_search?' + params, { signal: current.signal, cache: 'no-store' });
      if (controller !== current) return;
      if (!Array.isArray(data.items) || !Number.isInteger(data.total_results) || !Number.isInteger(data.page) || !Number.isInteger(data.total_pages)) throw Error('Unexpected security lender response.');
      page = data.page; totalPages = data.total_pages;
      const output = el('results');
      output.append(node('p', data.coverage || 'Stored charges only; not a complete lender portfolio.', 'notice'));
      for (const item of data.items) {
        const card = propertyCard(item, item.association_type);
        card.append(node('h3', 'Matching security lender charges'));
        for (const charge of item.matched_charges || []) card.append(chargeCard(charge, charge.borrower));
        output.append(card);
      }
      if (!data.items.length) output.append(node('div', 'No title-matched properties found in stored charges for these filters. Charges not yet indexed, or without an explicit title number, will not appear. This does not prove there are no matching properties.', 'card'));
      if (data.note) output.append(node('p', data.note, 'muted'));
      el('status').textContent = data.total_results + ' matching titles for “' + search.query + '”' + (data.items.length ? ' · showing ' + ((page - 1) * data.page_size + 1) + '–' + ((page - 1) * data.page_size + data.items.length) : '');
      el('page').textContent = totalPages ? 'Page ' + page + ' of ' + totalPages : 'No results';
      el('prev').disabled = page <= 1; el('next').disabled = page >= totalPages;
      el('pagination').hidden = totalPages === 0;
    } catch (error) {
      if (error.name === 'AbortError' || controller !== current) return;
      el('status').textContent = ''; el('error').className = 'error';
      el('error').textContent = error.message; el('error').hidden = false;
    } finally {
      if (controller === current) el('submit').disabled = false;
    }
  }
  runSearch = function(target) {
    submitted = { mode: mode(), query: el('query').value.trim(), tenure: el('tenure').value, status: statusSelect.value };
    if (submitted.mode === 'security_lender') {
      if (submitted.query.length < 2) { el('query').reportValidity(); return; }
      return loadLender(target);
    }
    return originalRunSearch(target);
  };
  form.addEventListener('submit', event => {
    event.preventDefault(); event.stopImmediatePropagation(); runSearch(1);
  }, true);
  for (const input of form.querySelectorAll('input[name="search_mode"]')) {
    input.addEventListener('change', () => { clearResults(); el('query').value = ''; updateMode(); });
  }
  statusSelect.addEventListener('change', clearResults);
  el('tenure').addEventListener('change', clearResults);
  el('reset').onclick = () => { form.reset(); clearResults(); el('query').value = ''; updateMode(); };
  el('prev').onclick = () => {
    if (submitted?.mode === 'security_lender') loadLender(page - 1); else loadProperty(page - 1);
    el('status').scrollIntoView({ block: 'start' });
  };
  el('next').onclick = () => {
    if (submitted?.mode === 'security_lender') loadLender(page + 1); else loadProperty(page + 1);
    el('status').scrollIntoView({ block: 'start' });
  };
  updateMode();
})();

import { readFileSync, writeFileSync } from 'node:fs';

const replacements = [
  ["<title>Cohort Capital — Mayfair Property Ownership</title>", "<title>Cohort Capital — Corporate Property Ownership</title>"],
  ["<h1>Mayfair property ownership</h1>", "<h1>Corporate property ownership — recorded price above £5 million</h1>"],
  ["Pilot area: W1J, W1K and W1S, not an exact Mayfair boundary. UK corporate ownership data only; overseas-company and individual ownership are not included. Registered titles are not necessarily separate buildings.", "Limited England-and-Wales CCOD subset: active managed titles selected by recorded price paid above £5 million, not current market valuation. Retained sample-only and retired records are excluded. This is not a complete register of all property or all corporate ownership. Overseas-company and individual ownership are not included. Registered titles are not necessarily separate buildings. Source release is shown on each result. Charge checks are on-demand Companies House title-number lookups, not Land Registry mortgage verification."],
  ['placeholder="e.g. Hanover Square, 12345678 or Barclays"', 'placeholder="e.g. address, postcode, title, owner, company name, company number or lender"'],
  ["'/.netlify/functions/property_search?'", "'/.netlify/functions/property_preview_search?'"],
  ["   const a=node('a',verified?'Open company profile':'Look up company candidate '+p.company_number_candidate);a.href='/index.html#/company/'+encodeURIComponent(p.company_number_candidate);li.append(a);", "   li.append(node('small','Company-number candidate: '+p.company_number_candidate+'. A Companies House lookup does not automatically verify the proprietor identity.'));"],
  ['</script></body></html>', '</script><script src="/security-lender-search.js"></script></body></html>']
];

export function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Preview template changed; refusing an incomplete transformation');
  return text.replace(before, after);
}

export function prepare(html) {
  for (const [before, after] of replacements) html = replaceOnce(html, before, after);
  return html;
}

export function prepareSearchHost(source) {
  return replaceOnce(source, "'deploy-preview-10--strudelproperty.netlify.app'", "'deploy-preview-10--strudelproperty.netlify.app', 'deploy-preview-11--strudelproperty.netlify.app'");
}

export function prepareCharges(source) {
  source = replaceOnce(source, "import { db, companiesHouse, json } from './shared.mjs';", "import { json } from './shared.mjs';\nimport { db, companiesHouse } from '../lib/property_preview_services.mjs';");
  source = replaceOnce(source, 'export default async (request) => {', "export default async (request) => {\n  const allowedHosts = new Set(['strudelproperty.netlify.app', 'deploy-preview-5--strudelproperty.netlify.app', 'deploy-preview-10--strudelproperty.netlify.app']);\n  if (!allowedHosts.has(new URL(request.url).hostname)) return json({ error: 'Property charge checks are not enabled on this hostname' }, 404);");
  source = replaceOnce(source, 'AND p.company_number_candidate = $2', `AND p.company_number_candidate = $2
          AND t.source_dataset = 'CCOD'
          AND EXISTS (
            SELECT 1 FROM ccod_import.refresh_membership m
            WHERE m.title_number = t.title_number
              AND m.managed_high_value = true
              AND m.active = true
          )`);
  source = replaceOnce(source, 'for (let page = 0; page < 20; page += 1) {', 'for (let page = 0; page < 5; page += 1) {');
  return prepareSearchHost(source);
}

const production = process.env.CONTEXT === 'production';
const preview = process.env.CONTEXT === 'deploy-preview';
if (production || preview) {
  const html = prepare(readFileSync('properties.html', 'utf8'));
  const charges = prepareCharges(readFileSync('netlify/functions/property_charges.mjs', 'utf8'));
  const searchFiles = ['netlify/functions/property_preview_search.mjs', 'netlify/functions/property_unified_search.mjs', 'netlify/functions/property_security_lender_search.mjs'];
  const preparedSearches = searchFiles.map(path => [path, prepareSearchHost(readFileSync(path, 'utf8'))]);
  writeFileSync('properties.html', html);
  writeFileSync('netlify/functions/property_preview_charges.mjs', charges);
  for (const [path, source] of preparedSearches) writeFileSync(path, source);
  console.log('Prepared active managed CCOD property search and guarded on-demand charge checks, including the exact PR 11 preview hostname. No database writes or refresh schedule changes.');
}

import { readFileSync, writeFileSync } from 'node:fs';

const replacements = [
  ["<title>Cohort Capital — Mayfair Property Ownership</title>", "<title>Cohort Capital — CCOD Test Dataset</title>"],
  ["<h1>Mayfair property ownership</h1>", "<h1>Property ownership — test dataset</h1>"],
  ["Pilot area: W1J, W1K and W1S, not an exact Mayfair boundary. UK corporate ownership data only; overseas-company and individual ownership are not included. Registered titles are not necessarily separate buildings.", "TEST DATASET - PR #5 preview only: england-wales-property-test. Contains the Mayfair pilot plus the first 1,000 titles from the November 2026 CCOD file; this is not full England-and-Wales coverage. Read-only search; no Mayfair postcode filter. Charge checks are on-demand Companies House title-number lookups, not Land Registry mortgage verification. Company-profile links are disabled. UK corporate ownership data only; overseas-company and individual ownership are not included. Registered titles are not necessarily separate buildings."],
  ['placeholder="e.g. Hanover Square or W1K"', 'placeholder="e.g. SYK161735, Parkgate or Rotherham"'],
  ["'/.netlify/functions/property_search?'", "'/.netlify/functions/property_preview_search?'"],
  ["'/.netlify/functions/property_charges?'", "'/.netlify/functions/property_preview_charges?'"],
  ["   const a=node('a',verified?'Open company profile':'Look up company candidate '+p.company_number_candidate);a.href='/index.html#/company/'+encodeURIComponent(p.company_number_candidate);li.append(a);", "   li.append(node('small','Company-number candidate: '+p.company_number_candidate+'. A Companies House lookup does not automatically verify the proprietor identity.'));"]
];

export function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('Preview template changed; refusing an incomplete transformation');
  return text.replace(before, after);
}

export function prepare(html) {
  for (const [before, after] of replacements) html = replaceOnce(html, before, after);
  return html;
}

export function prepareCharges(source) {
  source = replaceOnce(source, "import { db, companiesHouse, json } from './shared.mjs';", "import { json } from './shared.mjs';\nimport { db, companiesHouse } from '../lib/property_preview_services.mjs';");
  source = replaceOnce(source, 'export default async (request) => {', "export default async (request) => {\n  if (new URL(request.url).hostname !== 'deploy-preview-5--strudelproperty.netlify.app') return json({ error: 'PR5 preview only' }, 404);");
  source = replaceOnce(source, 'for (let page = 0; page < 20; page += 1) {', 'for (let page = 0; page < 5; page += 1) {');
  return source;
}

if (process.env.CONTEXT === 'deploy-preview' && process.env.REVIEW_ID === '5') {
  const html = prepare(readFileSync('properties.html', 'utf8'));
  const charges = prepareCharges(readFileSync('netlify/functions/property_charges.mjs', 'utf8'));
  writeFileSync('properties.html', html);
  writeFileSync('netlify/functions/property_preview_charges.mjs', charges);
  console.log('Prepared branded PR5 search and on-demand charge checks; production files unchanged in production context.');
}

import { readFileSync, writeFileSync } from 'node:fs';

const replacements = [
  ["<title>Cohort Capital — Mayfair Property Ownership</title>", "<title>Cohort Capital — CCOD Test Dataset</title>"],
  ["<h1>Mayfair property ownership</h1>", "<h1>Property ownership — test dataset</h1>"],
  ["Pilot area: W1J, W1K and W1S, not an exact Mayfair boundary. UK corporate ownership data only; overseas-company and individual ownership are not included. Registered titles are not necessarily separate buildings.", "TEST DATASET - PR #5 preview only: england-wales-property-test. Contains the Mayfair pilot plus the first 1,000 titles from the November 2026 CCOD file; this is not full England-and-Wales coverage. Read-only search; no Mayfair postcode filter. Company-profile and charge lookups are disabled. UK corporate ownership data only; overseas-company and individual ownership are not included. Registered titles are not necessarily separate buildings."],
  ['placeholder="e.g. Hanover Square or W1K"', 'placeholder="e.g. SYK161735, Parkgate or Rotherham"'],
  ["'/.netlify/functions/property_search?'", "'/.netlify/functions/property_preview_search?'"],
  [
    "  if(p.company_number_candidate){\n   const a=node('a',verified?'Open company profile':'Look up company candidate '+p.company_number_candidate);a.href='/index.html#/company/'+encodeURIComponent(p.company_number_candidate);li.append(a);\n   const button=node('button','Check owner charges','charge-button');button.type='button';\n   const output=node('div');output.setAttribute('aria-live','polite');\n   button.onclick=()=>checkPropertyCharges(item.title_number,p.company_number_candidate,button,output);\n   li.append(button,output);\n  }else{li.append(node('small','No company-number candidate available'))}",
    "  if(p.company_number_candidate){\n   li.append(node('small','Company-number candidate: '+p.company_number_candidate+'. Company-profile and charge lookups are disabled in this test preview.'));\n  }else{li.append(node('small','No company-number candidate available'))}"
  ]
];

export function prepare(html) {
  for (const [before, after] of replacements) {
    if (html.split(before).length !== 2) throw new Error('Branded preview template changed; refusing an incomplete transformation');
    html = html.replace(before, after);
  }
  return html;
}

if (process.env.CONTEXT === 'deploy-preview' && process.env.REVIEW_ID === '5') {
  writeFileSync('properties.html', prepare(readFileSync('properties.html', 'utf8')));
  console.log('Prepared branded PR5 property test page; production template is unchanged.');
}

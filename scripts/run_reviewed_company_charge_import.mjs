import { pathToFileURL } from 'node:url';
import { parseArgs,guardedConnection,createBudgetedClient } from './run_company_charge_import.mjs';
import { assertReviewReference } from './lib/company_identity_store.mjs';
import { stageCompanyChargeScan } from './lib/stage_company_charge_scan.mjs';
export function parseReviewedArgs(args) {
  const rest=[],ref={};
  for (let i=0;i<args.length;i++) {
    const field={'--identity-proposal':'proposalId','--identity-hash':'proposalHash'}[args[i]];
    if (!field) { rest.push(args[i]); continue; }
    if (ref[field] !== undefined || !args[i+1] || args[i+1].startsWith('--')) throw Error('INVALID_ARGUMENTS');
    ref[field]=args[++i];
  }
  const options=parseArgs(rest);
  if (options.phase !== 'stage') throw Error('REVIEWED_STAGING_ONLY');
  if (options.apply || Object.keys(ref).length) assertReviewReference(ref);
  return {...options,identityReview:ref};
}
export async function runReviewedImport(args,env=process.env) {
  const options=parseReviewedArgs(args);
  if (!options.apply) return {...options,mode:'dry_run',executed:false};
  const connectionString=guardedConnection(env.CCOD_TEST_DATABASE_URL);
  if (!env.COMPANIES_HOUSE_API_KEY) throw Error('COMPANIES_HOUSE_KEY_REQUIRED');
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString,ssl:{rejectUnauthorized:true},max:1,connectionTimeoutMillis:10000,statement_timeout:15000});
  try {
    const http=createBudgetedClient({apiKey:env.COMPANIES_HOUSE_API_KEY,companyNumber:options.companyNumber,maxRequests:options.maxRequests});
    return {...await stageCompanyChargeScan({...options,pool,request:http.request}),requestsUsed:http.requestsUsed()};
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReviewedImport(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error(JSON.stringify({error:'REVIEWED_CHARGE_IMPORT_FAILED'}));process.exitCode=1;});
}

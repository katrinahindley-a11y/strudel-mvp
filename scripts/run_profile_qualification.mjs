import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {planProfileDiscovery,runProfileDiscovery} from './lib/profile_discovery.mjs';
import {reviewDiscoveredProfiles} from './lib/automatic_identity_review.mjs';
export function parseProfileArgs(args){
  const f=new Map();for(let i=0;i<args.length;i++){const k=args[i];if(!['--output','--max-companies','--max-requests','--max-run-ms','--expires-at','--after-company','--approved-manifest-hash','--apply'].includes(k)||f.has(k))throw Error('INVALID_PROFILE_ARGUMENTS');if(k==='--apply'){f.set(k,true);continue;}const v=args[++i];if(!v||v.startsWith('--'))throw Error('INVALID_PROFILE_ARGUMENTS');f.set(k,v);}
  const n=k=>{const s=f.get(k);if(!/^[1-9][0-9]*$/.test(s||''))throw Error('PROFILE_BUDGET_REQUIRED');return Number(s);};
  if(!f.get('--output')||!f.get('--expires-at'))throw Error('PROFILE_OUTPUT_AND_EXPIRY_REQUIRED');
  return {output:f.get('--output'),maxCompanies:n('--max-companies'),maxRequests:n('--max-requests'),maxRunMs:n('--max-run-ms'),expiresAt:f.get('--expires-at'),afterCompany:f.get('--after-company')||'',approvedManifestHash:f.get('--approved-manifest-hash'),apply:f.has('--apply')};
}
export async function runProfileQualification(args,env=process.env){
  const options=parseProfileArgs(args),{guardedConnection}=await import('./run_company_charge_import.mjs'),{readScopedChargeSnapshot}=await import('./lib/read_scoped_charge_snapshot.mjs');
  // Reserve a private output file before any profile API request; never overwrite another run.
  const output=await open(options.output,'wx',0o600);let pool;
  try{
    const {default:pg}=await import('pg');pool=new pg.Pool({connectionString:guardedConnection(env.CCOD_TEST_DATABASE_URL),ssl:{rejectUnauthorized:true},max:1,connectionTimeoutMillis:10000,statement_timeout:15000});
    const snapshot=await readScopedChargeSnapshot(pool),plan=planProfileDiscovery(snapshot,options);
    if(!options.apply){const preview=await runProfileDiscovery(plan);await output.writeFile(JSON.stringify({preview,plan},null,2));return {mode:preview.mode,manifestHash:plan.manifestHash,candidateCompanies:plan.candidateCompanies,selectedCompanies:plan.entries.length,fetchesPlanned:preview.fetchesPlanned,moreCandidates:plan.moreCandidates,executed:false,approvalsWritten:0};}
    const discovery=await runProfileDiscovery(plan,{apply:true,approvedManifestHash:options.approvedManifestHash,apiKey:env.COMPANIES_HOUSE_API_KEY});
    const current=await readScopedChargeSnapshot(pool),review=reviewDiscoveredProfiles(plan,discovery,current,{asOf:new Date().toISOString()});
    await output.writeFile(JSON.stringify({plan,discovery,review},null,2));return {mode:'profile_qualification_shadow',status:discovery.status,requestsUsed:discovery.requestsUsed,resumeAfterCompany:discovery.resumeAfterCompany,pending:discovery.pending,summary:review.summary,approvalsWritten:0,scansScheduled:0,publishedToSearch:false};
  }catch(error){try{await output.writeFile(JSON.stringify({error:'PROFILE_QUALIFICATION_FAILED',note:'No automatic retry; profile requests may already have occurred. This file is not a completed qualification report.'}));}catch{}throw error;}finally{await output.close();if(pool)await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runProfileQualification(process.argv.slice(2)).then(r=>{console.log(JSON.stringify(r));if(r.status==='stopped')process.exitCode=1;}).catch(()=>{console.error(JSON.stringify({error:'PROFILE_QUALIFICATION_FAILED'}));process.exitCode=1;});

import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {planReviewedBatch,runReviewedChargeBatch} from './lib/reviewed_charge_batch.mjs';
export function parseBatchArgs(args){
  const flags=new Map();for(let i=0;i<args.length;i++){
    const k=args[i];if(!['--manifest','--max-companies','--max-requests','--max-pages','--max-run-ms','--apply'].includes(k)||flags.has(k))throw Error('INVALID_BATCH_ARGUMENTS');
    if(k==='--apply'){flags.set(k,true);continue;}const v=args[++i];if(!v||v.startsWith('--'))throw Error('INVALID_BATCH_ARGUMENTS');flags.set(k,v);
  }
  if(!flags.has('--manifest'))throw Error('BATCH_MANIFEST_REQUIRED');
  const n=k=>{const s=flags.get(k);if(!/^[1-9][0-9]*$/.test(s||''))throw Error('INVALID_BATCH_BUDGET');return Number(s);};
  return {manifestPath:flags.get('--manifest'),apply:flags.has('--apply'),maxCompanies:n('--max-companies'),maxRequests:n('--max-requests'),maxPages:n('--max-pages'),maxRunMs:n('--max-run-ms')};
}
export async function runBatch(args,env=process.env){
  const options=parseBatchArgs(args),entries=JSON.parse(await readFile(options.manifestPath,'utf8'));
  const plan=planReviewedBatch({...options,entries});
  if(!options.apply)return runReviewedChargeBatch({...plan,apply:false});
  const {guardedConnection}=await import('./run_company_charge_import.mjs');
  const connectionString=guardedConnection(env.CCOD_TEST_DATABASE_URL);
  if(!env.COMPANIES_HOUSE_API_KEY)throw Error('COMPANIES_HOUSE_KEY_REQUIRED');
  const {default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString,ssl:{rejectUnauthorized:true},max:2,connectionTimeoutMillis:10000,idleTimeoutMillis:5000,statement_timeout:15000});
  try{return await runReviewedChargeBatch({...plan,apply:true,pool,apiKey:env.COMPANIES_HOUSE_API_KEY});}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runBatch(process.argv.slice(2)).then(r=>{console.log(JSON.stringify(r));if(r.status==='stopped')process.exitCode=1;}).catch(()=>{console.error(JSON.stringify({error:'REVIEWED_CHARGE_BATCH_FAILED'}));process.exitCode=1;});

import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {guardedConnection} from './run_company_charge_import.mjs';
import {readScopedChargeSnapshot} from './lib/read_scoped_charge_snapshot.mjs';
import {buildScopedChargePlan} from './lib/scoped_charge_plan.mjs';
export async function runScopePlan(args,env=process.env){
  const flags=new Map();for(let i=0;i<args.length;i++){const k=args[i],v=args[++i];if(!['--output','--batch-size','--page-size'].includes(k)||flags.has(k)||!v||v.startsWith('--'))throw Error('INVALID_SCOPE_ARGUMENTS');flags.set(k,v);}
  if(!flags.get('--output'))throw Error('SCOPE_OUTPUT_REQUIRED');
  const integer=(k,d)=>{const v=flags.get(k)||String(d);if(!/^[1-9][0-9]*$/.test(v))throw Error('INVALID_SCOPE_ARGUMENTS');return Number(v);};
  const batchSize=integer('--batch-size',100),pageSize=integer('--page-size',1000);if(batchSize>100||pageSize>5000)throw Error('INVALID_SCOPE_ARGUMENTS');
  const connectionString=guardedConnection(env.CCOD_TEST_DATABASE_URL),{default:pg}=await import('pg');
  const pool=new pg.Pool({connectionString,ssl:{rejectUnauthorized:true},max:1,connectionTimeoutMillis:10000,statement_timeout:15000});
  try{const snapshot=await readScopedChargeSnapshot(pool,{pageSize}),plan=buildScopedChargePlan(snapshot,{batchSize});await writeFile(flags.get('--output'),JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});return {mode:plan.mode,asOf:plan.asOf,approvalStoreAvailable:plan.approvalStoreAvailable,summary:plan.summary,executed:false,publishedToSearch:false};}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runScopePlan(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error(JSON.stringify({error:'SCOPE_PLAN_FAILED'}));process.exitCode=1;});

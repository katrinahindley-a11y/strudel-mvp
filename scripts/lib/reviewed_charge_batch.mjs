const numberPattern=/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/;
const uuidPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hashPattern=/^[a-f0-9]{64}$/;
const reviewCodes=new Set(['IDENTITY_REVIEW_REQUIRED','IDENTITY_TARGET_MISMATCH','IDENTITY_REVIEW_NOT_APPROVED','IDENTITY_REVIEW_EXPIRED','IDENTITY_SOURCE_CHANGED','IDENTITY_EVIDENCE_STALE','IDENTITY_SOURCE_OR_PROFILE_MISMATCH','IDENTITY_AUTHORIZATION_CHANGED','IDENTITY_SCAN_ALREADY_USED']);
const budgetCodes=new Set(['BATCH_REQUEST_BUDGET_EXHAUSTED','BATCH_TIME_BUDGET_EXHAUSTED','BATCH_DISPATCH_AUTHORIZATION_REQUIRED']);
export function planReviewedBatch(options={}){
  const {entries,maxCompanies,maxRequests,maxPages,maxRunMs}=options;
  for(const [v,min,max] of [[maxCompanies,1,100],[maxRequests,1,10000],[maxPages,1,100],[maxRunMs,1000,1800000]])if(!Number.isSafeInteger(v)||v<min||v>max)throw Error('INVALID_BATCH_BUDGET');
  if(!Array.isArray(entries)||!entries.length||entries.length>maxCompanies)throw Error('INVALID_BATCH_MANIFEST');
  const seen=new Set();
  const manifest=entries.map(e=>{
    if(!numberPattern.test(e?.companyNumber||'')||!uuidPattern.test(e?.proposalId||'')||!hashPattern.test(e?.proposalHash||''))throw Error('INVALID_BATCH_MANIFEST');
    if(seen.has(e.companyNumber))throw Error('DUPLICATE_BATCH_COMPANY');seen.add(e.companyNumber);
    if(Object.keys(e).some(k=>!['companyNumber','proposalId','proposalHash'].includes(k)))throw Error('UNEXPECTED_BATCH_FIELD');
    return Object.freeze({companyNumber:e.companyNumber,proposalId:e.proposalId,proposalHash:e.proposalHash});
  });
  return Object.freeze({entries:Object.freeze(manifest),maxCompanies,maxRequests,maxPages,maxRunMs});
}
// Injection hooks are server-internal test dependencies, never HTTP/manifest fields.
export async function runReviewedChargeBatch(options={},dependencies={}){
  const plan=planReviewedBatch(options);
  if(options.apply!==true)return {mode:'dry_run',executed:false,companies:plan.entries.length,maxRequests:plan.maxRequests,maxPages:plan.maxPages,maxRunMs:plan.maxRunMs,publishedToSearch:false};
  const {pool,apiKey}=options;if(!apiKey||!pool||typeof pool.connect!=='function')throw Error('BATCH_DEPENDENCY_REQUIRED');
  const stage=dependencies.stage||(await import('./stage_company_charge_scan.mjs')).stageCompanyChargeScan;
  const makeClient=dependencies.makeClient||(await import('../run_company_charge_import.mjs')).createBudgetedClient;
  const diagnostic=dependencies.diagnostic||(await import('./charge_scan_diagnostics.mjs')).safeChargeScanDiagnostic;
  const clock=dependencies.clock||Date.now,sleep=dependencies.sleep||(ms=>new Promise(r=>setTimeout(r,ms))),fetchFn=dependencies.fetchFn||globalThis.fetch;
  const started=clock();let used=0,lastStart=null,locked=false,halted=false,tail=Promise.resolve(),authorize=null,dispatchFailure=null;
  const result={mode:'staged_batch',status:'complete',results:[],pending:[],requestsUsed:0,publishedToSearch:false};
  function budget(){if(used>=plan.maxRequests)throw Error('BATCH_REQUEST_BUDGET_EXHAUSTED');if(clock()-started>=plan.maxRunMs)throw Error('BATCH_TIME_BUDGET_EXHAUSTED');}
  function sharedFetch(url,init){
    const job=tail.then(async()=>{
      let signal;
      try{
        if(halted)throw Error('BATCH_REQUEST_BUDGET_EXHAUSTED');budget();
        if(lastStart!==null)await sleep(Math.max(0,1100-(clock()-lastStart)));budget();
        if(typeof authorize!=='function')throw Error('BATCH_DISPATCH_AUTHORIZATION_REQUIRED');
        await authorize();budget();
        signal=AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,Math.floor(plan.maxRunMs-(clock()-started))))]);
        signal.throwIfAborted();
      }catch(error){dispatchFailure=error;throw error;}
      lastStart=clock();used++;
      return fetchFn(url,{...init,signal});
    });tail=job.catch(()=>{halted=true;});return job;
  }
  const lockClient=await pool.connect();
  try{
    if(lockClient.connectionParameters?.host!=='ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech'||lockClient.connectionParameters?.database!=='neondb')throw Error('UNAPPROVED_DATABASE_ENDPOINT');
    const guard=await lockClient.query('SELECT target_name FROM ccod_import.target_guard WHERE id = 1');
    if(guard.rows.length!==1||guard.rows[0].target_name!=='england-wales-property-test')throw Error('TARGET_GUARD_FAILED');
    const claim=await lockClient.query("SELECT pg_try_advisory_lock(hashtextextended('ccod-reviewed-charge-batch-api',0)) AS acquired");
    if(claim.rows[0]?.acquired!==true)throw Error('BATCH_ALREADY_RUNNING');locked=true;
    for(let i=0;i<plan.entries.length;i++){
      const e=plan.entries[i];authorize=null;dispatchFailure=null;
      try{
        budget();
        const client=makeClient({apiKey,companyNumber:e.companyNumber,maxRequests:Math.min(102,plan.maxPages+1),fetchFn:sharedFetch});
        const r=await stage({companyNumber:e.companyNumber,pool,request:client.request,identityReview:{proposalId:e.proposalId,proposalHash:e.proposalHash},apply:true,maxPages:plan.maxPages,registerBeforeDispatch:check=>{authorize=check;}});
        result.results.push({companyNumber:e.companyNumber,status:'staged',scanId:r.scanId,charges:r.charges,pagesFetched:r.pagesFetched});
      }catch(error){
        result.status='stopped';halted=true;
        const failure=dispatchFailure||error,raw=failure?.message,code=reviewCodes.has(raw)||budgetCodes.has(raw)?raw:diagnostic(failure);
        result.results.push({companyNumber:e.companyNumber,status:'failed',diagnostic:code});
        result.pending=plan.entries.slice(i+1).map(x=>x.companyNumber);break;
      }finally{authorize=null;}
    }
    result.requestsUsed=used;return result;
  }finally{
    let destroy=false;
    if(locked)try{const u=await lockClient.query("SELECT pg_advisory_unlock(hashtextextended('ccod-reviewed-charge-batch-api',0)) AS released");if(u.rows[0]?.released!==true)destroy=true;}catch{destroy=true;}
    if(destroy)result.cleanupWarning=true;lockClient.release(destroy);
  }
}

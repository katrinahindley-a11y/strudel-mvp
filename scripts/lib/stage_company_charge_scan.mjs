import { randomUUID } from 'node:crypto';
import { collectCompanyCharges } from './collect_company_charges.mjs';
import { safeChargeScanDiagnostic } from './charge_scan_diagnostics.mjs';
import { assertReviewReference,loadReviewedIdentity } from './company_identity_store.mjs';
const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';
const reviewCodes = new Set(['IDENTITY_REVIEW_REQUIRED','IDENTITY_TARGET_MISMATCH','IDENTITY_REVIEW_NOT_APPROVED','IDENTITY_REVIEW_EXPIRED','IDENTITY_SOURCE_CHANGED','IDENTITY_EVIDENCE_STALE','IDENTITY_SOURCE_OR_PROFILE_MISMATCH','IDENTITY_AUTHORIZATION_CHANGED','IDENTITY_SCAN_ALREADY_USED']);
export async function stageCompanyChargeScan({ companyNumber,pool,request,identityReview,apply=false,maxPages=10,registerBeforeDispatch } = {}) {
  if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber || '')) throw Error('INVALID_COMPANY_NUMBER');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw Error('INVALID_PAGE_BUDGET');
  if (apply !== true) return { mode:'dry_run',companyNumber,maxPages,executed:false };
  assertReviewReference(identityReview);
  if (typeof request !== 'function' || !pool || typeof pool.connect !== 'function' || (registerBeforeDispatch!==undefined && typeof registerBeforeDispatch!=='function')) throw Error('MISSING_DEPENDENCY');
  const c = await pool.connect(), token = randomUUID();
  let transaction=false,destroy=false,dispatchProfile;
  try {
    if (c.connectionParameters?.host !== HOST || c.connectionParameters?.database !== 'neondb') throw Error('UNAPPROVED_DATABASE_ENDPOINT');
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED'); transaction=true;
    const lock = await c.query("SELECT pg_try_advisory_xact_lock(hashtextextended('ccod-charge-scan:' || $1,0)) AS acquired",[companyNumber]);
    if (lock.rows[0]?.acquired !== true) throw Error('COMPANY_SCAN_ALREADY_RUNNING');
    const first = await loadReviewedIdentity(c,identityReview,companyNumber);
    const used = await c.query('SELECT scan_id FROM ccod_import.identity_review_scan_bindings WHERE scan_event=$1',[first.scanEvent]);
    if (used.rows.length) throw Error('IDENTITY_SCAN_ALREADY_USED');
    if(registerBeforeDispatch)registerBeforeDispatch(async()=>{
      const current=await loadReviewedIdentity(c,identityReview,companyNumber,dispatchProfile);
      if(String(current.identityEvent)!==String(first.identityEvent)||String(current.scanEvent)!==String(first.scanEvent))throw Error('IDENTITY_AUTHORIZATION_CHANGED');
    });
    const company = await request('/company/'+companyNumber);
    if (company?.company_number !== companyNumber || !company.company_name) throw Error('COMPANY_IDENTITY_MISMATCH');
    await loadReviewedIdentity(c,identityReview,companyNumber,company);dispatchProfile=company;
    const scan = await collectCompanyCharges(companyNumber,request,{maxPages});
    if (scan.scanComplete !== true) throw Error('INCOMPLETE_CHARGE_SCAN');
    const final = await loadReviewedIdentity(c,identityReview,companyNumber,company);
    if (String(first.identityEvent) !== String(final.identityEvent) || String(first.scanEvent) !== String(final.scanEvent)) throw Error('IDENTITY_AUTHORIZATION_CHANGED');
    await c.query(`INSERT INTO ccod_import.company_charge_scan_state(company_number,status,attempt_token,attempts,last_attempted_at,updated_at) VALUES ($1,'running',$2,1,clock_timestamp(),clock_timestamp()) ON CONFLICT(company_number) DO UPDATE SET status='running',attempt_token=EXCLUDED.attempt_token,attempts=ccod_import.company_charge_scan_state.attempts+1,last_attempted_at=EXCLUDED.last_attempted_at,last_error_code=NULL,updated_at=EXCLUDED.updated_at`,[companyNumber,token]);
    await c.query(`INSERT INTO ccod_import.company_charge_scans(id,company_number,company_profile,charges,records_seen,pages_fetched,identity_status) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,'identity_review_approved')`,[token,companyNumber,JSON.stringify(company),JSON.stringify(scan.charges),scan.charges.length,scan.pagesFetched]);
    await c.query(`INSERT INTO ccod_import.identity_review_scan_bindings(scan_id,proposal_id,proposal_hash,identity_event,scan_event,original_source) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,[token,identityReview.proposalId,identityReview.proposalHash,first.identityEvent,first.scanEvent,JSON.stringify(final.source)]);
    const saved = await c.query(`UPDATE ccod_import.company_charge_scan_state SET status='complete',last_successful_scan_id=$2,last_successful_at=clock_timestamp(),last_successful_charge_count=$3,last_error_code=NULL,updated_at=clock_timestamp() WHERE company_number=$1 AND attempt_token=$2`,[companyNumber,token,scan.charges.length]);
    if (saved.rowCount !== 1) throw Error('SCAN_OWNERSHIP_LOST');
    await c.query('COMMIT'); transaction=false;
    return {mode:'staged',companyNumber,scanId:token,charges:scan.charges.length,pagesFetched:scan.pagesFetched,identityStatus:'identity_review_approved',publishedToSearch:false};
  } catch (error) {
    if (transaction) try { await c.query('ROLLBACK'); } catch { destroy=true; }
    throw Error(reviewCodes.has(error?.message) ? error.message : safeChargeScanDiagnostic(error));
  } finally { try{if(registerBeforeDispatch)registerBeforeDispatch(null);}finally{c.release(destroy);} }
}

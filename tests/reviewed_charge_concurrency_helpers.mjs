import assert from 'node:assert/strict';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function latch() { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; }
async function within(promise, milliseconds = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CONCURRENCY_TEST_TIMEOUT')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export async function runReviewedConcurrencyTests(t, { owner, scanner, stage, number, profile, approved, create, decide, counts }) {
  function heldScan(ref) {
    const entered = latch(), resume = latch();
    let calls = 0;
    const outcome = stage({ companyNumber: number, pool: scanner, identityReview: ref, apply: true, request: async path => {
      calls++;
      if (!path.includes('/charges?')) { entered.release(); await resume.promise; return profile; }
      return { items: [], total_count: 0, start_index: 0 };
    }}).then(value => ({ value }), error => ({ error }));
    return { entered, resume, outcome, calls: () => calls };
  }
  async function succeeds(scan) {
    const result = await within(scan.outcome);
    if (result.error) throw result.error;
    return result.value;
  }
  async function reviewerIsWaiting() {
    for (let i = 0; i < 40; i++) {
      const r = await owner.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='identity_ci_reviewer' AND wait_event_type='Lock' AND query LIKE '%append_identity_review_event%') AS waiting");
      if (r.rows[0].waiting) return;
      await pause(25);
    }
    throw Error('EXPECTED_REVIEWER_LOCK_WAIT_NOT_OBSERVED');
  }
  await t.test('competing scan rejects before API while first scan owns company lock', async () => {
    const firstRef = await approved(), secondRef = await approved(), before = await counts();
    const first = heldScan(firstRef);
    try {
      await within(Promise.race([first.entered.promise, first.outcome.then(r => { throw r.error || Error('SCAN_FINISHED_WITHOUT_PAUSE'); })]));
      let calls = 0;
      await assert.rejects(stage({companyNumber:number,pool:scanner,identityReview:secondRef,apply:true,request:async()=>{calls++;throw Error('UNEXPECTED_API_CALL');}}), /COMPANY_SCAN_ALREADY_RUNNING/);
      assert.equal(calls, 0);
    } finally { first.resume.release(); await succeeds(first); }
    assert.deepEqual(await counts(), {scans:before.scans+1,bindings:before.bindings+1});
  });
  await t.test('approval expiring during charge request rolls back and preserves pointers', async () => {
    const ref = await create();
    const expiry = new Date(Date.now()+2500).toISOString();
    await decide(ref,'identity','approve',expiry);
    await decide(ref,'scan');
    const before=await counts();
    const pointers=async()=>(await owner.query('SELECT last_successful_scan_id,last_published_scan_id FROM ccod_import.company_charge_scan_state WHERE company_number=$1',[number])).rows;
    const previous=await pointers();let calls=0;
    await assert.rejects(stage({companyNumber:number,pool:scanner,identityReview:ref,apply:true,request:async path=>{
      calls++;
      if(!path.includes('/charges?'))return profile;
      const remaining=(await owner.query('SELECT GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 AS ms',[expiry])).rows[0].ms;
      await pause(Math.ceil(remaining)+150);
      return {items:[],total_count:0,start_index:0};
    }}), /IDENTITY_REVIEW_EXPIRED/);
    assert.equal(calls,2);
    assert.deepEqual(await counts(),before);
    assert.deepEqual(await pointers(),previous);
  });
  await t.test('in-flight scan serializes revocation; revocation blocks subsequent scans', async () => {
    const ref=await approved(), scan=heldScan(ref);let decision;
    try {
      await within(Promise.race([scan.entered.promise,scan.outcome.then(r=>{throw r.error||Error('SCAN_FINISHED_WITHOUT_PAUSE');})]));
      decision=decide(ref,'identity','revoke').then(value=>({value}),error=>({error}));
      await reviewerIsWaiting();
    } finally { scan.resume.release(); await succeeds(scan); if(decision){const result=await within(decision);if(result.error)throw result.error;} }
    let calls=0;
    await assert.rejects(stage({companyNumber:number,pool:scanner,identityReview:ref,apply:true,request:async()=>{calls++;throw Error('UNEXPECTED_API_CALL');}}),/IDENTITY_REVIEW_NOT_APPROVED/);
    assert.equal(calls,0);
  });
  await t.test('source update waits for snapshot commit and binding keeps original source', async () => {
    const ref=await approved(),scan=heldScan(ref);let update,snapshot;
    const writer=await owner.connect();
    try {
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await within(Promise.race([scan.entered.promise,scan.outcome.then(r=>{throw r.error||Error('SCAN_FINISHED_WITHOUT_PAUSE');})]));
      update=writer.query("UPDATE public.property_proprietors SET registration_number_raw='concurrency-changed' WHERE title_number='SYNTH1' AND proprietor_position=1").then(value=>({value}),error=>({error}));
      let blocked=false;
      for(let i=0;i<40;i++){
        const r=await owner.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid]);
        if(r.rows[0]?.blocked){blocked=true;break;}await pause(25);
      }
      assert.equal(blocked,true);
    } finally {
      scan.resume.release();
      try { snapshot=await succeeds(scan); if(update){const result=await within(update);if(result.error)throw result.error;} }
      finally { try { await writer.query("UPDATE public.property_proprietors SET registration_number_raw='001234' WHERE title_number='SYNTH1' AND proprietor_position=1"); } finally { writer.release(); } }
    }
    const binding=(await owner.query('SELECT original_source FROM ccod_import.identity_review_scan_bindings WHERE scan_id=$1',[snapshot.scanId])).rows[0].original_source;
    assert.equal(binding.registrationRaw,'001234');assert.equal(binding.candidateNumber,'00001234');
  });
}

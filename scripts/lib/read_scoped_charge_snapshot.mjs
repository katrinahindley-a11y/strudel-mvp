const HOST='ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';
export async function readScopedChargeSnapshot(pool,{pageSize=1000}={}){
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>5000)throw Error('INVALID_SCOPE_PAGE_SIZE');
  const c=await pool.connect();let transaction=false,destroy=false;
  try{
    if(c.connectionParameters?.host!==HOST||c.connectionParameters?.database!=='neondb')throw Error('UNAPPROVED_DATABASE_ENDPOINT');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
    const guard=await c.query('SELECT target_name FROM ccod_import.target_guard WHERE id=1');if(guard.rows[0]?.target_name!=='england-wales-property-test'||guard.rows.length!==1)throw Error('TARGET_GUARD_FAILED');
    const state=(await c.query("SELECT transaction_timestamp() AS as_of,to_regclass('public.companies') AS companies,to_regclass('ccod_import.identity_review_proposals') AS proposals,to_regclass('ccod_import.identity_review_events') AS events,to_regclass('ccod_import.identity_review_principals') AS principals,to_regclass('ccod_import.identity_review_scan_bindings') AS bindings")).rows[0];
    const flags=['proposals','events','principals','bindings'].map(k=>state[k]!=null);if(flags.some(Boolean)&&!flags.every(Boolean))throw Error('REVIEW_SCHEMA_INCOMPLETE');
    const snapshot={asOf:state.as_of,approvalStoreAvailable:flags.every(Boolean),sources:[],proposals:[],events:[],bindings:[]};
    let title=null,position=0;
    for(;;){
      const result=await c.query(`SELECT jsonb_build_object('dataset',t.source_dataset,'release',to_char(t.source_snapshot_month,'YYYY-MM-DD'),'titleNumber',t.title_number,'proprietorPosition',COALESCE(p.proprietor_position,0)::text,'proprietorName',p.proprietor_name,'registrationRaw',p.registration_number_raw,'candidateNumber',p.company_number_candidate) AS source,
        (p.title_number IS NOT NULL) AS "hasProprietor",(m.last_checked_month=t.source_snapshot_month) AS "membershipCurrent",
        ${state.companies?'c.raw_data':'NULL::jsonb'} AS "candidateProfile",${state.companies?'c.last_fetched_at':'NULL::timestamptz'} AS "candidateProfileObservedAt"
        FROM public.property_titles t JOIN ccod_import.refresh_membership m ON m.title_number=t.title_number
        LEFT JOIN public.property_proprietors p ON p.title_number=t.title_number
        ${state.companies?'LEFT JOIN public.companies c ON c.company_number=p.company_number_candidate':''}
        WHERE t.source_dataset='CCOD' AND t.price_paid>5000000 AND m.active=true AND m.managed_high_value=true
        AND ($1::text IS NULL OR (t.title_number,COALESCE(p.proprietor_position,0))>($1::text,$2::smallint))
        ORDER BY t.title_number,COALESCE(p.proprietor_position,0) LIMIT $3`,[title,position,pageSize]);
      if(!result.rows.length)break;
      snapshot.sources.push(...result.rows);const last=result.rows.at(-1).source;
      if(last.titleNumber===title&&Number(last.proprietorPosition)===position)throw Error('SCOPE_CURSOR_DID_NOT_ADVANCE');
      title=last.titleNumber;position=Number(last.proprietorPosition);
    }
    if(snapshot.approvalStoreAvailable&&snapshot.sources.length){
      const titles=[...new Set(snapshot.sources.map(r=>r.source.titleNumber))];
      snapshot.proposals=(await c.query("SELECT id::text,proposal_hash,payload,profile_evidence,profile_observed_at FROM ccod_import.identity_review_proposals WHERE payload #>> '{source,titleNumber}' = ANY($1::text[]) ORDER BY id",[titles])).rows;
      const ids=snapshot.proposals.map(p=>p.id);
      if(ids.length){
        snapshot.events=(await c.query("SELECT DISTINCT ON(e.proposal_id,e.purpose) e.proposal_id::text,e.proposal_hash,e.purpose,e.event_sequence::text,e.decision,e.actor_database_login::text,e.rationale,e.reviewed_at,e.expires_at,COALESCE(a.enabled,false) AS enabled,COALESCE(a.can_authorize_scan,false) AS can_authorize_scan FROM ccod_import.identity_review_events e LEFT JOIN ccod_import.identity_review_principals a ON a.database_login=e.actor_database_login WHERE e.proposal_id=ANY($1::uuid[]) ORDER BY e.proposal_id,e.purpose,e.event_sequence DESC",[ids])).rows;
        snapshot.bindings=(await c.query('SELECT scan_event::text,scan_id::text FROM ccod_import.identity_review_scan_bindings WHERE proposal_id=ANY($1::uuid[])',[ids])).rows;
      }
    }
    await c.query('COMMIT');transaction=false;return snapshot;
  }catch(error){if(transaction)try{await c.query('ROLLBACK');}catch{destroy=true;}throw error;}finally{c.release(destroy);}
}

import {createHash} from 'node:crypto';
import {createBudgetedClient} from '../run_company_charge_import.mjs';
export const PROFILE_POLICY_VERSION='ccod-exact-profile-shadow-v1';
const number=/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/;
const keys=['dataset','release','titleNumber','proprietorPosition','proprietorName','registrationRaw','candidateNumber'];
const time=v=>v==null?NaN:new Date(v).getTime();
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
export const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const sourceKey=r=>JSON.stringify([r.source?.titleNumber,String(r.source?.proprietorPosition)]);
export const sourceDigest=r=>digest({source:Object.fromEntries(keys.map(k=>[k,r.source?.[k]??null])),hasProprietor:r.hasProprietor===true,membershipCurrent:r.membershipCurrent===true});
function cacheOK(p,observedAt,n,now){const t=time(observedAt);return p?.company_number===n&&typeof p.company_name==='string'&&p.company_name.trim()&&Number.isFinite(t)&&t<=now&&now-t<=604800000;}
export function planProfileDiscovery(snapshot,options={}){
  const {maxCompanies,maxRequests,maxRunMs,expiresAt,afterCompany=''}=options,now=time(snapshot?.asOf);
  if(!Number.isFinite(now)||!Array.isArray(snapshot.sources)||!Number.isInteger(maxCompanies)||maxCompanies<1||maxCompanies>100||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>100||!Number.isInteger(maxRunMs)||maxRunMs<1000||maxRunMs>1800000||!Number.isFinite(time(expiresAt))||time(expiresAt)<=now||time(expiresAt)-now>3600000||(afterCompany&&!number.test(afterCompany)))throw Error('INVALID_PROFILE_DISCOVERY_PLAN');
  const groups=new Map(),excluded=[],seen=new Set();
  for(const r of snapshot.sources){const k=sourceKey(r),s=r.source;if(!s?.titleNumber||seen.has(k))throw Error('DUPLICATE_DISCOVERY_SOURCE');seen.add(k);
    if(r.hasProprietor!==true||r.membershipCurrent!==true||s.dataset!=='CCOD'||!/^[1-4]$/.test(String(s.proprietorPosition))||!number.test(s.candidateNumber||'')){excluded.push({sourceKey:k,reason:'SOURCE_REQUIRES_REVIEW'});continue;}
    if(!groups.has(s.candidateNumber))groups.set(s.candidateNumber,[]);groups.get(s.candidateNumber).push(r);
  }
  const all=[...groups.keys()].sort(),selected=all.filter(n=>!afterCompany||n>afterCompany).slice(0,maxCompanies);
  const entries=selected.map(n=>{const rows=groups.get(n),cached=rows.filter(r=>cacheOK(r.candidateProfile,r.candidateProfileObservedAt,n,now));
    const reusable=cached.length===rows.length&&new Set(cached.map(r=>digest(r.candidateProfile))).size===1;
    return {companyNumber:n,sources:rows.map(r=>({key:sourceKey(r),hash:sourceDigest(r)})).sort((a,b)=>a.key<b.key?-1:1),mode:reusable?'cached':'fetch',cachedObservation:reusable?{profile:JSON.parse(JSON.stringify(cached[0].candidateProfile)),observedAt:new Date(Math.min(...cached.map(r=>time(r.candidateProfileObservedAt)))).toISOString()}:null};
  });
  const plan={version:1,policyVersion:PROFILE_POLICY_VERSION,entries,maxCompanies,maxRequests,maxRunMs,expiresAt:new Date(expiresAt).toISOString(),afterCompany,candidateCompanies:all.length,scopeTitles:new Set(snapshot.sources.map(r=>r.source.titleNumber)).size,scopeRows:snapshot.sources.length,excludedSources:excluded,moreCandidates:selected.length?all.some(n=>n>selected.at(-1)):false};
  return {...plan,manifestHash:digest(plan)};
}
const safe=new Set(['COMPANY_PROFILE_NOT_FOUND','COMPANIES_HOUSE_RATE_LIMITED_STOP','COMPANIES_HOUSE_AUTHENTICATION_FAILED','COMPANIES_HOUSE_HTTP_FAILURE','COMPANIES_HOUSE_REQUEST_FAILED','COMPANIES_HOUSE_INVALID_JSON','DISCOVERY_GRANT_EXPIRED','DISCOVERY_REQUEST_BUDGET_EXHAUSTED','DISCOVERY_TIME_BUDGET_EXHAUSTED','DISCOVERY_CACHE_EXPIRED_REPLAN','DISCOVERY_PROFILE_MISMATCH','UNAPPROVED_DISCOVERY_ENDPOINT']);
export async function runProfileDiscovery(plan,{apply=false,approvedManifestHash,apiKey}={},deps={}){
  const {manifestHash,...content}=plan||{};if(content.version!==1||content.policyVersion!==PROFILE_POLICY_VERSION||digest(content)!==manifestHash)throw Error('INVALID_PROFILE_MANIFEST_HASH');
  const result={mode:apply?'profile_discovery':'profile_discovery_preview',executed:false,manifestHash,observations:[],requestsUsed:0,status:'complete',resumeAfterCompany:content.afterCompany,pending:[],approved:false,scanAuthorized:false,publishedToSearch:false};
  if(!apply)return {...result,selectedCompanies:content.entries.length,fetchesPlanned:content.entries.filter(e=>e.mode==='fetch').length};
  if(approvedManifestHash!==manifestHash||(content.entries.some(e=>e.mode==='fetch')&&!apiKey))throw Error('PROFILE_DISCOVERY_PERMISSION_REQUIRED');
  const clock=deps.clock||Date.now,sleep=deps.sleep||(ms=>new Promise(r=>setTimeout(r,ms))),fetchFn=deps.fetchFn||globalThis.fetch,started=clock();let last=null,dispatchError=null;
  function temporal(){if(clock()>=time(content.expiresAt))throw Error('DISCOVERY_GRANT_EXPIRED');if(clock()-started>=content.maxRunMs)throw Error('DISCOVERY_TIME_BUDGET_EXHAUSTED');}
  for(let i=0;i<content.entries.length;i++){
    const e=content.entries[i];dispatchError=null;
    try{
      temporal();let profile,observedAt,origin;
      if(e.mode==='cached'){if(!cacheOK(e.cachedObservation?.profile,e.cachedObservation?.observedAt,e.companyNumber,clock()))throw Error('DISCOVERY_CACHE_EXPIRED_REPLAN');profile=e.cachedObservation.profile;observedAt=e.cachedObservation.observedAt;origin='cached';}
      else{
        const client=createBudgetedClient({apiKey,companyNumber:e.companyNumber,maxRequests:1,fetchFn:async(raw,init)=>{
          try{const u=new URL(raw);if(u.origin!=='https://api.company-information.service.gov.uk'||u.pathname!=='/company/'+e.companyNumber||u.search||u.hash||u.username||u.password)throw Error('UNAPPROVED_DISCOVERY_ENDPOINT');
            if(last!==null)await sleep(Math.max(0,1100-(clock()-last)));temporal();if(result.requestsUsed>=content.maxRequests)throw Error('DISCOVERY_REQUEST_BUDGET_EXHAUSTED');
            const signal=AbortSignal.any([init.signal,AbortSignal.timeout(Math.max(1,Math.floor(Math.min(content.maxRunMs-(clock()-started),time(content.expiresAt)-clock()))))]);signal.throwIfAborted();last=clock();result.requestsUsed++;return await fetchFn(raw,{...init,signal});
          }catch(error){dispatchError=error;throw error;}
        }});
        profile=await client.request('/company/'+e.companyNumber);temporal();observedAt=new Date(clock()).toISOString();origin='api';
        if(profile?.company_number!==e.companyNumber||typeof profile.company_name!=='string'||!profile.company_name.trim())throw Error('DISCOVERY_PROFILE_MISMATCH');
      }
      result.observations.push({companyNumber:e.companyNumber,status:'profile_observed',profile,observedAt,origin});result.resumeAfterCompany=e.companyNumber;
    }catch(error){const raw=(dispatchError||error)?.message,code=safe.has(raw)?raw:'PROFILE_DISCOVERY_FAILED';
      if(code==='COMPANY_PROFILE_NOT_FOUND'){result.observations.push({companyNumber:e.companyNumber,status:'not_found',diagnostic:code});result.resumeAfterCompany=e.companyNumber;continue;}
      result.observations.push({companyNumber:e.companyNumber,status:'lookup_failed',diagnostic:code});result.status='stopped';result.pending=content.entries.slice(i+1).map(x=>x.companyNumber);break;
    }
  }
  result.executed=result.requestsUsed>0;return result;
}

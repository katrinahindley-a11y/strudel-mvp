import pg from 'pg';
const {Pool}=pg;let pool;
export function db(){if(!process.env.DATABASE_URL)throw Error('DATABASE_URL is not configured');pool ||= new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:2});return pool}
export function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}})}
export function errorResponse(e){console.error(e);return json({error:e.message||'Unexpected error'},500)}
export async function companiesHouse(url){if(!process.env.COMPANIES_HOUSE_API_KEY)throw Error('COMPANIES_HOUSE_API_KEY is not configured');const auth=Buffer.from(`${process.env.COMPANIES_HOUSE_API_KEY}:`).toString('base64');const r=await fetch(url,{headers:{Authorization:`Basic ${auth}`}});const d=await r.json();if(!r.ok)throw Error(d.error||d.message||`Companies House returned ${r.status}`);return d}

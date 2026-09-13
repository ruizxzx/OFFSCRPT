import type { VercelRequest, VercelResponse } from '../../server/vercel-types.js';
import crypto from 'node:crypto';
import { getRazorpayConfig, isRazorpayConfigured, razorpayProvider, verifyCapturedPayment } from '../../server/razorpay.js';
import { createLinkedAccount, fetchLinkedAccount, updateLinkedAccount, providerHealth, createDirectTransfer, fetchTransfer, type RouteBusinessType } from '../../server/razorpay-route.js';
import { calculateCommission, calculateProportionalReversal, majorFromSubunits, subunitsFromMajor, validateCommissionRuleInput, type CommissionRule, type CommissionRuleInput, type CommissionRuleScope } from '../../server/commission.js';

const projectId = () => process.env.GOOGLE_CLOUD_PROJECT || process.env.VITE_FIREBASE_PROJECT_ID || 'krishficient-portfolio';
const apiKey = () => process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY || '';
const nowIso = () => new Date().toISOString();
const b64url=(input:string|Buffer)=>Buffer.from(input).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

async function serviceToken(){
  const email=process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL; const key=process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if(!email||!key) throw new Error('Commerce server credentials are not configured. Set GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.');
  const now=Math.floor(Date.now()/1000); const header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'})); const payload=b64url(JSON.stringify({iss:email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  const input=`${header}.${payload}`; const signer=crypto.createSign('RSA-SHA256'); signer.update(input); const sig=b64url(signer.sign(key.replace(/\\n/g,'\n'))); const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${input}.${sig}`})});
  if(!r.ok) throw new Error(`OAuth failed: ${r.status}`); const j:any=await r.json(); if(!j.access_token) throw new Error('OAuth access token missing.'); return String(j.access_token);
}

function firestoreBase(){return `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents`;}
function value(v:any):any { if(v===null) return {nullValue:'NULL_VALUE'}; if(typeof v==='string') return {stringValue:v}; if(typeof v==='boolean') return {booleanValue:v}; if(typeof v==='number' && Number.isInteger(v)) return {integerValue:String(v)}; if(typeof v==='number') return {doubleValue:v}; if(Array.isArray(v)) return {arrayValue:{values:v.map(value)}}; if(v instanceof Date) return {timestampValue:v.toISOString()}; if(typeof v==='object') { const fields:any={}; for(const [k,x] of Object.entries(v)){ if(x!==undefined) fields[k]=value(x); } return {mapValue:{fields}}; } return {stringValue:String(v)}; }
function fields(obj:any){const out:any={}; for(const [k,v] of Object.entries(obj)){ if(v!==undefined) out[k]=value(v); } return out;}
function decode(v:any):any { if(!v) return null; if('stringValue'in v)return v.stringValue; if('integerValue'in v)return Number(v.integerValue); if('doubleValue'in v)return v.doubleValue; if('booleanValue'in v)return v.booleanValue; if('timestampValue'in v)return v.timestampValue; if('nullValue'in v)return null; if('arrayValue'in v)return (v.arrayValue.values||[]).map(decode); if('mapValue'in v){const o:any={}; for(const [k,x] of Object.entries(v.mapValue.fields||{}))o[k]=decode(x); return o;} return undefined; }
function decodeFields(fs:any={}){const o:any={}; for(const [k,v] of Object.entries(fs))o[k]=decode(v); return o;}
async function fsGet(token:string,name:string){const r=await fetch(`${firestoreBase()}/${name}`,{headers:{Authorization:`Bearer ${token}`}}); if(r.status===404)return null; if(!r.ok)throw new Error(`Firestore read failed: ${r.status}`); const j:any=await r.json(); return {name:j.name,fields:decodeFields(j.fields),updateTime:j.updateTime};}
async function fsCreate(token:string,name:string,obj:any){const parent=name.split('/').slice(0,-1).join('/'); const id=name.split('/').pop()!; const r=await fetch(`${firestoreBase()}/${parent}?documentId=${encodeURIComponent(id)}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({fields:fields(obj)})}); if(r.status===409)return false; if(!r.ok)throw new Error(`Firestore create failed: ${r.status}`); return true;}
async function fsPatch(token:string,name:string,obj:any){const params=new URLSearchParams(); for(const k of Object.keys(obj))params.append('updateMask.fieldPaths',k); const r=await fetch(`${firestoreBase()}/${name}?${params.toString()}`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({fields:fields(obj)})}); if(!r.ok)throw new Error(`Firestore update failed: ${r.status}`); return true;}
function firestoreResourceName(name:string){
  const restPrefix='https://firestore.googleapis.com/v1/';
  const base=firestoreBase() + '/';
  if(name.startsWith(restPrefix)){
    const resource=name.slice(restPrefix.length);
    if(resource.startsWith(`projects/${projectId()}/databases/(default)/documents/`)) return resource;
  }
  if(name.startsWith('projects/')) return name;
  if(name.startsWith(base)) return `projects/${projectId()}/databases/(default)/documents/${name.slice(base.length)}`;
  if(!name.includes('/')) return `projects/${projectId()}/databases/(default)/documents/${name}`;
  if(/^(commerceProducts|commercePrices|commerceOrders|commercePayments|commerceRefunds|entitlements|creatorRevenue|creatorPayouts|commerceAuditLogs|commerceWebhookEvents|commerceIdempotency|creatorCommerceProfiles|commerceCommissionRules|commerceFinancialAllocations|commerceVendorLedger|creatorCommerceBalances|siteConfig|users|commerceReviews|commerceReports|commerceModerationCases|commerceModerationActions|commerceTrustSignals|commerceReviewAggregates)\//.test(name)) return `projects/${projectId()}/databases/(default)/documents/${name}`;
  throw new Error(`Invalid Firestore document path: ${name}`);
}
function normalizeCommitWrites(writes:any[]){
  return writes.map((write:any)=>{
    if(write?.create?.name){
      const create=write.create;
      return {
        update:{...create,name:firestoreResourceName(String(create.name))},
        currentDocument:{exists:false}
      };
    }
    if(write?.update?.name){
      const update={...write.update,name:firestoreResourceName(String(write.update.name))};
      const fieldPaths=Object.keys(update.fields||{});
      return fieldPaths.length ? {update,updateMask:{fieldPaths}} : {update};
    }
    if(write?.delete){
      return {delete:firestoreResourceName(String(write.delete))};
    }
    if(write?.transform?.document){
      return {transform:{...write.transform,document:firestoreResourceName(String(write.transform.document))}};
    }
    return write;
  });
}
async function fsCommit(token:string,writes:any[]){
  const normalized=normalizeCommitWrites(writes);
  const r=await fetch(`${firestoreBase()}:commit`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({writes:normalized})});
  if(!r.ok){const text=await r.text(); throw new Error(`Firestore commit failed: ${r.status} ${text.slice(0,500)}`);}
  return r.json();
}
async function fsRunQuery(token:string, from:string, filters:any[]){
  const structuredQuery:any={from:[{collectionId:from}]};
  if(filters.length===1) structuredQuery.where={fieldFilter:filters[0]};
  else if(filters.length>1) structuredQuery.where={compositeFilter:{op:'AND',filters:filters.map(fieldFilter=>({fieldFilter}))}};
  const r=await fetch(`${firestoreBase()}:runQuery`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({structuredQuery})});
  if(!r.ok)throw new Error(`Firestore query failed: ${r.status}`);
  const rows:any[]=await r.json();
  return rows.filter(x=>x.document).map(x=>({name:x.document.name,fields:decodeFields(x.document.fields)}));
}


async function fsRunQueryAdvanced(token:string, from:string, filters:any[] = [], orderByOrOptions?:string|{limit?:number;orderBy?:Array<{fieldPath:string;direction:'ASCENDING'|'DESCENDING'}>;startAt?:{values:any[];before?:boolean}}, direction:'ASCENDING'|'DESCENDING'='DESCENDING', limitCount?:number){
  let options:{limit?:number;orderBy?:Array<{fieldPath:string;direction:'ASCENDING'|'DESCENDING'}>;startAt?:{values:any[];before?:boolean}}={};
  if(typeof orderByOrOptions==='string') options={limit:limitCount,orderBy:[{fieldPath:orderByOrOptions,direction}]};
  else if(orderByOrOptions && typeof orderByOrOptions==='object') options=orderByOrOptions;
  const filterParts=filters.map((x:any)=>({fieldFilter:{field:x.field,op:x.op,value:x.value}}));
  const where=filterParts.length===1?filterParts[0]:filterParts.length>1?{compositeFilter:{op:'AND',filters:filterParts}}:undefined;
  const structured:any={from:[{collectionId:from}]};
  if(where) structured.where=where;
  if(options.orderBy?.length) structured.orderBy=options.orderBy.map(x=>({field:{fieldPath:x.fieldPath},direction:x.direction}));
  if(options.startAt?.values?.length) structured.startAt={values:options.startAt.values,before:options.startAt.before!==false};
  if(Number.isSafeInteger(options.limit)&&Number(options.limit)>0) structured.limit=Math.max(1,Math.min(500,Number(options.limit)));
  const r=await fetch(`${firestoreBase()}:runQuery`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({structuredQuery:structured})});
  if(!r.ok){const tx=await r.text();throw new Error(`Firestore query failed: ${r.status} ${tx.slice(0,500)}`);}
  const rows:any[]=await r.json();
  return rows.filter(x=>x.document).map(x=>({name:x.document.name,fields:decodeFields(x.document.fields),updateTime:x.document.updateTime}));
}
function v96CursorValuesForRow(row:any, order:Array<{fieldPath:string;direction:'ASCENDING'|'DESCENDING'}>):any[]{
  return order.map(o=>{
    if(o.fieldPath==='__name__') return {referenceValue:String(row?.name||'')};
    return value(v96Fields(row)[o.fieldPath]);
  });
}
function encodeV96QueryCursor(row:any, order:Array<{fieldPath:string;direction:'ASCENDING'|'DESCENDING'}>){
  return Buffer.from(JSON.stringify({values:v96CursorValuesForRow(row,order)}),'utf8').toString('base64url');
}
function decodeV96QueryCursor(raw:any):{values:any[]}|null{
  if(typeof raw!=='string'||!raw)return null;
  try{const parsed=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); return parsed&&Array.isArray(parsed.values)&&parsed.values.length?{values:parsed.values}:null;}catch{return null;}
}
async function fsRunQueryAll(token:string,from:string,filters:any[] = [],orderBy:Array<{fieldPath:string;direction:'ASCENDING'|'DESCENDING'}>=[{fieldPath:'__name__',direction:'ASCENDING'}]){
  const out:any[]=[]; let cursor:any[]|undefined; let lastId=''; let guard=0;
  while(guard++<1000){
    const rows=await fsRunQueryAdvanced(token,from,filters,{limit:500,orderBy,startAt:cursor?{values:cursor,before:false}:undefined});
    if(!rows.length) break;
    const page=(cursor && rows.length && v96DocId(rows[0])===lastId)?rows.slice(1):rows;
    if(page.length) out.push(...page);
    if(rows.length<500) break;
    const last=rows[rows.length-1];
    lastId=v96DocId(last);
    cursor=v96CursorValuesForRow(last,orderBy);
    if(!page.length && lastId===v96DocId(rows[0])) break;
  }
  if(guard>=1000) throw new Error(`Firestore pagination safety limit exceeded for ${from}.`);
  return out;
}

// Equality-only bulk reads intentionally omit orderBy so they work without any composite index.
// Callers sort/filter the bounded result server-side. This is used on public/creator screens where
// a missing Firestore deployment index must not turn into a blocking 400 popup.
function v96DecodeFilterValue(encoded:any){
  if(encoded && 'stringValue' in encoded) return encoded.stringValue;
  if(encoded && 'integerValue' in encoded) return Number(encoded.integerValue);
  if(encoded && 'doubleValue' in encoded) return Number(encoded.doubleValue);
  if(encoded && 'booleanValue' in encoded) return encoded.booleanValue;
  if(encoded && 'nullValue' in encoded) return null;
  return undefined;
}
function v96MatchesFilter(row:any,filter:any){
  const actual=v96Fields(row)?.[String(filter.field?.fieldPath||'')];
  const expected=v96DecodeFilterValue(filter.value);
  switch(String(filter.op||'')){
    case 'EQUAL': return String(actual??'')===String(expected??'');
    case 'NOT_EQUAL': return String(actual??'')!==String(expected??'');
    default: return true;
  }
}
async function fsRunQueryAllUnordered(token:string,from:string,filters:any[]=[],limitCount=500){
  const safeLimit=Math.max(1,Math.min(500,Number(limitCount)||500));
  // Multiple equality filters are intentionally reduced to one Firestore filter,
  // then the remaining predicates are evaluated server-side. This avoids creating
  // hidden composite-index dependencies in affected marketplace paths.
  const equalityOnly=filters.length>1 && filters.every(f=>String(f?.op||'')==='EQUAL');
  const queryFilters=equalityOnly?filters.slice(0,1):filters;
  const rows=await fsRunQueryAdvanced(token,from,queryFilters,{limit:safeLimit});
  return equalityOnly?rows.filter(row=>filters.slice(1).every(f=>v96MatchesFilter(row,f))):rows;
}

function v95Iso(value:any){
  const d=new Date(value);
  if(!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}
function v95Paise(value:any){
  const n=Number(value);
  return Number.isSafeInteger(n)?n:null;
}
function v95Major(value:any){
  const n=v95Paise(value);
  return n===null?0:n/100;
}
function v95SafeSum(rows:any[], field:string){
  return rows.reduce((sum,row)=>sum+(v95Paise(row?.fields?.[field])??0),0);
}
function v95Status(value:any){return String(value||'').trim().toLowerCase();}
function v95InRange(value:any, from:string, to:string){
  const iso=v95Iso(value); return !!iso && iso>=from && iso<to;
}
function v95PercentChange(current:number, previous:number){
  if(previous===0) return current===0?0:null;
  return ((current-previous)/Math.abs(previous))*100;
}
function v95ReportWindow(body:any){
  const now=new Date();
  const to=v95Iso(body?.to||now.toISOString())!;
  let fromRaw=body?.from;
  if(!fromRaw){
    const d=new Date(to);
    d.setUTCDate(d.getUTCDate()-29);
    fromRaw=d.toISOString();
  }
  const from=v95Iso(fromRaw);
  if(!from||!v95Iso(to)||from>=to) throw v94PayoutError('INVALID_DATE_RANGE','Invalid finance report date range.');
  return {from, to:v95Iso(to)!, timezone:String(body?.timezone||'Asia/Kolkata'), currency:String(body?.currency||'INR').toUpperCase()};
}
function v95PreviousWindow(from:string,to:string){
  const start=new Date(from).getTime(), end=new Date(to).getTime(), span=end-start;
  return {from:new Date(start-span).toISOString(),to:new Date(start).toISOString()};
}
async function v95LoadFinancialData(token:string, window:{from:string;to:string}, creatorId?:string, productId?:string){
  const equalCreator=creatorId?[{field:{fieldPath:'creatorId'},op:'EQUAL',value:{stringValue:creatorId}}]:[];
  const equalProduct=productId?[{field:{fieldPath:'productId'},op:'EQUAL',value:{stringValue:productId}}]:[];
  const paidOrders=await fsRunQueryAll(token,'commerceOrders',[fsFilter('status','IN',{arrayValue:{values:[{stringValue:'paid'},{stringValue:'partially_refunded'},{stringValue:'refunded'}]}}),...equalCreator]);
  const allocations=await fsRunQueryAll(token,'commerceFinancialAllocations',[...equalCreator,...equalProduct]);
  const refunds=await fsRunQueryAll(token,'commerceRefunds');
  const payouts=await fsRunQueryAll(token,'creatorPayouts',[...equalCreator]);
  const ledger=await fsRunQueryAll(token,'commerceVendorLedger',[...equalCreator]);
  const allocationByOrder=new Map<string,any>(); for(const r of allocations){const oid=String(r.fields?.orderId||''); if(oid) allocationByOrder.set(oid,r.fields);}
  const filteredOrders=paidOrders.filter(r=>v95InRange(r.fields?.paidAt||r.fields?.createdAt,window.from,window.to) && (!productId || (Array.isArray(r.fields?.items)&&r.fields.items.some((i:any)=>String(i?.productId||'')===productId))));
  const filteredAllocations=allocations.filter(r=>v95InRange(r.fields?.createdAt||r.fields?.updatedAt,window.from,window.to));
  const filteredRefunds=refunds.filter(r=>{
    const f=r.fields||{}; if(!v95InRange(f.updatedAt||f.createdAt,window.from,window.to)) return false;
    if(!creatorId&&!productId) return true;
    const a=allocationByOrder.get(String(f.orderId||'')); return !!a && (!creatorId||String(a.creatorId||'')===creatorId) && (!productId||String(a.productId||'')===productId);
  });
  return {paidOrders:filteredOrders, allocations:filteredAllocations,
    refunds:filteredRefunds,
    payouts:payouts.filter(r=>v95InRange(r.fields?.processedAt||r.fields?.createdAt,window.from,window.to)),
    ledger:ledger.filter(r=>v95InRange(r.fields?.effectiveAt||r.fields?.createdAt,window.from,window.to)),
    balances:creatorId ? await fsRunQueryAll(token,'creatorCommerceBalances',[{field:{fieldPath:'creatorId'},op:'EQUAL',value:{stringValue:creatorId}}]) : []};
}
function v95AllocationAmounts(rows:any[]){
  return rows.reduce((acc,row)=>{
    const f=row.fields||{};
    const currency=String(f.currency||'INR').toUpperCase();
    if(currency!=='INR') return acc;
    acc.gross += v95Paise(f.grossAmountSubunits??f.grossAmount*100)??0;
    acc.commission += v95Paise(f.platformCommissionAmountSubunits??(Number(f.platformCommissionAmount||0)*100))??0;
    acc.creatorNet += v95Paise(f.creatorNetAmountSubunits??(Number(f.creatorNetAmount||0)*100))??0;
    return acc;
  },{gross:0,commission:0,creatorNet:0});
}
function v95PaidOrderAmounts(rows:any[]){
  return rows.reduce((acc,row)=>{
    const f=row.fields||{};
    if(String(f.currency||'INR').toUpperCase()!=='INR') return acc;
    const gross=Number(f.total||0);
    if(Number.isSafeInteger(gross)) acc.gross+=gross*100;
    acc.count+=1;
    return acc;
  },{gross:0,count:0});
}
function v95RefundAmounts(rows:any[]){
  return rows.reduce((acc,row)=>{
    const f=row.fields||{};
    if(String(f.currency||'INR').toUpperCase()!=='INR') return acc;
    acc.amount += v95Paise(f.amountSubunits??(Number(f.amount||0)*100))??0;
    acc.count += 1;
    return acc;
  },{amount:0,count:0});
}
function v95PayoutAmounts(rows:any[]){
  return rows.reduce((acc,row)=>{
    const f=row.fields||{};
    if(String(f.currency||'INR').toUpperCase()!=='INR') return acc;
    const amount=v95Paise(f.amountPaise)??0;
    const status=v95Status(f.status);
    if(status==='processed') {acc.processed+=amount; acc.processedCount+=1;}
    if(status==='failed') {acc.failed+=amount; acc.failedCount+=1;}
    if(status==='reversed') {acc.reversed+=amount; acc.reversedCount+=1;}
    acc.requestedCount+=1;
    return acc;
  },{processed:0,failed:0,reversed:0,processedCount:0,failedCount:0,reversedCount:0,requestedCount:0});
}
function v95LedgerOutstanding(rows:any[]){
  const out={pending:0,available:0,reserved:0,paid:0,negative:0};
  for(const row of rows){
    const f=row.fields||{};
    const amount=Math.abs(v95Paise(f.amountPaise??f.amountSubunits)??0);
    const bucket=String(f.balanceBucket||'').toLowerCase();
    const type=v95Status(f.entryType);
    const dir=v95Status(f.entryDirection);
    const signed=(dir==='debit'||type.includes('debit')||type.includes('reversal')||type.includes('refund'))?-amount:amount;
    if(bucket==='pending') out.pending+=signed;
    else if(bucket==='available') out.available+=signed;
    else if(bucket==='reserved') out.reserved+=signed;
    else if(bucket==='paid') out.paid+=signed;
    else if(bucket==='negative') out.negative+=signed;
  }
  return out;
}
function v95Series(rows:any[], dateField:string, amountResolver:(row:any)=>number, from:string, to:string, groupBy:string){
  const map=new Map<string,number>();
  for(const row of rows){
    const iso=v95Iso(row?.fields?.[dateField]||row?.fields?.createdAt); if(!iso||iso<from||iso>=to) continue;
    const d=new Date(iso); let key:string;
    if(groupBy==='month') key=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    else if(groupBy==='week'){const day=(d.getUTCDay()+6)%7; const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-day)); key=start.toISOString().slice(0,10);}
    else key=iso.slice(0,10);
    map.set(key,(map.get(key)||0)+amountResolver(row));
  }
  return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([period,amountPaise])=>({period,amountPaise,amount:amountPaise/100}));
}
function v95MetricSummary(window:any,data:any){
  const order=v95PaidOrderAmounts(data.paidOrders);
  const alloc=v95AllocationAmounts(data.allocations);
  const refunds=v95RefundAmounts(data.refunds);
  const payout=v95PayoutAmounts(data.payouts);
  const netSales=Math.max(0,order.gross-refunds.amount);
  const netRevenue=Math.max(0,alloc.commission);
  const ledger=v95LedgerOutstanding(data.ledger);
  return {
    currency:'INR',
    grossSalesPaise:order.gross,
    grossSales:v95Major(order.gross),
    paidOrders:order.count,
    averageOrderValuePaise:order.count?Math.floor(order.gross/order.count):0,
    averageOrderValue:order.count?order.gross/order.count/100:0,
    platformCommissionPaise:alloc.commission,
    platformCommission:v95Major(alloc.commission),
    creatorNetPaise:alloc.creatorNet,
    creatorNet:v95Major(alloc.creatorNet),
    refundedAmountPaise:refunds.amount,
    refundedAmount:v95Major(refunds.amount),
    refundCount:refunds.count,
    refundRate:order.gross>0?(refunds.amount/order.gross)*100:0,
    netSalesAfterRefundsPaise:netSales,
    netSalesAfterRefunds:v95Major(netSales),
    pendingCreatorLiabilityPaise:Math.max(0,ledger.pending),
    pendingCreatorLiability:v95Major(Math.max(0,ledger.pending)),
    availableCreatorLiabilityPaise:Math.max(0,ledger.available),
    availableCreatorLiability:v95Major(Math.max(0,ledger.available)),
    reservedCreatorLiabilityPaise:Math.max(0,ledger.reserved),
    reservedCreatorLiability:v95Major(Math.max(0,ledger.reserved)),
    paidOutToCreatorsPaise:payout.processed,
    paidOutToCreators:v95Major(payout.processed),
    failedPayoutAmountPaise:payout.failed,
    failedPayoutAmount:v95Major(payout.failed),
    reversedPayoutAmountPaise:payout.reversed,
    reversedPayoutAmount:v95Major(payout.reversed),
    processedPayoutCount:payout.processedCount,
    failedPayoutCount:payout.failedCount,
    reversedPayoutCount:payout.reversedCount,
    payoutRequestCount:payout.requestedCount,
    payoutSuccessRate:payout.requestedCount?(payout.processedCount/payout.requestedCount)*100:0,
    netPlatformRevenuePaise:netRevenue,
    netPlatformRevenue:v95Major(netRevenue),
    generatedAt:nowIso(),
    period:window
  };
}
async function v95FinanceReport(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))) throw v94PayoutError('UNAUTHORIZED','Finance administrator access required.',403);
  const window=v95ReportWindow(b), previous=v95PreviousWindow(window.from,window.to);
  const filters={creatorId:b?.creatorId?String(b.creatorId):undefined,productId:b?.productId?String(b.productId):undefined};
  const data=await v95LoadFinancialData(token,window,filters.creatorId,filters.productId);
  const prevData=await v95LoadFinancialData(token,previous,filters.creatorId,filters.productId);
  const summary=v95MetricSummary(window,data), previousSummary=v95MetricSummary(previous,prevData);
  const groupBy=['month','week','day'].includes(String(b?.groupBy))?String(b.groupBy):'day';
  const revenue=v95Series(data.paidOrders,'paidAt',r=>{const n=Number(r.fields?.total||0);return Number.isSafeInteger(n)?n*100:0;},window.from,window.to,groupBy);
  const commission=v95Series(data.allocations,'createdAt',r=>v95Paise(r.fields?.platformCommissionAmountSubunits??(Number(r.fields?.platformCommissionAmount||0)*100))??0,window.from,window.to,groupBy);
  const creatorNet=v95Series(data.allocations,'createdAt',r=>v95Paise(r.fields?.creatorNetAmountSubunits??(Number(r.fields?.creatorNetAmount||0)*100))??0,window.from,window.to,groupBy);
  const payouts=v95Series(data.payouts,'processedAt',r=>v95Status(r.fields?.status)==='processed'?(v95Paise(r.fields?.amountPaise)??0):0,window.from,window.to,groupBy);
  const refunds=v95Series(data.refunds,'updatedAt',r=>v95Paise(r.fields?.amountSubunits??(Number(r.fields?.amount||0)*100))??0,window.from,window.to,groupBy);
  return {summary,previousSummary,comparison:{
    grossSales:v95PercentChange(summary.grossSalesPaise,previousSummary.grossSalesPaise),
    platformCommission:v95PercentChange(summary.platformCommissionPaise,previousSummary.platformCommissionPaise),
    creatorNet:v95PercentChange(summary.creatorNetPaise,previousSummary.creatorNetPaise),
    refunds:v95PercentChange(summary.refundedAmountPaise,previousSummary.refundedAmountPaise),
    payouts:v95PercentChange(summary.paidOutToCreatorsPaise,previousSummary.paidOutToCreatorsPaise)
  },series:{revenue,commission,creatorNet,payouts,refunds},meta:{from:window.from,to:window.to,previousFrom:previous.from,previousTo:previous.to,timezone:window.timezone,currency:window.currency,source:'canonical V90/V91 + V93/V94',fresh:true}};
}
async function v95ListFinanceDimension(token:string,uid:string,b:any,email?:string,emailVerified?:boolean,dimension:'creator'|'product'|'order'|'payout'|'refund'){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))) throw v94PayoutError('UNAUTHORIZED','Finance administrator access required.',403);
  const window=v95ReportWindow(b);
  if(dimension==='order'){
    const rows=await fsRunQueryAll(token,'commerceOrders',[fsFilter('status','IN',{arrayValue:{values:[{stringValue:'paid'},{stringValue:'partially_refunded'},{stringValue:'refunded'}]}})]);
    return {rows:rows.filter(r=>v95InRange(r.fields?.paidAt||r.fields?.createdAt,window.from,window.to)).slice(0,100).map(r=>({id:String(r.name).split('/').pop(),...r.fields})),generatedAt:nowIso(),period:window};
  }
  if(dimension==='payout'){
    const rows=await fsRunQueryAll(token,'creatorPayouts');
    return {rows:rows.filter(r=>v95InRange(r.fields?.createdAt,window.from,window.to)).slice(0,100).map(r=>({id:String(r.name).split('/').pop(),...r.fields})),generatedAt:nowIso(),period:window};
  }
  if(dimension==='refund'){
    const rows=await fsRunQueryAll(token,'commerceRefunds');
    return {rows:rows.filter(r=>v95InRange(r.fields?.createdAt,window.from,window.to)).slice(0,100).map(r=>({id:String(r.name).split('/').pop(),...r.fields})),generatedAt:nowIso(),period:window};
  }
  const alloc=await fsRunQueryAll(token,'commerceFinancialAllocations');
  const refunds=await fsRunQueryAll(token,'commerceRefunds');
  const payout=await fsRunQueryAll(token,'creatorPayouts');
  const allocByOrder=new Map<string,any>(); for(const r of alloc){const oid=String(r.fields?.orderId||''); if(oid) allocByOrder.set(oid,r.fields);}
  const map=new Map<string,any>();
  for(const row of alloc.filter(r=>v95InRange(r.fields?.createdAt,window.from,window.to))){
    const f=row.fields||{};
    const key=dimension==='creator'?String(f.creatorId||''):String(f.productId||'');
    if(!key) continue;
    if(!map.has(key)) map.set(key,{id:key,orders:0,grossSalesPaise:0,platformCommissionPaise:0,creatorNetPaise:0,refundsPaise:0,paidOutPaise:0});
    const x=map.get(key); x.orders+=1; x.grossSalesPaise+=v95Paise(f.grossAmountSubunits??(Number(f.grossAmount||0)*100))??0; x.platformCommissionPaise+=v95Paise(f.platformCommissionAmountSubunits??(Number(f.platformCommissionAmount||0)*100))??0; x.creatorNetPaise+=v95Paise(f.creatorNetAmountSubunits??(Number(f.creatorNetAmount||0)*100))??0;
  }
  for(const row of refunds.filter(r=>v95InRange(r.fields?.createdAt,window.from,window.to))){
    const f=row.fields||{}; const a=allocByOrder.get(String(f.orderId||'')); const key=dimension==='creator'?String(a?.creatorId||f.creatorId||''):String(a?.productId||f.productId||''); if(key&&map.has(key)) map.get(key).refundsPaise+=v95Paise(f.amountSubunits??(Number(f.amount||0)*100))??0;
  }
  if(dimension==='creator'){
    for(const row of payout.filter(r=>v95InRange(r.fields?.processedAt||r.fields?.createdAt,window.from,window.to))){
      const f=row.fields||{}; const key=String(f.creatorId||''); if(key&&map.has(key)&&v95Status(f.status)==='processed') map.get(key).paidOutPaise+=v95Paise(f.amountPaise)??0;
    }
  }
  const rows=[...map.values()].map(x=>({...x,grossSales:x.grossSalesPaise/100,platformCommission:x.platformCommissionPaise/100,creatorNet:x.creatorNetPaise/100,refunds:x.refundsPaise/100,paidOut:x.paidOutPaise/100,refundRate:x.grossSalesPaise?(x.refundsPaise/x.grossSalesPaise)*100:0})).sort((a,b)=>b.grossSalesPaise-a.grossSalesPaise).slice(0,100);
  return {rows,generatedAt:nowIso(),period:window};
}
function v95CsvEscape(v:any){const s=String(v??'');return `"${s.replace(/"/g,'""')}"`;}
async function v95Export(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))) throw v94PayoutError('UNAUTHORIZED','Finance administrator access required.',403);
  const dimension=['orders','creators','products','payouts','refunds','summary'].includes(String(b?.type))?String(b.type):'summary';
  const window=v95ReportWindow(b);
  let headers:string[]=[]; let rows:any[][]=[];
  if(dimension==='summary'){
    const report=await v95FinanceReport(token,uid,b,email,emailVerified);
    headers=['metric','value','currency']; const s=report.summary;
    rows=[['grossSales',s.grossSales,'INR'],['paidOrders',s.paidOrders,'count'],['platformCommission',s.platformCommission,'INR'],['creatorNet',s.creatorNet,'INR'],['refunds',s.refundedAmount,'INR'],['pendingCreatorLiability',s.pendingCreatorLiability,'INR'],['availableCreatorLiability',s.availableCreatorLiability,'INR'],['reservedCreatorLiability',s.reservedCreatorLiability,'INR'],['paidOutToCreators',s.paidOutToCreators,'INR'],['netPlatformRevenue',s.netPlatformRevenue,'INR']];
  } else if(dimension==='orders'||dimension==='payouts'||dimension==='refunds'){
    const out=await v95ListFinanceDimension(token,uid,b,email,emailVerified,dimension==='orders'?'order':dimension==='payouts'?'payout':'refund');
    const rs=out.rows;
    if(dimension==='orders'){headers=['orderId','creatorId','total','currency','status','paidAt']; rows=rs.map((x:any)=>[x.id,x.creatorId,x.total,x.currency,x.status,x.paidAt]);}
    else if(dimension==='payouts'){headers=['payoutId','creatorId','amountPaise','currency','status','requestedAt','processedAt','razorpayTransferId','reconciliationStatus']; rows=rs.map((x:any)=>[x.payoutId||x.id,x.creatorId,x.amountPaise,x.currency,x.status,x.requestedAt,x.processedAt,x.razorpayTransferId,x.reconciliationStatus]);}
    else {headers=['refundId','orderId','creatorId','amount','currency','status','createdAt']; rows=rs.map((x:any)=>[x.refundId||x.id,x.orderId,x.creatorId,x.amount,x.currency,x.status,x.createdAt]);}
  } else {
    const out=await v95ListFinanceDimension(token,uid,b,email,emailVerified,dimension==='creators'?'creator':'product');
    headers=dimension==='creators'?['creatorId','orders','grossSales','platformCommission','creatorNet','refunds','refundRate','paidOut']:['productId','orders','grossSales','platformCommission','creatorNet','refunds','refundRate'];
    rows=out.rows.map((x:any)=>headers.map(h=>x[h]));
  }
  const csv=[headers.map(v95CsvEscape).join(','),...rows.map(r=>r.map(v95CsvEscape).join(','))].join('\n');
  return {filename:`offscrpt-finance-${dimension}-${window.from.slice(0,10)}-${window.to.slice(0,10)}.csv`,csv,generatedAt:nowIso(),period:window,schemaVersion:'95.0'};
}
async function v95FinanceHealth(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))) throw v94PayoutError('UNAUTHORIZED','Finance administrator access required.',403);
  const window=v95ReportWindow(b);
  const [alloc,payout,refund,ledger]=await Promise.all([
    fsRunQueryAll(token,'commerceFinancialAllocations'),
    fsRunQueryAll(token,'creatorPayouts'),
    fsRunQueryAll(token,'commerceRefunds'),
    fsRunQueryAll(token,'commerceVendorLedger')
  ]);
  const issues:any[]=[];
  const seenTransfers=new Set<string>();
  for(const r of payout){
    const f=r.fields||{};
    if(v95Status(f.status)==='processed'&&!f.razorpayTransferId) issues.push({severity:'CRITICAL',type:'processed_payout_without_transfer',id:f.payoutId||r.name});
    if(f.razorpayTransferId){
      if(seenTransfers.has(String(f.razorpayTransferId))) issues.push({severity:'CRITICAL',type:'duplicate_transfer_id',id:f.razorpayTransferId});
      seenTransfers.add(String(f.razorpayTransferId));
    }
  }
  const allocById=new Map<string,any>(); for(const r of alloc) {const f=r.fields||{}; if(f.allocationId) allocById.set(String(f.allocationId),f);}
  for(const r of ledger){const f=r.fields||{}; if(['sale_credit','sale'].includes(v95Status(f.entryType))&&!f.financialAllocationId) issues.push({severity:'WARNING',type:'ledger_credit_without_allocation',id:r.name});}
  for(const r of refund){const f=r.fields||{}; if(v95Status(f.status)==='processed'&&f.amountSubunits&&Number(f.amountSubunits)<0) issues.push({severity:'CRITICAL',type:'negative_refund',id:r.name});}
  return {status:issues.some(x=>x.severity==='CRITICAL')?'critical':issues.length?'warning':'healthy',healthy:issues.filter(x=>x.severity==='INFO').length,warnings:issues.filter(x=>x.severity==='WARNING').length,critical:issues.filter(x=>x.severity==='CRITICAL').length,issues:issues.slice(0,100),period:window,generatedAt:nowIso(),recordsScanned:{allocations:alloc.length,payouts:payout.length,refunds:refund.length,ledger:ledger.length}};
}
async function fsCommitWithPrecondition(token:string,writes:any[],preconditions:Record<string,string>){
  const normalized=normalizeCommitWrites(writes).map((write:any)=>{
    if(write?.update?.name){
      const prefix=`projects/${projectId()}/databases/(default)/documents/`;
      const short=String(write.update.name).startsWith(prefix)?String(write.update.name).slice(prefix.length):String(write.update.name);
      const updateTime=preconditions[short];
      return updateTime ? {...write,currentDocument:{updateTime}} : write;
    }
    return write;
  });
  const r=await fetch(`${firestoreBase()}:commit`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({writes:normalized})});
  if(!r.ok){const text=await r.text(); const e:any=new Error(`Firestore conditional commit failed: ${r.status} ${text.slice(0,500)}`); e.statusCode=(r.status===409||r.status===400)?409:r.status; throw e;}
  return r.json();
}

function v94SafeInt(value:any){
  const n=Number(value); return Number.isSafeInteger(n)?n:null;
}
function v94BalanceId(creatorId:string,currency='INR'){return stableId('bal',`${creatorId}:${currency.toUpperCase()}`);}
function v94LedgerId(kind:string,sourceId:string){return stableId('vledger',`${kind}:${sourceId}`);}
function v94PayoutError(code:string,message:string,statusCode=400){const e:any=new Error(message);e.code=code;e.statusCode=statusCode;return e;}
const V94_DEFAULT_HOLD_DAYS=7;
const V94_DEFAULT_MINIMUM_PAYOUT_PAISE=10000;
const V94_DEFAULT_MANUAL_REVIEW=true;

function v94ParseAmountToPaise(raw:any){
  const text=String(raw??'').trim().replace(/[,₹\\s]/g,'');
  if(!/^\\d+(?:\\.\\d{1,2})?$/.test(text)) throw v94PayoutError('INVALID_AMOUNT','Enter a valid INR payout amount.');
  const [whole,fraction='']=text.split('.');
  const paise=Number(whole)*100+Number((fraction+'00').slice(0,2));
  if(!Number.isSafeInteger(paise)||paise<=0) throw v94PayoutError('INVALID_AMOUNT','Payout amount must be greater than zero.');
  return paise;
}

async function getPayoutSettings(token:string){
  const global=await fsGet(token,'siteConfig/global');
  const settings=(global?.fields?.commercePayouts&&typeof global.fields.commercePayouts==='object')?global.fields.commercePayouts:{};
  const min=v94SafeInt(settings.minimumPayoutAmountPaise);
  const max=v94SafeInt(settings.maximumPayoutAmountPaise);
  const holdRaw=Number(settings.payoutHoldDays);
  const holdDays=Number.isSafeInteger(holdRaw)&&holdRaw>=0&&holdRaw<=365?holdRaw:V94_DEFAULT_HOLD_DAYS;
  return {
    enabled:settings.enabled!==false,
    minimumPayoutAmountPaise:min!==null&&min>=100?min:V94_DEFAULT_MINIMUM_PAYOUT_PAISE,
    maximumPayoutAmountPaise:max!==null&&max>=100?max:null,
    dailyPayoutLimitPaise:v94SafeInt(settings.dailyPayoutLimitPaise),
    monthlyPayoutLimitPaise:v94SafeInt(settings.monthlyPayoutLimitPaise),
    holdDays,
    manualApprovalRequired:settings.manualApprovalRequired===undefined?V94_DEFAULT_MANUAL_REVIEW:Boolean(settings.manualApprovalRequired),
    version:Number(settings.version||1)
  };
}

async function v94EnsureBalanceSnapshot(token:string,creatorId:string,currency='INR'){
  const id=v94BalanceId(creatorId,currency); const path=`creatorCommerceBalances/${id}`; const existing=await fsGet(token,path);
  if(existing)return {id,doc:existing};
  const stamp=nowIso();
  const initial={creatorId,currency:currency.toUpperCase(),pendingAmountPaise:0,availableAmountPaise:0,reservedAmountPaise:0,paidAmountPaise:0,negativeAmountPaise:0,totalEarnedAmountPaise:0,totalRefundedAmountPaise:0,totalWithdrawnAmountPaise:0,balanceVersion:1,lastLedgerEntryId:null,createdAt:stamp,updatedAt:stamp};
  try{await fsCommit(token,[{create:{name:`${firestoreBase()}/${path}`,fields:fields(initial)}}]);}
  catch{const again=await fsGet(token,path);if(again)return {id,doc:again};throw new Error('Unable to initialize creator balance.');}
  return {id,doc:{name:`${firestoreBase()}/${path}`,fields:initial,updateTime:undefined}};
}

async function v94LoadLedger(token:string,creatorId:string){
  // Avoid creatorId+effectiveAt composite-index dependency. Fetch the owner's ledger
  // with the equality-only query and sort deterministically on the server.
  const rows=await fsRunQueryAllUnordered(token,'commerceVendorLedger',[fsFilter('creatorId','EQUAL',{stringValue:creatorId})],500);
  return rows.sort((a,b)=>String(a.fields?.effectiveAt||a.fields?.createdAt||'').localeCompare(String(b.fields?.effectiveAt||b.fields?.createdAt||'')) || String(a.name||'').localeCompare(String(b.name||'')));
}

function v94RecomputeBalance(rows:any[],nowMs=Date.now()){
  let pending=0, rawAvailable=0, reserved=0, paid=0, totalEarned=0, totalRefunded=0, totalWithdrawn=0;
  const ordered=rows.slice().sort((a,b)=>String(a.fields?.effectiveAt||a.fields?.createdAt||'').localeCompare(String(b.fields?.effectiveAt||b.fields?.createdAt||''))||String(a.name).localeCompare(String(b.name)));
  const saleEntries=new Map<string,{pending:number;available:number}>();
  for(const row of ordered){
    const f=row.fields||{}; const amount=v94SafeInt(f.amountPaise); const type=String(f.entryType||''); const status=String(f.status||'posted');
    if(status==='void'||amount===null||amount<0) continue;
    if(type==='sale_credit'){
      totalEarned+=amount;
      const at=Date.parse(String(f.availableAt||''));
      const keys=[String(f.financialAllocationId||f.sourceId||''),String(f.ledgerEntryId||''),String(row.name||'').split('/').pop()||''].filter(Boolean); const state={pending:0,available:amount};
      if(Number.isFinite(at)&&at>nowMs){pending+=amount;state.pending=amount;state.available=0;} else {rawAvailable+=amount;}
      for(const key of keys) saleEntries.set(key,state);
    } else if(type==='refund_debit'||type==='commission_reversal'){
      totalRefunded+=amount;
      const source=String(f.reversesLedgerEntryId||f.financialAllocationId||'');
      const sale=saleEntries.get(source);
      if(sale&&sale.pending>0){
        const use=Math.min(amount,sale.pending); sale.pending-=use; pending=Math.max(0,pending-use); const remainder=amount-use; if(remainder>0) rawAvailable-=remainder;
      } else rawAvailable-=amount;
    } else if(type==='payout_reservation'){
      reserved+=amount; rawAvailable-=amount;
    } else if(type==='payout_release'){
      reserved-=amount; rawAvailable+=amount;
    } else if(type==='payout_debit'){
      reserved-=amount; paid+=amount; totalWithdrawn+=amount;
    } else if(type==='payout_reversal'){
      const reversed=Math.min(amount,paid); paid-=reversed; totalWithdrawn=Math.max(0,totalWithdrawn-reversed); rawAvailable+=amount;
    } else if(type==='manual_adjustment'||type==='correction'){
      if(String(f.entryDirection||'credit')==='debit') rawAvailable-=amount; else rawAvailable+=amount;
    }
  }
  const negative=Math.max(0,-rawAvailable); const available=Math.max(0,rawAvailable);
  return {pendingAmountPaise:Math.max(0,pending),availableAmountPaise:available,reservedAmountPaise:Math.max(0,reserved),paidAmountPaise:Math.max(0,paid),negativeAmountPaise:negative,totalEarnedAmountPaise:Math.max(0,totalEarned),totalRefundedAmountPaise:Math.max(0,totalRefunded),totalWithdrawnAmountPaise:Math.max(0,totalWithdrawn)};
}

async function v94RefreshBalanceSnapshot(token:string,creatorId:string,currency='INR'){
  const snap=await v94EnsureBalanceSnapshot(token,creatorId,currency); const rows=await v94LoadLedger(token,creatorId); const computed=v94RecomputeBalance(rows); const version=(v94SafeInt(snap.doc.fields.balanceVersion)||0)+1; const path=`creatorCommerceBalances/${snap.id}`;
  if(snap.doc.updateTime){
    await fsCommitWithPrecondition(token,[{update:{name:`${firestoreBase()}/${path}`,fields:fields({...computed,balanceVersion:version,lastLedgerEntryId:rows[rows.length-1]?.name?String(rows[rows.length-1].name).split('/').pop():snap.doc.fields.lastLedgerEntryId,updatedAt:nowIso()})}}],{[path]:snap.doc.updateTime}).catch(()=>{});
  } else {
    await fsPatch(token,path,{...computed,balanceVersion:version,updatedAt:nowIso()}).catch(()=>{});
  }
  return {id:snap.id,computed};
}

async function v94AppendLedgerEntry(token:string,entry:any){
  const creatorId=String(entry.creatorId||''); if(!creatorId) throw new Error('Ledger creator is required.');
  const id=String(entry.ledgerEntryId||''); if(!id) throw new Error('Ledger entry ID is required.');
  const existing=await fsGet(token,`commerceVendorLedger/${id}`); if(existing) return {id,...existing.fields,existing:true};
  const snap=await v94EnsureBalanceSnapshot(token,creatorId,'INR'); const balancePath=`creatorCommerceBalances/${snap.id}`; const stamp=nowIso();
  const doc={...entry,ledgerEntryId:id,currency:'INR',status:entry.status||'posted',createdAt:entry.createdAt||stamp,effectiveAt:entry.effectiveAt||stamp,updatedAt:stamp};
  const nextVersion=(v94SafeInt(snap.doc.fields.balanceVersion)||0)+1;
  try{
    await fsCommitWithPrecondition(token,[
      {create:{name:`${firestoreBase()}/commerceVendorLedger/${id}`,fields:fields(doc)}},
      {update:{name:`${firestoreBase()}/${balancePath}`,fields:fields({balanceVersion:nextVersion,lastLedgerEntryId:id,updatedAt:stamp})}}
    ],snap.doc.updateTime?{[balancePath]:snap.doc.updateTime}:{});
  }catch(error:any){
    const raced=await fsGet(token,`commerceVendorLedger/${id}`); if(raced)return {id,...raced.fields,existing:true};
    if(Number(error?.statusCode)===409){ await new Promise(r=>setTimeout(r,25)); return v94AppendLedgerEntry(token,entry); }
    throw error;
  }
  return {id,...doc};
}

async function v94MaterializeSaleCredit(token:string,allocation:any){
  if(String(allocation?.financialStatus||'')!=='calculated') return null;
  const creatorId=String(allocation?.creatorId||''); const amountPaise=v94SafeInt(allocation?.creatorNetAmountSubunits); if(!creatorId||amountPaise===null||amountPaise<0) return null;
  const id=v94LedgerId('sale',String(allocation.allocationId||allocation.orderId||'')); const existing=await fsGet(token,`commerceVendorLedger/${id}`); if(existing)return {id,...existing.fields};
  const settings=await getPayoutSettings(token); const effectiveAt=String(allocation.paidAt||allocation.createdAt||nowIso()); const effectiveMs=Date.parse(effectiveAt); const availableAt=new Date((Number.isFinite(effectiveMs)?effectiveMs:Date.now())+settings.holdDays*86400000).toISOString();
  const doc={ledgerEntryId:id,creatorId,sellerId:String(allocation.sellerId||''),orderId:String(allocation.orderId||''),paymentId:String(allocation.paymentId||''),financialAllocationId:String(allocation.allocationId||''),payoutId:null,refundId:null,entryType:'sale_credit',entryDirection:'credit',amountPaise,originalAmountPaise:amountPaise,grossAmountPaise:v94SafeInt(allocation.grossAmountSubunits)||0,currency:'INR',balanceBucket:Date.parse(availableAt)<=Date.now()?'available':'pending',availableAt,status:'posted',source:'v93_financial_allocation',sourceId:String(allocation.allocationId||''),idempotencyKey:`sale_credit:${allocation.allocationId}`,effectiveAt,createdAt:nowIso(),updatedAt:nowIso()};
  return v94AppendLedgerEntry(token,doc);
}

async function v94CreateRefundLedgerEntry(token:any,allocation:any,refundId:string,creatorReversalPaise:number){
  if(creatorReversalPaise<=0) return null;
  const id=v94LedgerId('refund',refundId); const existing=await fsGet(token,`commerceVendorLedger/${id}`); if(existing)return {id,...existing.fields};
  return v94AppendLedgerEntry(token,{ledgerEntryId:id,creatorId:String(allocation.creatorId||''),sellerId:String(allocation.sellerId||''),orderId:String(allocation.orderId||''),paymentId:String(allocation.paymentId||''),financialAllocationId:String(allocation.allocationId||''),payoutId:null,refundId,entryType:'refund_debit',entryDirection:'debit',amountPaise:creatorReversalPaise,originalAmountPaise:creatorReversalPaise,currency:'INR',balanceBucket:'available',status:'posted',source:'v93_refund_reversal',sourceId:refundId,reversesLedgerEntryId:v94LedgerId('sale',String(allocation.allocationId||allocation.orderId||'')),idempotencyKey:`refund_debit:${refundId}`,effectiveAt:nowIso(),createdAt:nowIso(),updatedAt:nowIso()});
}

async function v94GetBalance(token:string,uid:string){
  const seller=await getSellerProfile(token,uid); const settings=await getPayoutSettings(token); const refreshed=await v94RefreshBalanceSnapshot(token,uid,'INR'); const c=refreshed.computed;
  const sellerActive=seller?.fields?.sellerEnabled===true && String(seller?.fields?.onboardingStatus||'')==='active';
  const manual=seller?.fields?.manualPayout||{}; const upi=String(manual.upiId||seller?.fields?.upiId||''); const mobile=String(manual.mobile||seller?.fields?.phone||''); const email=String(manual.email||seller?.fields?.email||'');
  const manualDetailsReady=Boolean(upi&&mobile&&email);
  let blockedReason=''; if(!settings.enabled)blockedReason='PAYOUTS_DISABLED'; else if(!sellerActive)blockedReason='SELLER_NOT_ACTIVE'; else if(!manualDetailsReady)blockedReason='PAYOUT_DETAILS_REQUIRED'; else if(c.negativeAmountPaise>0)blockedReason='NEGATIVE_BALANCE';
  const payoutEnabled=settings.enabled&&sellerActive&&manualDetailsReady&&c.negativeAmountPaise===0;
  return {creatorId:uid,currency:'INR',pendingBalancePaise:c.pendingAmountPaise,availableBalancePaise:c.availableAmountPaise,reservedBalancePaise:c.reservedAmountPaise,paidOutBalancePaise:c.paidAmountPaise,totalEarnedPaise:c.totalEarnedAmountPaise,totalRefundedPaise:c.totalRefundedAmountPaise,totalWithdrawnPaise:c.totalWithdrawnAmountPaise,negativeBalancePaise:c.negativeAmountPaise,withdrawablePaise:payoutEnabled?c.availableAmountPaise:0,minimumPayoutPaise:settings.minimumPayoutAmountPaise,payoutEnabled,payoutBlockedReason:blockedReason,sellerStatus:String(seller?.fields?.onboardingStatus||'not_started'),routeAccountStatus:'disabled_manual_mode',payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD,manualPayout:{upiId:upi,mobile,email}};
}

function v94PublicPayout(row:any){
  const f=row?.fields||row||{}; return {id:String(row?.id||row?.name||f.payoutId||''),...f};
}

async function v94CreatePayout(token:string,uid:string,b:any){
  const settings=await getPayoutSettings(token); if(!settings.enabled)throw v94PayoutError('PAYOUTS_DISABLED','Payouts are currently disabled.');
  const amountPaise=v94ParseAmountToPaise(b.amount); if(settings.maximumPayoutAmountPaise!==null&&amountPaise>settings.maximumPayoutAmountPaise)throw v94PayoutError('ABOVE_MAXIMUM','Requested payout exceeds the configured maximum.');
  const idempotencyKey=String(b.idempotencyKey||'').trim(); if(idempotencyKey.length<8||idempotencyKey.length>200)throw v94PayoutError('DUPLICATE_REQUEST','A valid idempotency key is required.');
  const idemId=stableId('payout_idem',`${uid}:${idempotencyKey}`); const idemPath=`commerceIdempotency/${idemId}`; const existingIdem=await fsGet(token,idemPath); if(existingIdem?.fields?.payoutId){const p=await fsGet(token,`creatorPayouts/${existingIdem.fields.payoutId}`);if(p)return {payout:v94PublicPayout({id:existingIdem.fields.payoutId,...p.fields}),balance:await v94GetBalance(token,uid),reused:true};}
  const balance=await v94GetBalance(token,uid); if(!balance.payoutEnabled)throw v94PayoutError(balance.payoutBlockedReason||'PAYOUT_NOT_AVAILABLE','Payouts are not currently available for this seller.');
  if(amountPaise<balance.minimumPayoutPaise)throw v94PayoutError('BELOW_MINIMUM',`Minimum payout is ${majorFromSubunits(balance.minimumPayoutPaise)} INR.`);
  if(amountPaise>balance.withdrawablePaise)throw v94PayoutError('INSUFFICIENT_BALANCE','Requested payout exceeds your withdrawable balance.');
  const seller=await getSellerProfile(token,uid); const sellerId=String(seller?.fields?.sellerId||sellerIdFor(uid)); const manual=seller?.fields?.manualPayout||{}; const upiId=String(manual.upiId||seller?.fields?.upiId||''); const payoutMobile=String(manual.mobile||seller?.fields?.phone||''); const payoutEmail=String(manual.email||seller?.fields?.email||''); if(!upiId||!payoutMobile||!payoutEmail)throw v94PayoutError('PAYOUT_DETAILS_REQUIRED','Complete your UPI ID, mobile number and email before requesting a payout.');
  const payoutId=crypto.randomUUID(); const stamp=nowIso(); const status=MANUAL_PAYOUT_MODE?'pending_review':(settings.manualApprovalRequired?'pending_review':'requested');
  const payout={payoutId,creatorId:uid,sellerId,amountPaise,currency:'INR',status,requestedAt:stamp,approvedAt:null,submittedAt:null,processedAt:null,failedAt:null,reversedAt:null,razorpayAccountId:null,razorpayTransferId:null,ledgerReservationId:null,ledgerDebitId:null,idempotencyKey,reconciliationStatus:'not_required',providerTransferStatus:'manual_pending',providerSettlementStatus:null,failureCode:null,failureMessage:null,payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD,manualPayoutSnapshot:{upiId,mobile:payoutMobile,email:payoutEmail},createdAt:stamp,updatedAt:stamp,financialSource:'v94_creator_balance'};
  try{await fsCommit(token,[
    {create:{name:`${firestoreBase()}/creatorPayouts/${payoutId}`,fields:fields(payout)}},
    {create:{name:`${firestoreBase()}/${idemPath}`,fields:fields({userId:uid,payoutId,createdAt:stamp,operation:'createPayout'})}},
    {create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`payout_requested:${payoutId}`)}`,fields:fields({actorId:uid,actorType:'creator',targetType:'payout',targetId:payoutId,event:'payout_requested',timestamp:stamp,metadata:{amountPaise,currency:'INR'}})}}
  ]);}catch(error:any){const raced=await fsGet(token,idemPath);if(raced?.fields?.payoutId){const p=await fsGet(token,`creatorPayouts/${raced.fields.payoutId}`);if(p)return {payout:v94PublicPayout({id:raced.fields.payoutId,...p.fields}),balance:await v94GetBalance(token,uid),reused:true};}throw error;}
  if(!settings.manualApprovalRequired && MANUAL_PAYOUT_MODE){
    await v94ReservePayout(token,payout,uid);
    const done=await fsGet(token,`creatorPayouts/${payoutId}`); return {payout:v94PublicPayout({id:payoutId,...(done?.fields||payout),payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD}),balance:await v94GetBalance(token,uid)};
  }
  if(!settings.manualApprovalRequired && !MANUAL_PAYOUT_MODE){
    await v94ApproveAndSubmitPayout(token,payoutId,uid,false);
    const done=await fsGet(token,`creatorPayouts/${payoutId}`); return {payout:v94PublicPayout({id:payoutId,...(done?.fields||payout)}),balance:await v94GetBalance(token,uid)};
  }
  return {payout:v94PublicPayout({id:payoutId,...payout}),balance};
}

async function v94ReservePayout(token:string,payout:any,actorId:string){
  const payoutId=String(payout.payoutId||''); const creatorId=String(payout.creatorId||''); const amountPaise=v94SafeInt(payout.amountPaise); if(!payoutId||!creatorId||amountPaise===null||amountPaise<100)throw v94PayoutError('INVALID_STATE','Invalid payout record.');
  const balance=await v94GetBalance(token,creatorId); if(!balance.payoutEnabled)throw v94PayoutError(balance.payoutBlockedReason||'PAYOUT_NOT_AVAILABLE','Payout is no longer eligible.');
  if(amountPaise>balance.withdrawablePaise)throw v94PayoutError('INSUFFICIENT_BALANCE','Payout exceeds current withdrawable balance.');
  const seller=await getSellerProfile(token,creatorId); const manual=seller?.fields?.manualPayout||{}; if(!String(manual.upiId||seller?.fields?.upiId||'')||!String(manual.mobile||seller?.fields?.phone||'')||!String(manual.email||seller?.fields?.email||'')) throw v94PayoutError('PAYOUT_DETAILS_REQUIRED','Creator payout details are incomplete.');
  const snap=await v94EnsureBalanceSnapshot(token,creatorId,'INR'); const reservationId=v94LedgerId('reserve',payoutId); const now=nowIso(); const balancePath=`creatorCommerceBalances/${snap.id}`; const version=(v94SafeInt(snap.doc.fields.balanceVersion)||0)+1;
  const reservation={ledgerEntryId:reservationId,creatorId,sellerId:String(payout.sellerId||''),orderId:null,paymentId:null,financialAllocationId:null,payoutId,refundId:null,entryType:'payout_reservation',entryDirection:'debit',amountPaise,currency:'INR',balanceBucket:'available',status:'posted',source:'v94_manual_payout',sourceId:payoutId,idempotencyKey:`payout_reservation:${payoutId}`,payoutMethod:MANUAL_PAYOUT_METHOD,effectiveAt:now,createdAt:now,updatedAt:now};
  try{
    await fsCommitWithPrecondition(token,[
      {create:{name:`${firestoreBase()}/commerceVendorLedger/${reservationId}`,fields:fields(reservation)}},
      {update:{name:`${firestoreBase()}/creatorPayouts/${payoutId}`,fields:fields({status:'reserved',approvedAt:payout.approvedAt||now,ledgerReservationId:reservationId,updatedAt:now,approvedBy:actorId})}},
      {update:{name:`${firestoreBase()}/${balancePath}`,fields:fields({balanceVersion:version,lastLedgerEntryId:reservationId,updatedAt:now})}},
      {create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`payout_reserved:${payoutId}`)}`,fields:fields({actorId,actorType:actorId===creatorId?'creator':'admin',targetType:'payout',targetId:payoutId,event:'payout_reserved',timestamp:now,metadata:{amountPaise}})}}
    ],snap.doc.updateTime?{[balancePath]:snap.doc.updateTime}:{});
  }catch(error:any){const existing=await fsGet(token,`commerceVendorLedger/${reservationId}`);if(existing){return {reservationId};}if(Number(error?.statusCode)===409)throw v94PayoutError('PAYOUT_CONFLICT','Payout balance changed while approving. Refresh and retry.',409);throw error;}
  return {reservationId};
}

async function v94ReleasePayoutReservation(token:string,payout:any,reasonCode:string,reason:string,actorId='system'){
  const payoutId=String(payout.payoutId||''); const creatorId=String(payout.creatorId||''); const amountPaise=v94SafeInt(payout.amountPaise); if(!payoutId||!creatorId||amountPaise===null)return;
  const id=v94LedgerId('release',payoutId); const existing=await fsGet(token,`commerceVendorLedger/${id}`); if(existing)return;
  await v94AppendLedgerEntry(token,{ledgerEntryId:id,creatorId,sellerId:String(payout.sellerId||''),orderId:null,paymentId:null,financialAllocationId:null,payoutId,refundId:null,entryType:'payout_release',entryDirection:'credit',amountPaise,currency:'INR',balanceBucket:'available',status:'posted',source:'v94_payout',sourceId:payoutId,idempotencyKey:`payout_release:${payoutId}`,reasonCode,reason,effectiveAt:nowIso(),createdAt:nowIso(),updatedAt:nowIso()});
  await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'failed',failedAt:nowIso(),failureCode:reasonCode,failureMessage:reason,updatedAt:nowIso(),reconciliationStatus:'not_required'});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`payout_failed:${payoutId}:${id}`)}`,fields:fields({actorId,actorType:actorId==='system'?'system':'admin',targetType:'payout',targetId:payoutId,event:'payout_failed',timestamp:nowIso(),metadata:{reasonCode,reason}})}}]).catch(()=>{});
}

async function v94FinalizeProcessedPayout(token:string,payout:any,providerTransfer:any,eventId:string){
  const payoutId=String(payout.payoutId||''); const creatorId=String(payout.creatorId||''); const amountPaise=v94SafeInt(payout.amountPaise); if(!payoutId||!creatorId||amountPaise===null)throw v94PayoutError('INVALID_STATE','Invalid payout state.');
  if(!['reserved','processing','processed'].includes(String(payout.status||''))) throw v94PayoutError('INVALID_STATE','Payout is not in a transferable state.');
  const providerAmount=v94SafeInt(providerTransfer?.amount); if(providerAmount!==null&&providerAmount!==amountPaise)throw v94PayoutError('RECONCILIATION_REQUIRED','Provider transfer amount does not match the payout amount.');
  const storedAccount=String(payout.razorpayAccountId||''); const recipient=String(providerTransfer?.recipient||''); if(recipient&&recipient!==storedAccount)throw v94PayoutError('RECONCILIATION_REQUIRED','Provider transfer recipient does not match the seller account.');
  const debitId=v94LedgerId('debit',payoutId); const existing=await fsGet(token,`commerceVendorLedger/${debitId}`); if(!existing){
    await v94AppendLedgerEntry(token,{ledgerEntryId:debitId,creatorId,sellerId:String(payout.sellerId||''),orderId:null,paymentId:null,financialAllocationId:null,payoutId,refundId:null,entryType:'payout_debit',entryDirection:'debit',amountPaise,currency:'INR',balanceBucket:'reserved',status:'posted',source:'razorpay_route_transfer',sourceId:String(providerTransfer?.id||payout.razorpayTransferId||payoutId),idempotencyKey:`payout_debit:${payoutId}`,effectiveAt:nowIso(),createdAt:nowIso(),updatedAt:nowIso()});
  }
  const now=nowIso(); const status=String(providerTransfer?.transfer_status||providerTransfer?.status||'processed'); const settlementStatus=providerTransfer?.settlement_status??null;
  await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'processed',processedAt:payout.processedAt||now,razorpayTransferId:String(providerTransfer?.id||payout.razorpayTransferId||''),providerTransferStatus:status,providerSettlementStatus:settlementStatus,reconciliationStatus:'reconciled',ledgerDebitId:debitId,updatedAt:now});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`payout_processed:${payoutId}:${eventId}`)}`,fields:fields({actorId:'system',actorType:'system',targetType:'payout',targetId:payoutId,event:'payout_processed',timestamp:now,metadata:{razorpayTransferId:String(providerTransfer?.id||payout.razorpayTransferId||''),providerStatus:status}})}}]).catch(()=>{});
}

async function v94SubmitReservedPayout(token:string,payoutId:string){
  if(MANUAL_PAYOUT_MODE) throw v94PayoutError('ROUTE_DISABLED','Razorpay Route transfers are disabled. Use manual creator payout settlement.');
  let payoutDoc=await fsGet(token,`creatorPayouts/${payoutId}`); if(!payoutDoc)throw v94PayoutError('INVALID_STATE','Payout not found.',404); let payout={payoutId,...payoutDoc.fields};
  if(!['reserved','processing'].includes(String(payout.status||'')))return payout;
  const creatorId=String(payout.creatorId||''); const accountId=String(payout.razorpayAccountId||''); if(!creatorId||!accountId)throw v94PayoutError('ACCOUNT_NOT_READY','Payout destination is not configured.');
  try{
    const account=await fetchLinkedAccount(accountId); if(String(account?.status||'')==='suspended'){await v94ReleasePayoutReservation(token,payout,'ACCOUNT_SUSPENDED','The Razorpay seller account is suspended.'); return {...payout,status:'failed'};}
  }catch(error:any){
    const providerStatus=Number(error?.providerStatus||0); if(providerStatus===401||providerStatus===403||Number(error?.statusCode)===502){await v94ReleasePayoutReservation(token,payout,'ROUTE_UNAVAILABLE','Razorpay Route is not currently available for this account.'); return {...payout,status:'failed'};}
    await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'reconciliation_required',failureCode:'PROVIDER_TIMEOUT',failureMessage:'Unable to verify the Razorpay seller account before payout submission.',reconciliationStatus:'required',updatedAt:nowIso()}); return {...payout,status:'reconciliation_required'};
  }
  const now=nowIso(); await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'processing',submittedAt:payout.submittedAt||now,updatedAt:now});
  try{
    const transfer=await createDirectTransfer({accountId,amountPaise:Number(payout.amountPaise),currency:'INR',notes:{offscrpt_payout_id:payoutId.slice(0,32)}});
    const transferStatus=String(transfer?.transfer_status||transfer?.status||'created'); const transferId=String(transfer?.id||''); if(!transferId)throw new Error('Razorpay did not return a transfer ID.');
    const latest=await fsGet(token,`creatorPayouts/${payoutId}`); const latestPayout={payoutId,...(latest?.fields||payout)};
    await fsPatch(token,`creatorPayouts/${payoutId}`,{razorpayTransferId:transferId,providerTransferStatus:transferStatus,providerSettlementStatus:transfer?.settlement_status??null,reconciliationStatus:'pending',updatedAt:nowIso()});
    if(transferStatus==='processed') await v94FinalizeProcessedPayout(token,latestPayout,{...transfer,id:transferId,recipient:String(transfer?.recipient||accountId)},`response:${transferId}`);
    return {...latestPayout,razorpayTransferId:transferId,providerTransferStatus:transferStatus,status:transferStatus==='processed'?'processed':'processing'};
  }catch(error:any){
    const providerStatus=Number(error?.providerStatus||0); const code=(providerStatus===401||providerStatus===403)?'ROUTE_UNAVAILABLE':Number(error?.statusCode)===503||!providerStatus?'PROVIDER_TIMEOUT':'PROVIDER_REJECTED';
    if(code==='PROVIDER_TIMEOUT'){
      await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'reconciliation_required',failureCode:code,failureMessage:'The transfer outcome could not be determined. Reconciliation is required before retrying.',reconciliationStatus:'required',updatedAt:nowIso()});
      return {...payout,status:'reconciliation_required'};
    }
    await v94ReleasePayoutReservation(token,payout,code,code==='ROUTE_UNAVAILABLE'?'Razorpay Route transfer capability is unavailable for this account.':String(error?.message||'Razorpay rejected the transfer.'));
    return {...payout,status:'failed'};
  }
}

async function v94ApproveAndSubmitPayout(token:string,payoutId:string,adminUid:string,isAdmin=true){
  const payoutDoc=await fsGet(token,`creatorPayouts/${payoutId}`); if(!payoutDoc)throw v94PayoutError('INVALID_STATE','Payout not found.',404); const payout={payoutId,...payoutDoc.fields};
  const creatorId=String(payout.creatorId||''); if(!creatorId)throw v94PayoutError('INVALID_STATE','Payout creator is missing.');
  if(!['requested','pending_review'].includes(String(payout.status||''))) { if(['reserved','processing'].includes(String(payout.status||''))) return v94SubmitReservedPayout(token,payoutId); return payout; }
  await v94ReservePayout(token,payout,adminUid);
  return v94SubmitReservedPayout(token,payoutId);
}

async function createPayout(token:string,uid:string,b:any){return v94CreatePayout(token,uid,b);}
async function getCreatorBalance(token:string,uid:string){return v94GetBalance(token,uid);}
async function listCreatorPayouts(token:string,uid:string){
  // Avoid creatorId+createdAt composite-index dependency; the server sorts the owner's
  // bounded payout set after the equality-only query.
  const rows=(await fsRunQueryAllUnordered(token,'creatorPayouts',[fsFilter('creatorId','EQUAL',{stringValue:uid})],500))
    .sort((a,b)=>String(b.fields?.createdAt||'').localeCompare(String(a.fields?.createdAt||'')) || v96DocId(a).localeCompare(v96DocId(b)))
    .slice(0,100);
  return {payouts:rows.map(v94PublicPayout)};
}
async function getPayout(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  const payoutId=String(b.payoutId||''); if(!payoutId)throw new Error('Payout ID is required.'); const row=await fsGet(token,`creatorPayouts/${payoutId}`); if(!row)throw v94PayoutError('NOT_FOUND','Payout not found.',404); const admin=await verifyCommerceAdmin(token,uid,email,emailVerified); if(String(row.fields.creatorId||'')!==uid&&!admin)throw v94PayoutError('UNAUTHORIZED','You are not authorized to view this payout.',403); return {payout:v94PublicPayout({id:payoutId,...row.fields})};
}
async function approvePayout(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified)))throw v94PayoutError('UNAUTHORIZED','Admin access required.',403);
  const payoutId=String(b.payoutId||''); if(!payoutId)throw new Error('Payout ID is required.');
  const row=await fsGet(token,`creatorPayouts/${payoutId}`); if(!row)throw v94PayoutError('NOT_FOUND','Payout not found.',404);
  const payout={payoutId,...row.fields};
  if(String(payout.payoutMode||'route')!=='manual') throw v94PayoutError('INVALID_MODE','Legacy Razorpay Route payouts are not approved through the new manual flow. Use legacy reconciliation for existing transfers.');
  if(!['requested','pending_review'].includes(String(payout.status||''))){ if(String(payout.status||'')==='reserved')return {payout:v94PublicPayout(payout),balance:await v94GetBalance(token,String(payout.creatorId||''))}; throw v94PayoutError('INVALID_STATE','Only pending manual payouts can be approved.'); }
  await v94ReservePayout(token,payout,uid);
  const final=await fsGet(token,`creatorPayouts/${payoutId}`); const creatorId=String(payout.creatorId||'');
  return {payout:v94PublicPayout({id:payoutId,...(final?.fields||payout),status:'reserved',payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD}),balance:creatorId?await v94GetBalance(token,creatorId):undefined};
}

async function markPayoutPaid(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified)))throw v94PayoutError('UNAUTHORIZED','Admin access required.',403);
  const payoutId=String(b.payoutId||'').trim(); const paymentReference=String(b.paymentReference||'').trim().slice(0,160); const note=String(b.note||'').trim().slice(0,500);
  if(!payoutId||!paymentReference)throw v94PayoutError('INVALID_ARGUMENT','A manual payment reference is required.');
  const row=await fsGet(token,`creatorPayouts/${payoutId}`); if(!row)throw v94PayoutError('NOT_FOUND','Payout not found.',404); const payout={payoutId,...row.fields};
  if(String(payout.payoutMode||'route')!=='manual')throw v94PayoutError('INVALID_MODE','This is a legacy Route payout. New Route settlement is disabled; reconcile its existing provider transfer or create a new manual payout.');
  if(!['reserved','approved','processing'].includes(String(payout.status||'')))throw v94PayoutError('INVALID_STATE','Only an approved/reserved manual payout can be marked paid.');
  const creatorId=String(payout.creatorId||''); const amountPaise=v94SafeInt(payout.amountPaise); if(!creatorId||amountPaise===null)throw v94PayoutError('INVALID_STATE','Payout amount or creator is invalid.');
  const debitId=v94LedgerId('manual_debit',payoutId); const existing=await fsGet(token,`commerceVendorLedger/${debitId}`); const now=nowIso();
  if(String(payout.status||'')==='processed' && existing) return {payout:v94PublicPayout(payout),balance:await v94GetBalance(token,creatorId),reused:true};
  if(existing && String(existing.fields?.sourceId||'')!==paymentReference) throw v94PayoutError('CONFLICT','This payout already has a different manual payment reference recorded.',409);
  if(!existing){
    const debit=await v94AppendLedgerEntry(token,{ledgerEntryId:debitId,creatorId,sellerId:String(payout.sellerId||''),orderId:null,paymentId:null,financialAllocationId:null,payoutId,refundId:null,entryType:'payout_debit',entryDirection:'debit',amountPaise,currency:'INR',balanceBucket:'reserved',status:'posted',source:'manual_creator_payout',sourceId:paymentReference,idempotencyKey:`manual_payout_debit:${payoutId}`,effectiveAt:now,createdAt:now,updatedAt:now,payoutMethod:MANUAL_PAYOUT_METHOD,paymentReference});
    if(String(debit?.sourceId||paymentReference)!==paymentReference) throw v94PayoutError('CONFLICT','Manual payout debit already exists with a different payment reference.',409);
  }
  await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'processed',processedAt:payout.processedAt||now,submittedAt:payout.submittedAt||now,providerTransferStatus:'manual_paid',providerSettlementStatus:'manual',reconciliationStatus:'reconciled',ledgerDebitId:debitId,manualPaidAt:now,manualPaidBy:uid,manualPaymentReference:paymentReference,manualPaymentNote:note||null,razorpayAccountId:null,razorpayTransferId:null,updatedAt:now,payoutMethod:MANUAL_PAYOUT_METHOD,payoutMode:'manual'});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`manual_payout_paid:${payoutId}:${paymentReference}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'payout',targetId:payoutId,event:'manual_payout_paid',timestamp:now,metadata:{amountPaise,paymentReference,payoutMethod:MANUAL_PAYOUT_METHOD}})}}]);
  const final=await fsGet(token,`creatorPayouts/${payoutId}`); return {payout:v94PublicPayout({id:payoutId,...(final?.fields||payout)}),balance:await v94GetBalance(token,creatorId)};
}

async function rejectPayout(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified)))throw v94PayoutError('UNAUTHORIZED','Admin access required.',403); const payoutId=String(b.payoutId||''); const row=await fsGet(token,`creatorPayouts/${payoutId}`); if(!row)throw v94PayoutError('NOT_FOUND','Payout not found.',404); if(!['requested','pending_review'].includes(String(row.fields.status||'')))throw v94PayoutError('INVALID_STATE','Only pending payouts can be rejected.'); const reason=String(b.reason||'Rejected by administrator.').trim().slice(0,300); const stamp=nowIso(); await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'rejected',failureCode:'ADMIN_REJECTED',failureMessage:reason,updatedAt:stamp}); await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`payout_rejected:${payoutId}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'payout',targetId:payoutId,event:'payout_rejected',timestamp:stamp,metadata:{reason}})}}]); return {payout:{id:payoutId,...row.fields,status:'rejected',failureCode:'ADMIN_REJECTED',failureMessage:reason,updatedAt:stamp}};
}
async function adminListPayouts(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified)))throw v94PayoutError('UNAUTHORIZED','Admin access required.',403); const filters:any=[]; if(String(b.status||''))filters.push(fsFilter('status','EQUAL',{stringValue:String(b.status)})); if(String(b.creatorId||''))filters.push(fsFilter('creatorId','EQUAL',{stringValue:String(b.creatorId)})); const rows=(await fsRunQueryAllUnordered(token,'creatorPayouts',filters,500)).sort((a,b)=>String(b.fields?.createdAt||'').localeCompare(String(a.fields?.createdAt||''))||String(b.name||'').localeCompare(String(a.name||''))).slice(0,100); return {payouts:rows.map(v94PublicPayout)};
}
async function reconcilePayout(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified)))throw v94PayoutError('UNAUTHORIZED','Admin access required.',403); const payoutId=String(b.payoutId||''); const row=await fsGet(token,`creatorPayouts/${payoutId}`); if(!row)throw v94PayoutError('NOT_FOUND','Payout not found.',404); let payout={payoutId,...row.fields}; if(String(payout.payoutMode||'route')==='manual') return {status:String(payout.status||'reserved'),payout:v94PublicPayout(payout),manual:true}; const transferId=String(payout.razorpayTransferId||''); if(!transferId){await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'reconciliation_required',reconciliationStatus:'required',failureCode:'MISSING_TRANSFER_ID',updatedAt:nowIso()}); return {status:'reconciliation_required',payout:{id:payoutId,...payout,status:'reconciliation_required'}};}
  let transfer:any; try{transfer=await fetchTransfer(transferId);}catch(error:any){await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'reconciliation_required',reconciliationStatus:'required',failureCode:'PROVIDER_LOOKUP_FAILED',failureMessage:String(error?.message||'Provider lookup failed.').slice(0,300),updatedAt:nowIso()}); return {status:'reconciliation_required',payout:{id:payoutId,...payout,status:'reconciliation_required'}};}
  const amount=v94SafeInt(transfer?.amount); const recipient=String(transfer?.recipient||''); if(amount!==v94SafeInt(payout.amountPaise)||recipient!==String(payout.razorpayAccountId||'')){await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'reconciliation_required',reconciliationStatus:'required',failureCode:'PROVIDER_MISMATCH',failureMessage:'Provider transfer amount or recipient does not match the payout.',updatedAt:nowIso()}); return {status:'reconciliation_required',payout:{id:payoutId,...payout,status:'reconciliation_required'}};}
  const ps=String(transfer?.transfer_status||transfer?.status||''); if(ps==='processed'){await v94FinalizeProcessedPayout(token,payout,transfer,`admin:${uid}`);} else if(ps==='failed'){await v94ReleasePayoutReservation(token,payout,'PROVIDER_REJECTED','Provider reports that the transfer failed.',uid);} else if(ps==='reversed'||ps==='partially_reversed'){
    await v94HandlePayoutReversal(token,transfer,`admin:${uid}`);
  } else await fsPatch(token,`creatorPayouts/${payoutId}`,{status:'processing',providerTransferStatus:ps,reconciliationStatus:'pending',updatedAt:nowIso()});
  const final=await fsGet(token,`creatorPayouts/${payoutId}`); return {status:String(final?.fields?.status||'processing'),payout:{id:payoutId,...(final?.fields||payout)}};
}
async function v94HandlePayoutReversal(token:string,transfer:any,eventId:string){
  const transferId=String(transfer?.id||''); const payouts=transferId?await fsRunQuery(token,'creatorPayouts',[fsFilter('razorpayTransferId','EQUAL',{stringValue:transferId})]):[]; let row=payouts[0]; if(!row){const notes=transfer?.notes||{}; const payoutId=String(notes.offscrpt_payout_id||''); if(payoutId)row=await fsGet(token,`creatorPayouts/${payoutId}`);} if(!row)return {ignored:'unmatched_provider_transfer'};
  const payoutId=String(row.fields.payoutId||String(row.name).split('/').pop()); const amountReversed=v94SafeInt(transfer?.amount_reversed)||0; if(amountReversed<=0)return {ignored:'no_reversal_amount'}; const cumulativeRows=await fsRunQuery(token,'commerceVendorLedger',[fsFilter('payoutId','EQUAL',{stringValue:payoutId}),fsFilter('entryType','EQUAL',{stringValue:'payout_reversal'})]); const previous=cumulativeRows.reduce((n,r)=>n+(v94SafeInt(r.fields.amountPaise)||0),0); const original=v94SafeInt(row.fields.amountPaise)||0; const delta=Math.min(amountReversed,Math.max(0,original-previous)); if(delta<=0)return {ignored:'reversal_already_recorded'};
  const reversalId=v94LedgerId('reversal_event',eventId); await v94AppendLedgerEntry(token,{ledgerEntryId:reversalId,creatorId:String(row.fields.creatorId||''),sellerId:String(row.fields.sellerId||''),orderId:null,paymentId:null,financialAllocationId:null,payoutId,refundId:null,entryType:'payout_reversal',entryDirection:'credit',amountPaise:delta,currency:'INR',balanceBucket:'available',status:'posted',source:'razorpay_route_transfer',sourceId:transferId,idempotencyKey:`payout_reversal:${eventId}`,effectiveAt:nowIso(),createdAt:nowIso(),updatedAt:nowIso()}); const fullyReversed=(previous+delta)>=original; await fsPatch(token,`creatorPayouts/${payoutId}`,{status:fullyReversed?'reversed':'reconciliation_required',reversedAt:fullyReversed?nowIso():undefined,providerTransferStatus:String(transfer?.transfer_status||transfer?.status||''),providerSettlementStatus:transfer?.settlement_status??null,reconciliationStatus:fullyReversed?'reconciled':'required',updatedAt:nowIso()}); return {payoutId,delta,fullyReversed};
}
async function handleRouteTransferWebhookPayout(token:string,eventType:string,transfer:any,eventId:string){
  const transferId=String(transfer?.id||''); if(!transferId)return {ignored:'missing_transfer_id'}; const payouts=await fsRunQuery(token,'creatorPayouts',[fsFilter('razorpayTransferId','EQUAL',{stringValue:transferId})]); let row=payouts[0]; if(!row){const notes=transfer?.notes||{}; const payoutId=String(notes.offscrpt_payout_id||''); if(payoutId)row=await fsGet(token,`creatorPayouts/${payoutId}`);} if(!row)return {ignored:'unmatched_provider_transfer'};
  const payout={payoutId:String(row.fields.payoutId||String(row.name).split('/').pop()),...row.fields}; const expected=v94SafeInt(payout.amountPaise); const actual=v94SafeInt(transfer?.amount); const recipient=String(transfer?.recipient||''); if(actual!==expected|| (recipient&&recipient!==String(payout.razorpayAccountId||''))){await fsPatch(token,`creatorPayouts/${payout.payoutId}`,{status:'reconciliation_required',reconciliationStatus:'required',failureCode:'PROVIDER_MISMATCH',failureMessage:'Verified Route webhook does not match the canonical payout.',updatedAt:nowIso()}); return {mismatch:true,payoutId:payout.payoutId};}
  if(eventType==='transfer.processed')return v94FinalizeProcessedPayout(token,payout,transfer,eventId);
  if(eventType==='transfer.failed'){await v94ReleasePayoutReservation(token,payout,'PROVIDER_REJECTED','Razorpay reports that the transfer failed.');return {payoutId:payout.payoutId,status:'failed'};}
  if(eventType==='transfer.reversed'||eventType==='transfer.partially_reversed')return v94HandlePayoutReversal(token,transfer,eventId);
  return {ignored:eventType};
}

async function fsCount(token:string, collectionId:string){
  const r=await fetch(`${firestoreBase()}:runAggregationQuery`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({structuredAggregationQuery:{structuredQuery:{from:[{collectionId}]},aggregations:[{alias:'count',count:{}}]}})});
  if(!r.ok){const text=await r.text();throw new Error(`Firestore count failed: ${r.status} ${text.slice(0,300)}`);}
  const rows:any[]=await r.json();
  const raw=rows?.[0]?.result?.aggregateFields?.count?.integerValue;
  return Number(raw||0);
}
async function verifyCommerceAdmin(token:string,uid:string,email?:string,emailVerified?:boolean){
  const normalized=String(email||'').trim().toLowerCase();
  // Keep backend commerce authorization aligned with the canonical OFFSCRPT master-admin bootstrap allowlist.
  if(emailVerified===true && ['ruizxzxz@gmail.com','krishsarkar456@gmail.com'].includes(normalized)) return true;
  const user=await fsGet(token,`users/${uid}`);
  if(user?.fields?.platformRole==='master_admin') return true;
  const admin=await fsGet(token,`masterAdmins/${uid}`);
  if(admin?.fields?.enabled===false) return false;
  if(admin) return true;
  if(emailVerified===true && normalized){
    const byEmail=await fsGet(token,`masterAdminEmails/${normalized}`);
    return Boolean(byEmail && byEmail.fields?.enabled!==false);
  }
  return false;
}
async function verifyFirebaseToken(idToken:string){ if(!idToken) throw new Error('Authentication required.'); if(!apiKey()) throw new Error('FIREBASE_WEB_API_KEY is not configured on the server.'); const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey())}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken})}); const j:any=await r.json(); if(!r.ok||!j.users?.[0]?.localId) throw new Error('Invalid authentication token.'); const account=j.users[0]; return {uid:String(account.localId),email:String(account.email||''),emailVerified:Boolean(account.emailVerified)}; }
function authHeader(req:VercelRequest){return String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();}
function amountOk(n:any){return Number.isSafeInteger(n)&&n>=0&&n<=10_000_000_000;}
function idempotencyId(userId:string, key:string){return crypto.createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0,48);}
function stableId(prefix:string,source:string){ return `${prefix}_${crypto.createHash('sha256').update(source).digest('hex').slice(0,40)}`; }

async function checkAccess(token:string,uid:string,b:any){
  const resourceType=String(b.resourceType||'').trim(), resourceId=String(b.resourceId||'').trim(); if(!resourceType||!resourceId) throw new Error('resourceType and resourceId are required.');
  const rows=await fsRunQuery(token,'entitlements',[{field:{fieldPath:'userId'},op:'EQUAL',value:{stringValue:uid}},{field:{fieldPath:'resourceType'},op:'EQUAL',value:{stringValue:resourceType}},{field:{fieldPath:'resourceId'},op:'EQUAL',value:{stringValue:resourceId}}]);
  const now=Date.now(); const access=rows.some(x=>{const d=x.fields; if(d.status!=='active')return false; const starts=d.startsAt?Date.parse(String(d.startsAt)):0; const expires=d.expiresAt?Date.parse(String(d.expiresAt)):NaN; return (!starts||starts<=now)&&(!Number.isFinite(expires)||expires>now);});
  return {access,resourceType,resourceId,userId:uid};
}

async function createProduct(token:string,uid:string,b:any){
  const user=await fsGet(token,`users/${uid}`); if(!user)throw new Error('Creator profile not found.'); if(!(user.fields.isAuthor===true || user.fields.creatorStatus===true || user.fields.platformRole==='master_admin'))throw new Error('Creator commerce is not configured for this account.'); const seller=await getSellerProfile(token,uid); if(seller && ['suspended','rejected'].includes(String(seller.fields.onboardingStatus||''))) throw new Error('Marketplace selling is not available for this seller.');
  const title=String(b.title||'').trim().slice(0,160), description=String(b.description||'').trim().slice(0,5000), type=String(b.type||'digital_product'), visibility=String(b.visibility||'private'), currency=String(b.currency||'INR').toUpperCase();
  if(!title||!['content','digital_product','course','subscription','community','service','bundle','tip'].includes(type))throw new Error('Invalid product.');
  if(!['private','public'].includes(visibility)||!/^[A-Z]{3}$/.test(currency))throw new Error('Invalid product visibility or currency.');
  const productId=crypto.randomUUID(); const priceInput=b.price; const writes=[{create:{name:`${firestoreBase()}/commerceProducts/${productId}`,fields:fields({creatorId:uid,creatorUsername:String(user.fields.username||''),title,description,type,status:'draft',visibility,moderationStatus:'active',trustState:'active',featured:false,currency,priceIds:[],version:1,createdAt:nowIso(),updatedAt:nowIso()})}}];
  let price:any=undefined;
  if(priceInput){ if(!amountOk(priceInput.amount)||String(priceInput.currency||currency).toUpperCase()!==currency)throw new Error('Invalid initial price.'); const priceId=crypto.randomUUID(); price={id:priceId,productId,amount:Number(priceInput.amount),currency,billingType:priceInput.billingType==='recurring'?'recurring':'one_time',interval:priceInput.interval,intervalCount:priceInput.intervalCount||1,trialDays:Math.max(0,Math.min(365,Number(priceInput.trialDays||0))),active:true,createdAt:nowIso(),updatedAt:nowIso()}; writes[0].create.fields.priceIds=value([priceId]); writes.push({create:{name:`${firestoreBase()}/commercePrices/${priceId}`,fields:fields(price)}}); }
  await fsCommit(token,writes); return {product:{id:productId,creatorId:uid,creatorUsername:String(user.fields.username||''),title,description,type,status:'draft',visibility,currency,priceIds:price?.id?[price.id]:[],version:1,createdAt:nowIso(),updatedAt:nowIso()},price};
}

async function setProductStatus(token:string,uid:string,b:any){
  const productId=String(b.productId||''); const next=String(b.status||'');
  if(!['active','archived','disabled','draft'].includes(next)) throw new Error('Invalid product status.');
  const product=await fsGet(token,`commerceProducts/${productId}`); if(!product) throw new Error('Product not found.');
  if(product.fields.creatorId!==uid) throw new Error('You do not own this product.');
  if(next==='active' && !(Array.isArray(product.fields.priceIds)&&product.fields.priceIds.length>0)) throw new Error('Add at least one price before activating the product.');
  if(next==='active' && product.fields.creatorId!=='' && product.fields.creatorId!==uid) throw new Error('Product creator linkage is invalid.'); if(next==='active' && String(product.fields.moderationStatus||'active')!=='active') throw new Error('Product is not eligible for marketplace activation while under moderation or enforcement.');
  if(next==='active'){
    const seller=await getSellerProfile(token,uid);
    if(!seller?.fields?.sellerEnabled || !['active'].includes(String(seller.fields.onboardingStatus||''))) throw new Error('Complete seller onboarding and enable selling before publishing marketplace products.');
  }
  const stamp=nowIso();
  await fsPatch(token,`commerceProducts/${productId}`,{status:next,updatedAt:stamp,...(next==='active'?{publishedAt:product.fields.publishedAt||stamp}:{}) ,...(next==='archived'?{archivedAt:stamp}:{})});
  return {product:{id:productId,...product.fields,status:next,updatedAt:stamp}};
}

async function createPrice(token:string,uid:string,b:any){
  const product=await fsGet(token,`commerceProducts/${String(b.productId||'')}`); if(!product)throw new Error('Product not found.'); if(String(product.fields.moderationStatus||'active')!=='active' || String(product.fields.trustState||'active')==='restricted') throw new Error('This product is not currently available for purchase.'); if(product.fields.creatorId!==uid)throw new Error('You do not own this product.');
  const currency=String(b.currency||product.fields.currency||'INR').toUpperCase(), amount=Number(b.amount); if(!amountOk(amount)||!/^[A-Z]{3}$/.test(currency))throw new Error('Invalid price.');
  const priceId=crypto.randomUUID(); const price={id:priceId,productId:String(b.productId),amount,currency,billingType:b.billingType==='recurring'?'recurring':'one_time',interval:b.interval,intervalCount:Math.max(1,Math.min(12,Number(b.intervalCount||1))),trialDays:Math.max(0,Math.min(365,Number(b.trialDays||0))),active:Boolean(b.active!==false),createdAt:nowIso(),updatedAt:nowIso()};
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commercePrices/${priceId}`,fields:fields(price)}},{update:{name:`${firestoreBase()}/commerceProducts/${price.productId}`,fields:fields({priceIds:[...(Array.isArray(product.fields.priceIds)?product.fields.priceIds:[]),priceId],updatedAt:nowIso()})}}]); return {price};
}



const ROUTE_BUSINESS_TYPES = new Set<RouteBusinessType>([
  'individual','proprietorship','partnership','llp','private_limited','public_limited','trust','society','ngo'
]);

const MANUAL_PAYOUT_MODE = true;
const MANUAL_PAYOUT_METHOD = 'manual_upi';

function sellerIdFor(uid:string){ return `seller_${uid}`; }
function sanitizeSellerStatus(status:string){ return ['not_started','collecting_information','creating_account','created','pending_review','active','suspended','rejected','error','reconciliation_required'].includes(status) ? status : 'error'; }

function normalizeManualUpiId(value:string){
  const upi=String(value||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9._-]{1,127}@[a-z0-9.-]{2,63}$/.test(upi)) throw new Error('Enter a valid UPI ID, for example name@upi.');
  return upi;
}
function validateSellerInput(b:any){
  const email=String(b.email||'').trim().toLowerCase();
  const phone=String(b.phone||'').replace(/[^\d+]/g,'');
  const upiId=normalizeManualUpiId(String(b.upiId||b.upiHandle||''));
  const legalBusinessName=String(b.legalBusinessName||b.customerFacingBusinessName||'').trim();
  const customerFacingBusinessName=String(b.customerFacingBusinessName||legalBusinessName).trim();
  const contactName=String(b.contactName||customerFacingBusinessName||'').trim();
  const businessType=(String(b.businessType||'individual').trim() as RouteBusinessType);
  const category=String(b.category||'digital_goods').trim();
  const subcategory=String(b.subcategory||'digital_products').trim();
  const description=String(b.description||'Digital products sold through OFFSCRPT.').trim();
  const street1=String(b.street1||'').trim();
  const street2=String(b.street2||'').trim();
  const city=String(b.city||'').trim();
  const state=String(b.state||'').trim();
  const postalCode=String(b.postalCode||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  if(phone.replace(/\D/g,'').length<10 || phone.replace(/\D/g,'').length>15) throw new Error('Enter a valid mobile number.');
  if(legalBusinessName.length<2) throw new Error('Seller/display name is required.');
  if(customerFacingBusinessName.length<1) throw new Error('Customer-facing name is required.');
  if(!ROUTE_BUSINESS_TYPES.has(businessType)) throw new Error('Invalid business type.');
  return {email,phone,upiId,legalBusinessName,customerFacingBusinessName,contactName,businessType,category,subcategory,description,street1,street2,city,state,postalCode};
}

async function getSellerProfile(token:string,uid:string){
  const sellerId=sellerIdFor(uid);
  return fsGet(token,`creatorCommerceProfiles/${uid}`);
}

async function createSeller(token:string,uid:string,b:any){
  const input=validateSellerInput(b);
  const existing=await getSellerProfile(token,uid);
  if(existing){
    const currentUpi=String(existing.fields?.manualPayout?.upiId||existing.fields?.upiId||'');
    const currentEmail=String(existing.fields?.manualPayout?.email||existing.fields?.email||'');
    const currentPhone=String(existing.fields?.manualPayout?.mobile||existing.fields?.phone||'');
    if(currentUpi===input.upiId && currentEmail===input.email && currentPhone===input.phone && existing.fields?.sellerEnabled===true && String(existing.fields?.onboardingStatus||'')==='active'){
      return {seller:{id:sellerIdFor(uid),...existing.fields},reused:true};
    }
  }
  const started=nowIso();
  const sellerId=sellerIdFor(uid);
  const manualPayout={method:MANUAL_PAYOUT_METHOD,upiId:input.upiId,mobile:input.phone,email:input.email,updatedAt:started};
  const profile={creatorId:uid,sellerId,sellerEnabled:true,onboardingStatus:'active',health:'ready',
    payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD,manualPayout,
    email:input.email,phone:input.phone,upiId:input.upiId,legalBusinessName:input.legalBusinessName,
    customerFacingBusinessName:input.customerFacingBusinessName,businessType:input.businessType,
    category:input.category,subcategory:input.subcategory,description:input.description,
    address:(input.street1||input.city||input.state||input.postalCode)?{street1:input.street1,street2:input.street2,city:input.city,state:input.state,postalCode:input.postalCode,country:'IN'}:undefined,
    referenceId:sellerId.replace(/^seller_/,'').slice(0,20),createdAt:existing?.fields?.createdAt||started,updatedAt:started,
    razorpayAccountId:existing?.fields?.razorpayAccountId||null,razorpayAccountStatus:existing?.fields?.razorpayAccountStatus||'disabled_manual_mode'};
  if(existing){
    await fsPatch(token,`creatorCommerceProfiles/${uid}`,profile);
  } else {
    try{await fsCommit(token,[{create:{name:`${firestoreBase()}/creatorCommerceProfiles/${uid}`,fields:fields(profile)}}]);}
    catch(error:any){const raced=await getSellerProfile(token,uid);if(raced){await fsPatch(token,`creatorCommerceProfiles/${uid}`,profile);return {seller:{id:sellerId,creatorId:uid,...profile},reused:true};}throw error;}
  }
  const stamp=nowIso();
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${uid}:manual_payout_profile:${stamp}`)}`,fields:fields({actorId:uid,actorType:'creator',targetType:'seller',targetId:sellerId,event:'seller_manual_payout_profile_saved',timestamp:stamp,metadata:{payoutMethod:MANUAL_PAYOUT_METHOD,hasUpiId:Boolean(input.upiId),hasMobile:Boolean(input.phone),hasEmail:Boolean(input.email),routeDisabled:MANUAL_PAYOUT_MODE}})}}]);
  return {seller:{id:sellerId,creatorId:uid,...profile},message:'Manual payout details saved. OFFSCRPT receives customer payments directly; creator payouts are paid manually by admin.'};
}

async function getSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid);
  if(!seller)return {seller:{id:sellerIdFor(uid),creatorId:uid,sellerEnabled:false,onboardingStatus:'not_started',health:'not_started'}};
  return {seller:{id:sellerIdFor(uid),...seller.fields}};
}

async function refreshSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid);
  if(!seller) return getSeller(token,uid);
  const enabled=seller.fields?.sellerEnabled===true && String(seller.fields?.onboardingStatus||'')==='active';
  return {seller:{id:sellerIdFor(uid),...seller.fields,payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD,sellerEnabled:enabled,onboardingStatus:enabled?'active':String(seller.fields?.onboardingStatus||'created'),health:enabled?'ready':String(seller.fields?.health||'pending')},provider:{status:'manual_only',accountId:''}};
}

async function disableSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid); if(!seller) throw new Error('Seller profile not found.'); const stamp=nowIso();
  await fsPatch(token,`creatorCommerceProfiles/${uid}`,{sellerEnabled:false,onboardingStatus:'created',updatedAt:stamp,payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${uid}:disabled:${stamp}`)}`,fields:fields({actorId:uid,actorType:'creator',targetType:'seller',targetId:sellerIdFor(uid),event:'seller_disabled',timestamp:stamp,metadata:{payoutMode:'manual'}})}}]);
  return {seller:{id:sellerIdFor(uid),...seller.fields,sellerEnabled:false,onboardingStatus:'created',updatedAt:stamp,payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD}};
}

async function enableSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid); if(!seller) throw new Error('Seller profile not found.');
  const payout=seller.fields?.manualPayout||{};
  const upi=String(payout.upiId||seller.fields?.upiId||''); const mobile=String(payout.mobile||seller.fields?.phone||''); const email=String(payout.email||seller.fields?.email||'');
  if(!upi||!mobile||!email) throw new Error('Complete your UPI ID, mobile number and email before enabling selling.');
  normalizeManualUpiId(upi); if(mobile.replace(/\D/g,'').length<10) throw new Error('A valid mobile number is required before enabling selling.');
  const stamp=nowIso(); await fsPatch(token,`creatorCommerceProfiles/${uid}`,{sellerEnabled:true,onboardingStatus:'active',health:'ready',payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD,updatedAt:stamp});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${uid}:enabled_manual:${stamp}`)}`,fields:fields({actorId:uid,actorType:'creator',targetType:'seller',targetId:sellerIdFor(uid),event:'seller_enabled_manual_payout',timestamp:stamp,metadata:{payoutMethod:MANUAL_PAYOUT_METHOD}})}}]);
  return {seller:{id:sellerIdFor(uid),...seller.fields,sellerEnabled:true,onboardingStatus:'active',health:'ready',payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD,updatedAt:stamp}};
}

async function adminListSellers(token:string,uid:string,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const rows=await fsRunQuery(token,'creatorCommerceProfiles',[]);
  return {sellers:rows.map(x=>({id:String(x.name).split('/').pop(),...x.fields,payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD}))};
}

async function adminSetSellerStatus(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const creatorId=String(b.creatorId||'').trim(); const status=String(b.status||'').trim(); if(!creatorId||!['active','suspended','created'].includes(status)) throw new Error('Invalid seller status request.');
  const seller=await getSellerProfile(token,creatorId); if(!seller) throw new Error('Seller profile not found.');
  if(status==='active'){
    const payout=seller.fields?.manualPayout||{}; const upi=String(payout.upiId||seller.fields?.upiId||''); const mobile=String(payout.mobile||seller.fields?.phone||''); const emailValue=String(payout.email||seller.fields?.email||'');
    if(!upi||!mobile||!emailValue) throw new Error('Creator must provide UPI ID, mobile number and email before activation.'); normalizeManualUpiId(upi);
  }
  const enabled=status==='active'; const stamp=nowIso();
  await fsPatch(token,`creatorCommerceProfiles/${creatorId}`,{sellerEnabled:enabled,onboardingStatus:status==='suspended'?'suspended':(enabled?'active':'created'),health:status==='suspended'?'suspended':(enabled?'ready':'pending'),payoutMode:'manual',payoutMethod:MANUAL_PAYOUT_METHOD,updatedAt:stamp});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${creatorId}:${status}:${stamp}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'seller',targetId:sellerIdFor(creatorId),event:`seller_${status}`,timestamp:stamp,metadata:{payoutMode:'manual'}})}}]);
  return getSeller(token,creatorId);
}

function commissionRuleIdForDocument(name:string){ return String(name).split('/').pop() || ''; }

function normalizeRuleDocument(row:any):CommissionRule {
  const f=row?.fields||{};
  return {
    id:commissionRuleIdForDocument(row?.name||f.id||''),
    ruleId:String(f.ruleId||''),
    ruleVersion:Number(f.ruleVersion||1),
    scope:String(f.scope||'global') as CommissionRuleScope,
    productId:f.productId?String(f.productId):undefined,
    creatorId:f.creatorId?String(f.creatorId):undefined,
    percentage:Number(f.percentage||0),
    percentageBps:Number(f.percentageBps||0),
    fixedAmount:Number(f.fixedAmount||0),
    minimumAmount:f.minimumAmount===undefined?undefined:Number(f.minimumAmount),
    maximumAmount:f.maximumAmount===undefined?undefined:Number(f.maximumAmount),
    currency:String(f.currency||'INR').toUpperCase(),
    effectiveFrom:String(f.effectiveFrom||f.createdAt||''),
    effectiveUntil:f.effectiveUntil?String(f.effectiveUntil):undefined,
    active:Boolean(f.active),
    priority:Number(f.priority||0),
    refundPolicy:{proportional:f.refundPolicy?.proportional!==false},
    createdAt:String(f.createdAt||''),
    updatedAt:String(f.updatedAt||f.createdAt||'')
  };
}

async function listAllCommissionRules(token:string){
  const rows=await fsRunQueryAdvanced(token,'commerceCommissionRules',[],{orderBy:[{fieldPath:'updatedAt',direction:'DESCENDING'}],limit:300});
  return rows.map(normalizeRuleDocument);
}

function ruleApplies(rule:CommissionRule, productId:string, creatorId:string, atMs:number){
  if(!rule.active) return false;
  if(rule.currency!=='INR') return false;
  const from=Date.parse(rule.effectiveFrom); if(Number.isFinite(from) && atMs<from) return false;
  if(rule.effectiveUntil){const until=Date.parse(rule.effectiveUntil); if(Number.isFinite(until) && atMs>=until) return false;}
  if(rule.scope==='product') return rule.productId===productId;
  if(rule.scope==='creator') return rule.creatorId===creatorId;
  return rule.scope==='global';
}

async function resolveCommissionRule(token:string,productId:string,creatorId:string,atIso:string){
  const atMs=Date.parse(atIso); const rules=await listAllCommissionRules(token); const matches=rules.filter(r=>ruleApplies(r,productId,creatorId,atMs));
  matches.sort((a,b)=>{
    const rank=(r:CommissionRule)=>r.scope==='product'?3:r.scope==='creator'?2:1;
    return rank(b)-rank(a) || b.priority-a.priority || b.ruleVersion-a.ruleVersion || Date.parse(b.effectiveFrom)-Date.parse(a.effectiveFrom) || b.ruleId.localeCompare(a.ruleId);
  });
  return matches[0]||null;
}

function ruleInputFromBody(b:any):CommissionRuleInput {
  return {
    scope:String(b.scope||'global') as CommissionRuleScope,
    productId:b.productId?String(b.productId):undefined,
    creatorId:b.creatorId?String(b.creatorId):undefined,
    percentage:b.percentage===undefined||b.percentage===''?undefined:Number(b.percentage),
    fixedAmount:b.fixedAmount===undefined||b.fixedAmount===''?undefined:Number(b.fixedAmount),
    minimumAmount:b.minimumAmount===undefined||b.minimumAmount===''?undefined:Number(b.minimumAmount),
    maximumAmount:b.maximumAmount===undefined||b.maximumAmount===''?undefined:Number(b.maximumAmount),
    currency:String(b.currency||'INR').toUpperCase(),
    effectiveFrom:b.effectiveFrom?String(b.effectiveFrom):undefined,
    effectiveUntil:b.effectiveUntil?String(b.effectiveUntil):undefined,
    priority:b.priority===undefined||b.priority===''?0:Number(b.priority),
    active:b.active!==false,
    refundPolicy:{proportional:b.refundPolicy?.proportional!==false}
  };
}

async function createCommissionRule(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const input=ruleInputFromBody(b); const normalized=validateCommissionRuleInput(input); const ruleId=`rule_${crypto.randomUUID()}`; const now=nowIso();
  const rule={id:stableId('crule',`${ruleId}:1`),ruleId,ruleVersion:1,scope:input.scope,productId:input.productId,creatorId:input.creatorId,percentage:normalized.percentage,percentageBps:normalized.percentageBps,fixedAmount:normalized.fixedAmount,minimumAmount:normalized.minimumAmount,maximumAmount:normalized.maximumAmount,currency:normalized.currency,effectiveFrom:normalized.effectiveFrom,effectiveUntil:normalized.effectiveUntil,active:normalized.active,priority:normalized.priority,refundPolicy:normalized.refundPolicy,createdAt:now,updatedAt:now};
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceCommissionRules/${rule.id}`,fields:fields(rule)}}]);
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_rule_created:${rule.id}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'commission_rule',targetId:rule.ruleId,event:'commission_rule_created',timestamp:now,metadata:{ruleVersion:1,scope:rule.scope}})}}]);
  return {rule};
}

async function updateCommissionRule(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const ruleId=String(b.ruleId||'').trim(); if(!ruleId) throw new Error('ruleId is required.');
  const all=await listAllCommissionRules(token); const versions=all.filter(r=>r.ruleId===ruleId); if(!versions.length) throw new Error('Commission rule not found.');
  const current=versions.sort((a,b)=>b.ruleVersion-a.ruleVersion)[0]; const input=ruleInputFromBody(b); const normalized=validateCommissionRuleInput(input); const nextVersion=current.ruleVersion+1; const now=nowIso();
  const next={id:stableId('crule',`${ruleId}:${nextVersion}`),ruleId,ruleVersion:nextVersion,scope:input.scope,productId:input.productId,creatorId:input.creatorId,percentage:normalized.percentage,percentageBps:normalized.percentageBps,fixedAmount:normalized.fixedAmount,minimumAmount:normalized.minimumAmount,maximumAmount:normalized.maximumAmount,currency:normalized.currency,effectiveFrom:normalized.effectiveFrom,effectiveUntil:normalized.effectiveUntil,active:normalized.active,priority:normalized.priority,refundPolicy:normalized.refundPolicy,createdAt:now,updatedAt:now};
  const writes:any[]=[{create:{name:`${firestoreBase()}/commerceCommissionRules/${next.id}`,fields:fields(next)}}];
  const nextFrom=Date.parse(next.effectiveFrom);
  for(const r of versions.filter(r=>r.active)){
    const oldFrom=Date.parse(r.effectiveFrom);
    if(Number.isFinite(nextFrom) && Number.isFinite(oldFrom) && nextFrom>oldFrom && nextFrom>Date.now()){
      writes.push({update:{name:`${firestoreBase()}/commerceCommissionRules/${r.id}`,fields:fields({effectiveUntil:next.effectiveFrom,active:true,updatedAt:now})}});
    } else {
      writes.push({update:{name:`${firestoreBase()}/commerceCommissionRules/${r.id}`,fields:fields({active:false,updatedAt:now})}});
    }
  }
  await fsCommit(token,writes);
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_rule_updated:${ruleId}:${nextVersion}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'commission_rule',targetId:ruleId,event:'commission_rule_updated',timestamp:now,metadata:{fromVersion:current.ruleVersion,toVersion:nextVersion}})}}]);
  return {rule:next};
}

async function setCommissionRuleStatus(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const ruleId=String(b.ruleId||'').trim(); const active=Boolean(b.active); if(!ruleId) throw new Error('ruleId is required.');
  const all=await listAllCommissionRules(token); const versions=all.filter(r=>r.ruleId===ruleId); if(!versions.length) throw new Error('Commission rule not found.'); const current=versions.sort((a,b)=>b.ruleVersion-a.ruleVersion)[0];
  const now=nowIso();
  if(active){ for(const r of versions.filter(r=>r.active && r.id!==current.id)){ await fsPatch(token,`commerceCommissionRules/${r.id}`,{active:false,updatedAt:now}); } }
  await fsPatch(token,`commerceCommissionRules/${current.id}`,{active,updatedAt:now});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_rule_status:${ruleId}:${active}:${now}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'commission_rule',targetId:ruleId,event:active?'commission_rule_activated':'commission_rule_deactivated',timestamp:now,metadata:{ruleVersion:current.ruleVersion}})}}]);
  return {rule:{...current,active,updatedAt:now}};
}

async function simulateCommission(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const grossAmount=Number(b.grossAmount); if(!Number.isSafeInteger(grossAmount)||grossAmount<0) throw new Error('Gross amount must be a valid whole INR amount.');
  const atIso=b.at?String(b.at):nowIso(); let rule:CommissionRule|null=null;
  if(b.ruleId){ const all=await listAllCommissionRules(token); rule=all.filter(r=>r.ruleId===String(b.ruleId)).sort((a,b)=>b.ruleVersion-a.ruleVersion)[0]||null; if(!rule) throw new Error('Commission rule not found.'); }
  else { const input=ruleInputFromBody(b); const normalized=validateCommissionRuleInput(input); rule={id:'simulation',ruleId:'simulation',ruleVersion:1,scope:input.scope,productId:input.productId,creatorId:input.creatorId,percentage:normalized.percentage,percentageBps:normalized.percentageBps,fixedAmount:normalized.fixedAmount,minimumAmount:normalized.minimumAmount,maximumAmount:normalized.maximumAmount,currency:normalized.currency,effectiveFrom:normalized.effectiveFrom,effectiveUntil:normalized.effectiveUntil,active:true,priority:normalized.priority,refundPolicy:normalized.refundPolicy,createdAt:atIso,updatedAt:atIso}; }
  const result=calculateCommission(grossAmount,'INR',rule); return {generatedAt:nowIso(),rule,result};
}

async function getOrderFinancials(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  const orderId=String(b.orderId||'').trim(); if(!orderId) throw new Error('orderId is required.'); const order=await fsGet(token,`commerceOrders/${orderId}`); if(!order) throw new Error('Order not found.');
  const allowed=order.fields.customerId===uid || order.fields.creatorId===uid || await verifyCommerceAdmin(token,uid,email,emailVerified); if(!allowed){const e:any=new Error('Access denied.'); e.statusCode=403; throw e;}
  const allocation=await fsGet(token,`commerceFinancialAllocations/${stableId('fin',orderId)}`);
  const refunds=await fsRunQuery(token,'commerceRefunds',[{field:{fieldPath:'orderId'},op:'EQUAL',value:{stringValue:orderId}}]);
  return {order:{id:orderId,...order.fields},allocation:allocation?{id:stableId('fin',orderId),...allocation.fields}:undefined,refunds:refunds.map(r=>({id:String(r.name).split('/').pop(),...r.fields}))};
}

async function ensureFinancialAllocation(token:string,orderId:string, paymentId:string, options:{allowRecalculate?:boolean}={}){
  const order=await fsGet(token,`commerceOrders/${orderId}`); if(!order) throw new Error('Order not found.'); const existing=await fsGet(token,`commerceFinancialAllocations/${stableId('fin',orderId)}`);
  if(existing){
    const state=String(existing.fields.financialStatus||'');
    if(['calculated','adjusted','reversed','partially_reversed'].includes(state)) return {id:stableId('fin',orderId),...existing.fields};
    if(!options.allowRecalculate && !['pending','error','reconciliation_required'].includes(state)) return {id:stableId('fin',orderId),...existing.fields};
  }
  const item=Array.isArray(order.fields.items)?order.fields.items[0]:null; const productId=String(item?.productId||''); const priceId=String(item?.priceId||''); const creatorId=String(order.fields.creatorId||''); const gross=Number(order.fields.total||0); const currency=String(order.fields.currency||'INR').toUpperCase(); const atIso=String(order.fields.paidAt||nowIso()); const baseId=stableId('fin',orderId);
  if(!productId||!creatorId||!Number.isSafeInteger(gross)||gross<0||currency!=='INR'){
    const bad={allocationId:baseId,entryType:'sale',orderId,paymentId,creatorId,sellerId:'',razorpayAccountId:null,productId,priceId,grossAmount:gross,grossAmountSubunits:currency==='INR'&&Number.isSafeInteger(gross)?subunitsFromMajor(gross,currency):null,platformCommissionAmount:null,platformCommissionAmountSubunits:null,creatorNetAmount:null,creatorNetAmountSubunits:null,currency,commissionRuleId:null,commissionRuleVersion:null,financialStatus:'reconciliation_required',transferStatus:'not_started',lastError:'Missing or invalid canonical order financial inputs.',createdAt:existing?.fields.createdAt||nowIso(),updatedAt:nowIso()};
    if(existing) await fsPatch(token,`commerceFinancialAllocations/${baseId}`,bad); else {try{await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceFinancialAllocations/${baseId}`,fields:fields(bad)}}]);}catch{const again=await fsGet(token,`commerceFinancialAllocations/${baseId}`); if(again)return {id:baseId,...again.fields}; throw new Error(bad.lastError);}}
    return {id:baseId,...bad};
  }
  const seller=await getSellerProfile(token,creatorId); const sellerId=String(seller?.fields?.sellerId||sellerIdFor(creatorId)); const accountId=MANUAL_PAYOUT_MODE ? '' : String(seller?.fields?.razorpayAccountId||'');
  const rule=await resolveCommissionRule(token,productId,creatorId,atIso);
  if(!seller||(!MANUAL_PAYOUT_MODE&&!accountId)||!rule){
    const reason=!seller?'Seller profile missing.':((!MANUAL_PAYOUT_MODE&&!accountId)?'Razorpay seller account mapping missing.':'No applicable commission rule is configured for this transaction.');
    const pending={allocationId:baseId,entryType:'sale',orderId,paymentId,creatorId,sellerId,razorpayAccountId:accountId||null,productId,priceId,grossAmount:gross,grossAmountSubunits:subunitsFromMajor(gross,currency),platformCommissionAmount:null,platformCommissionAmountSubunits:null,creatorNetAmount:null,creatorNetAmountSubunits:null,currency,commissionRuleId:null,commissionRuleVersion:null,financialStatus:'reconciliation_required',transferStatus:'not_started',lastError:reason,createdAt:existing?.fields.createdAt||nowIso(),updatedAt:nowIso()};
    if(existing) await fsPatch(token,`commerceFinancialAllocations/${baseId}`,pending); else {try{await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceFinancialAllocations/${baseId}`,fields:fields(pending)}}]);}catch{const again=await fsGet(token,`commerceFinancialAllocations/${baseId}`); if(again)return {id:baseId,...again.fields};}}
    await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_reconciliation:${orderId}`)}`,fields:fields({actorId:creatorId,actorType:'system',targetType:'financial_allocation',targetId:baseId,event:'commission_reconciliation_required',timestamp:nowIso(),metadata:{reason}})}}]).catch(()=>{});
    return {id:baseId,...pending};
  }
  const calc=calculateCommission(gross,currency,rule); const now=nowIso();
  const allocation={allocationId:baseId,entryType:'sale',orderId,paymentId,creatorId,sellerId,razorpayAccountId:accountId,productId,priceId,grossAmount:gross,grossAmountSubunits:calc.grossAmountSubunits,platformCommissionAmount:calc.platformCommissionAmount,platformCommissionAmountSubunits:calc.platformCommissionAmountSubunits,creatorNetAmount:calc.creatorNetAmount,creatorNetAmountSubunits:calc.creatorNetAmountSubunits,currency,commissionRuleId:rule.ruleId,commissionRuleVersion:rule.ruleVersion,commissionSnapshot:{ruleId:rule.ruleId,ruleVersion:rule.ruleVersion,ruleType:rule.percentageBps>0&&rule.fixedAmount>0?'percentage_plus_fixed':rule.fixedAmount>0?'fixed':'percentage',percentage:rule.percentage,percentageBps:rule.percentageBps,fixedAmount:rule.fixedAmount,effectiveFrom:rule.effectiveFrom,grossAmountSubunits:calc.grossAmountSubunits,commissionAmountSubunits:calc.platformCommissionAmountSubunits,creatorNetAmountSubunits:calc.creatorNetAmountSubunits,currency,calculatedAt:now},financialStatus:'calculated',transferStatus:'not_started',settlementMode:MANUAL_PAYOUT_MODE?'platform_manual_creator_repayment':'razorpay_route',createdAt:existing?.fields.createdAt||now,updatedAt:now};
  if(existing) await fsPatch(token,`commerceFinancialAllocations/${baseId}`,allocation); else {try{await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceFinancialAllocations/${baseId}`,fields:fields(allocation)}}]);}catch{const again=await fsGet(token,`commerceFinancialAllocations/${baseId}`); if(again)return {id:baseId,...again.fields};}}
  const ledgerId=stableId('rev',orderId);
  const ledger={platformFee:calc.platformCommissionAmount,netCreatorAmount:calc.creatorNetAmount,commissionStatus:'calculated',commissionRuleId:rule.ruleId,commissionRuleVersion:rule.ruleVersion,grossAmountSubunits:calc.grossAmountSubunits,platformCommissionAmountSubunits:calc.platformCommissionAmountSubunits,netCreatorAmountSubunits:calc.creatorNetAmountSubunits,financialAllocationId:baseId,razorpayAccountId:accountId,updatedAt:now};
  try {
    await fsPatch(token,`creatorRevenue/${ledgerId}`,ledger);
  } catch {
    await fsCommit(token,[{create:{name:`${firestoreBase()}/creatorRevenue/${ledgerId}`,fields:fields({creatorId,orderId,transactionId:paymentId,gross,discounts:Number(order.fields.discount||0),tax:Number(order.fields.tax||0),paymentFees:0,platformFee:calc.platformCommissionAmount,refundAmount:0,netCreatorAmount:calc.creatorNetAmount,type:'sale',status:'posted',currency,financialAllocationId:baseId,commissionStatus:'calculated',commissionRuleId:rule.ruleId,commissionRuleVersion:rule.ruleVersion,grossAmountSubunits:calc.grossAmountSubunits,platformCommissionAmountSubunits:calc.platformCommissionAmountSubunits,netCreatorAmountSubunits:calc.creatorNetAmountSubunits,razorpayAccountId:accountId,createdAt:now,updatedAt:now})}}]).catch(()=>{});
  }
  return {id:baseId,...allocation};
}

async function safeEnsureFinancialAllocation(token:string,orderId:string,paymentId:string){
  try { const allocation=await ensureFinancialAllocation(token,orderId,paymentId); await ensureSaleLedgerCredit(token,allocation); return allocation; }
  catch(error:any) {
    const allocationId=stableId('fin',orderId); const now=nowIso(); const fallback={allocationId,entryType:'sale',orderId,paymentId,financialStatus:'reconciliation_required',transferStatus:'not_started',lastError:String(error?.message||'Financial allocation failed.').slice(0,500),createdAt:now,updatedAt:now};
    const existing=await fsGet(token,`commerceFinancialAllocations/${allocationId}`).catch(()=>null);
    if(existing) await fsPatch(token,`commerceFinancialAllocations/${allocationId}`,fallback).catch(()=>{}); else await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceFinancialAllocations/${allocationId}`,fields:fields(fallback)}}]).catch(()=>{});
    await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_error:${orderId}:${now}`)}`,fields:fields({actorId:'system',actorType:'system',targetType:'financial_allocation',targetId:allocationId,event:'commission_error',timestamp:now,metadata:{message:fallback.lastError}})}}]).catch(()=>{});
    return fallback;
  }
}


async function ensureSaleLedgerCredit(token:string,allocation:any){ return v94MaterializeSaleCredit(token,allocation); }

async function processRefundWebhook(token:string,eventType:string,refundEntity:any,eventId:string){
  const refundId=String(refundEntity?.id||''); const providerPaymentId=String(refundEntity?.payment_id||''); const providerStatus=String(refundEntity?.status||'pending').toLowerCase(); const amountSubunits=Number(refundEntity?.amount||0); if(!refundId||!providerPaymentId||!Number.isSafeInteger(amountSubunits)||amountSubunits<=0) return {ignored:'invalid_refund_payload'};
  const payments=await fsRunQuery(token,'commercePayments',[{field:{fieldPath:'razorpayPaymentId'},op:'EQUAL',value:{stringValue:providerPaymentId}}]); const payment=payments[0]; if(!payment) return {ignored:'payment_not_found'}; const orderId=String(payment.fields.orderId||''); const order=orderId?await fsGet(token,`commerceOrders/${orderId}`):null; if(!order) return {ignored:'order_not_found'};
  const providerRefund=eventType==='refund.processed'?await razorpayProvider.fetchRefund(refundId):refundEntity;
  if(String(providerRefund?.payment_id||providerPaymentId)!==providerPaymentId) throw new Error('Razorpay refund/payment linkage is invalid.');
  const canonicalCurrency=String(order.fields.currency||'INR').toUpperCase(); const canonicalGrossSubunits=subunitsFromMajor(Number(order.fields.total||0),canonicalCurrency);
  const providerAmount=Number(providerRefund?.amount??amountSubunits); if(!Number.isSafeInteger(providerAmount)||providerAmount<=0||providerAmount>canonicalGrossSubunits) throw new Error('Razorpay refund amount exceeds canonical order amount.');
  if(providerRefund?.currency && String(providerRefund.currency).trim() && String(providerRefund.currency).toUpperCase()!==canonicalCurrency) throw new Error('Razorpay refund currency mismatch.');
  const existing=await fsGet(token,`commerceRefunds/${stableId('refund',refundId)}`); const now=nowIso();
  const refundDoc={refundId,orderId,paymentId:String(payment.name).split('/').pop()!,provider:'razorpay',razorpayPaymentId:providerPaymentId,razorpayRefundId:refundId,amount:majorFromSubunits(providerAmount),amountSubunits:providerAmount,currency:canonicalCurrency,status:providerStatus,eventType,lastProviderEventId:eventId,createdAt:existing?.fields?.createdAt||now,updatedAt:now};
  if(existing) await fsPatch(token,`commerceRefunds/${stableId('refund',refundId)}`,refundDoc); else {try{await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceRefunds/${stableId('refund',refundId)}`,fields:fields(refundDoc)}}]);}catch{}}
  if(providerStatus!=='processed' || (eventType!=='refund.processed' && providerStatus!=='processed')) return {refund:refundDoc};
  const allocation=await safeEnsureFinancialAllocation(token,orderId,String(payment.name).split('/').pop()!);
  if(allocation.financialStatus!=='calculated') { await fsPatch(token,`commerceRefunds/${stableId('refund',refundId)}`,{financialStatus:'reconciliation_required',updatedAt:now}); return {refund:refundDoc,financialStatus:'reconciliation_required'}; }
  const reversals=await fsRunQuery(token,'commerceFinancialAllocations',[{field:{fieldPath:'originalAllocationId'},op:'EQUAL',value:{stringValue:allocation.allocationId}}]);
  const existingRefunded=(await fsRunQuery(token,'commerceRefunds',[{field:{fieldPath:'paymentId'},op:'EQUAL',value:{stringValue:String(payment.name).split('/').pop()!}}])).filter(r=>String(r.fields.status||'').toLowerCase()==='processed').reduce((n,r)=>n+Number(r.fields.amountSubunits||0),0);
  if(existingRefunded>canonicalGrossSubunits) throw new Error('Cumulative refunds exceed the canonical order amount.');
  const previousCommissionReversed=reversals.reduce((n,r)=>n+Math.abs(Number(r.fields.platformCommissionAmountSubunits||0)),0);
  const previousCreatorReversed=reversals.reduce((n,r)=>n+Math.abs(Number(r.fields.creatorNetAmountSubunits||0)),0);
  const cumulativeIsFull=existingRefunded===canonicalGrossSubunits;
  let reversal=calculateProportionalReversal(providerAmount,Number(allocation.grossAmountSubunits),Number(allocation.platformCommissionAmountSubunits));
  if(cumulativeIsFull){ reversal={commissionReversalSubunits:Math.max(0,Number(allocation.platformCommissionAmountSubunits)-previousCommissionReversed),creatorReversalSubunits:Math.max(0,Number(allocation.creatorNetAmountSubunits)-previousCreatorReversed)}; }
  const reversalId=stableId('finrev',refundId); const reversalExisting=await fsGet(token,`commerceFinancialAllocations/${reversalId}`);
  if(!reversalExisting){ const reversalEntry={allocationId:reversalId,entryType:'refund_reversal',originalAllocationId:allocation.allocationId,refundId,orderId,paymentId:String(payment.name).split('/').pop()!,creatorId:String(allocation.creatorId||''),sellerId:String(allocation.sellerId||''),razorpayAccountId:allocation.razorpayAccountId||null,productId:String(allocation.productId||''),priceId:String(allocation.priceId||''),grossAmount:-majorFromSubunits(providerAmount),grossAmountSubunits:-providerAmount,platformCommissionAmount:-majorFromSubunits(reversal.commissionReversalSubunits),platformCommissionAmountSubunits:-reversal.commissionReversalSubunits,creatorNetAmount:-majorFromSubunits(reversal.creatorReversalSubunits),creatorNetAmountSubunits:-reversal.creatorReversalSubunits,currency:canonicalCurrency,financialStatus:cumulativeIsFull?'reversed':'partially_reversed',transferStatus:'not_started',createdAt:now,updatedAt:now}; try{await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceFinancialAllocations/${reversalId}`,fields:fields(reversalEntry)}}]);}catch{}}
  await v94CreateRefundLedgerEntry(token,allocation,refundId,Number(reversal.creatorReversalSubunits));
  const totalRefunded=existingRefunded; const orderRefundStatus=totalRefunded===canonicalGrossSubunits?'refunded':'partially_refunded'; const paymentIdLocal=String(payment.name).split('/').pop()!;
  await fsPatch(token,`commercePayments/${paymentIdLocal}`,{refundStatus:orderRefundStatus,refundAmount:majorFromSubunits(totalRefunded),updatedAt:now}); await fsPatch(token,`commerceOrders/${orderId}`,{status:orderRefundStatus,refundedAt:totalRefunded===canonicalGrossSubunits?now:undefined,refundAmount:majorFromSubunits(totalRefunded),updatedAt:now});
  await fsPatch(token,`commerceRefunds/${stableId('refund',refundId)}`,{financialStatus:cumulativeIsFull?'reversed':'partially_reversed',commissionReversalAmount:majorFromSubunits(reversal.commissionReversalSubunits),creatorReversalAmount:majorFromSubunits(reversal.creatorReversalSubunits),financialReversalId:reversalId,updatedAt:now});
  await fsPatch(token,`creatorRevenue/${stableId('rev',orderId)}`,{refundAmount:majorFromSubunits(totalRefunded),refundedCreatorAmount:majorFromSubunits(previousCreatorReversed+reversal.creatorReversalSubunits),refundedPlatformCommissionAmount:majorFromSubunits(previousCommissionReversed+reversal.commissionReversalSubunits),commissionStatus:cumulativeIsFull?'reversed':'partially_reversed',updatedAt:now}).catch(()=>{});
  return {refund:refundDoc,financialReversalId:reversalId};
}

async function getCreatorEarnings(token:string,uid:string){
  const rows=await fsRunQueryAdvanced(token,'commerceFinancialAllocations',[fsFilter('creatorId','EQUAL',{stringValue:uid})],{limit:300});
  let grossSalesSubunits=0,platformCommissionSubunits=0,netEarningsSubunits=0,refundedGrossSubunits=0,reversedCommissionSubunits=0,reversedCreatorSubunits=0;
  for(const row of rows){ const f=row.fields||{}; const gross=Math.abs(Number(f.grossAmountSubunits||0)); const commission=Math.abs(Number(f.platformCommissionAmountSubunits||0)); const creator=Math.abs(Number(f.creatorNetAmountSubunits||0)); if(f.entryType==='refund_reversal'){refundedGrossSubunits+=gross;reversedCommissionSubunits+=commission;reversedCreatorSubunits+=creator;} else if(f.entryType==='sale' && f.financialStatus==='calculated'){grossSalesSubunits+=gross;platformCommissionSubunits+=commission;netEarningsSubunits+=creator;} }
  netEarningsSubunits=Math.max(0,netEarningsSubunits-reversedCreatorSubunits);
  return {creatorId:uid,currency:'INR',grossSales:majorFromSubunits(grossSalesSubunits),platformCommission:majorFromSubunits(platformCommissionSubunits),netEarnings:majorFromSubunits(netEarningsSubunits),refundedGross:majorFromSubunits(refundedGrossSubunits),reversedCommission:majorFromSubunits(reversedCommissionSubunits),reversedCreatorAmount:majorFromSubunits(reversedCreatorSubunits),grossSalesSubunits,platformCommissionSubunits,netEarningsSubunits,refundedGrossSubunits,reversedCommissionSubunits,reversedCreatorSubunits,generatedAt:nowIso()};
}

async function adminFinancialSummary(token:string,uid:string,b:any={},email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const range=String(b?.range||'all'); const now=Date.now(); let fromMs=0; if(range==='today'){const d=new Date(now); d.setUTCHours(0,0,0,0); fromMs=d.getTime();} else if(range==='7d') fromMs=now-7*86400000; else if(range==='30d') fromMs=now-30*86400000;
  const rows=await fsRunQueryAdvanced(token,'commerceFinancialAllocations',[fsFilter('entryType','EQUAL',{stringValue:'sale'})],{limit:300}); let gross=0,commission=0,creatorSales=0,creatorReversed=0,errors=0;
  for(const row of rows){const f=row.fields||{}; const created=Date.parse(String(f.createdAt||'')); if(fromMs && (!Number.isFinite(created)||created<fromMs)) continue; if(f.financialStatus==='calculated'){gross+=Number(f.grossAmountSubunits||0);commission+=Number(f.platformCommissionAmountSubunits||0);creatorSales+=Number(f.creatorNetAmountSubunits||0);} else errors+=1;}
  const refundRows=await fsRunQueryAdvanced(token,'commerceRefunds',[fsFilter('status','EQUAL',{stringValue:'processed'})],{limit:300}); const refunds=refundRows.filter(r=>{const created=Date.parse(String(r.fields.createdAt||''));return !fromMs || (Number.isFinite(created)&&created>=fromMs);}).reduce((n,r)=>n+Number(r.fields.amountSubunits||0),0);
  const reversalRows=await fsRunQueryAdvanced(token,'commerceFinancialAllocations',[fsFilter('entryType','EQUAL',{stringValue:'refund_reversal'})],{limit:300}); for(const row of reversalRows){const f=row.fields||{}; const created=Date.parse(String(f.createdAt||'')); if(fromMs && (!Number.isFinite(created)||created<fromMs)) continue; creatorReversed+=Math.abs(Number(f.creatorNetAmountSubunits||0));}
  return {currency:'INR',range,grossSales:majorFromSubunits(gross),platformCommission:majorFromSubunits(commission),creatorNet:majorFromSubunits(Math.max(0,creatorSales-creatorReversed)),refundedAmount:majorFromSubunits(refunds),financialErrors:errors,generatedAt:nowIso()};
}

async function reconcileCommission(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const orderId=String(b.orderId||'').trim(); if(!orderId) throw new Error('orderId is required.'); const order=await fsGet(token,`commerceOrders/${orderId}`); if(!order) throw new Error('Order not found.');
  const paymentId=String(order.fields.paymentId||''); if(!paymentId) throw new Error('Order payment linkage is missing.');
  const allocation=await ensureFinancialAllocation(token,orderId,paymentId,{allowRecalculate:true});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_reconciled:${orderId}:${nowIso()}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'financial_allocation',targetId:allocation.allocationId,event:'commission_recalculated',timestamp:nowIso(),metadata:{financialStatus:allocation.financialStatus}})}}]);
  return {allocation};
}

async function finalizeVerifiedRazorpayPayment(token:string,orderId:string,paymentId:string,uid?:string,eventKey?:string,providerEvent?:string){
  const order=await fsGet(token,`commerceOrders/${orderId}`);
  if(!order) throw new Error('Order not found.');
  if(uid && order.fields.customerId!==uid) throw new Error('Order ownership check failed.');
  let internalPaymentId=String(order.fields.paymentId||'');
  let payment=internalPaymentId?await fsGet(token,`commercePayments/${internalPaymentId}`):null;
  // Backward compatibility: early V90 orders could be missing paymentId linkage.
  if(!payment){
    const candidates=await fsRunQuery(token,'commercePayments',[{field:{fieldPath:'orderId'},op:'EQUAL',value:{stringValue:orderId}}]);
    const matched=candidates.find(x=>String(x.fields.customerId||'')===String(order.fields.customerId||''))||candidates[0];
    if(matched){
      internalPaymentId=String(matched.name).split('/').pop()||'';
      payment=matched;
    }
  }
  if(!internalPaymentId || !payment || payment.fields.customerId!==order.fields.customerId || payment.fields.orderId!==orderId) throw new Error('Payment linkage is invalid.');
  if(String(payment.fields.provider||'')!=='razorpay' || String(payment.fields.razorpayOrderId||'')!==String(order.fields.razorpayOrderId||'')) throw new Error('Provider linkage is invalid.');
  if(order.fields.status==='paid'){
    const eid=Array.isArray(order.fields.entitlementIds)?String(order.fields.entitlementIds[0]||''):''; const ent=eid?await fsGet(token,`entitlements/${eid}`):null;
    const allocation=await safeEnsureFinancialAllocation(token,orderId,internalPaymentId);
    return {order:{id:orderId,...order.fields},payment:{id:internalPaymentId,...payment.fields},entitlement:ent?{id:eid,...ent.fields}:undefined,financialAllocation:allocation};
  }
  const providerPayment=await verifyCapturedPayment(order,paymentId);
  const item=Array.isArray(order.fields.items)?order.fields.items[0]:null; if(!item?.productId)throw new Error('Order item is invalid.');
  const entitlementId=stableId('ent',orderId), ledgerId=stableId('rev',orderId), auditId=stableId('audit',`${orderId}:${paymentId}:paid`);
  const now=nowIso();
  const ent={userId:String(order.fields.customerId),sourceType:'purchase',sourceId:orderId,resourceType:'product',resourceId:String(item.productId),status:'active',grantedAt:now,startsAt:now,orderId};
  const gross=Number(order.fields.total||0);
  const revenue={creatorId:String(order.fields.creatorId||''),orderId,transactionId:String(paymentId),gross,discounts:Number(order.fields.discount||0),tax:Number(order.fields.tax||0),paymentFees:0,platformFee:0,refundAmount:0,netCreatorAmount:gross,type:'sale',status:'posted',currency:String(order.fields.currency||'INR'),createdAt:now};
  const eventDocId=eventKey?stableId('rp_evt',eventKey):stableId('rp_evt',`${orderId}:${paymentId}`);
  const audit={actorId:String(order.fields.customerId),actorType:'customer',targetType:'order',targetId:orderId,event:'paymentPaid',timestamp:now,metadata:{provider:'razorpay',providerPaymentId:String(paymentId),providerEvent:String(providerEvent||'')}};
  const writes:any[]=[
    {update:{name:`${firestoreBase()}/commercePayments/${internalPaymentId}`,fields:fields({status:'paid',provider:'razorpay',razorpayPaymentId:String(paymentId),razorpayPaymentStatus:String(providerPayment?.status||'captured'),paidAt:now,verifiedAt:now,updatedAt:now,testMode:String(process.env.RAZORPAY_ENVIRONMENT||'').toLowerCase()!=='production'})}},
    {update:{name:`${firestoreBase()}/commerceOrders/${orderId}`,fields:fields({status:'paid',paymentId:internalPaymentId,entitlementIds:[entitlementId],paidAt:now,updatedAt:now,metadata:{...(order.fields.metadata||{}),paymentProvider:'razorpay'}})}},
    {create:{name:`${firestoreBase()}/entitlements/${entitlementId}`,fields:fields(ent)}},
    {create:{name:`${firestoreBase()}/creatorRevenue/${ledgerId}`,fields:fields(revenue)}},
    {create:{name:`${firestoreBase()}/commerceWebhookEvents/${eventDocId}`,fields:fields({event:'razorpay.payment.succeeded',orderId,paymentId:String(paymentId),entitlementId,providerEventId:String(eventKey||''),createdAt:now})}},
    {create:{name:`${firestoreBase()}/commerceAuditLogs/${auditId}`,fields:fields(audit)}}
  ];
  try{ await fsCommit(token,writes); } catch(err:any){
    const refreshed=await fsGet(token,`commerceOrders/${orderId}`);
    if(refreshed?.fields?.status==='paid'){
      const eid=Array.isArray(refreshed.fields.entitlementIds)?String(refreshed.fields.entitlementIds[0]||''):''; const ent2=eid?await fsGet(token,`entitlements/${eid}`):null;
      const pay2=await fsGet(token,`commercePayments/${internalPaymentId}`);
      const financialAllocation=await safeEnsureFinancialAllocation(token,orderId,internalPaymentId);
      return {order:{id:orderId,...refreshed.fields},payment:{id:internalPaymentId,...(pay2?.fields||{})},entitlement:ent2?{id:eid,...ent2.fields}:undefined,financialAllocation};
    }
    throw err;
  }
  const finalOrder=await fsGet(token,`commerceOrders/${orderId}`),finalPayment=await fsGet(token,`commercePayments/${internalPaymentId}`),finalEnt=await fsGet(token,`entitlements/${entitlementId}`);
  const financialAllocation=await safeEnsureFinancialAllocation(token,orderId,internalPaymentId);
  return {order:{id:orderId,...(finalOrder?.fields||order.fields)},payment:{id:internalPaymentId,...(finalPayment?.fields||payment.fields)},entitlement:{id:entitlementId,...(finalEnt?.fields||ent)},financialAllocation};
}

async function createCheckout(token:string,uid:string,b:any){
  if(!isRazorpayConfigured()) { const err:any=new Error('Razorpay payment configuration is not ready.'); err.statusCode=503; throw err; }
  const product=await fsGet(token,`commerceProducts/${String(b.productId||'')}`);
  const price=await fsGet(token,`commercePrices/${String(b.priceId||'')}`);
  if(!product||!price)throw new Error('Product or price not found.');
  if(product.fields.status!=='active' || product.fields.visibility!=='public')throw new Error('Product is not available.'); if(String(product.fields.moderationStatus||'active')!=='active' || String(product.fields.trustState||'active')==='restricted')throw new Error('Product is not available for purchase.');
  if(price.fields.productId!==product.name.split('/').pop())throw new Error('Price does not belong to product.');
  if(String(price.fields.currency||'').toUpperCase()!==String(product.fields.currency||'').toUpperCase())throw new Error('Price currency does not match product currency.');
  if(price.fields.active!==true)throw new Error('Price is inactive.');
  if(String(price.fields.billingType||'one_time')!=='one_time')throw new Error('Recurring products are not supported by V90 one-time checkout.');
  const amount=Number(price.fields.amount),currency=String(price.fields.currency||product.fields.currency||'INR').toUpperCase();
  razorpayProvider.amountSubunit(amount,currency);
  const seller=await getSellerProfile(token,String(product.fields.creatorId||''));
  if(!seller?.fields?.sellerEnabled || String(seller.fields.onboardingStatus||'')!=='active') throw new Error('This creator is not currently enabled for marketplace selling.');
  const payoutDetails=seller.fields?.manualPayout||{}; if(!String(payoutDetails.upiId||seller.fields?.upiId||'')||!String(payoutDetails.mobile||seller.fields?.phone||'')||!String(payoutDetails.email||seller.fields?.email||'')) throw new Error('This creator has incomplete manual payout details.');
  const ownership=await fsRunQuery(token,'entitlements',[{field:{fieldPath:'userId'},op:'EQUAL',value:{stringValue:uid}},{field:{fieldPath:'resourceType'},op:'EQUAL',value:{stringValue:product.name.split('/').pop()}}]);
  if(ownership.some(x=>x.fields.status==='active')) throw new Error('You already own this product.');
  const key=String(b.idempotencyKey||'').trim(); if(key.length<8||key.length>200)throw new Error('Valid idempotencyKey is required.');
  const idem=idempotencyId(uid,key), idemName=`commerceIdempotency/${idem}`, idemDoc=await fsGet(token,idemName);
  if(idemDoc){
    const orderId=String(idemDoc.fields.orderId||''),paymentId=String(idemDoc.fields.paymentId||''); const order=orderId?await fsGet(token,`commerceOrders/${orderId}`):null; const payment=paymentId?await fsGet(token,`commercePayments/${paymentId}`):null;
    if(order&&payment) return {order:{id:orderId,...order.fields},payment:{id:paymentId,...payment.fields},entitlement:undefined};
  }
  const orderId=crypto.randomUUID(),paymentId=crypto.randomUUID();
  const title=String(product.fields.title||'Untitled'), productId=product.name.split('/').pop()!, priceId=price.name.split('/').pop()!;
  const item={productId,priceId,quantity:1,unitAmount:amount,lineTotal:amount,title,type:String(product.fields.type||'digital_product')};
  const createdAt=nowIso();
  const order:any={customerId:uid,creatorId:String(product.fields.creatorId||''),items:[item],subtotal:amount,discount:0,tax:0,fees:0,total:amount,currency,status:'pending_payment',paymentId,createdAt,updatedAt:createdAt,provider:'razorpay',metadata:{paymentProvider:'razorpay',checkoutIdempotencyKey:key,settlementMode:'platform_manual_creator_repayment',payoutMethod:MANUAL_PAYOUT_METHOD}};
  const payment={orderId,customerId:uid,amount,currency,status:'pending',provider:'razorpay',testMode:String(process.env.RAZORPAY_ENVIRONMENT||'').toLowerCase()!=='production',createdAt,updatedAt:createdAt};
  const providerOrder=await razorpayProvider.request('/orders',{method:'POST',body:JSON.stringify({amount:razorpayProvider.amountSubunit(amount,currency),currency,receipt:`OFF_${orderId.slice(0,30)}`,notes:{offscrptOrderId:orderId,offscrptProductId:productId}})});
  const razorpayOrderId=String(providerOrder?.id||''); if(!razorpayOrderId)throw new Error('Razorpay did not return an order ID.');
  order.razorpayOrderId=razorpayOrderId; order.metadata={...order.metadata,razorpayOrderId};
  (payment as any).razorpayOrderId=razorpayOrderId;
  await fsCommit(token,[
    {create:{name:`${firestoreBase()}/commerceOrders/${orderId}`,fields:fields(order)}},
    {create:{name:`${firestoreBase()}/commercePayments/${paymentId}`,fields:fields(payment)}},
    {create:{name:`${firestoreBase()}/${idemName}`,fields:fields({userId:uid,orderId,paymentId,razorpayOrderId,createdAt})}}
  ]);
  return {order:{id:orderId,...order},payment:{id:paymentId,...payment},checkout:{keyId:String(razorpayProvider.config().keyId),razorpayOrderId,orderId,amount:razorpayProvider.amountSubunit(amount,currency),currency,name:'OFFSCRPT',description:title,prefill:{email:String((await fsGet(token,`users/${uid}`))?.fields?.email||'')}}};
}

async function confirmRazorpayPayment(token:string,uid:string,b:any){
  if(!isRazorpayConfigured()) { const err:any=new Error('Razorpay payment configuration is not ready.'); err.statusCode=503; throw err; }
  const orderId=String(b.orderId||''), paymentId=String(b.razorpayPaymentId||b.paymentId||''), razorpayOrderId=String(b.razorpayOrderId||''), signature=String(b.razorpaySignature||'');
  if(!orderId||!paymentId||!razorpayOrderId||!signature)throw new Error('Payment verification data is incomplete.');
  const order=await fsGet(token,`commerceOrders/${orderId}`); if(!order||order.fields.customerId!==uid)throw new Error('Order not found.');
  if(String(order.fields.razorpayOrderId||order.fields.metadata?.razorpayOrderId||'')!==razorpayOrderId)throw new Error('Razorpay order mismatch.');
  if(!razorpayProvider.verifyPaymentSignature(razorpayOrderId,paymentId,signature))throw new Error('Razorpay payment signature verification failed.');
  const providerPayment=await verifyCapturedPayment(order,paymentId);
  return finalizeVerifiedRazorpayPayment(token,orderId,paymentId,uid,undefined,'handler.payment.succeeded');
}


async function getRazorpayPaymentStatus(token:string,uid:string,b:any){
  if(!isRazorpayConfigured()) { const err:any=new Error('Razorpay payment configuration is not ready.'); err.statusCode=503; throw err; }
  const orderId=String(b.orderId||''); if(!orderId)throw new Error('Order ID is required.');
  const order=await fsGet(token,`commerceOrders/${orderId}`);
  if(!order||order.fields.customerId!==uid)throw new Error('Order not found.');
  const providerOrderId=String(order.fields.razorpayOrderId||order.fields.metadata?.razorpayOrderId||'');
  if(!providerOrderId)throw new Error('Razorpay order reference is missing.');
  const providerOrder=await razorpayProvider.fetchOrder(providerOrderId);
  const expected=razorpayProvider.amountSubunit(Number(order.fields.total||0),String(order.fields.currency||'INR'));
  if(Number(providerOrder?.amount)!==expected || String(providerOrder?.currency||'').toUpperCase()!==String(order.fields.currency||'INR').toUpperCase()) throw new Error('Razorpay order integrity check failed.');
  return {order:{id:orderId,...order.fields},provider:{orderId:providerOrderId,status:String(providerOrder?.status||'unknown'),amount:Number(providerOrder?.amount||0),currency:String(providerOrder?.currency||'')}};
}

async function handleRazorpayWebhook(req:any,res:any){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  if(!String(process.env.RAZORPAY_WEBHOOK_SECRET||'')) return res.status(503).json({error:'Razorpay webhook is not configured.'});
  const raw=String(req.rawBody||''); if(!raw) return res.status(400).json({error:'Raw webhook body is required.'});
  const signature=String(req.headers['x-razorpay-signature']||'');
  if(!razorpayProvider.verifyWebhookSignature(raw,signature)) return res.status(401).json({error:'Invalid webhook signature.'});
  let payload:any; try{payload=JSON.parse(raw);}catch{return res.status(400).json({error:'Invalid webhook payload.'});}
  const eventId=String(req.headers['x-razorpay-event-id']||payload?.id||crypto.createHash('sha256').update(raw).digest('hex'));
  const eventType=String(payload?.event||'');
  const token=await serviceToken();
  if(!eventType)return res.status(200).json({received:true});
  const paymentEntity=payload?.payload?.payment?.entity||payload?.payload?.payment?.entity;
  const paymentId=String(paymentEntity?.id||'');
  const razorpayOrderId=String(paymentEntity?.order_id||'');
  if(eventType==='payment.captured' && paymentId && razorpayOrderId){
    const orders=await fsRunQuery(token,'commerceOrders',[{field:{fieldPath:'razorpayOrderId'},op:'EQUAL',value:{stringValue:razorpayOrderId}}]);
    const order=orders[0];
    if(!order)return res.status(200).json({received:true,ignored:'order_not_found'});
    const existing=await fsGet(token,`commerceWebhookEvents/${stableId('rp_evt',eventId)}`);
    if(existing)return res.status(200).json({received:true,duplicate:true});
    await finalizeVerifiedRazorpayPayment(token,String(order.name).split('/').pop()!,paymentId,undefined,eventId,eventType);
  } else if(eventType==='payment.failed' || eventType==='order.paid'){
    const eventDocId=stableId('rp_evt',eventId);
    const existing=await fsGet(token,`commerceWebhookEvents/${eventDocId}`);
    if(!existing) await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceWebhookEvents/${eventDocId}`,fields:fields({event:eventType,providerEventId:eventId,status:'received',createdAt:nowIso()})}}]);
  } else if(['refund.created','refund.processed','refund.failed','refund.reversed','refund.speed_changed'].includes(eventType)){
    const eventDocId=stableId('rp_evt',eventId);
    const existing=await fsGet(token,`commerceWebhookEvents/${eventDocId}`);
    if(existing) return res.status(200).json({received:true,duplicate:true});
    const refundEntity=payload?.payload?.refund?.entity;
    try{
      await processRefundWebhook(token,eventType,refundEntity,eventId);
      await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceWebhookEvents/${eventDocId}`,fields:fields({event:eventType,providerEventId:eventId,status:'processed',createdAt:nowIso()})}}]);
    }catch(error:any){
      await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceWebhookEvents/${eventDocId}`,fields:fields({event:eventType,providerEventId:eventId,status:'error',error:String(error?.message||'Refund processing failed.').slice(0,300),createdAt:nowIso()})}}]).catch(()=>{});
      throw error;
    }
  }
  return res.status(200).json({received:true});
}


async function handleRazorpayRouteWebhook(req:any,res:any){
  if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
  const raw=await readRawBody(req);
  const signature=String(req.headers['x-razorpay-signature']||'');
  if(!verifyRouteWebhook(raw,signature)) return res.status(401).json({error:'Invalid Route webhook signature.'});
  let payload:any={}; try{payload=raw?JSON.parse(raw):{};}catch{return res.status(400).json({error:'Invalid webhook payload.'});}
  const token=await serviceToken();
  const eventId=String(req.headers['x-razorpay-event-id']||payload?.id||crypto.createHash('sha256').update(raw).digest('hex'));
  const eventType=String(payload?.event||'');
  const eventDocId=stableId('rp_route_evt',eventId);
  if(!eventType) return res.status(200).json({received:true});
  const existing=await fsGet(token,`commerceWebhookEvents/${eventDocId}`);
  if(existing) return res.status(200).json({received:true,duplicate:true});
  const transfer=payload?.payload?.transfer?.entity;
  const accountId=String(payload?.account_id||transfer?.recipient||'');
  if(['transfer.processed','transfer.failed','transfer.reversed','transfer.partially_reversed'].includes(eventType)){
    await handleRouteTransferWebhookPayout(token,eventType,transfer,eventId);
  }
  if(accountId){
    const sellers=await fsRunQuery(token,'creatorCommerceProfiles',[{field:{fieldPath:'razorpayAccountId'},op:'EQUAL',value:{stringValue:accountId}}]);
    if(sellers[0]){
      const creatorId=String(sellers[0].fields.creatorId||String(sellers[0].name).split('/').pop());
      await fsPatch(token,`creatorCommerceProfiles/${creatorId}`,{lastRouteEvent:eventType,lastRouteEventAt:nowIso(),lastTransferId:String(transfer?.id||''),lastTransferStatus:String(transfer?.status||transfer?.transfer_status||''),lastSettlementId:String(transfer?.recipient_settlement_id||'')});
    }
  }
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceWebhookEvents/${eventDocId}`,fields:fields({event:eventType,provider:'razorpay_route',providerEventId:eventId,accountId,createdAt:nowIso(),status:'processed',metadata:{transferId:String(transfer?.id||''),status:String(transfer?.status||transfer?.transfer_status||'')}})}}]);
  return res.status(200).json({received:true});
}



// ========================= V96 TRUST / MODERATION / REVIEWS =========================
const V96_REVIEW_STATUSES = new Set(['pending','published','flagged','under_review','hidden','rejected','removed']);
const V96_REVIEW_MODERATION = new Set(['none','queued','under_review','approved','rejected','removed']);
const V96_REPORT_STATUSES = new Set(['submitted','queued','under_review','resolved','dismissed']);
const V96_CASE_STATUSES = new Set(['open','queued','under_review','resolved','escalated','dismissed']);
const V96_PRIORITIES = new Set(['low','normal','high','critical']);
const V96_REPORT_REASONS = new Set(['spam','harassment','hate_or_abusive_content','misleading','fake_review','copyright','prohibited_content','fraud_concern','duplicate_content','other']);
const V96_MODERATION_REASONS = new Set(['policy_violation','spam','harassment','fraud_concern','fake_review','copyright','prohibited_content','misleading_content','duplicate','other','fake_purchase']);
const V96_PUBLIC_SORTS = new Set(['recent','highest','lowest','verified']);
const V96_MAX_REVIEW_TITLE = 120;
const V96_MAX_REVIEW_BODY = 5000;
const V96_MAX_REPORT_BODY = 1200;
const V96_MAX_MODERATION_NOTE = 3000;
const V96_DAILY_REPORT_LIMIT = 25;
const V96_DAILY_REVIEW_LIMIT = 20;

function v96Id(prefix:string, source:string){return stableId(prefix,source);}
function v96Text(v:any,max:number){return String(v||'').trim().slice(0,max);}
function v96Now(){return nowIso();}
function v96Error(message:string,status=400,code?:string){const e:any=new Error(message); e.statusCode=status; if(code)e.code=code; return e;}
function v96Fields(row:any){return row?.fields||{};}
function v96DocId(row:any){return String(row?.id||row?.name||'').split('/').pop()||'';}
function v96TargetType(v:any){const t=String(v||'').trim(); if(!['review','product','creator','order'].includes(t))throw v96Error('Invalid moderation target type.'); return t;}
function v96CleanReviewPublic(row:any){const f=v96Fields(row); return {id:v96DocId(row),productId:String(f.productId||''),creatorId:String(f.creatorId||''),reviewerDisplayName:String(f.reviewerDisplayName||'OFFSCRPT user'),reviewerAvatar:String(f.reviewerAvatar||''),rating:Number(f.rating||0),title:String(f.title||''),body:String(f.body||''),verifiedPurchase:f.verifiedPurchase===true,createdAt:f.createdAt,updatedAt:f.updatedAt,publishedAt:f.publishedAt};}
function v96ReviewContribution(f:any){return {count:1,total:Number(f.rating||0),verified:f.verifiedPurchase===true};}
function v96AggregateFromReviews(rows:any[]){let count=0,total=0,verified=0,dist=[0,0,0,0,0]; for(const row of rows){const f=v96Fields(row); if(!v96ReviewIsPublic(f))continue; const rating=Number(f.rating||0); count++; total+=rating; verified+=f.verifiedPurchase===true?1:0; dist[rating-1]++;} return {reviewCount:count,ratingTotal:total,averageRating:count?Number((total/count).toFixed(2)):0,rating1Count:dist[0],rating2Count:dist[1],rating3Count:dist[2],rating4Count:dist[3],rating5Count:dist[4],verifiedReviewCount:verified};}
function v96AggregateDelta(prev:any,next:any){
  const d:any={reviewCount:0,ratingTotal:0,verifiedReviewCount:0,rating1Count:0,rating2Count:0,rating3Count:0,rating4Count:0,rating5Count:0};
  const apply=(f:any,sign:number)=>{if(!f)return; const rating=Math.max(1,Math.min(5,Number(f.rating||0))); d.reviewCount+=sign; d.ratingTotal+=sign*rating; d.verifiedReviewCount+=sign*(f.verifiedPurchase===true?1:0); d[`rating${rating}Count`]+=sign;};
  apply(prev,-1); apply(next,1); return d;
}

function v96ReviewIsPublic(f:any){return String(f.status||'')==='published' && String(f.moderationStatus||'')==='approved';}
function v96ValidReviewTransition(from:string,to:string){const map:any={pending:['published','rejected','removed'],published:['flagged','hidden','removed'],flagged:['under_review','hidden','removed'],under_review:['published','hidden','removed','rejected'],hidden:['published','removed'],rejected:['pending','removed'],removed:['hidden','published']}; return (map[from]||[]).includes(to);}
function v96ValidCaseTransition(from:string,to:string){const map:any={open:['queued','under_review','escalated','dismissed','resolved'],queued:['under_review','escalated','dismissed','resolved'],under_review:['resolved','dismissed','escalated'],escalated:['under_review','resolved','dismissed'],resolved:['under_review','escalated'],dismissed:['under_review','escalated']}; return (map[from]||[]).includes(to);}
function v96ValidReportTransition(from:string,to:string){const map:any={submitted:['queued','under_review','resolved','dismissed'],queued:['under_review','resolved','dismissed'],under_review:['resolved','dismissed'],resolved:['under_review'],dismissed:['under_review']}; return (map[from]||[]).includes(to);}
function v96Reason(reason:string,set:Set<string>,fallback='other'){return set.has(reason)?reason:fallback;}
function v96PublicTargetSafe(targetType:string,target:any){const f=v96Fields(target); if(targetType==='product') return {id:v96DocId(target),title:v96Text(f.title,160),creatorId:String(f.creatorId||''),status:String(f.status||''),visibility:String(f.visibility||'')}; if(targetType==='creator') return {id:v96DocId(target),username:String(f.username||''),displayName:String(f.displayName||''),creatorStatus:Boolean(f.creatorStatus||f.isAuthor)}; if(targetType==='order') return {id:v96DocId(target),status:String(f.status||''),customerId:String(f.customerId||'')}; return v96CleanReviewPublic(target);}
function v96AdminTargetSafe(targetType:string,target:any){const f=v96Fields(target); if(targetType==='review') return {id:v96DocId(target),productId:String(f.productId||''),creatorId:String(f.creatorId||''),reviewerId:String(f.reviewerId||''),orderId:String(f.orderId||''),orderItemId:String(f.orderItemId||''),rating:Number(f.rating||0),status:String(f.status||''),moderationStatus:String(f.moderationStatus||''),verifiedPurchase:f.verifiedPurchase===true,reportCount:Number(f.reportCount||0),createdAt:f.createdAt,updatedAt:f.updatedAt,publishedAt:f.publishedAt,editedAt:f.editedAt,removedAt:f.removedAt,version:Number(f.version||1)}; if(targetType==='product') return {id:v96DocId(target),title:v96Text(f.title,160),creatorId:String(f.creatorId||''),status:String(f.status||''),visibility:String(f.visibility||''),moderationStatus:String(f.moderationStatus||'active'),trustState:String(f.trustState||'active'),updatedAt:f.updatedAt}; if(targetType==='creator') return {id:v96DocId(target),username:String(f.username||''),displayName:String(f.displayName||''),creatorStatus:Boolean(f.creatorStatus||f.isAuthor),trustStatus:String(f.trustStatus||'new'),creatorId:String(f.creatorId||v96DocId(target)),updatedAt:f.updatedAt}; if(targetType==='order') return {id:v96DocId(target),status:String(f.status||''),customerId:String(f.customerId||''),items:Array.isArray(f.items)?f.items:[],paymentId:String(f.paymentId||''),paidAt:f.paidAt,createdAt:f.createdAt}; return v96PublicTargetSafe(targetType,target);}

async function v96VerifyModerationRole(token:string,uid:string,permission='view',email?:string,emailVerified?:boolean){
  if(await verifyCommerceAdmin(token,uid,email,emailVerified)) return {role:'master_admin',permissions:['*']};
  const moderator=await fsGet(token,`siteModerators/${uid}`);
  if(!moderator || moderator.fields?.enabled===false) throw v96Error('Moderation access required.',403,'FORBIDDEN');
  const rawPermissions=moderator.fields?.permissions;
  const permissions=Array.isArray(rawPermissions)?rawPermissions.map(String):Object.entries(rawPermissions||{}).filter(([,enabled])=>enabled===true).map(([key])=>String(key));
  const allowed=permissions.includes('*')||permissions.includes(permission)||permissions.includes('moderation:all')||permissions.includes('moderation:admin');
  if(!allowed) throw v96Error('You are not authorized for this moderation action.',403,'FORBIDDEN');
  return {role:String(moderator.fields?.role||'moderator'),permissions};
}
async function v96VerifyAssignee(token:string,assigneeId:string){
  if(!assigneeId) return null;
  const admin=await fsGet(token,`masterAdmins/${assigneeId}`); if(admin && admin.fields?.enabled!==false)return {id:assigneeId,role:'master_admin'};
  const user=await fsGet(token,`users/${assigneeId}`); if(user?.fields?.platformRole==='master_admin')return {id:assigneeId,role:'master_admin'};
  const mod=await fsGet(token,`siteModerators/${assigneeId}`); if(mod && mod.fields?.enabled!==false)return {id:assigneeId,role:String(mod.fields?.role||'moderator')};
  throw v96Error('Assignee is not an authorized moderator.',400,'INVALID_ARGUMENT');
}
async function v96GetProduct(token:string,productId:string){const p=await fsGet(token,`commerceProducts/${productId}`); if(!p)throw v96Error('Product not found.',404,'NOT_FOUND'); return p;}
async function v96GetCreator(token:string,creatorId:string){const p=await fsGet(token,`users/${creatorId}`); if(!p)throw v96Error('Creator not found.',404,'NOT_FOUND'); return p;}
async function v96GetCreatorAdminTarget(token:string,creatorId:string){const user=await v96GetCreator(token,creatorId); const profile=await fsGet(token,`creatorCommerceProfiles/${creatorId}`); const userFields=user.fields||{}; const profileFields=profile?.fields||{}; return {name:user.name,fields:{...userFields,...profileFields,creatorId}};}
async function v96GetOrder(token:string,orderId:string){const p=await fsGet(token,`commerceOrders/${orderId}`); if(!p)throw v96Error('Order not found.',404,'NOT_FOUND'); return p;}
async function v96GetReview(token:string,reviewId:string){const r=await fsGet(token,`commerceReviews/${reviewId}`); if(!r)throw v96Error('Review not found.',404,'NOT_FOUND'); return r;}
async function v96GetAggregate(token:string,productId:string){const existing=await fsGet(token,`commerceReviewAggregates/${productId}`); return existing || {name:`${firestoreBase()}/commerceReviewAggregates/${productId}`,fields:{productId,reviewCount:0,ratingTotal:0,averageRating:0,rating1Count:0,rating2Count:0,rating3Count:0,rating4Count:0,rating5Count:0,verifiedReviewCount:0},updateTime:undefined};}
function v96AggregateNext(cur:any,delta:any){
  const totalBase=Number.isSafeInteger(Number(cur.ratingTotal))?Number(cur.ratingTotal):Math.round(Number(cur.averageRating||0)*Number(cur.reviewCount||0));
  const next:any={reviewCount:Number(cur.reviewCount||0)+Number(delta.reviewCount||0),ratingTotal:totalBase+Number(delta.ratingTotal||0),rating1Count:Number(cur.rating1Count||0)+Number(delta.rating1Count||0),rating2Count:Number(cur.rating2Count||0)+Number(delta.rating2Count||0),rating3Count:Number(cur.rating3Count||0)+Number(delta.rating3Count||0),rating4Count:Number(cur.rating4Count||0)+Number(delta.rating4Count||0),rating5Count:Number(cur.rating5Count||0)+Number(delta.rating5Count||0),verifiedReviewCount:Number(cur.verifiedReviewCount||0)+Number(delta.verifiedReviewCount||0)};
  for(const k of ['reviewCount','ratingTotal','rating1Count','rating2Count','rating3Count','rating4Count','rating5Count','verifiedReviewCount']) if(!Number.isSafeInteger(next[k])||next[k]<0) throw v96Error(`Review aggregate integrity conflict on ${k}.`,409,'AGGREGATE_CONFLICT');
  next.averageRating=next.reviewCount?Number((next.ratingTotal/next.reviewCount).toFixed(2)):0;
  return next;
}

async function v96UpsertAggregate(token:string,productId:string,delta:any,requestId:string){const existing=await v96GetAggregate(token,productId); const next={...v96AggregateNext(existing.fields||{},delta),productId,updatedAt:v96Now(),lastRequestId:requestId}; const path=`commerceReviewAggregates/${productId}`; if(existing.updateTime)await fsPatch(token,path,next); else await fsCreate(token,path,next); return next;}
function v96AuditWrite(doc:any){return {create:{name:`${firestoreBase()}/commerceAuditLogs/${v96Id('audit',String(doc.requestId||`${doc.action}:${doc.targetType}:${doc.targetId}:${doc.timestamp}`))}`,fields:fields({actorId:String(doc.actorId||''),actorType:String(doc.actorRole||'system'),targetType:String(doc.targetType||''),targetId:String(doc.targetId||''),event:String(doc.action||'v96_moderation'),timestamp:String(doc.timestamp||v96Now()),metadata:{previousState:doc.previousState,newState:doc.newState,reasonCode:doc.reasonCode,caseId:doc.caseId,notes:doc.notes,requestId:doc.requestId}})}};}
async function v96CommitReviewMutation(token:string,review:any,nextReview:any,delta:any,actionDoc:any,requestId:string,extraWrites:any[]=[],extraPreconditions:Record<string,string>={}){
  const productId=String(nextReview.productId||review.fields?.productId||''); const writes:any[]=[{update:{name:`${firestoreBase()}/commerceReviews/${v96DocId(review)}`,fields:fields(nextReview)}},{create:{name:`${firestoreBase()}/commerceModerationActions/${v96Id('action',requestId)}`,fields:fields(actionDoc)}},v96AuditWrite(actionDoc),...extraWrites]; const pre:any={...extraPreconditions}; const agg=delta && (delta.reviewCount||delta.ratingTotal||delta.verifiedReviewCount||delta.rating1Count||delta.rating2Count||delta.rating3Count||delta.rating4Count||delta.rating5Count)?await v96GetAggregate(token,productId):null; if(agg){const nextAgg={...v96AggregateNext(agg.fields||{},delta),productId,updatedAt:v96Now(),lastRequestId:requestId}; if(agg.updateTime){writes.splice(1,0,{update:{name:`${firestoreBase()}/commerceReviewAggregates/${productId}`,fields:fields(nextAgg)}}); pre[`commerceReviewAggregates/${productId}`]=agg.updateTime;}else{writes.splice(1,0,{create:{name:`${firestoreBase()}/commerceReviewAggregates/${productId}`,fields:fields(nextAgg)}});} } pre[`commerceReviews/${v96DocId(review)}`]=review.updateTime; await fsCommitWithPrecondition(token,writes,pre); return {review:nextReview,aggregate:agg?v96AggregateNext(agg.fields||{},delta):undefined};}

async function v96RebuildAggregateData(token:string,productId:string){
  const reviews=(await fsRunQueryAllUnordered(token,'commerceReviews',[fsFilter('productId','EQUAL',{stringValue:productId})],500))
    .sort((a,b)=>String(v96Fields(a).createdAt||'').localeCompare(String(v96Fields(b).createdAt||'')) || v96DocId(a).localeCompare(v96DocId(b)));
  return v96AggregateFromReviews(reviews);
}
async function v96Eligibility(token:string,uid:string,productId:string){
  if(!uid)throw v96Error('Authentication required.',401,'UNAUTHENTICATED');
  const product=await v96GetProduct(token,productId); if(String(product.fields.status||'')!=='active' || String(product.fields.visibility||'')!=='public' || String(product.fields.moderationStatus||'active')!=='active')return {eligible:false,reason:'PRODUCT_NOT_ELIGIBLE'};
  if(String(product.fields.creatorId||'')===uid)return {eligible:false,reason:'SELF_REVIEW_NOT_ALLOWED'};
  const orders=(await fsRunQueryAllUnordered(token,'commerceOrders',[fsFilter('customerId','EQUAL',{stringValue:uid})],500))
    .sort((a,b)=>String(b.fields?.createdAt||'').localeCompare(String(a.fields?.createdAt||'')) || String(b.name||'').localeCompare(String(a.name||'')));
  for(const row of orders){const f=v96Fields(row); if(!['paid','partially_refunded','refunded'].includes(String(f.status||'')))continue; const items=Array.isArray(f.items)?f.items:[]; for(let i=0;i<items.length;i++){if(String(items[i]?.productId||'')!==productId)continue; const orderItemId=`${v96DocId(row)}:${i}`; const reviewId=v96Id('review',`${uid}:${orderItemId}`); const existing=await fsGet(token,`commerceReviews/${reviewId}`); if(existing)return {eligible:false,reason:'ALREADY_REVIEWED',orderId:v96DocId(row),orderItemId,reviewId,existing:v96CleanReviewPublic(existing)}; return {eligible:true,reason:'ELIGIBLE',orderId:v96DocId(row),orderItemId,reviewId}; }}
  return {eligible:false,reason:'PURCHASE_REQUIRED'};
}
async function v96CreateReview(token:string,uid:string,b:any){
  const productId=v96Text(b.productId,200); if(!productId)throw v96Error('Product is required.');
  const product=await v96GetProduct(token,productId); const pf=v96Fields(product);
  if(String(pf.status||'')!=='active'||String(pf.visibility||'')!=='public'||String(pf.moderationStatus||'active')!=='active')throw v96Error('This product is not currently reviewable.');
  if(String(pf.creatorId||'')===uid)throw v96Error('Creators cannot review their own products.');
  const eligibility=await v96Eligibility(token,uid,productId);
  if(!eligibility.eligible)throw v96Error(eligibility.reason==='ALREADY_REVIEWED'?'This purchase already has a review.':eligibility.reason==='PURCHASE_REQUIRED'?'A verified purchase is required to review this product.':'This purchase is not currently eligible for review.');
  const rating=Number(b.rating); if(!Number.isInteger(rating)||rating<1||rating>5)throw v96Error('Rating must be an integer from 1 to 5.');
  const title=v96Text(b.title,V96_MAX_REVIEW_TITLE); const body=v96Text(b.body,V96_MAX_REVIEW_BODY); if(!body)throw v96Error('Review text is required.');
  const today=new Date().toISOString().slice(0,10); const recentReviews=await fsRunQueryAllUnordered(token,'commerceReviews',[fsFilter('reviewerId','EQUAL',{stringValue:uid})],500); const reviewsToday=recentReviews.filter(row=>String(row.fields?.createdAt||'').slice(0,10)===today).length; if(reviewsToday>=V96_DAILY_REVIEW_LIMIT) throw v96Error('Daily review limit reached. Try again tomorrow.',429,'RATE_LIMITED');
  const profile=await fsGet(token,`users/${uid}`); const pfUser=profile?.fields||{}; const now=v96Now(); const reviewId=String(eligibility.reviewId||''); if(!reviewId)throw v96Error('Review identity could not be established.',500,'REVIEW_ID_ERROR');
  const requestId=v96Text(b.requestId||b.idempotencyKey||reviewId,200);
  const existing=await fsGet(token,`commerceReviews/${reviewId}`);
  if(existing){if(String(existing.fields?.reviewerId||'')!==uid||String(existing.fields?.productId||'')!==productId)throw v96Error('Review already exists for another identity.',409,'CONFLICT'); return {review:v96CleanReviewPublic(existing),verifiedPurchase:existing.fields?.verifiedPurchase===true,status:String(existing.fields?.status||'pending'),idempotent:true};}
  const caseId=v96Id('case',`review:${reviewId}`); const actionId=v96Id('action',`review_created:${reviewId}:${requestId}`);
  const review={id:reviewId,productId,creatorId:String(pf.creatorId||''),reviewerId:uid,orderId:String(eligibility.orderId||''),orderItemId:String(eligibility.orderItemId||''),rating,title,body,verifiedPurchase:true,status:'pending',moderationStatus:'queued',reportCount:0,reviewerDisplayName:v96Text(pfUser.displayName||pfUser.name||pfUser.username||'OFFSCRPT user',120),reviewerAvatar:v96Text(pfUser.avatarUrl||pfUser.photoURL||'',500),createdAt:now,updatedAt:now,version:1,requestId};
  const caseDoc={id:caseId,targetType:'review',targetId:reviewId,reportIds:[],priority:'normal',status:'queued',createdAt:now,updatedAt:now,source:'review_submission'};
  const actionDoc={action:'review_created',targetType:'review',targetId:reviewId,actorId:uid,actorRole:'buyer',previousState:null,newState:'pending',reasonCode:'other',notes:'',requestId,timestamp:now};
  await fsCommitWithPrecondition(token,[{create:{name:`${firestoreBase()}/commerceReviews/${reviewId}`,fields:fields(review)}},{create:{name:`${firestoreBase()}/commerceModerationCases/${caseId}`,fields:fields(caseDoc)}},{create:{name:`${firestoreBase()}/commerceModerationActions/${actionId}`,fields:fields(actionDoc)}},v96AuditWrite(actionDoc)],{[`commerceReviews/${reviewId}`]:'',[`commerceModerationCases/${caseId}`]:''});
  return {review:v96CleanReviewPublic({name:`commerceReviews/${reviewId}`,fields:review}),verifiedPurchase:true,status:'pending'};
}

async function v96UpdateReview(token:string,uid:string,b:any){
  const requestedId=v96Text(b.requestId,200); if(requestedId){const replay=await fsGet(token,`commerceModerationActions/${v96Id('action',requestedId)}`); if(replay)return {idempotent:true,review:v96CleanReviewPublic(await v96GetReview(token,String(b.reviewId||'')))};}
  const review=await v96GetReview(token,String(b.reviewId||'')); const f=v96Fields(review);
  if(String(f.reviewerId||'')!==uid)throw v96Error('You do not own this review.',403,'FORBIDDEN');
  if(!['pending','published'].includes(String(f.status||'')))throw v96Error('This review cannot be edited in its current state.',409,'CONFLICT');
  const title=v96Text(b.title,V96_MAX_REVIEW_TITLE), body=v96Text(b.body,V96_MAX_REVIEW_BODY), rating=Number(b.rating);
  if(!Number.isInteger(rating)||rating<1||rating>5)throw v96Error('Rating must be an integer from 1 to 5.');
  if(!body)throw v96Error('Review text is required.');
  const now=v96Now(), wasPublic=v96ReviewIsPublic(f), next={...f,title,body,rating,status:'pending',moderationStatus:'queued',updatedAt:now,editedAt:now,version:Number(f.version||1)+1};
  const delta=v96AggregateDelta(wasPublic?f:null,null); const reqId=v96Text(b.requestId,200)||v96Id('req',`${review.name}:${now}`);
  const actionDoc={action:'review_edited',targetType:'review',targetId:v96DocId(review),actorId:uid,actorRole:'buyer',previousState:f.status,newState:'pending',reasonCode:'other',notes:'',requestId:reqId,timestamp:now};
  const caseId=v96Id('case',`review:${v96DocId(review)}`); const caseRow=await fsGet(token,`commerceModerationCases/${caseId}`);
  const caseNext=caseRow?{...caseRow.fields,status:'queued',updatedAt:now,resolutionCode:null,resolvedAt:null,resolvedBy:null}:{id:caseId,targetType:'review',targetId:v96DocId(review),reportIds:[],priority:'normal',status:'queued',createdAt:now,updatedAt:now,source:'review_edit'};
  await v96CommitReviewMutation(token,review,next,delta,actionDoc,reqId,
    [caseRow?{update:{name:`${firestoreBase()}/commerceModerationCases/${caseId}`,fields:fields(caseNext)}}:{create:{name:`${firestoreBase()}/commerceModerationCases/${caseId}`,fields:fields(caseNext)}}],
    caseRow?{[`commerceModerationCases/${caseId}`]:caseRow.updateTime}:{[`commerceModerationCases/${caseId}`]:''});
  return {review:v96CleanReviewPublic({fields:next,name:review.name}),status:'pending'};
}

async function v96RemoveOwnReview(token:string,uid:string,b:any){
  const requestedId=v96Text(b.requestId,200); if(requestedId){const replay=await fsGet(token,`commerceModerationActions/${v96Id('action',requestedId)}`); if(replay)return {removed:true,idempotent:true};}
  const review=await v96GetReview(token,String(b.reviewId||'')); const f=v96Fields(review); if(String(f.reviewerId||'')!==uid)throw v96Error('You do not own this review.',403,'FORBIDDEN'); if(String(f.status||'')==='removed')return {removed:true}; const wasPublic=v96ReviewIsPublic(f); const now=v96Now(); const next={...f,status:'removed',moderationStatus:'removed',removedAt:now,updatedAt:now,version:Number(f.version||1)+1}; const reqId=String(b.requestId||v96Id('req',`${review.name}:remove:${uid}`)); const actionDoc={action:'review_removed_by_owner',targetType:'review',targetId:v96DocId(review),actorId:uid,actorRole:'buyer',previousState:f.status,newState:'removed',reasonCode:'other',notes:'',requestId:reqId,timestamp:now}; await v96CommitReviewMutation(token,review,next,wasPublic?v96AggregateDelta(f,null):null,actionDoc,reqId); return {removed:true};
}
async function v96ListPublicReviews(token:string,productId:string,params:any){
  const product=await v96GetProduct(token,productId);
  if(String(product.fields.status||'')!=='active'||String(product.fields.visibility||'')!=='public'||String(product.fields.moderationStatus||'active')!=='active')return {reviews:[],nextCursor:null,aggregate:await v96GetAggregate(token,productId)};
  const sort=v96Text(params.sort,'recent'); const normalized=V96_PUBLIC_SORTS.has(sort)?sort:'recent'; const limitCount=Math.max(1,Math.min(50,Number(params.limit||20)));
  // Deliberately avoid composite-index-dependent ordering here. The browser was
  // previously failing with FAILED_PRECONDITION for productId+status+createdAt.
  // Query only the equality fields (which use Firestore single-field indexes), then
  // apply the public moderation filter, stable sorting, and cursor slicing in the
  // server. This keeps public product pages functional even before indexes are deployed.
  const rows=await fsRunQueryAllUnordered(token,'commerceReviews',[fsFilter('productId','EQUAL',{stringValue:productId})],500);
  const publicRows=rows.filter(r=>v96ReviewIsPublic(v96Fields(r)));
  publicRows.sort((a,b)=>{
    const af=v96Fields(a), bf=v96Fields(b);
    if(normalized==='highest'){const d=Number(bf.rating||0)-Number(af.rating||0); if(d) return d;}
    if(normalized==='lowest'){const d=Number(af.rating||0)-Number(bf.rating||0); if(d) return d;}
    if(normalized==='verified'){const d=Number(Boolean(bf.verifiedPurchase))-Number(Boolean(af.verifiedPurchase)); if(d) return d;}
    const d=String(bf.createdAt||'').localeCompare(String(af.createdAt||''));
    return d || v96DocId(b).localeCompare(v96DocId(a));
  });
  const cursor=decodeV96QueryCursor(params.cursor);
  let startIndex=0;
  if(cursor){
    const cursorId=cursor.values?.find((v:any)=>v?.referenceValue)?.referenceValue;
    const id=cursorId?String(cursorId).split('/').pop():'';
    const idx=publicRows.findIndex(r=>v96DocId(r)===id);
    if(idx>=0) startIndex=idx+1;
  }
  const page=publicRows.slice(startIndex,startIndex+limitCount);
  const hasMore=startIndex+limitCount<publicRows.length;
  const next=hasMore&&page.length?encodeV96QueryCursor(page[page.length-1],[{fieldPath:'createdAt',direction:'DESCENDING'},{fieldPath:'__name__',direction:'DESCENDING'}]):null;
  return {reviews:page.map(v96CleanReviewPublic),nextCursor:next,aggregate:await v96GetAggregate(token,productId)};
}

async function v96MyReviews(token:string,uid:string,b:any){
  const limitCount=Math.max(1,Math.min(50,Number(b.limit||20))); const requestedProduct=v96Text(b.productId,200);
  // Deliberately avoid reviewerId/productId/updatedAt composite requirements.
  // The equality-only query is sorted and optionally filtered on the server.
  const rows=(await fsRunQueryAllUnordered(token,'commerceReviews',[fsFilter('reviewerId','EQUAL',{stringValue:uid})],500))
    .sort((a,b)=>String(b.fields?.updatedAt||b.fields?.createdAt||'').localeCompare(String(a.fields?.updatedAt||a.fields?.createdAt||'')) || String(b.name||'').localeCompare(String(a.name||'')));
  const filtered=requestedProduct?rows.filter(r=>String(r.fields?.productId||'')===requestedProduct):rows;
  return {reviews:filtered.slice(0,limitCount).map(v96CleanReviewPublic)};
}
async function v96GetReviewAggregate(token:string,productId:string){const product=await v96GetProduct(token,productId); if(String(product.fields.status||'')!=='active'||String(product.fields.visibility||'')!=='public'||String(product.fields.moderationStatus||'active')!=='active')throw v96Error('Product not publicly available.',404,'NOT_FOUND'); return {productId,...v96Fields(await v96GetAggregate(token,productId))};}
async function v96GetTrustSignals(token:string,productId:string,creatorId?:string){
  const product=await v96GetProduct(token,productId); if(String(product.fields.status||'')!=='active'||String(product.fields.visibility||'')!=='public'||String(product.fields.moderationStatus||'active')!=='active')throw v96Error('Product not publicly available.',404,'NOT_FOUND');
  const pf=v96Fields(product), cid=creatorId||String(pf.creatorId||''), seller=cid?await fsGet(token,`creatorCommerceProfiles/${cid}`):null, agg=await v96GetAggregate(token,productId), af=v96Fields(agg);
  const sellerStatus=String(seller?.fields?.onboardingStatus||'not_started'), sellerEnabled=seller?.fields?.sellerEnabled!==false, operational=sellerEnabled&&sellerStatus==='active', raw=String(seller?.fields?.trustStatus||'new'), publicTrust=operational&&raw==='trusted'?'trusted':operational?'active':'new';
  return {productId,creatorId:cid,sellerStatus:operational?'active':'not_public',trustStatus:publicTrust,productPublished:true,verifiedReviewCount:Number(af.verifiedReviewCount||0),reviewCount:Number(af.reviewCount||0),averageRating:Number(af.averageRating||0),trustedSeller:publicTrust==='trusted'&&Number(af.verifiedReviewCount||0)>=5&&Number(af.averageRating||0)>=4,generatedAt:v96Now()};
}
async function v96GetCreatorTrustSignals(token:string,creatorId:string){
  // Query by creatorId only. Filtering and sorting are performed server-side after retrieval
  // so this endpoint never depends on a creatorId+updatedAt composite index being deployed.
  const products= (await fsRunQueryAllUnordered(token,'commerceProducts',[fsFilter('creatorId','EQUAL',{stringValue:creatorId})],500))
    .filter(p=>String(p.fields?.status||'')==='active'&&String(p.fields?.visibility||'')==='public')
    .sort((a,b)=>String(b.fields?.updatedAt||'').localeCompare(String(a.fields?.updatedAt||'')) || v96DocId(a).localeCompare(v96DocId(b)));
  let reviewCount=0,verifiedReviewCount=0,totalRating=0; const productSignals:any[]=[];
  for(const p of products){if(String(p.fields?.moderationStatus||'active')!=='active'||String(p.fields?.trustState||'active')==='restricted')continue; const pid=v96DocId(p), agg=await v96GetAggregate(token,pid), a=agg.fields||{}; reviewCount+=Number(a.reviewCount||0); verifiedReviewCount+=Number(a.verifiedReviewCount||0); totalRating+=Number(a.averageRating||0)*Number(a.reviewCount||0); productSignals.push({productId:pid,title:String(p.fields?.title||''),reviewCount:Number(a.reviewCount||0),averageRating:Number(a.averageRating||0),verifiedReviewCount:Number(a.verifiedReviewCount||0)});}
  const seller=await fsGet(token,`creatorCommerceProfiles/${creatorId}`), sellerEnabled=seller?.fields?.sellerEnabled!==false, sellerStatus=String(seller?.fields?.onboardingStatus||'not_started'), operational=sellerEnabled&&sellerStatus==='active', raw=String(seller?.fields?.trustStatus||'new'), averageRating=reviewCount?Number((totalRating/reviewCount).toFixed(2)):0, trustedSeller=operational&&raw==='trusted'&&verifiedReviewCount>=5&&averageRating>=4;
  return {creatorId,sellerStatus:operational?'active':'not_public',trustStatus:trustedSeller?'trusted':operational?'active':'new',productCount:productSignals.length,reviewCount,verifiedReviewCount,averageRating,trustedSeller,products:productSignals,generatedAt:v96Now()};
}
async function v96CreateReport(token:string,uid:string,b:any){
  const targetType=v96TargetType(b.targetType), targetId=v96Text(b.targetId,200); if(!targetId)throw v96Error('Target is required.');
  const reason=v96Text(b.reasonCode,80); if(!V96_REPORT_REASONS.has(reason))throw v96Error('Invalid report reason.');
  const description=v96Text(b.description,V96_MAX_REPORT_BODY); const now=v96Now(); let target:any;
  if(targetType==='review')target=await v96GetReview(token,targetId); else if(targetType==='product')target=await v96GetProduct(token,targetId); else if(targetType==='creator')target=await v96GetCreator(token,targetId); else target=await v96GetOrder(token,targetId);
  if(targetType==='review'&&String(target.fields.reviewerId||'')===uid)throw v96Error('You cannot report your own review.');
  if(targetType==='order'&&String(target.fields.customerId||'')!==uid)throw v96Error('You can only report an order belonging to you.',403,'FORBIDDEN');
  const day=new Date().toISOString().slice(0,10); const existingReports=await fsRunQueryAdvanced(token,'commerceReports',[fsFilter('reporterId','EQUAL',{stringValue:uid})],{limit:V96_DAILY_REPORT_LIMIT+1,orderBy:[{fieldPath:'createdAt',direction:'DESCENDING'}]}); const reportsToday=existingReports.filter(r=>String(r.fields?.createdAt||'').slice(0,10)===day).length; if(reportsToday>=V96_DAILY_REPORT_LIMIT)throw v96Error('Daily report limit reached. Try again tomorrow.',429,'RATE_LIMITED'); const reportId=v96Id('report',`${uid}:${targetType}:${targetId}:${reason}:${day}`);
  const existing=await fsGet(token,`commerceReports/${reportId}`); if(existing)throw v96Error('You have already submitted this report recently.',409,'REPORT_DUPLICATE');
  const report={id:reportId,targetType,targetId,reporterId:uid,reasonCode:reason,description,status:'submitted',createdAt:now,updatedAt:now,version:1};
  const caseId=v96Id('case',`${targetType}:${targetId}`); const existingCase=await fsGet(token,`commerceModerationCases/${caseId}`);
  const caseNext=existingCase?{...existingCase.fields,reportIds:Array.from(new Set([...(Array.isArray(existingCase.fields?.reportIds)?existingCase.fields.reportIds:[]),reportId])),priority:existingCase.fields?.priority||((targetType==='creator'||reason==='fraud_concern')?'high':'normal'),status:['resolved','dismissed'].includes(String(existingCase.fields?.status||''))?'queued':String(existingCase.fields?.status||'queued'),updatedAt:now,reportCount:Number(existingCase.fields?.reportCount||0)+1}:{id:caseId,targetType,targetId,reportIds:[reportId],priority:(targetType==='creator'||reason==='fraud_concern')?'high':'normal',status:'queued',createdAt:now,updatedAt:now,reportCount:1};
  const reportAction={action:'report_created',targetType,targetId,actorId:uid,actorRole:'buyer',previousState:null,newState:'submitted',reasonCode:reason,notes:description,requestId:reportId,timestamp:now};
  const writes:any[]=[{create:{name:`${firestoreBase()}/commerceReports/${reportId}`,fields:fields(report)}},existingCase?{update:{name:`${firestoreBase()}/commerceModerationCases/${caseId}`,fields:fields(caseNext)}}:{create:{name:`${firestoreBase()}/commerceModerationCases/${caseId}`,fields:fields(caseNext)}},{create:{name:`${firestoreBase()}/commerceModerationActions/${v96Id('action',`${reportId}:created`)}`,fields:fields(reportAction)}},v96AuditWrite(reportAction)];
  const pre:any={}; if(existingCase)pre[`commerceModerationCases/${caseId}`]=existingCase.updateTime;
  if(targetType==='review'){
    const rf=target.fields, beforePublic=v96ReviewIsPublic(rf); const nextReview={...rf,status:beforePublic?'flagged':rf.status,moderationStatus:'queued',reportCount:Number(rf.reportCount||0)+1,updatedAt:now,version:Number(rf.version||1)+1};
    writes.push({update:{name:`${firestoreBase()}/commerceReviews/${targetId}`,fields:fields(nextReview)}}); pre[`commerceReviews/${targetId}`]=target.updateTime;
    if(beforePublic){
      const pid=String(rf.productId||''); const agg=await v96GetAggregate(token,pid); const delta=v96AggregateDelta(rf,null); const nextAgg={...v96AggregateNext(agg.fields||{},delta),productId:pid,updatedAt:now,lastRequestId:reportId};
      if(agg.updateTime){writes.push({update:{name:`${firestoreBase()}/commerceReviewAggregates/${pid}`,fields:fields(nextAgg)}});pre[`commerceReviewAggregates/${pid}`]=agg.updateTime;} else writes.push({create:{name:`${firestoreBase()}/commerceReviewAggregates/${pid}`,fields:fields(nextAgg)}});
    }
  }
  await fsCommitWithPrecondition(token,writes,pre);
  return {report,case:{...caseNext}};
}

async function v96ListModerationQueue(token:string,uid:string,email?:string,emailVerified?:boolean,b:any={}){
  await v96VerifyModerationRole(token,uid,'view',email,emailVerified); const limitCount=Math.max(1,Math.min(100,Number(b.limit||25))); const filters:any[]=[];
  if(String(b.status||'')){if(!V96_CASE_STATUSES.has(String(b.status)))throw v96Error('Invalid case status.');filters.push(fsFilter('status','EQUAL',{stringValue:String(b.status)}));}
  if(String(b.priority||'')){if(!V96_PRIORITIES.has(String(b.priority)))throw v96Error('Invalid priority.');filters.push(fsFilter('priority','EQUAL',{stringValue:String(b.priority)}));}
  if(String(b.targetType||'')){v96TargetType(b.targetType);filters.push(fsFilter('targetType','EQUAL',{stringValue:String(b.targetType)}));}
  if(String(b.assignedTo||''))filters.push(fsFilter('assignedTo','EQUAL',{stringValue:String(b.assignedTo)}));
  const order=[{fieldPath:'updatedAt',direction:'DESCENDING' as const},{fieldPath:'__name__',direction:'DESCENDING' as const}], cursor=decodeV96QueryCursor(b.cursor);
  const rows=await fsRunQueryAdvanced(token,'commerceModerationCases',filters,{limit:limitCount+1+(cursor?1:0),orderBy:order,startAt:cursor?{values:cursor.values,before:false}:undefined});
  const cursorLastId=cursor?.values?.[cursor.values.length-1]?.referenceValue?String(cursor.values[cursor.values.length-1].referenceValue).split('/').pop():''; const deduped=cursorLastId&&rows.length&&v96DocId(rows[0])===cursorLastId?rows.slice(1):rows; const page=deduped.slice(0,limitCount); return {cases:page.map(r=>({id:v96DocId(r),...r.fields})),nextCursor:deduped.length>limitCount?encodeV96QueryCursor(page[page.length-1],order):null};
}

async function v96GetModerationCase(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  await v96VerifyModerationRole(token,uid,'view',email,emailVerified); const caseId=v96Text(b.caseId,200); const row=await fsGet(token,`commerceModerationCases/${caseId}`); if(!row)throw v96Error('Moderation case not found.',404,'NOT_FOUND');
  const f=row.fields||{}, reportIds=Array.isArray(f.reportIds)?f.reportIds.map(String):[], reports:any[]=[]; for(const rid of reportIds){const r=await fsGet(token,`commerceReports/${rid}`);if(r)reports.push({id:rid,...r.fields});}
  const target=f.targetType==='review'?await v96GetReview(token,String(f.targetId)):f.targetType==='product'?await v96GetProduct(token,String(f.targetId)):f.targetType==='creator'?await v96GetCreatorAdminTarget(token,String(f.targetId)):await v96GetOrder(token,String(f.targetId));
  const actions=await fsRunQueryAll(token,'commerceModerationActions',[fsFilter('targetId','EQUAL',{stringValue:String(f.targetId)})],[{fieldPath:'timestamp',direction:'ASCENDING'},{fieldPath:'__name__',direction:'ASCENDING'}]);
  return {case:{id:caseId,...f},reports,target:v96AdminTargetSafe(String(f.targetType||''),target),actions:actions.map(r=>({id:v96DocId(r),...r.fields}))};
}

async function v96UpdateReviewModeration(token:string,uid:string,b:any,actor:any){
  const review=await v96GetReview(token,String(b.reviewId||'')); const f=review.fields||{}; const nextStatus=String(b.status||'');
  if(!V96_REVIEW_STATUSES.has(nextStatus))throw v96Error('Invalid review status.');
  if(!v96ValidReviewTransition(String(f.status||''),nextStatus))throw v96Error('Invalid review state transition.',409,'INVALID_STATE_TRANSITION');
  const reason=String(b.reasonCode||'other'); if(!V96_MODERATION_REASONS.has(reason))throw v96Error('A valid moderation reason is required.');
  const now=v96Now(); const requestId=String(b.requestId||v96Id('req',`${v96DocId(review)}:${nextStatus}:${f.version||1}`));
  const existingAction=await fsGet(token,`commerceModerationActions/${v96Id('action',requestId)}`); if(existingAction)return {review:v96CleanReviewPublic(review),actionId:v96Id('action',requestId),idempotent:true};
  const beforePublic=v96ReviewIsPublic(f);
  const nextMod=nextStatus==='published'?'approved':nextStatus==='removed'?'removed':nextStatus==='pending'?'queued':nextStatus==='under_review'?'under_review':'queued';
  const next={...f,status:nextStatus,moderationStatus:nextMod,moderationReason:reason,updatedAt:now,publishedAt:nextStatus==='published'?(f.publishedAt||now):f.publishedAt,removedAt:nextStatus==='removed'?now:f.removedAt,version:Number(f.version||1)+1};
  const afterPublic=v96ReviewIsPublic(next); const delta=v96AggregateDelta(beforePublic?f:null,afterPublic?next:null);
  const actionDoc={action:`review_${nextStatus}`,targetType:'review',targetId:v96DocId(review),actorId:uid,actorRole:actor.role,previousState:f.status,newState:nextStatus,reasonCode:reason,notes:v96Text(b.notes,V96_MAX_MODERATION_NOTE),requestId,timestamp:now};
  const caseId=v96Id('case',`review:${v96DocId(review)}`); const caseRow=await fsGet(token,`commerceModerationCases/${caseId}`); const extraWrites:any[]=[]; const extraPre:any={};
  if(caseRow){
    const cf=caseRow.fields||{}; let caseStatus=String(cf.status||'queued'); let resolvedAt=cf.resolvedAt, resolvedBy=cf.resolvedBy, resolutionCode=cf.resolutionCode;
    if(['published','hidden','rejected','removed'].includes(nextStatus)){caseStatus='resolved'; resolvedAt=now; resolvedBy=uid; resolutionCode=reason;}
    else if(['flagged','under_review'].includes(nextStatus)){caseStatus='under_review'; resolvedAt=null; resolvedBy=null; resolutionCode=null;}
    else if(nextStatus==='pending'){caseStatus='queued'; resolvedAt=null; resolvedBy=null; resolutionCode=null;}
    const caseNext={...cf,status:caseStatus,updatedAt:now,resolvedAt,resolvedBy,resolutionCode};
    extraWrites.push({update:{name:`${firestoreBase()}/commerceModerationCases/${caseId}`,fields:fields(caseNext)}}); extraPre[`commerceModerationCases/${caseId}`]=caseRow.updateTime;
    const reportIds=Array.isArray(cf.reportIds)?cf.reportIds.map(String):[];
    if(['published','hidden','rejected','removed'].includes(nextStatus)) for(const rid of reportIds){const rr=await fsGet(token,`commerceReports/${rid}`); if(rr){const old=String(rr.fields?.status||''); const rs=old==='resolved'||old==='dismissed'?old:'resolved'; if(rs!==old){extraWrites.push({update:{name:`${firestoreBase()}/commerceReports/${rid}`,fields:fields({status:rs,updatedAt:now,version:Number(rr.fields?.version||1)+1})}}); extraPre[`commerceReports/${rid}`]=rr.updateTime;}}}
  }
  const result=await v96CommitReviewMutation(token,review,next,delta,actionDoc,requestId,extraWrites,extraPre);
  return {review:v96CleanReviewPublic({name:review.name,fields:next}),actionId:v96Id('action',requestId),aggregate:result.aggregate};
}

async function v96ModerationAction(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  const targetType=String(b.targetType||''); const action=String(b.action||''); const permission=targetType==='review'?'moderate:reviews':targetType==='product'?'moderate:products':targetType==='creator'?'moderate:sellers':''; if(!permission)throw v96Error('Invalid moderation target type.'); const actor=await v96VerifyModerationRole(token,uid,permission,email,emailVerified); let linkedCase:any=null; if(String(b.caseId||'')){linkedCase=await fsGet(token,`commerceModerationCases/${String(b.caseId||'')}`); if(!linkedCase)throw v96Error('Moderation case not found.',404,'NOT_FOUND'); if(String(linkedCase.fields?.targetType||'')!==targetType || String(linkedCase.fields?.targetId||'')!==String(b.targetId||''))throw v96Error('Case target mismatch.',409,'CONFLICT');} const requestId=v96Text(b.requestId,200)||v96Id('req',`${targetType}:${String(b.targetId||'')}:${action}:${String(b.currentVersion||'')}`); const existingAction=await fsGet(token,`commerceModerationActions/${v96Id('action',requestId)}`); if(existingAction)return {actionId:v96Id('action',requestId),idempotent:true}; const reason=String(b.reasonCode||'other'); if(!V96_MODERATION_REASONS.has(reason))throw v96Error('A valid moderation reason is required for this action.');
  if(action==='assign'||action==='unassign'||action==='resolve'||action==='dismiss'||action==='escalate'){
    const caseRow=await fsGet(token,`commerceModerationCases/${String(b.caseId||'')}`); if(!caseRow)throw v96Error('Moderation case not found.',404,'NOT_FOUND'); const cf=caseRow.fields||{}; if(String(cf.targetType||'')!==targetType)throw v96Error('Case target mismatch.',409,'CONFLICT');
    let nextStatus=String(cf.status||'open'); if(action==='resolve')nextStatus='resolved'; if(action==='dismiss')nextStatus='dismissed'; if(action==='escalate')nextStatus='escalated';
    if(action!=='assign'&&action!=='unassign'&&!v96ValidCaseTransition(String(cf.status||''),nextStatus))throw v96Error('Invalid case state transition.',409,'INVALID_STATE_TRANSITION');
    const now=v96Now(), assignedTo=action==='assign'?String(b.assignedTo||''):action==='unassign'?null:cf.assignedTo; if(action==='assign')await v96VerifyAssignee(token,assignedTo);
    const next={...cf,status:action==='assign'||action==='unassign'?String(cf.status||'queued'):nextStatus,assignedTo:action==='unassign'?null:assignedTo,resolvedAt:['resolved','dismissed'].includes(nextStatus)?now:cf.resolvedAt,resolvedBy:['resolved','dismissed'].includes(nextStatus)?uid:cf.resolvedBy,resolutionCode:['resolve','dismiss'].includes(action)?v96Text(b.resolutionCode||reason,80):cf.resolutionCode,internalNotes:['resolve','dismiss'].includes(action)?v96Text(b.notes,V96_MAX_MODERATION_NOTE):cf.internalNotes};
    const actionDoc={action:`case_${action}`,targetType:String(cf.targetType),targetId:String(cf.targetId),caseId:String(b.caseId||''),actorId:uid,actorRole:actor.role,previousState:cf.status,newState:next.status,reasonCode:reason,notes:v96Text(b.notes,V96_MAX_MODERATION_NOTE),requestId,timestamp:now};
    const writes:any[]=[{update:{name:`${firestoreBase()}/commerceModerationCases/${String(b.caseId||'')}`,fields:fields(next)}},{create:{name:`${firestoreBase()}/commerceModerationActions/${v96Id('action',requestId)}`,fields:fields(actionDoc)}},v96AuditWrite(actionDoc)];
    const pre:any={[`commerceModerationCases/${String(b.caseId||'')}`]:caseRow.updateTime};
    if(['resolve','dismiss'].includes(action)){const reportIds=Array.isArray(cf.reportIds)?cf.reportIds.map(String):[]; for(const rid of reportIds){const rr=await fsGet(token,`commerceReports/${rid}`); if(rr){const newStatus=action==='resolve'?'resolved':'dismissed'; const oldStatus=String(rr.fields?.status||''); if(oldStatus!==newStatus&&v96ValidReportTransition(oldStatus,newStatus)){writes.push({update:{name:`${firestoreBase()}/commerceReports/${rid}`,fields:fields({status:newStatus,updatedAt:now,version:Number(rr.fields?.version||1)+1})}});pre[`commerceReports/${rid}`]=rr.updateTime;}}}}
    await fsCommitWithPrecondition(token,writes,pre); return {case:{id:String(b.caseId||''),...next},actionId:v96Id('action',requestId)};
  }
  if(targetType==='review'){ const reviewStatus=action==='publish'||action==='approve'?'published':action==='hide'?'hidden':action==='remove'?'removed':action==='flag'?'flagged':action==='reject'?'rejected':String(b.status||''); return v96UpdateReviewModeration(token,uid,{...b,status:reviewStatus,requestId},actor); }
  if(targetType==='product'){
    const product=await v96GetProduct(token,String(b.targetId||'')); const pf=product.fields||{}; const currentState=String(pf.moderationStatus||'active'); const nextState=action==='restore'?'active':action==='hide'?'hidden':action==='remove'?'removed':action==='restrict'?'restricted':action==='approve'?'active':String(b.status||''); const allowed:any={active:['hidden','removed','restricted'],hidden:['active','removed','restricted'],restricted:['active','hidden','removed'],removed:['active','hidden']}; if(!allowed[currentState]?.includes(nextState))throw v96Error('Invalid product moderation transition.',409,'INVALID_STATE_TRANSITION'); if(actor.role!=='master_admin'&&action==='remove'&&!actor.permissions.includes('moderate:products:destructive'))throw v96Error('Destructive product moderation requires elevated permission.',403); const now=v96Now(); const next={...pf,moderationStatus:nextState==='active'?'active':nextState,trustState:nextState==='active'?'active':'restricted',updatedAt:now}; const audit={action:`product_${action}`,targetType:'product',targetId:v96DocId(product),actorId:uid,actorRole:actor.role,previousState:currentState,newState:nextState,reasonCode:reason,notes:v96Text(b.notes,V96_MAX_MODERATION_NOTE),requestId,timestamp:now}; const writes:any[]=[{update:{name:`${firestoreBase()}/commerceProducts/${v96DocId(product)}`,fields:fields(next)}},{create:{name:`${firestoreBase()}/commerceModerationActions/${v96Id('action',requestId)}`,fields:fields(audit)}},v96AuditWrite(audit)]; const pre:any={[`commerceProducts/${v96DocId(product)}`]:product.updateTime}; if(linkedCase){const cf=linkedCase.fields||{}; const caseNext={...cf,status:'resolved',updatedAt:now,resolvedAt:now,resolvedBy:uid,resolutionCode:reason}; writes.unshift({update:{name:`${firestoreBase()}/commerceModerationCases/${v96DocId(linkedCase)}`,fields:fields(caseNext)}}); pre[`commerceModerationCases/${v96DocId(linkedCase)}`]=linkedCase.updateTime; const reportIds=Array.isArray(cf.reportIds)?cf.reportIds.map(String):[]; for(const rid of reportIds){const rr=await fsGet(token,`commerceReports/${rid}`); if(rr){const old=String(rr.fields?.status||''); if(old!=='resolved'&&v96ValidReportTransition(old,'resolved')){writes.push({update:{name:`${firestoreBase()}/commerceReports/${rid}`,fields:fields({status:'resolved',updatedAt:now,version:Number(rr.fields?.version||1)+1})}}); pre[`commerceReports/${rid}`]=rr.updateTime;}}}} await fsCommitWithPrecondition(token,writes,pre); return {product:{id:v96DocId(product),...next},actionId:v96Id('action',requestId)};
  }
  if(targetType==='creator'){
    const creatorId=String(b.targetId||''); if(!creatorId)throw v96Error('Creator is required.'); const seller=await fsGet(token,`creatorCommerceProfiles/${creatorId}`) || {name:`${firestoreBase()}/creatorCommerceProfiles/${creatorId}`,fields:{creatorId}}; const currentTrust=String(seller.fields?.trustStatus||'active'); const nextTrust=action==='restore'?'active':action==='restrict'?'restricted':action==='suspend'?'suspended':action==='approve'?'active':String(b.trustStatus||''); const allowed:any={active:['restricted','suspended'],restricted:['active','suspended'],suspended:['active','restricted'],new:['active','restricted','suspended']}; if(!allowed[currentTrust]?.includes(nextTrust))throw v96Error('Invalid creator trust transition.',409,'INVALID_STATE_TRANSITION'); const now=v96Now(); const next={...seller.fields,creatorId,trustStatus:nextTrust,updatedAt:now}; const audit={action:`creator_${action}`,targetType:'creator',targetId:creatorId,actorId:uid,actorRole:actor.role,previousState:currentTrust,newState:nextTrust,reasonCode:reason,notes:v96Text(b.notes,V96_MAX_MODERATION_NOTE),requestId,timestamp:now}; const writes:any[]=[seller.updateTime?{update:{name:`${firestoreBase()}/creatorCommerceProfiles/${creatorId}`,fields:fields(next)}}:{create:{name:`${firestoreBase()}/creatorCommerceProfiles/${creatorId}`,fields:fields(next)}},{create:{name:`${firestoreBase()}/commerceModerationActions/${v96Id('action',requestId)}`,fields:fields(audit)}},v96AuditWrite(audit)]; const pre:any=seller.updateTime?{[`creatorCommerceProfiles/${creatorId}`]:seller.updateTime}:{}; if(linkedCase){const cf=linkedCase.fields||{}; const caseNext={...cf,status:'resolved',updatedAt:now,resolvedAt:now,resolvedBy:uid,resolutionCode:reason}; writes.unshift({update:{name:`${firestoreBase()}/commerceModerationCases/${v96DocId(linkedCase)}`,fields:fields(caseNext)}}); pre[`commerceModerationCases/${v96DocId(linkedCase)}`]=linkedCase.updateTime; const reportIds=Array.isArray(cf.reportIds)?cf.reportIds.map(String):[]; for(const rid of reportIds){const rr=await fsGet(token,`commerceReports/${rid}`); if(rr){const old=String(rr.fields?.status||''); if(old!=='resolved'&&v96ValidReportTransition(old,'resolved')){writes.push({update:{name:`${firestoreBase()}/commerceReports/${rid}`,fields:fields({status:'resolved',updatedAt:now,version:Number(rr.fields?.version||1)+1})}}); pre[`commerceReports/${rid}`]=rr.updateTime;}}}} await fsCommitWithPrecondition(token,writes,pre); return {creator:{id:creatorId,...next},actionId:v96Id('action',requestId)};
  }
  throw v96Error('Unsupported moderation action.');
}
async function v96SearchModeration(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){await v96VerifyModerationRole(token,uid,'view',email,emailVerified); const q=v96Text(b.q,120).toLowerCase(); if(!q)return {cases:[]}; const buckets=await Promise.all(['commerceModerationCases','commerceReports','commerceReviews'].map(async collection=>fsRunQueryAdvanced(token,collection,[],{limit:200,orderBy:[{fieldPath:'updatedAt',direction:'DESCENDING'}]}).catch(()=>[]))); const cases:any[]=[]; for(const rows of buckets){for(const row of rows){const f=row.fields||{}; const blob=JSON.stringify({id:v96DocId(row),...f}).toLowerCase(); if(blob.includes(q))cases.push({collection,id:v96DocId(row),...f});}} return {results:cases.slice(0,100)};}
async function v96TrustHealth(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  await v96VerifyModerationRole(token,uid,'view',email,emailVerified); const issues:any[]=[];
  const [reviews,products,orders,aggregates,reports,cases,actions,audits]=await Promise.all([fsRunQueryAll(token,'commerceReviews'),fsRunQueryAll(token,'commerceProducts'),fsRunQueryAll(token,'commerceOrders'),fsRunQueryAll(token,'commerceReviewAggregates'),fsRunQueryAll(token,'commerceReports'),fsRunQueryAll(token,'commerceModerationCases'),fsRunQueryAll(token,'commerceModerationActions'),fsRunQueryAll(token,'commerceAuditLogs')]);
  const productIds=new Set(products.map(v96DocId)), orderMap=new Map(orders.map(x=>[v96DocId(x),x.fields||{}])), reviewKeys=new Set<string>();
  for(const r of reviews){const f=r.fields||{}, rating=Number(f.rating), key=`${f.reviewerId}:${f.orderItemId||f.productId||''}`; if(reviewKeys.has(key))issues.push({severity:'critical',type:'duplicate_review',entityId:v96DocId(r)}); reviewKeys.add(key); if(!V96_REVIEW_STATUSES.has(String(f.status||''))||!V96_REVIEW_MODERATION.has(String(f.moderationStatus||'')))issues.push({severity:'critical',type:'invalid_review_state',entityId:v96DocId(r)}); if(String(f.status||'')==='published'&&String(f.moderationStatus||'')!=='approved')issues.push({severity:'critical',type:'published_review_not_approved',entityId:v96DocId(r)}); if(!Number.isInteger(rating)||rating<1||rating>5)issues.push({severity:'critical',type:'invalid_rating',entityId:v96DocId(r)}); if(f.verifiedPurchase===true){const o=orderMap.get(String(f.orderId||'')), valid=!!o&&['paid','partially_refunded','refunded'].includes(String(o.status||''))&&String(o.customerId||'')===String(f.reviewerId||'')&&Array.isArray(o.items)&&o.items.some((it:any,i:number)=>String(it?.productId||'')===String(f.productId||'')&&(!f.orderItemId||`${f.orderId}:${i}`===String(f.orderItemId))); if(!valid)issues.push({severity:'critical',type:'invalid_verification',entityId:v96DocId(r)});} if(v96ReviewIsPublic(f)&&!productIds.has(String(f.productId||'')))issues.push({severity:'critical',type:'orphan_published_review',entityId:v96DocId(r)});}
  const reviewGroups=new Map<string,any[]>(); for(const r of reviews){const pid=String(r.fields?.productId||'');if(pid){const arr=reviewGroups.get(pid)||[];arr.push(r);reviewGroups.set(pid,arr);}}
  const aggregateIds=new Set(aggregates.map(v96DocId)); for(const a of aggregates){const pid=v96DocId(a), expected=v96AggregateFromReviews(reviewGroups.get(pid)||[]), af=a.fields||{}; if(['reviewCount','ratingTotal','averageRating','rating1Count','rating2Count','rating3Count','rating4Count','rating5Count','verifiedReviewCount'].some(k=>Number(af[k]||0)!==Number(expected[k]||0)))issues.push({severity:'warning',type:'aggregate_mismatch',entityId:pid,expected,actual:af});}
  for(const [pid,rows] of reviewGroups)if(!aggregateIds.has(pid)&&v96AggregateFromReviews(rows).reviewCount>0)issues.push({severity:'warning',type:'missing_review_aggregate',entityId:pid});
  const reportIds=new Set(reports.map(v96DocId)); for(const r of reports){const f=r.fields||{}; if(!V96_REPORT_STATUSES.has(String(f.status||'')))issues.push({severity:'critical',type:'invalid_report_state',entityId:v96DocId(r)}); if(!['review','product','creator','order'].includes(String(f.targetType||'')))issues.push({severity:'critical',type:'invalid_report_target',entityId:v96DocId(r)});}
  for(const c of cases){const f=c.fields||{}; if(!V96_CASE_STATUSES.has(String(f.status||''))||!V96_PRIORITIES.has(String(f.priority||'')))issues.push({severity:'critical',type:'invalid_case_state',entityId:v96DocId(c)}); for(const rid of Array.isArray(f.reportIds)?f.reportIds.map(String):[])if(!reportIds.has(rid))issues.push({severity:'warning',type:'missing_report_reference',entityId:v96DocId(c),reportId:rid});}
  const creatorProfiles=await fsRunQueryAll(token,'creatorCommerceProfiles'); const creatorIds=new Set(creatorProfiles.map(v96DocId)); const reviewIds=new Set(reviews.map(v96DocId));
  for(const r of reports){const f=r.fields||{}, t=String(f.targetType||''), id=String(f.targetId||''); const exists=t==='review'?reviewIds.has(id):t==='product'?productIds.has(id):t==='creator'?creatorIds.has(id):t==='order'?orderMap.has(id):false; if(!exists)issues.push({severity:'critical',type:'orphan_report_target',entityId:v96DocId(r)});}
  const caseTargetSeen=new Set<string>(); for(const c of cases){const f=c.fields||{}, t=String(f.targetType||''), id=String(f.targetId||''), key=`${t}:${id}`; caseTargetSeen.add(key); const exists=t==='review'?reviewIds.has(id):t==='product'?productIds.has(id):t==='creator'?creatorIds.has(id):t==='order'?orderMap.has(id):false; if(!exists)issues.push({severity:'critical',type:'orphan_case_target',entityId:v96DocId(c)});}
  const auditKeys=new Set<string>(); for(const a of audits){const req=String(a.fields?.metadata?.requestId||''); if(req)auditKeys.add(req);}
  for(const a of actions){const req=String(a.fields?.requestId||''); if(!req)issues.push({severity:'warning',type:'missing_request_id',entityId:v96DocId(a)}); else if(!auditKeys.has(req))issues.push({severity:'warning',type:'missing_audit_event',entityId:v96DocId(a),requestId:req}); const targetId=String(a.fields?.targetId||''); const targetType=String(a.fields?.targetType||''); if(targetId&&!((targetType==='review'&&reviewIds.has(targetId))||(targetType==='product'&&productIds.has(targetId))||(targetType==='creator'&&creatorIds.has(targetId))||(targetType==='order'&&orderMap.has(targetId)))) issues.push({severity:'warning',type:'orphan_action_target',entityId:v96DocId(a)});}
  const critical=issues.filter(i=>i.severity==='critical').length,warnings=issues.filter(i=>i.severity==='warning').length;
  return {status:critical?'critical':warnings?'warning':'healthy',healthy:critical===0&&warnings===0?1:0,warnings,critical,issues:issues.slice(0,200),checkedAt:v96Now(),recordsScanned:{reviews:reviews.length,reports:reports.length,cases:cases.length,aggregates:aggregates.length,actions:actions.length,products:products.length,orders:orders.length,audits:audits.length}};
}
async function v96ValidateAggregate(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){await v96VerifyModerationRole(token,uid,'view',email,emailVerified); const productId=v96Text(b.productId,200); if(!productId)throw v96Error('productId is required.'); const expected=await v96RebuildAggregateData(token,productId); const stored=await v96GetAggregate(token,productId); const actual=stored.fields||{}; const mismatches:any={}; for(const k of ['reviewCount','ratingTotal','averageRating','rating1Count','rating2Count','rating3Count','rating4Count','rating5Count','verifiedReviewCount'])if(Number(actual[k]||0)!==Number(expected[k]||0))mismatches[k]={expected:expected[k],actual:actual[k]}; return {productId,healthy:Object.keys(mismatches).length===0,expected,actual,mismatches,checkedAt:v96Now()};}
async function v96RebuildAggregate(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  await v96VerifyModerationRole(token,uid,'moderation:aggregate_rebuild',email,emailVerified); const productId=v96Text(b.productId,200); if(!productId)throw v96Error('productId is required.');
  const expected=await v96RebuildAggregateData(token,productId), stored=await v96GetAggregate(token,productId), before=stored.fields||{}; if(b.repair!==true)return {repaired:false,productId,expected,actual:before};
  const requestId=v96Text(b.requestId,200)||v96Id('repair',`${productId}:${Date.now()}`); const existingAction=await fsGet(token,`commerceModerationActions/${v96Id('action',requestId)}`); if(existingAction)return {repaired:true,productId,expected,actual:expected,requestId,idempotent:true}; const now=v96Now(), actionDoc={action:'review_aggregate_rebuilt',targetType:'product',targetId:productId,actorId:uid,actorRole:'admin',previousState:JSON.stringify(before),newState:JSON.stringify(expected),reasonCode:'data_quality_repair',notes:'Explicit aggregate repair',requestId,timestamp:now};
  const writes:any[]=[{create:{name:`${firestoreBase()}/commerceModerationActions/${v96Id('action',requestId)}`,fields:fields(actionDoc)}},v96AuditWrite(actionDoc)], pre:any={};
  const aggWrite=stored.updateTime?{update:{name:`${firestoreBase()}/commerceReviewAggregates/${productId}`,fields:fields({...expected,productId,updatedAt:now,lastRequestId:requestId})}}:{create:{name:`${firestoreBase()}/commerceReviewAggregates/${productId}`,fields:fields({...expected,productId,updatedAt:now,lastRequestId:requestId})}};
  writes.push(aggWrite); if(stored.updateTime)pre[`commerceReviewAggregates/${productId}`]=stored.updateTime; await fsCommitWithPrecondition(token,writes,pre);
  return {repaired:true,productId,expected,actual:expected,requestId};
}

function fsFilter(fieldPath:string, op:string, v:any){
  return {field:{fieldPath},op,value:v};
}

function decodeCursor(raw:string|undefined): {id:string;sortKey:string}|null {
  if(!raw) return null;
  try { const parsed=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); if(!parsed || typeof parsed.id!=='string') return null; return {id:parsed.id,sortKey:String(parsed.sortKey??'')}; } catch { return null; }
}
function encodeCursor(id:string,sortKey:string){ return Buffer.from(JSON.stringify({id,sortKey}),'utf8').toString('base64url'); }

function publicProductProjection(p:any){
  return {
    id:String(p.id||''),creatorId:String(p.creatorId||''),creatorUsername:String(p.creatorUsername||''),creatorDisplayName:String(p.creatorDisplayName||''),
    title:String(p.title||''),subtitle:String(p.subtitle||''),description:String(p.description||''),type:String(p.type||'digital_product'),subtype:String(p.subtype||''),
    status:'active',visibility:'public',featured:Boolean(p.featured),currency:String(p.currency||'INR'),priceIds:Array.isArray(p.priceIds)?p.priceIds.map(String):[],
    version:Number(p.version||1),thumbnail:String(p.thumbnail||''),gallery:Array.isArray(p.gallery)?p.gallery.map(String).slice(0,12):[],
    category:String(p.category||''),subcategory:String(p.subcategory||''),tags:Array.isArray(p.tags)?p.tags.map(String).slice(0,30):[],
    license:String(p.license||''),usageRestrictions:String(p.usageRestrictions||''),requirements:String(p.requirements||''),whatIsIncluded:String(p.whatIsIncluded||''),
    createdAt:p.createdAt,updatedAt:p.updatedAt,publishedAt:p.publishedAt,
    viewsCount:Number(p.viewsCount||0),saveCount:Number(p.saveCount||0),purchaseCount:Number(p.purchaseCount||0)
  };
}

function marketplaceRelevance(p:any,query:string){
  const q=String(query||'').toLowerCase().trim(); if(!q) return 0;
  const terms=q.split(/\s+/).filter(Boolean); const fields=[['title',String(p.title||'')],['subtitle',String(p.subtitle||'')],['category',String(p.category||'')],['subcategory',String(p.subcategory||'')],['tags',(Array.isArray(p.tags)?p.tags:[]).join(' ')],['creator',`${p.creatorUsername||''} ${p.creatorDisplayName||''}`],['description',String(p.description||'')]];
  let score=0; for(const term of terms){ for(const [name,value] of fields){const hay=value.toLowerCase(); if(!hay.includes(term)) continue; score += name==='title'?12:name==='subtitle'?8:name==='category'||name==='subcategory'?7:name==='tags'?6:name==='creator'?5:2; if(hay===term) score+=4; }}
  if(String(p.title||'').toLowerCase()===q) score+=20; return score;
}
function marketplaceTrendScore(p:any){
  const views=Number(p.viewsCount||0), saves=Number(p.saveCount||0), purchases=Number(p.purchaseCount||0);
  const published=Date.parse(String(p.publishedAt||p.updatedAt||'')); const ageDays=published>0?Math.max(0,(Date.now()-published)/86400000):365;
  const recency=Math.max(0,14-ageDays);
  return views*0.01+saves*2+purchases*6+recency;
}

async function loadPublicMarketplaceProducts(token:string, filters:any = {}){
  const category=String(filters.category||'').trim(); const subcategory=String(filters.subcategory||'').trim(); const type=String(filters.type||'').trim(); const creatorId=String(filters.creatorId||'').trim();
  // Keep the discovery query index-light: only the canonical active-status equality is sent to Firestore.
  // Visibility and secondary marketplace filters are enforced on the server after retrieval, while
  // ordering by document name provides a bounded, deterministic query without requiring a
  // status+visibility+publishedAt composite index to be present in every environment.
  const rows=await fsRunQueryAdvanced(token,'commerceProducts',[fsFilter('status','EQUAL',{stringValue:'active'})],{orderBy:[{fieldPath:'__name__',direction:'ASCENDING'}],limit:300});
  let products=rows.filter(x=>String(x.fields?.moderationStatus||'active')==='active' && String(x.fields?.trustState||'active')!=='restricted').map(x=>publicProductProjection({id:x.name.split('/').pop(),...x.fields}))
    .filter(p=>String(p.visibility||'').toLowerCase()==='public');
  if(creatorId) products=products.filter(p=>String(p.creatorId||'')===creatorId);
  if(category) products=products.filter(p=>String(p.category||'').toLowerCase()===category.toLowerCase());
  if(subcategory) products=products.filter(p=>String(p.subcategory||'').toLowerCase()===subcategory.toLowerCase());
  if(type) products=products.filter(p=>String(p.type||'').toLowerCase()===type.toLowerCase());
  return products;
}

async function loadPublicPricesForProducts(token:string, products:any[]){
  const ids=Array.from(new Set(products.map(p=>String(p.id||'')).filter(Boolean))); const map:any={};
  for(let i=0;i<ids.length;i+=30){
    const chunk=ids.slice(i,i+30); if(!chunk.length) continue;
    try{
      const rows=await fsRunQueryAdvanced(token,'commercePrices',[fsFilter('productId','IN',{arrayValue:{values:chunk.map(id=>({stringValue:id}))}})],{limit:250});
      rows.forEach(x=>{const price={id:x.name.split('/').pop(),...x.fields}; if(price.active===true){const pid=String(price.productId||''); const amt=Number(price.amount||0); if(pid && (!map[pid]||amt<Number(map[pid].amount||0))) map[pid]={id:String(price.id||''),productId:pid,amount:amt,currency:String(price.currency||'INR'),billingType:price.billingType==='recurring'?'recurring':'one_time',active:true,validFrom:price.validFrom,validUntil:price.validUntil,createdAt:price.createdAt,updatedAt:price.updatedAt}; }});
    }catch(error){ console.warn('Marketplace price batch failed:',error); }
  }
  return map;
}

async function marketplaceList(token:string, params:any){
  const q=String(params.q||'').trim().slice(0,100); const sort=String(params.sort||'newest'); const limitCount=Math.max(6,Math.min(24,Number(params.limit||24)));
  let products=await loadPublicMarketplaceProducts(token,params);
  const prices=await loadPublicPricesForProducts(token,products);
  if(q){const queryText=q.toLowerCase(); products=products.map(p=>({...p,__score:marketplaceRelevance(p,queryText)})).filter(p=>p.__score>0);}
  const priceAmount=(p:any)=>Number(prices[p.id]?.amount||0);
  products.sort((a:any,b:any)=>{
    if(sort==='relevance') return Number(b.__score||0)-Number(a.__score||0) || String(b.publishedAt||b.updatedAt||'').localeCompare(String(a.publishedAt||a.updatedAt||'')) || String(a.id).localeCompare(String(b.id));
    if(sort==='popular') return marketplaceTrendScore(b)-marketplaceTrendScore(a) || String(b.publishedAt||b.updatedAt||'').localeCompare(String(a.publishedAt||a.updatedAt||'')) || String(a.id).localeCompare(String(b.id));
    if(sort==='price_asc') return priceAmount(a)-priceAmount(b) || String(a.id).localeCompare(String(b.id));
    if(sort==='price_desc') return priceAmount(b)-priceAmount(a) || String(a.id).localeCompare(String(b.id));
    return String(b.publishedAt||b.updatedAt||'').localeCompare(String(a.publishedAt||a.updatedAt||'')) || String(a.id).localeCompare(String(b.id));
  });
  products=products.map(({__score,...p}:any)=>p);
  const cursor=decodeCursor(typeof params.cursor==='string'?params.cursor:undefined);
  let startIndex=0;
  if(cursor){const idx=products.findIndex((p:any)=>String(p.id)===cursor.id); startIndex=idx>=0?idx+1:0;}
  const page=products.slice(startIndex,startIndex+limitCount); const next= startIndex+limitCount<products.length && page.length ? encodeCursor(String(page[page.length-1].id), String(sort==='price_asc'||sort==='price_desc'?priceAmount(page[page.length-1]):sort==='popular'?marketplaceTrendScore(page[page.length-1]):page[page.length-1].publishedAt||page[page.length-1].updatedAt||'')) : undefined;
  return {generatedAt:nowIso(),products:page,prices,hasMore:Boolean(next),nextCursor:next,total:products.length};
}

async function marketplaceHome(token:string){
  const products=await loadPublicMarketplaceProducts(token,{}); const prices=await loadPublicPricesForProducts(token,products);
  const featured=products.filter(p=>p.featured).slice(0,8);
  const newest=[...products].sort((a,b)=>String(b.publishedAt||b.updatedAt||'').localeCompare(String(a.publishedAt||a.updatedAt||''))).slice(0,8);
  const trending=[...products].sort((a,b)=>marketplaceTrendScore(b)-marketplaceTrendScore(a)||String(b.publishedAt||'').localeCompare(String(a.publishedAt||''))).slice(0,8);
  const creatorsMap=new Map<string,any>(); for(const p of products){if(!p.creatorId)continue; const row=creatorsMap.get(p.creatorId)||{id:p.creatorId,username:p.creatorUsername,displayName:p.creatorDisplayName,productCount:0,cover:p.thumbnail||p.gallery?.[0]||''}; row.productCount++; if(!row.cover)row.cover=p.thumbnail||p.gallery?.[0]||''; creatorsMap.set(p.creatorId,row);}
  const creators=[...creatorsMap.values()].sort((a,b)=>b.productCount-a.productCount||String(a.username||'').localeCompare(String(b.username||''))).slice(0,50);
  return {generatedAt:nowIso(),featured,trending,newest,creators,prices};
}

async function marketplaceByIds(token:string, rawIds:string){
  const ids=Array.from(new Set(String(rawIds||'').split(',').map(s=>s.trim()).filter(Boolean))).slice(0,100);
  const all:any[]=[];
  for(let i=0;i<ids.length;i+=30){
    const chunk=ids.slice(i,i+30); if(!chunk.length)continue;
    try{const rows=await fsRunQueryAdvanced(token,'commerceProducts',[fsFilter('status','EQUAL',{stringValue:'active'}),fsFilter('visibility','EQUAL',{stringValue:'public'}),fsFilter('__name__','IN',{arrayValue:{values:chunk.map(id=>({referenceValue:`projects/${projectId()}/databases/(default)/documents/commerceProducts/${id}`}))}})],{limit:30}); all.push(...rows.filter(x=>String(x.fields?.moderationStatus||'active')==='active' && String(x.fields?.trustState||'active')!=='restricted').map(x=>publicProductProjection({id:x.name.split('/').pop(),...x.fields})));}
    catch{for(const id of chunk){const row=await fsGet(token,`commerceProducts/${id}`); if(row?.fields?.status==='active'&&row?.fields?.visibility==='public'&&String(row.fields?.moderationStatus||'active')==='active'&&String(row.fields?.trustState||'active')!=='restricted')all.push(publicProductProjection({id,...row.fields}));}}
  }
  const priceMap=await loadPublicPricesForProducts(token,all); return {generatedAt:nowIso(),products:all,prices:priceMap};
}

async function listPublicProducts(token:string,creatorId?:string){
  const id=String(creatorId||'').trim();
  const products=await loadPublicMarketplaceProducts(token,{creatorId:id});
  products.sort((a:any,b:any)=>Number(Boolean(b.featured))-Number(Boolean(a.featured))||String(b.updatedAt||b.publishedAt||'').localeCompare(String(a.updatedAt||a.publishedAt||'')));
  return {generatedAt:nowIso(),products:products.slice(0,100)};
}

async function listPublicPrices(token:string,productId:string){
  const id=String(productId||'').trim(); if(!id) return {generatedAt:nowIso(),prices:[]};
  const product=await fsGet(token,`commerceProducts/${id}`);
  if(!product || product.fields.status!=='active' || product.fields.visibility!=='public' || String(product.fields.moderationStatus||'active')!=='active' || String(product.fields.trustState||'active')==='restricted') return {generatedAt:nowIso(),prices:[]};
  const rows=await fsRunQuery(token,'commercePrices',[{field:{fieldPath:'productId'},op:'EQUAL',value:{stringValue:id}}]);
  const prices=rows.map(x=>({id:x.name.split('/').pop(),...x.fields})).filter((p:any)=>p.active===true).map((p:any)=>({
    id:String(p.id||''),productId:id,amount:Number(p.amount||0),currency:String(p.currency||product.fields.currency||'INR'),billingType:p.billingType==='recurring'?'recurring':'one_time',interval:p.interval,intervalCount:p.intervalCount?Number(p.intervalCount):undefined,trialDays:p.trialDays?Number(p.trialDays):undefined,active:true,validFrom:p.validFrom,validUntil:p.validUntil,createdAt:p.createdAt,updatedAt:p.updatedAt
  })).sort((a:any,b:any)=>a.amount-b.amount);
  return {generatedAt:nowIso(),prices:prices.slice(0,50)};
}

async function commerceDiagnostics(token:string,uid:string,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))) { const error:any=new Error('Administrator access required.'); error.statusCode=403; throw error; }
  const names=['commerceProducts','commercePrices','commerceOrders','commercePayments','commerceRefunds','entitlements','creatorRevenue','creatorPayouts','creatorCommerceProfiles','commerceCommissionRules','commerceFinancialAllocations','commerceAuditLogs','commerceWebhookEvents','commerceReviews','commerceReports','commerceModerationCases','commerceModerationActions','commerceTrustSignals','commerceReviewAggregates'];
  const entries=await Promise.all(names.map(async name=>{try{return [name,await fsCount(token,name),null] as const;}catch(error:any){return [name,null,String(error?.message||'Count failed')] as const;}}));
  return {generatedAt:nowIso(),counts:Object.fromEntries(entries.map(([name,count])=>[name,count??0])),errors:Object.fromEntries(entries.filter(([,count,error])=>count===null).map(([name,,error])=>[name,error]))};
}

async function setProductVisibility(token:string,uid:string,b:any){
  const productId=String(b.productId||''); const visibility=String(b.visibility||'');
  if(!['public','private','unlisted'].includes(visibility)) throw new Error('Invalid product visibility.');
  const product=await fsGet(token,`commerceProducts/${productId}`); if(!product) throw new Error('Product not found.');
  if(product.fields.creatorId!==uid) throw new Error('You do not own this product.');
  const stamp=nowIso();
  await fsPatch(token,`commerceProducts/${productId}`,{visibility,updatedAt:stamp});
  return {product:{id:productId,...product.fields,visibility,updatedAt:stamp}};
}


export const config = { api: { bodyParser: false } };

async function readRawBody(req:any):Promise<string>{
  if(typeof req.rawBody==='string') return req.rawBody;
  if(Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if(typeof req.body==='string') return req.body;
  const chunks:Buffer[]=[];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}
async function readJsonBody(req:any):Promise<any>{
  const raw=await readRawBody(req); if(!raw)return {};
  try{return JSON.parse(raw);}catch{throw new Error('Invalid JSON request body.');}
}

export default async function handler(req:VercelRequest,res:VercelResponse){
  const action=String(req.query.action||'').trim();
  if(req.method==='GET' && action==='marketplace'){
    try{ const token=await serviceToken(); const out=await marketplaceList(token,req.query||{}); return res.status(200).json(out); }
    catch(e:any){ return res.status(500).json({error:e?.message||'Unable to load marketplace.'}); }
  }
  if(req.method==='GET' && action==='marketplaceHome'){
    try{ const token=await serviceToken(); const out=await marketplaceHome(token); return res.status(200).json(out); }
    catch(e:any){ return res.status(500).json({error:e?.message||'Unable to load marketplace home.'}); }
  }
  if(req.method==='GET' && action==='marketplaceByIds'){
    try{ const token=await serviceToken(); const ids=typeof req.query.ids==='string'?req.query.ids:''; const out=await marketplaceByIds(token,ids); return res.status(200).json(out); }
    catch(e:any){ return res.status(500).json({error:e?.message||'Unable to load saved products.'}); }
  }
  if(req.method==='GET' && action==='listPublicPrices'){
    try{ const token=await serviceToken(); const productId=typeof req.query.productId==='string'?req.query.productId:''; const out=await listPublicPrices(token,productId); return res.status(200).json(out); }
    catch(e:any){ return res.status(500).json({error:e?.message||'Unable to load public prices.'}); }
  }
  if(req.method==='GET' && action==='listPublicProducts'){
    try{ const token=await serviceToken(); const creatorId=typeof req.query.creatorId==='string'?req.query.creatorId:undefined; const out=await listPublicProducts(token,creatorId); return res.status(200).json(out); }
    catch(e:any){ return res.status(500).json({error:e?.message||'Unable to load public products.'}); }
  }
  if(req.method==='GET' && action==='getProductReviews'){ try{ const token=await serviceToken(); const productId=typeof req.query.productId==='string'?req.query.productId:''; const out=await v96ListPublicReviews(token,productId,req.query||{}); return res.status(200).json(out);}catch(e:any){return res.status(Number(e?.statusCode)||400).json({error:e?.message||'Unable to load reviews.'});} }
  if(req.method==='GET' && action==='getReviewAggregate'){ try{ const token=await serviceToken(); const productId=typeof req.query.productId==='string'?req.query.productId:''; const out=await v96GetReviewAggregate(token,productId); return res.status(200).json(out);}catch(e:any){return res.status(Number(e?.statusCode)||400).json({error:e?.message||'Unable to load review aggregate.'});} }
  if(req.method==='GET' && action==='getTrustSignals'){ try{ const token=await serviceToken(); const productId=typeof req.query.productId==='string'?req.query.productId:''; const out=await v96GetTrustSignals(token,productId); return res.status(200).json(out);}catch(e:any){return res.status(Number(e?.statusCode)||400).json({error:e?.message||'Unable to load trust signals.'});} }
  if(req.method==='GET' && action==='getCreatorTrustSignals'){ try{ const token=await serviceToken(); const creatorId=typeof req.query.creatorId==='string'?req.query.creatorId:''; if(!creatorId)throw v96Error('creatorId is required.'); const out=await v96GetCreatorTrustSignals(token,creatorId); return res.status(200).json(out);}catch(e:any){return res.status(Number(e?.statusCode)||400).json({error:e?.message||'Unable to load creator trust signals.'});} }
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(action==='razorpayWebhook') return handleRazorpayWebhook(req,res);
  if(action==='razorpayRouteWebhook') return handleRazorpayRouteWebhook(req,res);
  try{const raw=await readRawBody(req); let body:any={}; try{body=raw?JSON.parse(raw):{};}catch{throw new Error('Invalid JSON request body.');} const identity=await verifyFirebaseToken(authHeader(req)), uid=identity.uid, token=await serviceToken(); let out:any; if(action==='createProduct')out=await createProduct(token,uid,body); else if(action==='createPrice')out=await createPrice(token,uid,body); else if(action==='setProductStatus')out=await setProductStatus(token,uid,body); else if(action==='setProductVisibility')out=await setProductVisibility(token,uid,body); else if(action==='createCheckout')out=await createCheckout(token,uid,body); else if(action==='createSeller')out=await createSeller(token,uid,body); else if(action==='getSeller')out=await getSeller(token,uid); else if(action==='refreshSeller')out=await refreshSeller(token,uid); else if(action==='enableSeller')out=await enableSeller(token,uid); else if(action==='disableSeller')out=await disableSeller(token,uid); else if(action==='adminListSellers')out=await adminListSellers(token,uid,identity.email,identity.emailVerified); else if(action==='adminSetSellerStatus')out=await adminSetSellerStatus(token,uid,body,identity.email,identity.emailVerified); else if(action==='confirmRazorpayPayment'||action==='verifyPayment')out=await confirmRazorpayPayment(token,uid,body); else if(action==='paymentStatus')out=await getRazorpayPaymentStatus(token,uid,body); else if(action==='checkAccess')out=await checkAccess(token,uid,body); else if(action==='diagnostics')out=await commerceDiagnostics(token,uid,identity.email,identity.emailVerified); else if(action==='createCommissionRule')out=await createCommissionRule(token,uid,body,identity.email,identity.emailVerified); else if(action==='updateCommissionRule')out=await updateCommissionRule(token,uid,body,identity.email,identity.emailVerified); else if(action==='setCommissionRuleStatus')out=await setCommissionRuleStatus(token,uid,body,identity.email,identity.emailVerified); else if(action==='listCommissionRules'){if(!(await verifyCommerceAdmin(token,uid,identity.email,identity.emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;} out={rules:await listAllCommissionRules(token)};} else if(action==='simulateCommission')out=await simulateCommission(token,uid,body,identity.email,identity.emailVerified); else if(action==='getOrderFinancials')out=await getOrderFinancials(token,uid,body,identity.email,identity.emailVerified); else if(action==='getCreatorEarnings')out=await getCreatorEarnings(token,uid); else if(action==='adminFinancialSummary')out=await adminFinancialSummary(token,uid,body,identity.email,identity.emailVerified); else if(action==='reconcileCommission')out=await reconcileCommission(token,uid,body,identity.email,identity.emailVerified); else if(action==='getCreatorBalance')out=await getCreatorBalance(token,uid); else if(action==='getCreatorPayouts')out=await listCreatorPayouts(token,uid); else if(action==='getPayout')out=await getPayout(token,uid,body,identity.email,identity.emailVerified); else if(action==='createPayout')out=await createPayout(token,uid,body); else if(action==='approvePayout')out=await approvePayout(token,uid,body,identity.email,identity.emailVerified); else if(action==='markPayoutPaid')out=await markPayoutPaid(token,uid,body,identity.email,identity.emailVerified); else if(action==='rejectPayout')out=await rejectPayout(token,uid,body,identity.email,identity.emailVerified); else if(action==='adminListPayouts')out=await adminListPayouts(token,uid,body,identity.email,identity.emailVerified); else if(action==='reconcilePayout')out=await reconcilePayout(token,uid,body,identity.email,identity.emailVerified); else if(action==='getFinanceSummary'||action==='adminFinanceReport')out=await v95FinanceReport(token,uid,body,identity.email,identity.emailVerified); else if(action==='getRevenueSeries'){const r=await v95FinanceReport(token,uid,body,identity.email,identity.emailVerified);out={series:r.series.revenue,meta:r.meta,generatedAt:r.summary.generatedAt};} else if(action==='getCreatorFinance')out=await v95ListFinanceDimension(token,uid,body,identity.email,identity.emailVerified,'creator'); else if(action==='getProductFinance')out=await v95ListFinanceDimension(token,uid,body,identity.email,identity.emailVerified,'product'); else if(action==='getOrderFinance')out=await v95ListFinanceDimension(token,uid,body,identity.email,identity.emailVerified,'order'); else if(action==='getPayoutFinance')out=await v95ListFinanceDimension(token,uid,body,identity.email,identity.emailVerified,'payout'); else if(action==='getRefundFinance')out=await v95ListFinanceDimension(token,uid,body,identity.email,identity.emailVerified,'refund'); else if(action==='getFinanceHealth')out=await v95FinanceHealth(token,uid,body,identity.email,identity.emailVerified); else if(action==='exportFinance')out=await v95Export(token,uid,body,identity.email,identity.emailVerified); else if(action==='createReview')out=await v96CreateReview(token,uid,body); else if(action==='updateReview')out=await v96UpdateReview(token,uid,body); else if(action==='removeReview')out=await v96RemoveOwnReview(token,uid,body); else if(action==='getReviewEligibility')out=await v96Eligibility(token,uid,String(body.productId||'')); else if(action==='getMyReviews')out=await v96MyReviews(token,uid,body); else if(action==='createCommerceReport')out=await v96CreateReport(token,uid,body); else if(action==='adminModerationQueue')out=await v96ListModerationQueue(token,uid,identity.email,identity.emailVerified,body); else if(action==='adminModerationCase')out=await v96GetModerationCase(token,uid,body,identity.email,identity.emailVerified); else if(action==='adminModerationAction')out=await v96ModerationAction(token,uid,body,identity.email,identity.emailVerified); else if(action==='adminSearchModeration')out=await v96SearchModeration(token,uid,body,identity.email,identity.emailVerified); else if(action==='getTrustHealth')out=await v96TrustHealth(token,uid,body,identity.email,identity.emailVerified); else if(action==='validateReviewAggregates')out=await v96ValidateAggregate(token,uid,body,identity.email,identity.emailVerified); else if(action==='rebuildReviewAggregate')out=await v96RebuildAggregate(token,uid,body,identity.email,identity.emailVerified); else if(action==='getCreatorTrustSignals')out=await v96GetCreatorTrustSignals(token,uid); else return res.status(400).json({error:'Unknown commerce action.'}); return res.status(200).json(out);}catch(e:any){const status=Number(e?.statusCode); return res.status(status>=400&&status<=599?status:400).json({error:e?.message||'Commerce request failed.'});}
}

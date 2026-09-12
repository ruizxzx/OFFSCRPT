import type { VercelRequest, VercelResponse } from '../../server/vercel-types.js';
import crypto from 'node:crypto';
import { getRazorpayConfig, isRazorpayConfigured, razorpayProvider, verifyCapturedPayment } from '../../server/razorpay.js';
import { createLinkedAccount, fetchLinkedAccount, updateLinkedAccount, providerHealth, type RouteBusinessType } from '../../server/razorpay-route.js';
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
async function fsGet(token:string,name:string){const r=await fetch(`${firestoreBase()}/${name}`,{headers:{Authorization:`Bearer ${token}`}}); if(r.status===404)return null; if(!r.ok)throw new Error(`Firestore read failed: ${r.status}`); const j:any=await r.json(); return {name:j.name,fields:decodeFields(j.fields)};}
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
  if(/^(commerceProducts|commercePrices|commerceOrders|commercePayments|commerceRefunds|entitlements|creatorRevenue|creatorPayouts|commerceAuditLogs|commerceWebhookEvents|commerceIdempotency|creatorCommerceProfiles|commerceCommissionRules|commerceFinancialAllocations|users)\//.test(name)) return `projects/${projectId()}/databases/(default)/documents/${name}`;
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
  const user=await fsGet(token,`users/${uid}`); if(!user)throw new Error('Creator profile not found.'); if(!(user.fields.isAuthor===true || user.fields.creatorStatus===true || user.fields.platformRole==='master_admin'))throw new Error('Creator commerce is not configured for this account.');
  const title=String(b.title||'').trim().slice(0,160), description=String(b.description||'').trim().slice(0,5000), type=String(b.type||'digital_product'), visibility=String(b.visibility||'private'), currency=String(b.currency||'INR').toUpperCase();
  if(!title||!['content','digital_product','course','subscription','community','service','bundle','tip'].includes(type))throw new Error('Invalid product.');
  if(!['private','public'].includes(visibility)||!/^[A-Z]{3}$/.test(currency))throw new Error('Invalid product visibility or currency.');
  const productId=crypto.randomUUID(); const priceInput=b.price; const writes=[{create:{name:`${firestoreBase()}/commerceProducts/${productId}`,fields:fields({creatorId:uid,creatorUsername:String(user.fields.username||''),title,description,type,status:'draft',visibility,featured:false,currency,priceIds:[],version:1,createdAt:nowIso(),updatedAt:nowIso()})}}];
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
  if(next==='active' && product.fields.creatorId!=='' && product.fields.creatorId!==uid) throw new Error('Product creator linkage is invalid.');
  if(next==='active'){
    const seller=await getSellerProfile(token,uid);
    if(!seller?.fields?.sellerEnabled || !['active'].includes(String(seller.fields.onboardingStatus||''))) throw new Error('Complete seller onboarding and enable selling before publishing marketplace products.');
  }
  const stamp=nowIso();
  await fsPatch(token,`commerceProducts/${productId}`,{status:next,updatedAt:stamp,...(next==='active'?{publishedAt:product.fields.publishedAt||stamp}:{}) ,...(next==='archived'?{archivedAt:stamp}:{})});
  return {product:{id:productId,...product.fields,status:next,updatedAt:stamp}};
}

async function createPrice(token:string,uid:string,b:any){
  const product=await fsGet(token,`commerceProducts/${String(b.productId||'')}`); if(!product)throw new Error('Product not found.'); if(product.fields.creatorId!==uid)throw new Error('You do not own this product.');
  const currency=String(b.currency||product.fields.currency||'INR').toUpperCase(), amount=Number(b.amount); if(!amountOk(amount)||!/^[A-Z]{3}$/.test(currency))throw new Error('Invalid price.');
  const priceId=crypto.randomUUID(); const price={id:priceId,productId:String(b.productId),amount,currency,billingType:b.billingType==='recurring'?'recurring':'one_time',interval:b.interval,intervalCount:Math.max(1,Math.min(12,Number(b.intervalCount||1))),trialDays:Math.max(0,Math.min(365,Number(b.trialDays||0))),active:Boolean(b.active!==false),createdAt:nowIso(),updatedAt:nowIso()};
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commercePrices/${priceId}`,fields:fields(price)}},{update:{name:`${firestoreBase()}/commerceProducts/${price.productId}`,fields:fields({priceIds:[...(Array.isArray(product.fields.priceIds)?product.fields.priceIds:[]),priceId],updatedAt:nowIso()})}}]); return {price};
}



const ROUTE_BUSINESS_TYPES = new Set<RouteBusinessType>([
  'individual','proprietorship','partnership','llp','private_limited','public_limited','trust','society','ngo'
]);

function sellerIdFor(uid:string){ return `seller_${uid}`; }
function sanitizeSellerStatus(status:string){ return ['not_started','collecting_information','creating_account','created','pending_review','active','suspended','rejected','error','reconciliation_required'].includes(status) ? status : 'error'; }

function validateSellerInput(b:any){
  const email=String(b.email||'').trim().toLowerCase();
  const phone=String(b.phone||'').replace(/[^\d+]/g,'');
  const legalBusinessName=String(b.legalBusinessName||'').trim();
  const customerFacingBusinessName=String(b.customerFacingBusinessName||legalBusinessName).trim();
  const contactName=String(b.contactName||'').trim();
  const businessType=String(b.businessType||'').trim() as RouteBusinessType;
  const category=String(b.category||'digital_goods').trim();
  const subcategory=String(b.subcategory||'digital_products').trim();
  const description=String(b.description||'Digital products sold through OFFSCRPT.').trim();
  const street1=String(b.street1||'').trim();
  const street2=String(b.street2||'').trim();
  const city=String(b.city||'').trim();
  const state=String(b.state||'').trim();
  const postalCode=String(b.postalCode||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid business email.');
  if(phone.replace(/\D/g,'').length<8 || phone.replace(/\D/g,'').length>15) throw new Error('Enter a valid business phone number.');
  if(legalBusinessName.length<4) throw new Error('Legal business name must contain at least 4 characters.');
  if(customerFacingBusinessName.length<1) throw new Error('Customer-facing business name is required.');
  if(contactName.length<4) throw new Error('Contact name must contain at least 4 characters.');
  if(!ROUTE_BUSINESS_TYPES.has(businessType)) throw new Error('Select a supported business type.');
  if(!street1||!city||!state||!postalCode) throw new Error('Complete the registered business address.');
  if(postalCode.length<4 || postalCode.length>20) throw new Error('Enter a valid postal code.');
  return {email,phone,legalBusinessName,customerFacingBusinessName,contactName,businessType,category,subcategory,description,street1,street2,city,state,postalCode};
}

async function getSellerProfile(token:string,uid:string){
  const sellerId=sellerIdFor(uid);
  return fsGet(token,`creatorCommerceProfiles/${uid}`);
}

async function createSeller(token:string,uid:string,b:any){
  const input=validateSellerInput(b);
  const existing=await getSellerProfile(token,uid);
  if(existing?.fields?.razorpayAccountId){
    return {seller:{id:sellerIdFor(uid),...existing.fields},reused:true};
  }
  const started=nowIso();
  const sellerId=sellerIdFor(uid);
  try {
    await fsCommit(token,[{
      create:{name:`${firestoreBase()}/creatorCommerceProfiles/${uid}`,fields:fields({
        creatorId:uid,sellerId,sellerEnabled:false,onboardingStatus:'creating_account',health:'pending',
        email:input.email,phone:input.phone,legalBusinessName:input.legalBusinessName,
        customerFacingBusinessName:input.customerFacingBusinessName,businessType:input.businessType,
        category:input.category,subcategory:input.subcategory,description:input.description,
        address:{street1:input.street1,street2:input.street2,city:input.city,state:input.state,postalCode:input.postalCode,country:'IN'},
        referenceId:sellerId.replace(/^seller_/,'').slice(0,20),createdAt:started,updatedAt:started
      })}
    }]);
  } catch (error:any) {
    // A concurrent onboarding request may have created the canonical seller first.
    const raced=await getSellerProfile(token,uid);
    if(raced) return {seller:{id:sellerId,creatorId:uid,...raced.fields},reused:true};
    throw error;
  }
  try{
    const account=await createLinkedAccount({
      email:input.email,phone:input.phone,legalBusinessName:input.legalBusinessName,
      customerFacingBusinessName:input.customerFacingBusinessName,businessType:input.businessType,
      referenceId:sellerId.replace(/^seller_/,'').slice(0,20),contactName:input.contactName,
      category:input.category,subcategory:input.subcategory,description:input.description,
      registeredAddress:{street1:input.street1,street2:input.street2,city:input.city,state:input.state,postalCode:input.postalCode,country:'IN'},
      website:String(process.env.OFFSCRPT_PRODUCTION_URL||'https://offscrpt.vercel.app')
    });
    const accountId=String(account?.id||'');
    if(!/^acc_/.test(accountId)) throw new Error('Razorpay did not return a Linked Account ID.');
    const providerStatus=String(account?.status||'created');
    const onboardingStatus=providerStatus==='suspended'?'suspended':'created';
    const health=providerHealth(accountId,providerStatus);
    const updated=nowIso();
    await fsPatch(token,`creatorCommerceProfiles/${uid}`,{
      razorpayAccountId:accountId,razorpayAccountStatus:providerStatus,
      onboardingStatus,health,sellerEnabled:false,verifiedAt:undefined,updatedAt:updated
    });
    await fsCommit(token,[{
      create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${uid}:created`)}`,fields:fields({
        actorId:uid,actorType:'creator',targetType:'seller',targetId:sellerId,event:'seller_onboarding_account_created',
        timestamp:updated,metadata:{provider:'razorpay',razorpayAccountId:accountId}
      })}
    }]);
    return {seller:{id:sellerId,creatorId:uid,razorpayAccountId:accountId,razorpayAccountStatus:providerStatus,onboardingStatus,health,sellerEnabled:false},message:'Linked Account created. Complete any required Razorpay verification/KYC before selling is enabled.'};
  }catch(error:any){
    await fsPatch(token,`creatorCommerceProfiles/${uid}`,{onboardingStatus:'reconciliation_required',health:'reconciliation_required',lastError:String(error?.message||'Seller creation failed.').slice(0,500),updatedAt:nowIso()});
    throw error;
  }
}

async function getSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid);
  if(!seller)return {seller:{id:sellerIdFor(uid),creatorId:uid,sellerEnabled:false,onboardingStatus:'not_started',health:'not_started'}};
  return {seller:{id:sellerIdFor(uid),...seller.fields}};
}

async function refreshSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid);
  if(!seller) return getSeller(token,uid);
  const accountId=String(seller.fields.razorpayAccountId||'');
  if(!accountId) return getSeller(token,uid);
  const account=await fetchLinkedAccount(accountId);
  const providerStatus=String(account?.status||'created');
  const health=providerHealth(accountId,providerStatus);
  const onboardingStatus=providerStatus==='suspended'?'suspended':(seller.fields.sellerEnabled===true?'active':'pending_review');
  const stamp=nowIso();
  await fsPatch(token,`creatorCommerceProfiles/${uid}`,{razorpayAccountStatus:providerStatus,health,onboardingStatus,updatedAt:stamp});
  return {seller:{id:sellerIdFor(uid),...seller.fields,razorpayAccountStatus:providerStatus,health,onboardingStatus,updatedAt:stamp},provider:{accountId,status:providerStatus}};
}

async function disableSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid);
  if(!seller) throw new Error('Seller profile not found.');
  const stamp=nowIso();
  await fsPatch(token,`creatorCommerceProfiles/${uid}`,{sellerEnabled:false,onboardingStatus:'created',updatedAt:stamp});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${uid}:disabled:${stamp}`)}`,fields:fields({actorId:uid,actorType:'creator',targetType:'seller',targetId:sellerIdFor(uid),event:'seller_disabled',timestamp:stamp,metadata:{}})}}]);
  return {seller:{id:sellerIdFor(uid),...seller.fields,sellerEnabled:false,onboardingStatus:'created',updatedAt:stamp}};
}

async function enableSeller(token:string,uid:string){
  const seller=await getSellerProfile(token,uid);
  if(!seller?.fields?.razorpayAccountId) throw new Error('Connect your Razorpay seller account first.');
  if(String(seller.fields.razorpayAccountStatus||'')==='suspended') throw new Error('This Razorpay seller account is suspended.');
  const account=await fetchLinkedAccount(String(seller.fields.razorpayAccountId));
  if(String(account?.status||'created')==='suspended') throw new Error('Razorpay has suspended this seller account.');
  const stamp=nowIso();
  await fsPatch(token,`creatorCommerceProfiles/${uid}`,{sellerEnabled:true,onboardingStatus:'active',health:'ready',verifiedAt:stamp,updatedAt:stamp});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${uid}:enabled:${stamp}`)}`,fields:fields({actorId:uid,actorType:'creator',targetType:'seller',targetId:sellerIdFor(uid),event:'seller_enabled',timestamp:stamp,metadata:{provider:'razorpay',razorpayAccountId:String(seller.fields.razorpayAccountId)}})}}]);
  return {seller:{id:sellerIdFor(uid),...seller.fields,sellerEnabled:true,onboardingStatus:'active',health:'ready',updatedAt:stamp}};
}

async function adminListSellers(token:string,uid:string,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const rows=await fsRunQuery(token,'creatorCommerceProfiles',[]);
  return {sellers:rows.map(x=>({id:String(x.name).split('/').pop(),...x.fields}))};
}

async function adminSetSellerStatus(token:string,uid:string,b:any,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;}
  const creatorId=String(b.creatorId||'').trim(); const status=String(b.status||'').trim();
  if(!creatorId||!['active','suspended','created'].includes(status)) throw new Error('Invalid seller status request.');
  const seller=await getSellerProfile(token,creatorId); if(!seller) throw new Error('Seller profile not found.');
  if(status==='active' && !seller.fields.razorpayAccountId) throw new Error('Seller does not have a Razorpay account.');
  if(status==='active'){
    const account=await fetchLinkedAccount(String(seller.fields.razorpayAccountId));
    if(String(account?.status||'created')==='suspended') throw new Error('Razorpay has suspended this seller account.');
  }
  const enabled=status==='active';
  const stamp=nowIso();
  await fsPatch(token,`creatorCommerceProfiles/${creatorId}`,{sellerEnabled:enabled,onboardingStatus:status==='suspended'?'suspended':(enabled?'active':'created'),health:status==='suspended'?'suspended':(enabled?'ready':'pending'),updatedAt:stamp});
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`seller:${creatorId}:${status}:${stamp}`)}`,fields:fields({actorId:uid,actorType:'admin',targetType:'seller',targetId:sellerIdFor(creatorId),event:`seller_${status}`,timestamp:stamp,metadata:{}})}}]);
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
  const seller=await getSellerProfile(token,creatorId); const sellerId=String(seller?.fields?.sellerId||sellerIdFor(creatorId)); const accountId=String(seller?.fields?.razorpayAccountId||'');
  const rule=await resolveCommissionRule(token,productId,creatorId,atIso);
  if(!seller||!accountId||!rule){
    const reason=!seller?'Seller profile missing.':!accountId?'Razorpay seller account mapping missing.':'No applicable commission rule is configured for this transaction.';
    const pending={allocationId:baseId,entryType:'sale',orderId,paymentId,creatorId,sellerId,razorpayAccountId:accountId||null,productId,priceId,grossAmount:gross,grossAmountSubunits:subunitsFromMajor(gross,currency),platformCommissionAmount:null,platformCommissionAmountSubunits:null,creatorNetAmount:null,creatorNetAmountSubunits:null,currency,commissionRuleId:null,commissionRuleVersion:null,financialStatus:'reconciliation_required',transferStatus:'not_started',lastError:reason,createdAt:existing?.fields.createdAt||nowIso(),updatedAt:nowIso()};
    if(existing) await fsPatch(token,`commerceFinancialAllocations/${baseId}`,pending); else {try{await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceFinancialAllocations/${baseId}`,fields:fields(pending)}}]);}catch{const again=await fsGet(token,`commerceFinancialAllocations/${baseId}`); if(again)return {id:baseId,...again.fields};}}
    await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_reconciliation:${orderId}`)}`,fields:fields({actorId:creatorId,actorType:'system',targetType:'financial_allocation',targetId:baseId,event:'commission_reconciliation_required',timestamp:nowIso(),metadata:{reason}})}}]).catch(()=>{});
    return {id:baseId,...pending};
  }
  const calc=calculateCommission(gross,currency,rule); const now=nowIso();
  const allocation={allocationId:baseId,entryType:'sale',orderId,paymentId,creatorId,sellerId,razorpayAccountId:accountId,productId,priceId,grossAmount:gross,grossAmountSubunits:calc.grossAmountSubunits,platformCommissionAmount:calc.platformCommissionAmount,platformCommissionAmountSubunits:calc.platformCommissionAmountSubunits,creatorNetAmount:calc.creatorNetAmount,creatorNetAmountSubunits:calc.creatorNetAmountSubunits,currency,commissionRuleId:rule.ruleId,commissionRuleVersion:rule.ruleVersion,commissionSnapshot:{ruleId:rule.ruleId,ruleVersion:rule.ruleVersion,ruleType:rule.percentageBps>0&&rule.fixedAmount>0?'percentage_plus_fixed':rule.fixedAmount>0?'fixed':'percentage',percentage:rule.percentage,percentageBps:rule.percentageBps,fixedAmount:rule.fixedAmount,effectiveFrom:rule.effectiveFrom,grossAmountSubunits:calc.grossAmountSubunits,commissionAmountSubunits:calc.platformCommissionAmountSubunits,creatorNetAmountSubunits:calc.creatorNetAmountSubunits,currency,calculatedAt:now},financialStatus:'calculated',transferStatus:'not_started',createdAt:existing?.fields.createdAt||now,updatedAt:now};
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
  try { return await ensureFinancialAllocation(token,orderId,paymentId); }
  catch(error:any) {
    const allocationId=stableId('fin',orderId); const now=nowIso(); const fallback={allocationId,entryType:'sale',orderId,paymentId,financialStatus:'reconciliation_required',transferStatus:'not_started',lastError:String(error?.message||'Financial allocation failed.').slice(0,500),createdAt:now,updatedAt:now};
    const existing=await fsGet(token,`commerceFinancialAllocations/${allocationId}`).catch(()=>null);
    if(existing) await fsPatch(token,`commerceFinancialAllocations/${allocationId}`,fallback).catch(()=>{}); else await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceFinancialAllocations/${allocationId}`,fields:fields(fallback)}}]).catch(()=>{});
    await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceAuditLogs/${stableId('audit',`commission_error:${orderId}:${now}`)}`,fields:fields({actorId:'system',actorType:'system',targetType:'financial_allocation',targetId:allocationId,event:'commission_error',timestamp:now,metadata:{message:fallback.lastError}})}}]).catch(()=>{});
    return fallback;
  }
}

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
  if(product.fields.status!=='active' || product.fields.visibility!=='public')throw new Error('Product is not available.');
  if(price.fields.productId!==product.name.split('/').pop())throw new Error('Price does not belong to product.');
  if(String(price.fields.currency||'').toUpperCase()!==String(product.fields.currency||'').toUpperCase())throw new Error('Price currency does not match product currency.');
  if(price.fields.active!==true)throw new Error('Price is inactive.');
  if(String(price.fields.billingType||'one_time')!=='one_time')throw new Error('Recurring products are not supported by V90 one-time checkout.');
  const amount=Number(price.fields.amount),currency=String(price.fields.currency||product.fields.currency||'INR').toUpperCase();
  razorpayProvider.amountSubunit(amount,currency);
  const seller=await getSellerProfile(token,String(product.fields.creatorId||''));
  if(!seller?.fields?.sellerEnabled || String(seller.fields.onboardingStatus||'')!=='active' || !seller.fields.razorpayAccountId) throw new Error('This creator is not currently enabled for marketplace selling.');
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
  const order:any={customerId:uid,creatorId:String(product.fields.creatorId||''),items:[item],subtotal:amount,discount:0,tax:0,fees:0,total:amount,currency,status:'pending_payment',paymentId,createdAt,updatedAt:createdAt,provider:'razorpay',metadata:{paymentProvider:'razorpay',checkoutIdempotencyKey:key}};
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
  const accountId=String(payload?.account_id||payload?.payload?.transfer?.entity?.recipient||'');
  const transfer=payload?.payload?.transfer?.entity;
  const recipient=String(transfer?.recipient||accountId);
  if(recipient){
    const sellers=await fsRunQuery(token,'creatorCommerceProfiles',[{field:{fieldPath:'razorpayAccountId'},op:'EQUAL',value:{stringValue:recipient}}]);
    if(sellers[0]){
      const creatorId=String(sellers[0].fields.creatorId||String(sellers[0].name).split('/').pop());
      await fsPatch(token,`creatorCommerceProfiles/${creatorId}`,{
        lastRouteEvent:eventType,lastRouteEventAt:nowIso(),
        lastTransferId:String(transfer?.id||''),lastTransferStatus:String(transfer?.status||''),
        lastSettlementId:String(transfer?.recipient_settlement_id||'')
      });
    }
  }
  await fsCommit(token,[{create:{name:`${firestoreBase()}/commerceWebhookEvents/${eventDocId}`,fields:fields({
    event:eventType,provider:'razorpay_route',providerEventId:eventId,accountId,createdAt:nowIso(),
    metadata:{transferId:String(transfer?.id||''),status:String(transfer?.status||'')}
  })}}]);
  return res.status(200).json({received:true});
}

function fsFilter(fieldPath:string, op:string, v:any){
  return {field:{fieldPath},op,value:v};
}

function decodeCursor(raw:string|undefined): {id:string;sortKey:string}|null {
  if(!raw) return null;
  try { const parsed=JSON.parse(Buffer.from(raw,'base64url').toString('utf8')); if(!parsed || typeof parsed.id!=='string') return null; return {id:parsed.id,sortKey:String(parsed.sortKey??'')}; } catch { return null; }
}
function encodeCursor(id:string,sortKey:string){ return Buffer.from(JSON.stringify({id,sortKey}),'utf8').toString('base64url'); }

async function fsRunQueryAdvanced(token:string, from:string, filters:any[] = [], options:{limit?:number;orderBy?:Array<{fieldPath:string;direction:'ASCENDING'|'DESCENDING'}>}={}){
  const filterParts=filters.map((x:any)=>({fieldFilter:{field:x.field,op:x.op,value:x.value}}));
  const where=filterParts.length===1?filterParts[0]:filterParts.length>1?{compositeFilter:{op:'AND',filters:filterParts}}:undefined;
  const structured:any={from:[{collectionId:from}]};
  if(where) structured.where=where;
  if(options.orderBy?.length) structured.orderBy=options.orderBy.map(x=>({field:{fieldPath:x.fieldPath},direction:x.direction}));
  structured.limit=Math.max(1,Math.min(300,Number(options.limit||50)));
  const r=await fetch(`${firestoreBase()}:runQuery`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({structuredQuery:structured})});
  if(!r.ok){const text=await r.text();throw new Error(`Firestore query failed: ${r.status} ${text.slice(0,500)}`);}
  const rows:any[]=await r.json();
  return rows.filter(x=>x.document).map(x=>({name:x.document.name,fields:decodeFields(x.document.fields)}));
}

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
  let products=rows.map(x=>publicProductProjection({id:x.name.split('/').pop(),...x.fields}))
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
    try{const rows=await fsRunQueryAdvanced(token,'commerceProducts',[fsFilter('status','EQUAL',{stringValue:'active'}),fsFilter('visibility','EQUAL',{stringValue:'public'}),fsFilter('__name__','IN',{arrayValue:{values:chunk.map(id=>({referenceValue:`projects/${projectId()}/databases/(default)/documents/commerceProducts/${id}`}))}})],{limit:30}); all.push(...rows.map(x=>publicProductProjection({id:x.name.split('/').pop(),...x.fields})));}
    catch{for(const id of chunk){const row=await fsGet(token,`commerceProducts/${id}`); if(row?.fields?.status==='active'&&row?.fields?.visibility==='public')all.push(publicProductProjection({id,...row.fields}));}}
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
  if(!product || product.fields.status!=='active' || product.fields.visibility!=='public') return {generatedAt:nowIso(),prices:[]};
  const rows=await fsRunQuery(token,'commercePrices',[{field:{fieldPath:'productId'},op:'EQUAL',value:{stringValue:id}}]);
  const prices=rows.map(x=>({id:x.name.split('/').pop(),...x.fields})).filter((p:any)=>p.active===true).map((p:any)=>({
    id:String(p.id||''),productId:id,amount:Number(p.amount||0),currency:String(p.currency||product.fields.currency||'INR'),billingType:p.billingType==='recurring'?'recurring':'one_time',interval:p.interval,intervalCount:p.intervalCount?Number(p.intervalCount):undefined,trialDays:p.trialDays?Number(p.trialDays):undefined,active:true,validFrom:p.validFrom,validUntil:p.validUntil,createdAt:p.createdAt,updatedAt:p.updatedAt
  })).sort((a:any,b:any)=>a.amount-b.amount);
  return {generatedAt:nowIso(),prices:prices.slice(0,50)};
}

async function commerceDiagnostics(token:string,uid:string,email?:string,emailVerified?:boolean){
  if(!(await verifyCommerceAdmin(token,uid,email,emailVerified))) { const error:any=new Error('Administrator access required.'); error.statusCode=403; throw error; }
  const names=['commerceProducts','commercePrices','commerceOrders','commercePayments','commerceRefunds','entitlements','creatorRevenue','creatorPayouts','creatorCommerceProfiles','commerceCommissionRules','commerceFinancialAllocations','commerceAuditLogs','commerceWebhookEvents'];
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
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(action==='razorpayWebhook') return handleRazorpayWebhook(req,res);
  if(action==='razorpayRouteWebhook') return handleRazorpayRouteWebhook(req,res);
  try{const raw=await readRawBody(req); let body:any={}; try{body=raw?JSON.parse(raw):{};}catch{throw new Error('Invalid JSON request body.');} const identity=await verifyFirebaseToken(authHeader(req)), uid=identity.uid, token=await serviceToken(); let out:any; if(action==='createProduct')out=await createProduct(token,uid,body); else if(action==='createPrice')out=await createPrice(token,uid,body); else if(action==='setProductStatus')out=await setProductStatus(token,uid,body); else if(action==='setProductVisibility')out=await setProductVisibility(token,uid,body); else if(action==='createCheckout')out=await createCheckout(token,uid,body); else if(action==='createSeller')out=await createSeller(token,uid,body); else if(action==='getSeller')out=await getSeller(token,uid); else if(action==='refreshSeller')out=await refreshSeller(token,uid); else if(action==='enableSeller')out=await enableSeller(token,uid); else if(action==='disableSeller')out=await disableSeller(token,uid); else if(action==='adminListSellers')out=await adminListSellers(token,uid,identity.email,identity.emailVerified); else if(action==='adminSetSellerStatus')out=await adminSetSellerStatus(token,uid,body,identity.email,identity.emailVerified); else if(action==='confirmRazorpayPayment'||action==='verifyPayment')out=await confirmRazorpayPayment(token,uid,body); else if(action==='paymentStatus')out=await getRazorpayPaymentStatus(token,uid,body); else if(action==='checkAccess')out=await checkAccess(token,uid,body); else if(action==='diagnostics')out=await commerceDiagnostics(token,uid,identity.email,identity.emailVerified); else if(action==='createCommissionRule')out=await createCommissionRule(token,uid,body,identity.email,identity.emailVerified); else if(action==='updateCommissionRule')out=await updateCommissionRule(token,uid,body,identity.email,identity.emailVerified); else if(action==='setCommissionRuleStatus')out=await setCommissionRuleStatus(token,uid,body,identity.email,identity.emailVerified); else if(action==='listCommissionRules'){if(!(await verifyCommerceAdmin(token,uid,identity.email,identity.emailVerified))){const e:any=new Error('Admin access required.'); e.statusCode=403; throw e;} out={rules:await listAllCommissionRules(token)};} else if(action==='simulateCommission')out=await simulateCommission(token,uid,body,identity.email,identity.emailVerified); else if(action==='getOrderFinancials')out=await getOrderFinancials(token,uid,body,identity.email,identity.emailVerified); else if(action==='getCreatorEarnings')out=await getCreatorEarnings(token,uid); else if(action==='adminFinancialSummary')out=await adminFinancialSummary(token,uid,body,identity.email,identity.emailVerified); else if(action==='reconcileCommission')out=await reconcileCommission(token,uid,body,identity.email,identity.emailVerified); else return res.status(400).json({error:'Unknown commerce action.'}); return res.status(200).json(out);}catch(e:any){const status=Number(e?.statusCode); return res.status(status>=400&&status<=599?status:400).json({error:e?.message||'Commerce request failed.'});}
}

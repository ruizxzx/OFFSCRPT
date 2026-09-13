import type { VercelRequest, VercelResponse } from '../server/vercel-types.js';
import crypto from 'node:crypto';
import {
  serviceToken, verifyFirebaseToken, fsGet, fsCommit, fsQuery,
  r2ProductConfig, r2PresignedUrl, productLimits, isBlockedFile, safeName, fileExtension, storageKey, fields, nowIso
} from '../server/digital-products-server.js';

const PRODUCT_TYPES = new Set(['pdf','ebook','template','spreadsheet','presentation','document','zip','research_pack','dataset','prompt_pack','design_assets','audio','video','guide','checklist','worksheet','resource_pack','other']);
const STATUSES = new Set(['draft','pending_review','published','rejected','archived','suspended']);
const VISIBILITIES = new Set(['public','unlisted','private']);
const LICENSES = new Set(['personal','commercial','extended_commercial','educational','team']);
const FILE_ROLES = new Set(['preview','cover','product_file','documentation']);
const RESOURCE_TYPES = new Set(['upload','external']);
const LINK_PROVIDERS = new Set(['google_drive','dropbox','notion','github','other']);
const MAX_RESOURCE_NAME = 60;
function cleanDisplayName(raw:any){ const value=String(raw??'').replace(/\s+/g,' ').trim(); if(!value) throw new Error('Resource name is required.'); if(value.length>MAX_RESOURCE_NAME) throw new Error(`Resource name must be ${MAX_RESOURCE_NAME} characters or fewer.`); return value; }
function detectLinkProvider(raw:string){ try{ const host=new URL(raw).hostname.toLowerCase(); if(host==='drive.google.com' || host.endsWith('.drive.google.com')) return 'google_drive'; if(host==='dropbox.com'||host.endsWith('.dropbox.com')) return 'dropbox'; if(host==='notion.so'||host.endsWith('.notion.so')) return 'notion'; if(host==='github.com'||host.endsWith('.github.com')) return 'github'; return 'other'; }catch{return 'other';} }
function cleanExternalUrl(raw:any){ const value=String(raw??'').trim(); if(!value||value.length>2048) throw new Error('Enter a valid HTTPS resource URL.'); let u:URL; try{u=new URL(value);}catch{throw new Error('Enter a valid HTTPS resource URL.');} if(u.protocol!=='https:') throw new Error('Resource URL must use HTTPS.'); return value; }
function isPurchasableResourceStatus(f:any,purchasedAt:string){ const status=String(f.status||''); if(status==='ready') return true; if(status!=='archived') return false; const archivedAt=Date.parse(String(f.archivedAt||'')); const bought=Date.parse(String(purchasedAt||'')); return Number.isFinite(archivedAt)&&Number.isFinite(bought)?bought<=archivedAt:false; }
async function assertOwnedResource(adminToken:string,uid:string,resourceId:string){ const r=await fsGet(adminToken,`digitalProductFiles/${resourceId}`); if(!r) throw new Error('Resource not found.'); const f:any=r.fields||{}; const productId=String(f.productId||''); const product=productId?await fsGet(adminToken,`commerceProducts/${productId}`):null; if(!product) throw new Error('Product not found.'); if(String(product.fields.creatorId||'')!==uid||String(f.creatorId||'')!==uid||String(f.productId||'')!==productId) throw new Error('You do not own this resource.'); if(String(f.resourceType||'upload')!=='upload'&&String(f.resourceType||'')!=='external') throw new Error('Invalid resource type.'); return {resource:r,product}; }
async function recomputeVersionResourceCounts(adminToken:string,versionId:string,productId:string){ const rows=await fsQuery(adminToken,'digitalProductFiles',[{field:{fieldPath:'versionId'},op:'EQUAL',value:{stringValue:versionId}}]); const uploads=rows.filter(r=>String(r.fields?.resourceType||'upload')==='upload'&&String(r.fields?.status||'')==='ready'); const totalSize=uploads.reduce((n,r)=>n+Math.max(0,Number(r.fields?.sizeBytes||0)),0); const version=await fsGet(adminToken,`digitalProductVersions/${versionId}`); if(version) await fsPatch(adminToken,`digitalProductVersions/${versionId}`,{fileCount:uploads.length,totalSizeBytes:totalSize,updatedAt:nowIso()}); const product=await fsGet(adminToken,`commerceProducts/${productId}`); if(product&&String(product.fields.currentVersionId||'')===versionId) await fsPatch(adminToken,`commerceProducts/${productId}`,{fileCount:uploads.length,totalSizeBytes:totalSize,updatedAt:nowIso()}); return {fileCount:uploads.length,totalSizeBytes:totalSize}; }


function auth(req:VercelRequest){ return String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim(); }
function okJson(res:VercelResponse,data:any){ return res.status(200).json(data); }
function fail(res:VercelResponse,status:number,error:string,code='BAD_REQUEST',retryable=false){ return res.status(status).json({error,code,retryable}); }
function idKey(uid:string,key:string){ return crypto.createHash('sha256').update(`${uid}:${key}`).digest('hex').slice(0,48); }

async function getUser(adminToken:string,uid:string){
  return fsGet(adminToken,`users/${uid}`);
}
async function requireVendor(adminToken:string,uid:string){
  const user=await getUser(adminToken,uid);
  if(!user) throw new Error('Creator profile not found.');
  const f:any=user.fields||{};
  const eligible = f.platformRole==='master_admin' || f.isAuthor===true || f.creatorStatus===true || f.vendorStatus==='active';
  if(!eligible) throw new Error('Vendor access is not configured for this account.');
  if(f.vendorStatus==='suspended' || f.vendorStatus==='rejected') throw new Error('Vendor account is not allowed to publish products.');
  return {user, vendorStatus:f.vendorStatus==='active'?'active':'active'};
}
function parseBody(req:VercelRequest){ return typeof req.body==='string'?JSON.parse(req.body):(req.body||{}); }

async function createProduct(adminToken:string,uid:string,b:any){
  const {user}=await requireVendor(adminToken,uid);
  const title=String(b.title||'').trim();
  const description=String(b.description||'').trim();
  const currency=String(b.currency||'INR').toUpperCase();
  const subtype=String(b.subtype||'other');
  const visibility=String(b.visibility||'private');
  const category=String(b.category||'').trim().slice(0,80);
  const subcategory=String(b.subcategory||'').trim().slice(0,80);
  const tags=Array.isArray(b.tags)?[...new Set(b.tags.map((x:any)=>String(x).trim().toLowerCase()).filter(Boolean))].slice(0,20):[];
  const amount=Number(b.amount);
  if(title.length<2||title.length>160) throw new Error('Title must contain 2–160 characters.');
  if(description.length<10||description.length>5000) throw new Error('Description must contain 10–5000 characters.');
  if(!PRODUCT_TYPES.has(subtype)) throw new Error('Invalid digital product type.');
  if(!VISIBILITIES.has(visibility)) throw new Error('Invalid product visibility.');
  if(!category) throw new Error('Select a product category.');
  if(!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency.');
  if(!Number.isSafeInteger(amount)||amount<=0||amount>10_000_000_000) throw new Error('Enter a valid price in minor currency units.');
  const productId=crypto.randomUUID(), versionId=crypto.randomUUID(), priceId=crypto.randomUUID(), now=nowIso();
  const product={
    creatorId:uid, creatorUsername:String(user.fields.username||''), creatorDisplayName:String(user.fields.displayName||user.fields.name||''),
    title, subtitle:String(b.subtitle||'').trim().slice(0,220), description, type:'digital_product', subtype,
    status:'draft', visibility, category, subcategory, tags,
    thumbnail:String(b.thumbnail||'').trim(), gallery:Array.isArray(b.gallery)?b.gallery.filter((x:any)=>typeof x==='string').slice(0,12):[],
    preview:b.preview||null, version:1, currentVersionId:versionId, currentVersionNumber:1,
    license:LICENSES.has(String(b.license))?String(b.license):'personal',
    usageRestrictions:String(b.usageRestrictions||'').trim().slice(0,2000),
    requirements:String(b.requirements||'').trim().slice(0,2000),
    whatIsIncluded:String(b.whatIsIncluded||'').trim().slice(0,3000),
    fileCount:0, totalSizeBytes:0, reviewStatus:'not_required',
    createdAt:now, updatedAt:now
  };
  const price={productId,amount,currency,billingType:'one_time',active:true,createdAt:now,updatedAt:now};
  const versionDoc={productId,creatorId:uid,versionNumber:1,versionLabel:'1.0',changelog:'',status:'draft',fileIds:[],fileCount:0,totalSizeBytes:0,createdAt:now,updatedAt:now};
  const audit={actorId:uid,actorType:'vendor',targetType:'product',targetId:productId,event:'productCreated',timestamp:now,metadata:{type:'digital_product'}};
  await fsCommit(adminToken,[
    {create:{name:`commerceProducts/${productId}`,fields:fields({...product,priceIds:[priceId]})}},
    {create:{name:`commercePrices/${priceId}`,fields:fields(price)}},
    {create:{name:`digitalProductVersions/${versionId}`,fields:fields(versionDoc)}},
    {create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields(audit)}}
  ]);
  return {product:{id:productId,...product,priceIds:[priceId]},price:{id:priceId,...price},version:{id:versionId,...versionDoc}};
}

async function updateProduct(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||'').trim(); if(!productId) throw new Error('productId is required.');
  const product=await fsGet(adminToken,`commerceProducts/${productId}`);
  if(!product) throw new Error('Product not found.');
  if(product.fields.creatorId!==uid) throw new Error('You do not own this product.');
  const allowed:any={};
  const stringFields=['title','subtitle','description','category','subcategory','thumbnail','requirements','whatIsIncluded','usageRestrictions'];
  for(const k of stringFields) if(b[k]!==undefined) allowed[k]=String(b[k]).trim().slice(0,k==='description'?5000:k==='title'?160:3000);
  if(b.tags!==undefined) allowed.tags=Array.isArray(b.tags)?[...new Set(b.tags.map((x:any)=>String(x).trim().toLowerCase()).filter(Boolean))].slice(0,20):[];
  if(b.visibility!==undefined){const v=String(b.visibility);if(!VISIBILITIES.has(v))throw new Error('Invalid visibility.');allowed.visibility=v;}
  if(b.license!==undefined){const v=String(b.license);if(!LICENSES.has(v))throw new Error('Invalid license.');allowed.license=v;}
  if(b.subtype!==undefined){const v=String(b.subtype);if(!PRODUCT_TYPES.has(v))throw new Error('Invalid digital product type.');allowed.subtype=v;}
  if(b.gallery!==undefined) allowed.gallery=Array.isArray(b.gallery)?b.gallery.filter((x:any)=>typeof x==='string').slice(0,12):[];
  if(Object.keys(allowed).length===0) throw new Error('No editable product fields were provided.');
  allowed.updatedAt=nowIso();
  const expectedUpdatedAt=String(b.expectedUpdatedAt||'');
  if(expectedUpdatedAt && String(product.fields.updatedAt||'')!==expectedUpdatedAt) throw new Error('This product was updated elsewhere. Reload before saving.');
  await fsCommit(adminToken,[{update:{name:`commerceProducts/${productId}`,fields:fields(allowed)}}]);
  return {product:{id:productId,...product.fields,...allowed}};
}

async function createVersion(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||''); const product=await fsGet(adminToken,`commerceProducts/${productId}`);
  if(!product) throw new Error('Product not found.'); if(product.fields.creatorId!==uid) throw new Error('You do not own this product.');
  const current=Number(product.fields.currentVersionNumber||product.fields.version||1); const versionNumber=current+1;
  const versionId=crypto.randomUUID(),now=nowIso();
  const version={productId,creatorId:uid,versionNumber,versionLabel:String(b.versionLabel||`${Math.floor(versionNumber)}.0`).slice(0,40),changelog:String(b.changelog||'').trim().slice(0,5000),status:'draft',fileIds:[],fileCount:0,totalSizeBytes:0,createdAt:now,updatedAt:now};
  const audit={actorId:uid,actorType:'vendor',targetType:'product_version',targetId:versionId,event:'versionCreated',timestamp:now,metadata:{productId,versionNumber}};
  await fsCommit(adminToken,[
    {create:{name:`digitalProductVersions/${versionId}`,fields:fields(version)}},
    {create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields(audit)}}
  ]);
  return {version:{id:versionId,...version}};
}

async function requestUpload(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||''), versionId=String(b.versionId||'');
  const product=await fsGet(adminToken,`commerceProducts/${productId}`), version=await fsGet(adminToken,`digitalProductVersions/${versionId}`);
  if(!product||!version) throw new Error('Product or version not found.');
  if(product.fields.creatorId!==uid||version.fields.creatorId!==uid||version.fields.productId!==productId) throw new Error('You do not own this upload target.');
  if(['archived','suspended'].includes(String(product.fields.status))) throw new Error('This product cannot receive uploads in its current state.');
  const fileName=safeName(String(b.fileName||'file'));
  const mime=String(b.contentType||'application/octet-stream').toLowerCase();
  const size=Number(b.size);
  const role=String(b.role||'product_file');
  const limits=productLimits();
  if(!FILE_ROLES.has(role)) throw new Error('Invalid file role.');
  if(!Number.isSafeInteger(size)||size<=0) throw new Error('Invalid file size.');
  if(size>limits.maxFileBytes) throw new Error(`File is too large. Maximum allowed is ${Math.round(limits.maxFileBytes/1024/1024)} MB.`);
  if(isBlockedFile(fileName,mime)) throw new Error('This file type is not allowed for digital products.');
  const existingCount=Number(version.fields.fileCount||0);
  if(existingCount>=limits.maxFilesPerVersion) throw new Error(`This version already contains the maximum of ${limits.maxFilesPerVersion} files.`);
  const existingBytes=Number(version.fields.totalSizeBytes||0);
  if(existingBytes+size>limits.maxTotalBytesPerVersion) throw new Error('This version exceeds its total file-size limit.');
  const fileId=crypto.randomUUID();
  const objectKey=storageKey(uid,productId,versionId,fileId,fileName);
  const uploadUrl=r2PresignedUrl({method:'PUT',bucket:r2ProductConfig().bucket,key:objectKey,expiresIn:900});
  return {file:{id:fileId,productId,versionId,creatorId:uid,resourceType:'upload',displayName:fileName,originalFilename:fileName,safeFilename:fileName,mimeType:mime,sizeBytes:size,role,status:'pending',objectKey},uploadUrl,expiresIn:900,limits};
}

async function completeUpload(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||''), versionId=String(b.versionId||''), fileId=String(b.fileId||''), objectKey=String(b.objectKey||'');
  const product=await fsGet(adminToken,`commerceProducts/${productId}`), version=await fsGet(adminToken,`digitalProductVersions/${versionId}`);
  if(!product||!version) throw new Error('Product or version not found.');
  if(product.fields.creatorId!==uid||version.fields.creatorId!==uid||version.fields.productId!==productId) throw new Error('Upload ownership check failed.');
  const expectedKey=storageKey(uid,productId,versionId,fileId,safeName(String(b.fileName||'file')));
  if(objectKey!==expectedKey) throw new Error('Invalid storage reference.');
  const cfg=r2ProductConfig();
  const headUrl=r2PresignedUrl({method:'HEAD',bucket:cfg.bucket,key:objectKey,expiresIn:300});
  const head=await fetch(headUrl,{method:'HEAD'});
  if(!head.ok) throw new Error('Uploaded file could not be verified in storage.');
  const size=Number(head.headers.get('content-length')||b.size||0);
  const mime=String(b.contentType||head.headers.get('content-type')||'application/octet-stream').toLowerCase();
  if(!Number.isSafeInteger(size)||size<=0) throw new Error('Uploaded file size could not be verified.');
  if(isBlockedFile(String(b.fileName||''),mime)) throw new Error('This file type is not allowed.');
  const file={
    productId,versionId,creatorId:uid,fileId,objectKey,
    resourceType:'upload',displayName:safeName(String(b.fileName||'file')),originalFilename:safeName(String(b.fileName||'file')),safeFilename:safeName(String(b.fileName||'file')),
    mimeType:mime,sizeBytes:size,checksum:String(b.checksum||head.headers.get('etag')||'').slice(0,512),
    checksumSource:b.checksum?'client':'r2_etag',role:FILE_ROLES.has(String(b.role))?String(b.role):'product_file',
    status:'ready',createdAt:nowIso(),updatedAt:nowIso()
  };
  const existing=await fsGet(adminToken,`digitalProductFiles/${fileId}`);
  if(existing) return {file:{id:fileId,...existing.fields}};
  const newCount=Number(version.fields.fileCount||0)+1, newBytes=Number(version.fields.totalSizeBytes||0)+size;
  await fsCommit(adminToken,[
    {create:{name:`digitalProductFiles/${fileId}`,fields:fields(file)}},
    {transform:{document:`digitalProductVersions/${versionId}`,fieldTransforms:[{fieldPath:'fileIds',appendMissingElements:{values:[{stringValue:fileId}]}},{fieldPath:'fileCount',increment:{integerValue:'1'}},{fieldPath:'totalSizeBytes',increment:{integerValue:String(size)}}]}},
    {update:{name:`commerceProducts/${productId}`,fields:fields({fileCount:Number(product.fields.fileCount||0)+1,totalSizeBytes:Number(product.fields.totalSizeBytes||0)+size,updatedAt:nowIso()})}},
    {create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'file',targetId:fileId,event:'fileUploaded',timestamp:nowIso(),metadata:{productId,versionId,sizeBytes:size}})}}
  ]);
  return {file:{id:fileId,...file},versionFileCount:newCount,versionTotalSizeBytes:newBytes};
}

async function listMine(adminToken:string,uid:string){
  const products=await fsQuery(adminToken,'commerceProducts',[{field:{fieldPath:'creatorId'},op:'EQUAL',value:{stringValue:uid}}]);
  const versions=await fsQuery(adminToken,'digitalProductVersions',[{field:{fieldPath:'creatorId'},op:'EQUAL',value:{stringValue:uid}}]);
  const files=await fsQuery(adminToken,'digitalProductFiles',[{field:{fieldPath:'creatorId'},op:'EQUAL',value:{stringValue:uid}}]);
  return {
    products:products.map(x=>({id:x.name.split('/').pop(),...x.fields})),
    versions:versions.map(x=>({id:x.name.split('/').pop(),...x.fields})),
    files:files.map(x=>({id:x.name.split('/').pop(),...x.fields}))
  };
}

function entitlementIsActive(fields:any){
  if(String(fields?.status||'')!=='active') return false;
  const now=Date.now();
  const startsRaw=fields?.startsAt?.toDate?.()?.getTime?.();
  const starts=Number.isFinite(startsRaw)?startsRaw:(fields?.startsAt?Date.parse(String(fields.startsAt)):0);
  const expiresRaw=fields?.expiresAt?.toDate?.()?.getTime?.();
  const expires=Number.isFinite(expiresRaw)?expiresRaw:(fields?.expiresAt?Date.parse(String(fields.expiresAt)):NaN);
  return (!starts||starts<=now)&&(!Number.isFinite(expires)||expires>now);
}

async function listPurchases(adminToken:string,uid:string){
  const entitlements=await fsQuery(adminToken,'entitlements',[{field:{fieldPath:'userId'},op:'EQUAL',value:{stringValue:uid}}]);
  const purchases:any[]=[];
  for(const entitlement of entitlements){
    const ef:any=entitlement.fields||{};
    if(String(ef.resourceType||'')!=='product' || !ef.resourceId) continue;
    const product=await fsGet(adminToken,`commerceProducts/${String(ef.resourceId)}`); if(!product) continue;
    const orderId=String(ef.orderId||ef.sourceId||'');
    const order=orderId?await fsGet(adminToken,`commerceOrders/${orderId}`):null;
    const items=Array.isArray(order?.fields?.items)?order?.fields?.items:[];
    const item=items.find((x:any)=>String(x.productId||'')===String(ef.resourceId)) || items[0] || {};
    const currentVersionId=String(product.fields.currentVersionId||'');
    const purchasedAt=String(ef.grantedAt||order?.fields?.paidAt||order?.fields?.createdAt||'');
    let files:any[]=[];
    if(currentVersionId){
      const rows=await fsQuery(adminToken,'digitalProductFiles',[{field:{fieldPath:'productId'},op:'EQUAL',value:{stringValue:String(ef.resourceId)}}]);
      files=rows.filter(r=>String(r.fields?.versionId||'')===currentVersionId && isPurchasableResourceStatus(r.fields,purchasedAt) && String(r.fields?.creatorId||'')===String(product.fields.creatorId||'')).map(r=>{
        const f:any=r.fields||{}; const resourceType=String(f.resourceType||'upload');
        return {id:r.name.split('/').pop(),...f,resourceType,displayName:String(f.displayName||f.originalFilename||'Resource'),originalFilename:String(f.originalFilename||f.displayName||'Resource'),safeFilename:String(f.safeFilename||f.originalFilename||f.displayName||'download'),sizeBytes:Number(f.sizeBytes||0),provider:resourceType==='external'?String(f.provider||detectLinkProvider(String(f.url||''))):undefined,url:resourceType==='external'?String(f.url||''):undefined};
      });
    }
    purchases.push({
      id:entitlement.name.split('/').pop(), entitlementId:entitlement.name.split('/').pop(), orderId,
      purchasedAt, entitlementStatus:String(ef.status||'unknown'), canDownload:entitlementIsActive(ef),
      product:{id:String(ef.resourceId),title:String(product.fields.title||item.title||'Digital Product'),subtitle:String(product.fields.subtitle||''),thumbnail:String(product.fields.thumbnail||''),gallery:Array.isArray(product.fields.gallery)?product.fields.gallery.slice(0,12):[],creatorId:String(product.fields.creatorId||''),creatorUsername:String(product.fields.creatorUsername||''),creatorDisplayName:String(product.fields.creatorDisplayName||''),status:String(product.fields.status||'')},
      order:{status:String(order?.fields?.status||''),currency:String(order?.fields?.currency||item.currency||'INR'),total:Number(order?.fields?.total||item.lineTotal||item.unitAmount||0)},
      files:entitlementIsActive(ef)?files:[], resources:entitlementIsActive(ef)?files:[]
    });
  }
  purchases.sort((a,b)=>String(b.purchasedAt||'').localeCompare(String(a.purchasedAt||'')));
  return {purchases};
}

async function addProductLink(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||'').trim(), versionId=String(b.versionId||'').trim(); if(!productId||!versionId) throw new Error('productId and versionId are required.');
  const product=await fsGet(adminToken,`commerceProducts/${productId}`), version=await fsGet(adminToken,`digitalProductVersions/${versionId}`);
  if(!product||!version) throw new Error('Product or version not found.'); if(String(product.fields.creatorId||'')!==uid||String(version.fields.creatorId||'')!==uid||String(version.fields.productId||'')!==productId) throw new Error('You do not own this resource target.');
  const displayName=cleanDisplayName(b.displayName||b.name); const url=cleanExternalUrl(b.url); const providerRaw=String(b.provider||detectLinkProvider(url)); const provider=LINK_PROVIDERS.has(providerRaw)?providerRaw:detectLinkProvider(url); const id=crypto.randomUUID(); const now=nowIso();
  const resource={productId,versionId,creatorId:uid,resourceType:'external',displayName,url,provider,status:'ready',createdAt:now,updatedAt:now};
  await fsCommit(adminToken,[{create:{name:`digitalProductFiles/${id}`,fields:fields(resource)}},{create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product_resource',targetId:id,event:'resource_created',timestamp:now,metadata:{productId,versionId,resourceType:'external'}})}}]);
  return {resource:{id,...resource}};
}

async function renameProductResource(adminToken:string,uid:string,b:any){
  const resourceId=String(b.resourceId||'').trim(); if(!resourceId) throw new Error('resourceId is required.'); const {resource}=await assertOwnedResource(adminToken,uid,resourceId); const name=cleanDisplayName(b.displayName); const old=String(resource.fields.displayName||resource.fields.originalFilename||'Resource'); const now=nowIso();
  await fsCommit(adminToken,[{update:{name:`digitalProductFiles/${resourceId}`,fields:fields({displayName:name,updatedAt:now})}},{create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product_resource',targetId:resourceId,event:'resource_renamed',timestamp:now,metadata:{oldDisplayName:old,newDisplayName:name}})}}]);
  return {resource:{id:resourceId,...resource.fields,displayName:name,updatedAt:now}};
}

async function updateProductLink(adminToken:string,uid:string,b:any){
  const resourceId=String(b.resourceId||'').trim(); if(!resourceId) throw new Error('resourceId is required.'); const {resource}=await assertOwnedResource(adminToken,uid,resourceId); const f:any=resource.fields||{}; if(String(f.resourceType||'')!=='external') throw new Error('Only external resources can have their URL changed.');
  const displayName=cleanDisplayName(b.displayName); const url=cleanExternalUrl(b.url); const providerRaw=String(b.provider||detectLinkProvider(url)); const provider=LINK_PROVIDERS.has(providerRaw)?providerRaw:detectLinkProvider(url); const now=nowIso();
  await fsCommit(adminToken,[{update:{name:`digitalProductFiles/${resourceId}`,fields:fields({displayName,url,provider,updatedAt:now})}},{create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product_resource',targetId:resourceId,event:'resource_link_updated',timestamp:now,metadata:{provider}})}}]);
  return {resource:{id:resourceId,...f,displayName,url,provider,updatedAt:now}};
}

async function archiveProductResource(adminToken:string,uid:string,b:any){
  const resourceId=String(b.resourceId||'').trim(); if(!resourceId) throw new Error('resourceId is required.'); const {resource}=await assertOwnedResource(adminToken,uid,resourceId); const f:any=resource.fields||{}; if(String(f.status||'')==='archived') return {resource:{id:resourceId,...f}}; const now=nowIso();
  await fsCommit(adminToken,[{update:{name:`digitalProductFiles/${resourceId}`,fields:fields({status:'archived',archivedAt:now,updatedAt:now})}},{create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product_resource',targetId:resourceId,event:'resource_archived',timestamp:now,metadata:{productId:f.productId,versionId:f.versionId}})}}]);
  if(String(f.resourceType||'upload')==='upload'&&String(f.role||'product_file')==='product_file') await recomputeVersionResourceCounts(adminToken,String(f.versionId||''),String(f.productId||''));
  return {resource:{id:resourceId,...f,status:'archived',archivedAt:now,updatedAt:now}};
}

async function restoreProductResource(adminToken:string,uid:string,b:any){
  const resourceId=String(b.resourceId||'').trim(); if(!resourceId) throw new Error('resourceId is required.'); const {resource}=await assertOwnedResource(adminToken,uid,resourceId); const f:any=resource.fields||{}; if(String(f.status||'')!=='archived') return {resource:{id:resourceId,...f}}; const product=await fsGet(adminToken,`commerceProducts/${String(f.productId||'')}`); if(!product||String(product.fields.status||'')==='suspended') throw new Error('This product cannot restore resources in its current state.'); const now=nowIso();
  await fsCommit(adminToken,[{update:{name:`digitalProductFiles/${resourceId}`,fields:fields({status:'ready',archivedAt:null,updatedAt:now})}},{create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product_resource',targetId:resourceId,event:'resource_restored',timestamp:now,metadata:{productId:f.productId,versionId:f.versionId}})}}]);
  if(String(f.resourceType||'upload')==='upload'&&String(f.role||'product_file')==='product_file') await recomputeVersionResourceCounts(adminToken,String(f.versionId||''),String(f.productId||''));
  return {resource:{id:resourceId,...f,status:'ready',archivedAt:null,updatedAt:now}};
}

async function downloadFile(adminToken:string,uid:string,b:any){
  const fileId=String(b.fileId||'').trim(); if(!fileId) throw new Error('fileId is required.');
  const file=await fsGet(adminToken,`digitalProductFiles/${fileId}`); if(!file) throw new Error('Purchased file not found.');
  const f:any=file.fields||{}; if(String(f.resourceType||'upload')!=='upload') throw new Error('This resource is not an uploaded file.');
  if(!['ready','archived'].includes(String(f.status||''))) throw new Error('This file is not available for download.');
  const productId=String(f.productId||''); if(!productId) throw new Error('Purchased file is missing its product reference.');
  const entitlements=await fsQuery(adminToken,'entitlements',[{field:{fieldPath:'userId'},op:'EQUAL',value:{stringValue:uid}}]);
  const entitlement=entitlements.find(x=>String(x.fields?.resourceType||'')==='product'&&String(x.fields?.resourceId||'')===productId&&entitlementIsActive(x.fields));
  if(!entitlement) throw new Error('You do not have an active purchase for this product.');
  if(!isPurchasableResourceStatus(f,String(entitlement.fields?.grantedAt||''))) throw new Error('This resource is no longer available for your purchase.');
  const objectKey=String(f.objectKey||''); if(!objectKey) throw new Error('Uploaded resource is missing storage information.');
  const cfg=r2ProductConfig(); const filename=safeName(String(f.safeFilename||f.originalFilename||f.displayName||'download')); const disposition=`attachment; filename*=UTF-8''${filename}`;
  const downloadUrl=r2PresignedUrl({method:'GET',bucket:cfg.bucket,key:objectKey,expiresIn:300,responseContentDisposition:disposition});
  return {downloadUrl,expiresIn:300,file:{id:fileId,filename:String(f.displayName||f.originalFilename||filename),mimeType:String(f.mimeType||'application/octet-stream'),sizeBytes:Number(f.sizeBytes||0),productId}};
}

async function openExternalResource(adminToken:string,uid:string,b:any){
  const resourceId=String(b.resourceId||'').trim(); if(!resourceId) throw new Error('resourceId is required.'); const resource=await fsGet(adminToken,`digitalProductFiles/${resourceId}`); if(!resource) throw new Error('Resource not found.'); const f:any=resource.fields||{}; if(String(f.resourceType||'')!=='external') throw new Error('This resource is not an external link.'); const productId=String(f.productId||'');
  const entitlements=await fsQuery(adminToken,'entitlements',[{field:{fieldPath:'userId'},op:'EQUAL',value:{stringValue:uid}}]); const entitlement=entitlements.find(x=>String(x.fields?.resourceType||'')==='product'&&String(x.fields?.resourceId||'')===productId&&entitlementIsActive(x.fields)); if(!entitlement)throw new Error('Purchase required to open this resource.');
  if(!isPurchasableResourceStatus(f,String(entitlement.fields?.grantedAt||'')))throw new Error('This external resource is no longer available for your purchase.');
  const url=cleanExternalUrl(f.url); return {url,expiresIn:300,resource:{id:resourceId,displayName:String(f.displayName||'External Resource'),provider:String(f.provider||detectLinkProvider(url))}};
}

async function publishProduct(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||''); const product=await fsGet(adminToken,`commerceProducts/${productId}`); if(!product) throw new Error('Product not found.');
  if(product.fields.creatorId!==uid) throw new Error('You do not own this product.');
  await requireVendor(adminToken,uid);
  const versionId=String(product.fields.currentVersionId||''); const version=await fsGet(adminToken,`digitalProductVersions/${versionId}`);
  if(!version) throw new Error('Current product version not found.');
  if(!Array.isArray(product.fields.priceIds)||!product.fields.priceIds.length) throw new Error('Add a valid price before publishing.');
  if(!Number(version.fields.fileCount||0)) throw new Error('Add at least one ready product file before publishing.');
  if(!product.fields.title||!product.fields.description||!product.fields.category) throw new Error('Complete the required product information before publishing.');
  const now=nowIso();
  await fsCommit(adminToken,[
    {update:{name:`digitalProductVersions/${versionId}`,fields:fields({status:'published',updatedAt:now})}},
    {update:{name:`commerceProducts/${productId}`,fields:fields({status:'active',visibility:product.fields.visibility||'public',publishedAt:product.fields.publishedAt||now,updatedAt:now})}},
    {create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product',targetId:productId,event:'productPublished',timestamp:now,metadata:{versionId}})}}
  ]);
  return {product:{id:productId,...product.fields,status:'active',publishedAt:product.fields.publishedAt||now,updatedAt:now}};
}

async function publishVersion(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||''),versionId=String(b.versionId||'');
  const product=await fsGet(adminToken,`commerceProducts/${productId}`), version=await fsGet(adminToken,`digitalProductVersions/${versionId}`);
  if(!product||!version) throw new Error('Product or version not found.');
  if(product.fields.creatorId!==uid||version.fields.creatorId!==uid||version.fields.productId!==productId) throw new Error('Ownership check failed.');
  if(Number(version.fields.fileCount||0)<1) throw new Error('Version must contain at least one ready file.');
  const now=nowIso(),previousId=String(product.fields.currentVersionId||'');
  const writes:any[]=[
    {update:{name:`digitalProductVersions/${versionId}`,fields:fields({status:'published',updatedAt:now})}},
    {update:{name:`commerceProducts/${productId}`,fields:fields({currentVersionId:versionId,currentVersionNumber:version.fields.versionNumber||1,version:version.fields.versionNumber||1,updatedAt:now})}}
  ];
  if(previousId && previousId!==versionId) writes.push({update:{name:`digitalProductVersions/${previousId}`,fields:fields({status:'archived',updatedAt:now})}});
  writes.push({create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product_version',targetId:versionId,event:'versionPublished',timestamp:now,metadata:{productId}})}});
  await fsCommit(adminToken,writes);
  return {version:{id:versionId,...version.fields,status:'published'},product:{id:productId,...product.fields,currentVersionId:versionId,currentVersionNumber:version.fields.versionNumber||1,version:version.fields.versionNumber||1,updatedAt:now}};
}

async function archiveProduct(adminToken:string,uid:string,b:any){
  const productId=String(b.productId||''), product=await fsGet(adminToken,`commerceProducts/${productId}`); if(!product)throw new Error('Product not found.'); if(product.fields.creatorId!==uid)throw new Error('You do not own this product.');
  const now=nowIso();
  await fsCommit(adminToken,[{update:{name:`commerceProducts/${productId}`,fields:fields({status:'archived',archivedAt:now,updatedAt:now})}},{create:{name:`commerceAuditLogs/${crypto.randomUUID()}`,fields:fields({actorId:uid,actorType:'vendor',targetType:'product',targetId:productId,event:'productArchived',timestamp:now,metadata:{}})}}]);
  return {product:{id:productId,...product.fields,status:'archived',archivedAt:now,updatedAt:now}};
}

export default async function handler(req:VercelRequest,res:VercelResponse){
  if(req.method!=='POST') return fail(res,405,'Method not allowed.','METHOD_NOT_ALLOWED');
  try{
    const token=auth(req); const authUser=await verifyFirebaseToken(token); const adminToken=await serviceToken(); const body=parseBody(req); const action=String(body.action||req.query?.action||'').trim();
    let result:any;
    switch(action){
      case 'createProduct': result=await createProduct(adminToken,authUser.uid,body); break;
      case 'updateProduct': result=await updateProduct(adminToken,authUser.uid,body); break;
      case 'createVersion': result=await createVersion(adminToken,authUser.uid,body); break;
      case 'requestUpload': result=await requestUpload(adminToken,authUser.uid,body); break;
      case 'completeUpload': result=await completeUpload(adminToken,authUser.uid,body); break;
      case 'listMine': result=await listMine(adminToken,authUser.uid); break;
      case 'listPurchases': result=await listPurchases(adminToken,authUser.uid); break;
      case 'downloadFile': result=await downloadFile(adminToken,authUser.uid,body); break;
      case 'openExternalResource': result=await openExternalResource(adminToken,authUser.uid,body); break;
      case 'addProductLink': result=await addProductLink(adminToken,authUser.uid,body); break;
      case 'renameProductResource': result=await renameProductResource(adminToken,authUser.uid,body); break;
      case 'updateProductLink': result=await updateProductLink(adminToken,authUser.uid,body); break;
      case 'archiveProductResource': result=await archiveProductResource(adminToken,authUser.uid,body); break;
      case 'restoreProductResource': result=await restoreProductResource(adminToken,authUser.uid,body); break;
      case 'publishProduct': result=await publishProduct(adminToken,authUser.uid,body); break;
      case 'publishVersion': result=await publishVersion(adminToken,authUser.uid,body); break;
      case 'archiveProduct': result=await archiveProduct(adminToken,authUser.uid,body); break;
      default: return fail(res,400,'Unknown digital product action.','UNKNOWN_ACTION');
    }
    return okJson(res,result);
  }catch(error:any){
    const message=String(error?.message||'Digital product request failed.');
    const status=/Authentication|token/i.test(message)?401:/permission|not own|Vendor access|not allowed/i.test(message)?403:/not found/i.test(message)?404:400;
    return fail(res,status,message,status===400?'DIGITAL_PRODUCT_ERROR':status===403?'FORBIDDEN':status===404?'NOT_FOUND':'UNAUTHORIZED');
  }
}

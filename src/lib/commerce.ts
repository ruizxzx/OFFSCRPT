import { auth, db } from './firebase';
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';

export type CommerceProductType = 'content'|'digital_product'|'course'|'subscription'|'community'|'service'|'bundle'|'tip';
export type CommerceProductStatus = 'draft'|'active'|'archived'|'disabled';
export type CommerceBillingType = 'one_time'|'recurring';
export type CommerceOrderStatus = 'created'|'pending_payment'|'paid'|'partially_refunded'|'refunded'|'cancelled'|'failed';
export type CommerceEntitlementStatus = 'pending'|'active'|'expired'|'cancelled'|'refunded'|'revoked';

export interface CommerceProduct {
  id: string; creatorId: string; creatorUsername?: string; creatorDisplayName?: string;
  title: string; subtitle?: string; description: string;
  type: CommerceProductType; subtype?: string; status: CommerceProductStatus; visibility: 'private'|'public'|'unlisted'; featured?: boolean;
  currency: string; priceIds: string[]; version: number;
  thumbnail?: string; gallery?: string[];
  category?: string; subcategory?: string; tags?: string[];
  license?: string; usageRestrictions?: string; requirements?: string; whatIsIncluded?: string;
  viewsCount?: number; saveCount?: number; purchaseCount?: number;
  createdAt?: string; updatedAt?: string; publishedAt?: string; archivedAt?: string;
}

export interface CommercePublicPrice {
  id: string; productId: string; amount: number; currency: string; billingType: CommerceBillingType;
  interval?: 'month'|'year'; intervalCount?: number; trialDays?: number; active: boolean; validFrom?: string; validUntil?: string;
  createdAt?: string; updatedAt?: string;
}
export interface CommercePrice {
  id: string; productId: string; amount: number; currency: string; billingType: CommerceBillingType;
  interval?: 'month'|'year'; intervalCount?: number; trialDays?: number; active: boolean; validFrom?: string; validUntil?: string;
}
export interface CommerceOrder {
  id: string; customerId: string; creatorId?: string; items: Array<{productId:string;priceId:string;quantity:number;unitAmount:number;lineTotal:number;title:string;type:CommerceProductType}>;
  subtotal: number; discount: number; tax: number; fees: number; total: number; currency: string; status: CommerceOrderStatus;
  paymentId?: string; entitlementIds?: string[]; createdAt?: string; paidAt?: string; refundedAt?: string;
}
export interface CommerceEntitlement {
  id: string; userId: string; sourceType: string; sourceId: string; resourceType: string; resourceId: string;
  status: CommerceEntitlementStatus; grantedAt?: string; startsAt?: string; expiresAt?: string;
  orderId?: string; revokedAt?: string;
}

const apiBase = '/api/commerce';
const getIdToken = async () => {
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  return user.getIdToken();
};

async function callApi<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const token = await getIdToken();
  const response = await fetch(`${apiBase}?action=${encodeURIComponent(action)}`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.error || `Commerce request failed (${response.status}).`));
  return payload as T;
}


async function callPublicApi<T>(action:string, params:Record<string,string>={}):Promise<T>{
  const search=new URLSearchParams({action,...params});
  const response=await fetch(`${apiBase}?${search.toString()}`,{method:'GET',headers:{accept:'application/json'}});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(String(payload?.error||`Commerce request failed (${response.status}).`));
  return payload as T;
}

export async function createCommerceProduct(input: Pick<CommerceProduct,'title'|'description'|'type'|'visibility'|'currency'> & { price?: {amount:number;currency:string;billingType:CommerceBillingType;interval?:'month'|'year';intervalCount?:number;trialDays?:number} }): Promise<{product:CommerceProduct;price?:CommercePrice}> {
  return callApi('createProduct', input);
}
export async function createCommercePrice(input: {productId:string;amount:number;currency:string;billingType:CommerceBillingType;interval?:'month'|'year';intervalCount?:number;trialDays?:number}): Promise<{price:CommercePrice}> {
  return callApi('createPrice', input);
}
export async function setCommerceProductStatus(productId:string,status:'draft'|'active'|'archived'|'disabled'):Promise<{product:CommerceProduct}> {
  return callApi('setProductStatus',{productId,status});
}
export async function setCommerceProductVisibility(productId:string,visibility:'public'|'private'|'unlisted'):Promise<{product:CommerceProduct}> {
  return callApi('setProductVisibility',{productId,visibility});
}

export interface RazorpayCheckoutData {
  keyId: string;
  razorpayOrderId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: {email?:string;name?:string;contact?:string};
}
export async function createCommerceCheckout(productId:string, priceId:string, idempotencyKey?:string): Promise<{order:CommerceOrder;payment:{id:string;status:string;testMode:boolean;provider?:string};checkout:RazorpayCheckoutData;entitlement?:CommerceEntitlement}> {
  return callApi('createCheckout', {productId,priceId,idempotencyKey:idempotencyKey || crypto.randomUUID()});
}
export async function confirmRazorpayPayment(input:{orderId:string;razorpayPaymentId:string;razorpayOrderId:string;razorpaySignature:string}): Promise<{order:CommerceOrder;payment:{id:string;status:string;testMode:boolean;provider?:string};entitlement?:CommerceEntitlement}> {
  return callApi('confirmRazorpayPayment', input);
}
export async function checkCommerceAccess(userId:string, resourceType:string, resourceId:string):Promise<boolean> {
  if (!userId || auth.currentUser?.uid !== userId) return false;
  const result = await callApi<{access:boolean}>('checkAccess',{resourceType,resourceId});
  return result.access === true;
}

export async function listCreatorCommerceProducts(userId: string): Promise<CommerceProduct[]> {
  if (!userId || auth.currentUser?.uid !== userId) return [];
  const snap = await getDocs(query(collection(db,'commerceProducts'), where('creatorId','==',userId), limit(100)));
  return snap.docs.map(d => ({id:d.id,...d.data()} as CommerceProduct)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
}
export async function listActiveCommerceProducts(limitCount=50): Promise<CommerceProduct[]> {
  const snap = await getDocs(query(collection(db,'commerceProducts'), where('status','==','active'), limit(limitCount)));
  return snap.docs.map(d => ({id:d.id,...d.data()} as CommerceProduct)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
}
export async function listUserCommerceOrders(userId:string):Promise<CommerceOrder[]> {
  if (!userId || auth.currentUser?.uid !== userId) return [];
  const snap = await getDocs(query(collection(db,'commerceOrders'), where('customerId','==',userId), limit(100)));
  return snap.docs.map(d => ({id:d.id,...d.data()} as CommerceOrder)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
}
export async function listUserEntitlements(userId:string):Promise<CommerceEntitlement[]> {
  if (!userId || auth.currentUser?.uid !== userId) return [];
  const snap = await getDocs(query(collection(db,'entitlements'), where('userId','==',userId), limit(100)));
  return snap.docs.map(d => ({id:d.id,...d.data()} as CommerceEntitlement)).sort((a,b)=>String(b.grantedAt||'').localeCompare(String(a.grantedAt||'')));
}
export async function hasCommerceAccess(userId:string, resourceType:string, resourceId:string):Promise<boolean> {
  if (!userId || auth.currentUser?.uid !== userId || !resourceType || !resourceId) return false;
  const snap = await getDocs(query(collection(db,'entitlements'), where('userId','==',userId), limit(200)));
  const now=Date.now();
  return snap.docs.some(d => {
    const x:any=d.data();
    if(x.status!=='active' || String(x.resourceType||'')!==resourceType || String(x.resourceId||'')!==resourceId) return false;
    const startsRaw=x.startsAt?.toDate?.()?.getTime?.();
    const starts=Number.isFinite(startsRaw)?startsRaw:(x.startsAt?Date.parse(String(x.startsAt)):0);
    const expiresRaw=x.expiresAt?.toDate?.()?.getTime?.();
    const expires=Number.isFinite(expiresRaw)?expiresRaw:(x.expiresAt?Date.parse(String(x.expiresAt)):NaN);
    return (!starts || starts<=now) && (!Number.isFinite(expires) || expires>now);
  });
}

export async function getCommerceProduct(productId:string): Promise<CommerceProduct | null> {
  const id=String(productId||'').trim();
  if(!id) return null;
  const result=await callPublicApi<{products:CommerceProduct[]}>('marketplaceByIds',{ids:id});
  return result.products?.[0] || null;
}

export async function listPublicCreatorCommerceProducts(creatorId:string): Promise<CommerceProduct[]> {
  if(!creatorId) return [];
  const result=await callPublicApi<{products:CommerceProduct[]}>('listPublicProducts',{creatorId});
  return Array.isArray(result.products)?result.products:[];
}

export async function listCommercePrices(productId:string): Promise<CommercePublicPrice[]> {
  if(!productId) return [];
  const result=await callPublicApi<{prices:CommercePublicPrice[]}>('listPublicPrices',{productId});
  return Array.isArray(result.prices)?result.prices:[];
}

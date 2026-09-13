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


export type SellerOnboardingStatus = 'not_started'|'collecting_information'|'creating_account'|'created'|'pending_review'|'active'|'suspended'|'rejected'|'error'|'reconciliation_required';
export interface CreatorSellerProfile {
  id: string;
  creatorId: string;
  sellerId?: string;
  sellerEnabled: boolean;
  onboardingStatus: SellerOnboardingStatus;
  health?: 'not_started'|'pending'|'ready'|'suspended'|'error'|'reconciliation_required';
  razorpayAccountId?: string;
  razorpayAccountStatus?: string;
  legalBusinessName?: string;
  customerFacingBusinessName?: string;
  businessType?: string;
  email?: string;
  phone?: string;
  category?: string;
  subcategory?: string;
  description?: string;
  address?: {street1:string;street2?:string;city:string;state:string;postalCode:string;country:string};
  updatedAt?: string;
  createdAt?: string;
}
export interface SellerOnboardingInput {
  email: string;
  phone: string;
  legalBusinessName: string;
  customerFacingBusinessName: string;
  businessType: string;
  contactName: string;
  category: string;
  subcategory: string;
  description: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
}
export async function getCreatorSeller(): Promise<{seller:CreatorSellerProfile}> {
  return callApi('getSeller');
}
export async function createCreatorSeller(input:SellerOnboardingInput): Promise<{seller:CreatorSellerProfile;message?:string;reused?:boolean}> {
  return callApi('createSeller',input as unknown as Record<string,unknown>);
}
export async function refreshCreatorSeller(): Promise<{seller:CreatorSellerProfile;provider?:{accountId:string;status:string}}> {
  return callApi('refreshSeller');
}
export async function enableCreatorSeller(): Promise<{seller:CreatorSellerProfile}> {
  return callApi('enableSeller');
}
export async function disableCreatorSeller(): Promise<{seller:CreatorSellerProfile}> {
  return callApi('disableSeller');
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


export type CommissionRuleScope = 'global'|'creator'|'product';
export interface CommissionRule {
  id:string; ruleId:string; ruleVersion:number; scope:CommissionRuleScope; productId?:string; creatorId?:string;
  percentage:number; percentageBps:number; fixedAmount:number; minimumAmount?:number; maximumAmount?:number; currency:string;
  effectiveFrom:string; effectiveUntil?:string; active:boolean; priority:number; refundPolicy:{proportional:boolean}; createdAt:string; updatedAt:string;
}
export interface CommissionSimulation { generatedAt:string; rule:CommissionRule; result:{grossAmount:number;grossAmountSubunits:number;platformCommissionAmount:number;platformCommissionAmountSubunits:number;creatorNetAmount:number;creatorNetAmountSubunits:number;currency:string}; }
export interface CreatorEarningsSummary { creatorId:string; currency:string; grossSales:number; platformCommission:number; netEarnings:number; refundedGross:number; reversedCommission:number; reversedCreatorAmount:number; generatedAt:string; }
export interface FinancialAllocation { id:string; allocationId:string; entryType:string; orderId:string; paymentId:string; creatorId:string; sellerId:string; razorpayAccountId?:string|null; productId:string; priceId:string; grossAmount:number; grossAmountSubunits?:number; platformCommissionAmount:number|null; platformCommissionAmountSubunits?:number|null; creatorNetAmount:number|null; creatorNetAmountSubunits?:number|null; currency:string; financialStatus:string; commissionRuleId?:string|null; commissionRuleVersion?:number|null; transferStatus:string; }
export interface OrderFinancials { order:CommerceOrder; allocation?:FinancialAllocation; refunds:Array<Record<string,any>>; }
export async function listCommissionRules():Promise<{rules:CommissionRule[]}> { return callApi('listCommissionRules'); }
export async function createCommissionRule(input:Record<string,unknown>):Promise<{rule:CommissionRule}> { return callApi('createCommissionRule',input); }
export async function updateCommissionRule(input:Record<string,unknown>):Promise<{rule:CommissionRule}> { return callApi('updateCommissionRule',input); }
export async function setCommissionRuleStatus(ruleId:string,active:boolean):Promise<{rule:CommissionRule}> { return callApi('setCommissionRuleStatus',{ruleId,active}); }
export async function simulateCommission(input:Record<string,unknown>):Promise<CommissionSimulation> { return callApi('simulateCommission',input); }
export async function getCreatorEarnings():Promise<CreatorEarningsSummary> { return callApi('getCreatorEarnings'); }
export async function getOrderFinancials(orderId:string):Promise<OrderFinancials> { return callApi('getOrderFinancials',{orderId}); }
export async function adminFinancialSummary():Promise<{currency:string;grossSales:number;platformCommission:number;creatorNet:number;refundedAmount:number;financialErrors:number;generatedAt:string}> { return callApi('adminFinancialSummary'); }
export async function reconcileCommission(orderId:string):Promise<{allocation:FinancialAllocation}> { return callApi('reconcileCommission',{orderId}); }

export interface AdminSellerRow extends CreatorSellerProfile { id:string; }
export async function adminListCreatorSellers(): Promise<{sellers:AdminSellerRow[]}> { return callApi('adminListSellers'); }
export async function adminSetCreatorSellerStatus(creatorId:string,status:'active'|'suspended'|'created'): Promise<{seller:CreatorSellerProfile}> { return callApi('adminSetSellerStatus',{creatorId,status}); }


export interface CreatorBalanceSummary {
  creatorId:string; currency:string; pendingBalancePaise:number; availableBalancePaise:number; reservedBalancePaise:number; paidOutBalancePaise:number; totalEarnedPaise:number; totalRefundedPaise:number; totalWithdrawnPaise:number; negativeBalancePaise:number; withdrawablePaise:number; minimumPayoutPaise:number; payoutEnabled:boolean; payoutBlockedReason:string; sellerStatus:string; routeAccountStatus:string;
}
export interface CreatorPayout { id:string; payoutId:string; creatorId:string; sellerId:string; amountPaise:number; currency:string; status:string; requestedAt?:string; approvedAt?:string; submittedAt?:string; processedAt?:string; failedAt?:string; reversedAt?:string; razorpayAccountId?:string|null; razorpayTransferId?:string|null; ledgerReservationId?:string|null; ledgerDebitId?:string|null; idempotencyKey:string; failureCode?:string|null; failureMessage?:string|null; reconciliationStatus?:string; providerTransferStatus?:string; providerSettlementStatus?:string; createdAt:string; updatedAt:string; }
export async function getCreatorBalance():Promise<CreatorBalanceSummary>{ return callApi('getCreatorBalance'); }
export async function getCreatorPayouts():Promise<{payouts:CreatorPayout[]}>{ return callApi('getCreatorPayouts'); }
export async function getCreatorPayout(payoutId:string):Promise<{payout:CreatorPayout}>{ return callApi('getPayout',{payoutId}); }
export async function createCreatorPayout(amount:string,idempotencyKey?:string):Promise<{payout:CreatorPayout;balance:CreatorBalanceSummary}>{ return callApi('createPayout',{amount,idempotencyKey:idempotencyKey||`payout_${Date.now()}_${Math.random().toString(36).slice(2,14)}`}); }
export async function adminListPayouts(filters:Record<string,unknown>={}):Promise<{payouts:CreatorPayout[]}>{ return callApi('adminListPayouts',filters); }
export async function adminApprovePayout(payoutId:string):Promise<{payout:CreatorPayout;balance?:CreatorBalanceSummary}>{ return callApi('approvePayout',{payoutId}); }
export async function adminRejectPayout(payoutId:string,reason?:string):Promise<{payout:CreatorPayout;balance?:CreatorBalanceSummary}>{ return callApi('rejectPayout',{payoutId,reason}); }
export async function adminReconcilePayout(payoutId:string):Promise<any>{ return callApi('reconcilePayout',{payoutId}); }


export interface FinanceReport {
  summary:any;
  previousSummary:any;
  comparison:{grossSales:number|null;platformCommission:number|null;creatorNet:number|null;refunds:number|null;payouts:number|null};
  series:{revenue:any[];commission:any[];creatorNet:any[];payouts:any[];refunds:any[]};
  meta:any;
}
export interface FinanceDimensionRow { id:string; [key:string]:any; }
export interface FinanceHealth {status:string;healthy:number;warnings:number;critical:number;issues:any[];period:any;generatedAt:string;recordsScanned:any;}
export async function getFinanceReport(input:Record<string,unknown>):Promise<FinanceReport>{ return callApi('getFinanceSummary',input); }
export async function getFinanceHealth(input:Record<string,unknown>):Promise<FinanceHealth>{ return callApi('getFinanceHealth',input); }
export async function getFinanceDimension(dimension:'creator'|'product'|'order'|'payout'|'refund',input:Record<string,unknown>):Promise<{rows:FinanceDimensionRow[];generatedAt:string;period:any}>{ return callApi(`get${dimension.charAt(0).toUpperCase()+dimension.slice(1)}Finance`,input); }
export async function exportFinanceCsv(input:Record<string,unknown>):Promise<{filename:string;csv:string;generatedAt:string;period:any;schemaVersion:string}>{ return callApi('exportFinance',input); }

// ========================= V96 Trust / Moderation / Reviews =========================
export type CommerceReviewStatus = 'pending'|'published'|'flagged'|'under_review'|'hidden'|'rejected'|'removed';
export type CommerceReportReason = 'spam'|'harassment'|'hate_or_abusive_content'|'misleading'|'fake_review'|'copyright'|'prohibited_content'|'fraud_concern'|'duplicate_content'|'other';
export type CommerceModerationCaseStatus = 'open'|'queued'|'under_review'|'resolved'|'escalated'|'dismissed';
export type CommerceModerationPriority = 'low'|'normal'|'high'|'critical';
export interface CommerceReview {
  id:string; productId:string; creatorId:string; reviewerId?:string; orderId?:string; orderItemId?:string;
  rating:number; title?:string; body:string; verifiedPurchase:boolean; status:CommerceReviewStatus;
  moderationStatus?:string; reportCount?:number; reviewerDisplayName?:string; reviewerAvatar?:string;
  createdAt?:string; updatedAt?:string; publishedAt?:string; editedAt?:string; removedAt?:string; version?:number;
}
export interface CommerceReviewAggregate { productId:string; reviewCount:number; averageRating:number; rating1Count:number; rating2Count:number; rating3Count:number; rating4Count:number; rating5Count:number; verifiedReviewCount:number; updatedAt?:string; }
export interface CommerceReviewEligibility { eligible:boolean; reason:string; orderId?:string; orderItemId?:string; reviewId?:string; existing?:CommerceReview; }
export interface CommerceReport { id:string; targetType:'review'|'product'|'creator'|'order'; targetId:string; reporterId:string; reasonCode:CommerceReportReason; description?:string; status:string; createdAt:string; updatedAt:string; }
export interface CommerceModerationCase { id:string; targetType:'review'|'product'|'creator'|'order'; targetId:string; reportIds:string[]; reportCount?:number; priority:CommerceModerationPriority; status:CommerceModerationCaseStatus; assignedTo?:string; createdAt:string; updatedAt:string; resolvedAt?:string; resolvedBy?:string; resolutionCode?:string; internalNotes?:string; }
export interface CommerceModerationAction { id:string; action:string; targetType:string; targetId:string; caseId?:string; actorId:string; actorRole:string; previousState?:string|null; newState?:string|null; reasonCode:string; notes?:string; requestId:string; timestamp:string; }
export interface CommerceTrustSignals { productId:string; creatorId:string; sellerStatus:string; trustStatus:string; productPublished:boolean; verifiedReviewCount:number; reviewCount:number; averageRating:number; trustedSeller:boolean; generatedAt:string; }
export interface CommerceTrustHealth { status:string; healthy:number; warnings:number; critical:number; issues:any[]; checkedAt:string; recordsScanned:any; }

export async function getProductReviews(productId:string, options:{sort?:'recent'|'highest'|'lowest'|'verified';limit?:number;cursor?:string}={}):Promise<{reviews:CommerceReview[];nextCursor:string|null;aggregate:CommerceReviewAggregate}> {
  return callPublicApi('getProductReviews',{productId,sort:String(options.sort||'recent'),limit:String(Math.min(50,Math.max(1,Number(options.limit||20)))),...(options.cursor?{cursor:options.cursor}:{})});
}
export async function getReviewAggregate(productId:string):Promise<CommerceReviewAggregate>{ return callPublicApi('getReviewAggregate',{productId}); }
export async function getCommerceTrustSignals(productId:string):Promise<CommerceTrustSignals>{ return callPublicApi('getTrustSignals',{productId}); }
export async function getCreatorTrustSignals(creatorId:string):Promise<any>{ return callApi('getCreatorTrustSignals',{creatorId}); }
export async function getPublicCreatorTrustSignals(creatorId:string):Promise<any>{ return callPublicApi('getCreatorTrustSignals',{creatorId}); }
export async function getReviewEligibility(productId:string):Promise<CommerceReviewEligibility>{ return callApi('getReviewEligibility',{productId}); }
export async function createCommerceReview(input:{productId:string;rating:number;title?:string;body:string;requestId?:string}):Promise<{review:CommerceReview;verifiedPurchase:boolean;status:string}>{ return callApi('createReview',input as Record<string,unknown>); }
export async function updateCommerceReview(input:{reviewId:string;rating:number;title?:string;body:string;requestId?:string}):Promise<{review:CommerceReview;status:string}>{ return callApi('updateReview',input as Record<string,unknown>); }
export async function removeCommerceReview(reviewId:string,requestId?:string):Promise<{removed:boolean;idempotent?:boolean}>{ return callApi('removeReview',{reviewId,requestId}); }
export async function getMyCommerceReviews(productId?:string):Promise<{reviews:CommerceReview[]}>{ return callApi('getMyReviews',productId?{productId}:{ }); }
export async function createCommerceReport(input:{targetType:'review'|'product'|'creator'|'order';targetId:string;reasonCode:CommerceReportReason;description?:string}):Promise<{report:CommerceReport;case:CommerceModerationCase}>{ return callApi('createCommerceReport',input as Record<string,unknown>); }
export async function adminGetModerationQueue(filters:Record<string,unknown>={}):Promise<{cases:CommerceModerationCase[];nextCursor:string|null}>{ return callApi('adminModerationQueue',filters); }
export async function adminGetModerationCase(caseId:string):Promise<{case:CommerceModerationCase;reports:CommerceReport[];target:any;actions:CommerceModerationAction[]}>{ return callApi('adminModerationCase',{caseId}); }
export async function adminModerationAction(input:Record<string,unknown>):Promise<any>{ return callApi('adminModerationAction',input); }
export async function adminSearchModeration(q:string):Promise<{results:any[]}>{ return callApi('adminSearchModeration',{q}); }
export async function getTrustHealth():Promise<CommerceTrustHealth>{ return callApi('getTrustHealth'); }
export async function validateReviewAggregates(productId:string):Promise<any>{ return callApi('validateReviewAggregates',{productId}); }
export async function rebuildReviewAggregate(productId:string,repair=false,requestId?:string):Promise<any>{ return callApi('rebuildReviewAggregate',{productId,repair,requestId}); }

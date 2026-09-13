import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const checks=[]; const ok=(name,cond)=>checks.push([name,!!cond]);
const pkg=JSON.parse(read('package.json')); const api=read('api/commerce/index.ts'); const rules=read('firestore.rules'); const lib=read('src/lib/commerce.ts'); const indexes=read('firestore.indexes.json');
ok('version 0.96.9',pkg.version==='0.96.9');
ok('manual payout mode',api.includes('MANUAL_PAYOUT_MODE')&&api.includes('MANUAL_PAYOUT_METHOD')&&api.includes("const MANUAL_PAYOUT_METHOD = 'manual_upi';"));
ok('manual payout API',api.includes("action==='markPayoutPaid'")&&api.includes('manualPaymentReference'));
ok('Route disabled for new payouts',api.includes("ROUTE_DISABLED")&&api.includes('Razorpay Route transfers are disabled'));
ok('checkout manual settlement mode',api.includes("settlementMode:'platform_manual_creator_repayment'")&&api.includes('const payoutDetails=seller.fields?.manualPayout'));
ok('creator payout details',lib.includes('upiId')&&lib.includes('manualPayout'));
ok('admin manual payout UI',fs.existsSync(path.join(root,'src/components/PayoutAdminPanel.tsx'))&&read('src/components/PayoutAdminPanel.tsx').includes('MARK PAID'));

ok('review collection API',api.includes('commerceReviews'));
ok('report collection API',api.includes('commerceReports'));
ok('moderation cases API',api.includes('commerceModerationCases'));
ok('moderation actions API',api.includes('commerceModerationActions'));
ok('trust signals API',api.includes('commerceTrustSignals'));
ok('review aggregate API',api.includes('commerceReviewAggregates'));
for(const a of ['createReview','updateReview','removeReview','getReviewEligibility','getMyReviews','createCommerceReport','adminModerationQueue','adminModerationCase','adminModerationAction','adminSearchModeration','getTrustHealth','validateReviewAggregates','rebuildReviewAggregate']) ok(`action ${a}`,api.includes(`action==='${a}'`));
for(const x of ['v96Eligibility','verifiedPurchase:true','reviewerId','orderId','orderItemId']) ok(`server review verification ${x}`,api.includes(x));
for(const x of ['v96ValidReviewTransition','v96ValidCaseTransition','v96ValidReportTransition']) ok(`state machine ${x}`,api.includes(x));
for(const x of ['requestId','commerceModerationActions','previousState','newState']) ok(`audit ${x}`,api.includes(x));
ok('pagination limit',api.includes('Math.min(50,Number(b.limit||20))')||api.includes('Math.min(100,Number(b.limit||25))'));
const v96Start=api.indexOf('// ========================= V96 TRUST'); const v96End=api.indexOf('function fsFilter',v96Start); const v96Block=v96Start>=0&&v96End>v96Start?api.slice(v96Start,v96End):''; ok('no V94 financial writes in V96 block',!v96Block.includes('v94AppendLedgerEntry')&&!v96Block.includes('commerceVendorLedger')&&!v96Block.includes('creatorCommerceBalances'));
ok('firestore review denied',rules.includes('match /commerceReviews/{reviewId}') && rules.includes('allow read, write: if false;'));
ok('firestore report denied',rules.includes('match /commerceReports/{reportId}') && rules.includes('allow read, write: if false;'));
ok('indexes added',indexes.includes('commerceReviews') && indexes.includes('commerceModerationCases'));
ok('client wrappers present',lib.includes('Review') && lib.includes('CommerceReport'));

ok('Firestore V96 path whitelist',api.includes('commerceReviews|commerceReports|commerceModerationCases|commerceModerationActions|commerceTrustSignals|commerceReviewAggregates'));
ok('create review atomic commit',api.includes('fsCommitWithPrecondition(token,[{create:{name:`${firestoreBase()}/commerceReviews/${reviewId}`'));
ok('report audit atomic',api.includes("v96AuditWrite(reportAction)" ) && api.includes('fsCommitWithPrecondition(token,writes,pre)'));
ok('review public moderation filter',api.includes('const publicRows=rows.filter(r=>v96ReviewIsPublic(v96Fields(r)))')); 
ok('product page avoids creatorId+status+visibility query',!api.includes("fsFilter('creatorId','EQUAL',{stringValue:creatorId}),fsFilter('status','EQUAL',{stringValue:'active'}),fsFilter('visibility','EQUAL',{stringValue:'public'})"));
ok('public reviews avoid moderationStatus composite query',!api.includes("fsFilter('productId','EQUAL',{stringValue:productId}),fsFilter('status','EQUAL',{stringValue:'published'}),fsFilter('moderationStatus','EQUAL',{stringValue:'approved'})"));
ok('own review lookup avoids reviewerId+productId composite',!api.includes("fsFilter('reviewerId','EQUAL',{stringValue:uid})]; if(v96Text(b.productId,200)) filters.push(fsFilter('productId'"));
ok('abuse-limit indexes declared',indexes.includes('reporterId')&&indexes.includes('createdAt')&&indexes.includes('reviewerId'));
ok('review cursor support',api.includes('encodeV96QueryCursor') && api.includes('decodeV96QueryCursor'));
ok('moderation queue cursor support',api.includes("const order=[{fieldPath:'updatedAt',direction:'DESCENDING' as const},{fieldPath:'__name__',direction:'DESCENDING' as const}"));
ok('full trust health pagination',api.includes("fsRunQueryAll(token,'commerceReviews')") && api.includes("fsRunQueryAll(token,'commerceAuditLogs')"));
ok('aggregate rebuild audits',api.includes("action:'review_aggregate_rebuilt'") && api.includes('v96AuditWrite(actionDoc)'));
ok('order report ownership',api.includes('You can only report an order belonging to you.'));
ok('no public reviewer UID',api.includes('function v96CleanReviewPublic') && !api.slice(api.indexOf('function v96CleanReviewPublic'), api.indexOf('function v96ReviewContribution')).includes('reviewerId'));
ok('review creation rate limit',api.includes('V96_DAILY_REVIEW_LIMIT') && api.includes('RATE_LIMITED'));
ok('admin case target context',api.includes('function v96AdminTargetSafe') && api.includes('target:v96AdminTargetSafe'));
ok('moderation case target binding',api.includes('Case target mismatch.') && api.includes('linkedCase'));
ok('master admin assignee resolution',api.includes("platformRole==='master_admin'"));


ok('aggregate includes ratingTotal',api.includes('ratingTotal') && api.includes("['reviewCount','ratingTotal','averageRating"));
ok('unassign clears assignment',api.includes("action==='unassign'?null:cf.assignedTo"));
ok('review edit clears case resolution',api.includes('resolutionCode:null,resolvedAt:null,resolvedBy:null'));
ok('V95 historical order statuses',api.includes("['paid','partially_refunded','refunded']"));
ok('V95 full financial pagination',api.includes("fsRunQueryAll(token,'commerceFinancialAllocations')") && api.includes("fsRunQueryAll(token,'commerceVendorLedger')"));
ok('trust health orphan target checks',api.includes('orphan_report_target') && api.includes('orphan_case_target'));

let fails=0; for(const [n,c] of checks){console.log(`${c?'PASS':'FAIL'} — ${n}`); if(!c)fails++;} console.log(`V96 checks: ${checks.length-fails}/${checks.length} passed`); if(fails)process.exit(1);

import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const files={api:read('api/commerce/index.ts'),finance:read('server/commission.ts'),razorpay:read('server/razorpay.ts'),lib:read('src/lib/commerce.ts'),creator:read('src/components/CreatorEarningsPanel.tsx'),admin:read('src/components/CommissionAdminPanel.tsx'),adminHost:read('src/components/CommerceAdminPanel.tsx'),rules:read('firestore.rules'),indexes:read('firestore.indexes.json'),package:read('package.json'),version:read('VERSION.md'),docs:read('V93.0.0_COMMISSION_PROFIT_ENGINE.md')};
const checks=[
 ['version is V93.0.0',files.version.includes('V93.0.0')&&files.package.includes('"version": "0.93.0"')],
 ['commission server module exists',files.finance.includes('calculateCommission')&&files.finance.includes('calculateProportionalReversal')],
 ['server-side exact percentage arithmetic',files.finance.includes('percentageBps')&&files.finance.includes('BigInt')],
 ['commission rule create action',files.api.includes("action==='createCommissionRule'")],
 ['commission rule update/version action',files.api.includes("action==='updateCommissionRule'")&&files.api.includes('ruleVersion')],
 ['commission rule status action',files.api.includes("action==='setCommissionRuleStatus'")],
 ['commission rule list action',files.api.includes("action==='listCommissionRules'")],
 ['commission simulator action',files.api.includes("action==='simulateCommission'")],
 ['creator earnings action',files.api.includes("action==='getCreatorEarnings'")],
 ['admin financial summary action',files.api.includes("action==='adminFinancialSummary'")],
 ['order financial lookup action',files.api.includes("action==='getOrderFinancials'")],
 ['commission reconciliation action',files.api.includes("action==='reconcileCommission'")],
 ['financial allocation collection',files.api.includes('commerceFinancialAllocations/')],
 ['creatorRevenue V93 snapshot',files.api.includes('platformCommissionAmountSubunits')&&files.api.includes('commissionRuleVersion')],
 ['payment-gated calculation',files.api.includes('safeEnsureFinancialAllocation(token,orderId,internalPaymentId)')&&files.api.includes('verifyCapturedPayment(order,paymentId)')],
 ['idempotent financial allocation',files.api.includes("stableId('fin',orderId)")&&files.api.includes('financial allocation must')||files.api.includes('existing=await fsGet(token,`commerceFinancialAllocations/${stableId(\'fin\',orderId)}`)')],
 ['refund webhook processing',files.api.includes('processRefundWebhook')&&files.api.includes("refund.processed")],
 ['refund provider verification',files.razorpay.includes('fetchRefund')],
 ['refund reversal allocation',files.api.includes("entryType:'refund_reversal'")&&files.api.includes('originalAllocationId')],
 ['refund overage protection',files.api.includes('Cumulative refunds exceed')&&files.api.includes('providerAmount>canonicalGrossSubunits')],
 ['historical rule snapshot',files.api.includes('commissionSnapshot')&&files.api.includes('ruleVersion')],
 ['deterministic rule hierarchy',files.api.includes("r.scope==='product'?3:r.scope==='creator'?2:1")],
 ['no client-side commission authority',!files.admin.includes('creatorNetAmount=')&&!files.creator.includes('calculateCommission')],
 ['no automatic Route transfer',!files.api.includes("createTransfer(")],
 ['no payout engine',!files.api.includes('withdrawableBalance')&&!files.api.includes("action==='createPayout'")],
 ['creator earnings UI exists',files.creator.includes('Creator Earnings')&&files.creator.includes('CREATOR NET')],
 ['admin commission UI exists',files.admin.includes('COMMISSION RULE')&&files.admin.includes('COMMISSION SIMULATOR')],
 ['admin host includes V93 panel',files.adminHost.includes('<CommissionAdminPanel />')],
 ['server-authoritative Firestore finance rules',files.rules.includes('match /commerceCommissionRules/{ruleId}')&&files.rules.includes('match /commerceFinancialAllocations/{allocationId}')&&files.rules.includes('allow write: if false')],
 ['V93 indexes present',files.indexes.includes('"commerceFinancialAllocations"')&&files.indexes.includes('"commerceCommissionRules"')],
 ['audit event support',files.api.includes('commission_rule_created')&&files.api.includes('commission_reconciliation_required')&&files.api.includes('commission_recalculated')],
 ['future transfer remains not_started',files.api.includes("transferStatus:'not_started'")],
 ['V93 verify script wired',files.package.includes('check:v93-commission-engine')&&files.package.includes('npm run check:v93-commission-engine')],
 ['documentation defines V94 handoff',files.docs.includes('V94 creates creator balances and payout eligibility')],
 ['documentation defines V95 handoff',files.docs.includes('V95 will build advanced admin finance and revenue analytics')],
];
let failed=0; for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok) failed++;}
if(failed) process.exit(1); console.log(`V93 validator passed: ${checks.length} checks`);

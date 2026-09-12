import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const files={api:read('api/commerce/index.ts'), route:read('server/razorpay-route.ts'), provider:read('server/payment-provider.ts'), lib:read('src/lib/commerce.ts'), ui:read('src/components/CreatorSellerOnboardingPanel.tsx'), rules:read('firestore.rules'), version:read('VERSION.md'), package:read('package.json'), admin:read('src/components/CommerceAdminPanel.tsx')};
const checks=[
 ['version is V92+ compatible', /^V9[2-9]\./.test(files.version.trim())],
 ['Route provider module exists', files.route.includes("POST") && files.route.includes("/accounts")],
 ['Linked Account creation endpoint uses v2/accounts', files.route.includes("https://api.razorpay.com/v2${path}") && files.route.includes("request('/accounts'")],
 ['creatorCommerceProfiles server storage', files.api.includes('creatorCommerceProfiles/')],
 ['createSeller action', files.api.includes("action==='createSeller'"),],
 ['getSeller action', files.api.includes("action==='getSeller'"),],
 ['refreshSeller action', files.api.includes("action==='refreshSeller'"),],
 ['enableSeller action', files.api.includes("action==='enableSeller'"),],
 ['disableSeller action', files.api.includes("action==='disableSeller'"),],
 ['admin seller actions', files.api.includes("action==='adminListSellers'") && files.api.includes("action==='adminSetSellerStatus'"),],
 ['Route webhook action', files.api.includes("action==='razorpayRouteWebhook'"),],
 ['webhook signature verification', files.route.includes('verifyRouteWebhook') && files.api.includes('verifyRouteWebhook(raw,signature)'),],
 ['creator seller UI', files.ui.includes('SELLER ONBOARDING') && files.ui.includes('CONNECT RAZORPAY SELLER ACCOUNT'),],
 ['seller eligibility gate', files.api.includes("seller.fields.sellerEnabled")],
 ['product publishing gate', files.api.includes('Complete seller onboarding and enable selling before publishing'),],
 ['no client account trust', files.api.includes('product.fields.creatorId') && !files.ui.includes('razorpayAccountId = creator'),],
 ['Firestore seller rules', files.rules.includes('match /creatorCommerceProfiles/{creatorId}') && files.rules.includes('allow write: if false'),],
 ['admin seller management UI', files.admin.includes('V92 SELLER MANAGEMENT')],
 ['no payout implementation in V92', !files.api.includes('createTransfer(') || !files.api.includes('action===\'createTransfer\''),]
];
let failed=0; for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`); if(!ok)failed++;}
if(failed) process.exit(1);
console.log(`V92 validator passed: ${checks.length} checks`);

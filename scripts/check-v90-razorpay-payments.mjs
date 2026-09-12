#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const assert=(ok,msg)=>{if(!ok){console.error(`FAIL: ${msg}`);process.exitCode=1;}else console.log(`PASS: ${msg}`);};

const api=read('api/commerce/index.ts');
const provider=read('server/razorpay.ts');
const commerce=read('src/lib/commerce.ts');
const product=read('src/components/CommerceProductView.tsx');
const pkg=JSON.parse(read('package.json'));

assert(provider.includes("request('/orders'"),'server-side Razorpay Orders creation exists');
assert(provider.includes('OFFSCRPT Commerce stores money in currency subunits already'),'Commerce/Razorpay amount-unit handling is explicitly preserved');
assert(provider.includes('verifyPaymentSignature') && provider.includes('createHmac'),'Checkout signature verification exists');
assert(provider.includes('verifyWebhookSignature') && provider.includes('RAZORPAY_WEBHOOK_SECRET'),'Webhook signature verification exists');
assert(api.includes("payment.captured"),'captured-payment webhook handling exists');
assert(api.includes('paymentId,createdAt') && /const order:any=\{[^\n]*paymentId/.test(api),'canonical order stores its internal paymentId before payment finalization');
assert(api.includes("finalizeVerifiedRazorpayPayment"),'canonical payment finalization exists');
assert(api.includes("stableId('ent'"),'deterministic entitlement ID exists');
assert(api.includes("stableId('rp_evt'"),'webhook deduplication identifier exists');
assert(provider.includes('payment amount mismatch'),'amount integrity validation exists');
assert(provider.includes('payment currency mismatch'),'currency integrity validation exists');
assert(provider.includes('RAZORPAY_KEY_SECRET'),'server-side secret reference exists');
assert(!product.includes('confirmTestPayment'),'fake test payment is absent from buyer product UI');
assert(!commerce.includes('confirmTestPayment'),'fake test payment client helper is absent');
assert(!product.includes('offscript_test'),'test provider is absent from buyer product UI');
assert(!read('src/components/CommerceFoundationPanel.tsx').includes('TEST PURCHASE'),'fake test purchase button is absent');
assert(/^0\.(?:9[0-9]|[1-9][0-9])\.\d+$/.test(pkg.version),'package version is V90+ compatible');
assert(pkg.scripts['check:v90-razorpay-payments']==='node scripts/check-v90-razorpay-payments.mjs','V90 validator is registered');

const srcFiles=[];
for(const dir of ['src','public']){
  const base=path.join(root,dir);
  if(!fs.existsSync(base)) continue;
  const walk=(d)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else srcFiles.push(p);}};
  walk(base);
}
const joined=srcFiles.map(p=>fs.readFileSync(p,'utf8')).join('\n');
assert(!joined.includes('RAZORPAY_KEY_SECRET='),'no Razorpay secret assignment is present in browser/public source');
assert(!joined.includes('RAZORPAY_WEBHOOK_SECRET='),'no webhook secret assignment is present in browser/public source');
assert(!joined.includes('R2_PRODUCT_SECRET_ACCESS_KEY='),'no R2 secret assignment is present in browser/public source');

console.log(process.exitCode?'V90 validation failed.':'V90 compatibility validation passed.');

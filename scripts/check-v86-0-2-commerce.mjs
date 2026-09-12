import fs from 'node:fs';

const api = fs.readFileSync('api/commerce/index.ts', 'utf8');
const commerce = fs.readFileSync('src/lib/commerce.ts', 'utf8');
const admin = fs.readFileSync('src/components/CommerceAdminPanel.tsx', 'utf8');
const rules = fs.readFileSync('firestore.rules', 'utf8');
const indexes = JSON.parse(fs.readFileSync('firestore.indexes.json', 'utf8'));

const failures = [];
if (api.includes("return {update:{...write.update,name:firestoreResourceName(String(write.update.name))}};")) failures.push('partial Commit updates still lack updateMask');
if (!api.includes('updateMask:{fieldPaths}')) failures.push('Commit updateMask support missing');
if (!api.includes('currentDocument:{exists:false}')) failures.push('Create emulation precondition missing');
if (api.includes('writes:normalized') === false) failures.push('Commit path missing');
for (const fn of ['createProduct', 'createPrice', 'createCheckout', 'confirmRazorpayPayment', 'handleRazorpayWebhook']) {
  if (!api.includes(`async function ${fn}`)) failures.push(`missing ${fn}`);
}
if (commerce.includes("orderBy('createdAt','desc')")) failures.push('user order list still requires orderBy composite index');
if (commerce.includes("orderBy('updatedAt','desc')")) failures.push('commerce product list still requires orderBy composite index');
if (admin.includes('getCountFromServer')) failures.push('admin commerce panel still performs direct aggregate reads');
if (!admin.includes('/api/commerce?action=diagnostics')) failures.push('admin commerce diagnostics API missing');
for (const path of [
  'match /commerceProducts/{productId}',
  'match /commerceOrders/{orderId}',
  'match /entitlements/{entitlementId}',
  'match /creatorRevenue/{ledgerEntryId}'
]) if (!rules.includes(path)) failures.push(`missing Firestore rule: ${path}`);
for (const group of ['commerceProducts','commerceOrders','entitlements']) if (!indexes.indexes.some(x => x.collectionGroup === group)) failures.push(`missing index group: ${group}`);
if (fs.existsSync('src/firestore.rules')) failures.push('duplicate src/firestore.rules exists');
if (failures.length) { console.error('V86.0.2 CHECK FAILED'); for (const f of failures) console.error(`- ${f}`); process.exit(1); }
console.log('V86.0.2 COMMERCE CHECK PASSED');

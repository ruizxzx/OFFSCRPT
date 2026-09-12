import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));
const fail = (msg) => { console.error(`FAIL: ${msg}`); failures++; };
const pass = (msg) => console.log(`PASS: ${msg}`);
let failures = 0;

const pkg = JSON.parse(read('package.json'));
if (!/^0\.(?:9[0-9]|[1-9][0-9])\.\d+$/.test(pkg.version)) fail(`package.json version ${pkg.version} is outside the V89+ release line`); else pass(`package version ${pkg.version} is V89+ compatible`);
if (!/^V(?:89|9[0-9])(?:\.\d+)+$/.test(read('VERSION.md').trim())) fail('VERSION.md is outside the V89+ release line'); else pass(`VERSION.md ${read('VERSION.md').trim()} is V89+ compatible`);

for (const rel of [
  'src/components/MarketplaceView.tsx',
  'src/components/MarketplaceProductCard.tsx',
  'src/components/SavedProductsView.tsx',
  'src/components/MarketplaceErrorBoundary.tsx',
  'src/components/CommerceProductView.tsx',
  'src/lib/marketplace.ts',
  'scripts/check-v89-marketplace.mjs',
  'V89.0.0_MARKETPLACE_BUYER_EXPERIENCE.md',
  'V89.0.1_MARKETPLACE_INDEX_HOTFIX.md',
  'V89.0.1_RELEASE.md',
  'BUILD_VALIDATION_V89.0.1.txt',
]) if (!exists(rel)) fail(`missing required V89 file: ${rel}`); else pass(`required file present: ${rel}`);

const app = read('src/App.tsx');
for (const marker of ["hash === 'shop'", "hash === 'marketplace'", "currentPage === 'shop'", "currentPage === 'saved_products'", "currentPage === 'product'", 'MarketplaceErrorBoundary']) {
  if (!app.includes(marker)) fail(`App missing marketplace integration marker: ${marker}`);
}
if (!failures) pass('Shop, marketplace alias, saved products, product route, and error-boundary integration present');

const card = read('src/components/MarketplaceProductCard.tsx');
for (const marker of ['product_impression', 'IntersectionObserver', 'product.thumbnail', 'product.gallery']) {
  if (!card.includes(marker)) fail(`product card missing ${marker}`);
}

const market = read('src/components/MarketplaceView.tsx');
for (const marker of ['marketplace_view','marketplace_search','marketplace_filter','debounceRef','requestSeqRef','LOAD MORE','price_asc','price_desc','creatorId']) {
  if (!market.includes(marker)) fail(`MarketplaceView missing ${marker}`);
}

const lib = read('src/lib/marketplace.ts');
const commerceApi = read('api/commerce/index.ts');
if (!commerceApi.includes('commerceProducts')) fail('commerce API is missing canonical commerceProducts usage'); else pass('canonical commerceProducts remains the marketplace source');
for (const marker of ['savedProducts','toggleMarketplaceSave','listMarketplaceProducts']) {
  if (!lib.includes(marker)) fail(`marketplace lib missing ${marker}`);
}
if (lib.includes('marketplaceProducts') || lib.includes('shopProducts') || lib.includes('storeProducts') || lib.includes('digitalMarketplaceProducts') || lib.includes('buyerProducts')) fail('duplicate marketplace product collection name found'); else pass('no duplicate marketplace product collection implementation');

const product = read('src/components/CommerceProductView.tsx');
for (const marker of ['useMemo','lightboxOpen','product_gallery_open','OPEN MY PURCHASES','COPY LINK','canonicalHref','loginWithGoogle']) {
  if (!product.includes(marker)) fail(`product page missing ${marker}`);
}

const commerce = read('src/lib/commerce.ts');
if (!commerce.includes("callPublicApi<{products:CommerceProduct[]}>('marketplaceByIds'")) fail('getCommerceProduct is not using sanitized marketplace projection'); else pass('product page reads sanitized public projection');
for (const marker of ['category?: string','tags?: string[]','whatIsIncluded?: string','viewsCount?: number']) {
  if (!commerce.includes(marker)) fail(`CommerceProduct type missing ${marker}`);
}

const api = read('api/commerce/index.ts');
if (!api.includes("fsRunQueryAdvanced(token,'commerceProducts',[fsFilter('status','EQUAL',{stringValue:'active'})]")) fail('marketplace does not use the index-light active-product query'); else pass('marketplace uses index-light active-product query');
if (!api.includes("orderBy:[{fieldPath:'__name__',direction:'ASCENDING'}]")) fail('marketplace active query lacks deterministic bounded ordering'); else pass('marketplace active query uses deterministic document ordering');
for (const marker of ['publicProductProjection','status','visibility','marketplaceList','marketplaceHome','marketplaceByIds']) {
  if (!api.includes(marker)) fail(`commerce API missing ${marker}`);
}
if (!api.includes("visibility:'public'")) fail('public product projection does not force public visibility');
if (!api.includes("status:'active'")) fail('public product projection does not force active status');
for (const secret of ['R2_SECRET_ACCESS_KEY','R2_PRODUCT_SECRET_ACCESS_KEY']) {
  if (api.includes(secret)) fail(`commerce API unexpectedly references R2 secret ${secret}`);
}
if (!api.includes("slice(0,50)")) fail('popular creator result is not bounded'); else pass('popular creator discovery is bounded');

const rules = read('firestore.rules');
for (const marker of ['match /users/{userId}/savedProducts/{productId}', 'request.auth.uid == userId', 'incoming().productId == productId']) {
  if (!rules.includes(marker)) fail(`Firestore saved-product rule missing ${marker}`);
}
if (!rules.includes('marketplace_view') || !rules.includes('product_impression')) fail('marketplace activity event allowlist incomplete'); else pass('saved-product rules and marketplace activity events present');

const indexes = JSON.parse(read('firestore.indexes.json'));
const hasMarketplaceIndex = indexes.indexes?.some(i => i.collectionGroup === 'commerceProducts' && i.fields?.some(f => f.fieldPath === 'status') && i.fields?.some(f => f.fieldPath === 'visibility') && i.fields?.some(f => f.fieldPath === 'publishedAt'));
if (!hasMarketplaceIndex) fail('missing commerceProducts status/visibility/publishedAt marketplace index'); else pass('marketplace Firestore index declared');

const apiFiles = fs.readdirSync(path.join(root,'api'), { withFileTypes: true }).reduce((acc, ent) => {
  if (ent.isFile() && ent.name.endsWith('.ts')) acc.push(path.join('api', ent.name));
  if (ent.isDirectory()) {
    for (const sub of fs.readdirSync(path.join(root,'api',ent.name), { withFileTypes: true })) {
      if (sub.isFile() && sub.name.endsWith('.ts')) acc.push(path.join('api',ent.name,sub.name));
    }
  }
  return acc;
}, []);
if (apiFiles.length > 12) fail(`/api route/function candidates ${apiFiles.length} exceeds Vercel Hobby headroom`); else pass(`/api routes/function candidates bounded at ${apiFiles.length}`);
if (fs.existsSync(path.join(root,'api','lib'))) fail('api/lib exists; shared server utilities must remain outside /api'); else pass('no api/lib directory');

for (const rel of ['src','public']) {
  const bad = [];
  const stack = [path.join(root, rel)];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir,{withFileTypes:true})) {
      const fp = path.join(dir,ent.name);
      if (ent.isDirectory()) stack.push(fp);
      else if (/\.(ts|tsx|js|jsx|mjs|html|css)$/.test(ent.name)) {
        const text = fs.readFileSync(fp,'utf8');
        if (/process\.env\.(R2_PRODUCT_SECRET_ACCESS_KEY|R2_SECRET_ACCESS_KEY)|import\.meta\.env\.(R2_PRODUCT_SECRET_ACCESS_KEY|R2_SECRET_ACCESS_KEY)/.test(text)) bad.push(path.relative(root,fp));
      }
    }
  }
  if (bad.length) fail(`secret environment variable usage leaked into ${rel}: ${bad.join(', ')}`); else pass(`no R2 secret env access in ${rel}`);
}

const sourceFiles=[];
const srcRoot=path.join(root,'src');
const walk=(dir)=>{for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const fp=path.join(dir,ent.name);if(ent.isDirectory())walk(fp);else if(/\.(ts|tsx)$/.test(ent.name))sourceFiles.push(fp);}};
walk(srcRoot);
let cjs=[];
for(const fp of sourceFiles){const text=fs.readFileSync(fp,'utf8');if(/(^|\s)require\s*\(/.test(text)||/module\.exports|(^|\s)exports\./.test(text))cjs.push(path.relative(root,fp));}
if(cjs.length) fail(`browser CommonJS patterns found: ${cjs.join(', ')}`); else pass('no browser CommonJS require/module.exports patterns');

if (failures) { console.error(`\nV89 marketplace checks failed: ${failures}`); process.exit(1); }
console.log('\nV89 marketplace checks passed.');

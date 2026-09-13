import React, { useEffect, useState } from 'react';
import { CheckCircle2, Download, ExternalLink, FileText, Loader2, Package, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuthUser } from '../lib/useAuthUser';
import { loginWithGoogle } from '../lib/firebase';
import { downloadMyDigitalProductFile, listMyDigitalPurchases, openMyDigitalExternalResource, type DigitalPurchase, type PurchasedDigitalProductFile } from '../lib/digitalProducts';
import type { PageView } from '../types';
import { notifyToast } from '../lib/toast';

interface Props { onNavigate:(page:PageView,param?:string)=>void; }

const money = (amount:number,currency:string) => {
  try { return new Intl.NumberFormat('en-IN',{style:'currency',currency}).format((Number(amount)||0)/100); }
  catch { return `${currency} ${((Number(amount)||0)/100).toFixed(2)}`; }
};
const dateLabel = (value?:string) => value ? new Date(value).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}) : 'RECENT PURCHASE';
const sizeLabel = (bytes:number) => { const n=Number(bytes); if(!Number.isFinite(n)||n<=0) return 'SIZE UNKNOWN'; return n < 1024*1024 ? `${Math.max(1,Math.round(n/1024))} KB` : `${(n/(1024*1024)).toFixed(1)} MB`; };
const previewImage = (purchase:DigitalPurchase) => purchase.product.thumbnail || purchase.product.gallery?.[0] || '';

const FileRow:React.FC<{file:PurchasedDigitalProductFile;disabled?:boolean}> = ({file,disabled}) => {
  const [loading,setLoading]=useState(false); const external=String(file.resourceType||'upload')==='external';
  const handleAction = async () => {
    if(disabled||loading)return; setLoading(true);
    try{ if(external){const result=await openMyDigitalExternalResource(file.id); window.open(result.url,'_blank','noopener,noreferrer');} else {const result=await downloadMyDigitalProductFile(file.id); window.location.assign(result.downloadUrl);} }
    catch(error){notifyToast(error instanceof Error?error.message:(external?'Resource could not be opened.':'Download could not be started.'),'error');}
    finally{setLoading(false);}
  };
  return <div className="border-2 border-black bg-white p-3 flex flex-col sm:flex-row sm:items-center gap-3 overflow-hidden">
    <div className="w-10 h-10 border-2 border-black bg-neutral-100 flex items-center justify-center shrink-0"><FileText className="w-5 h-5"/></div>
    <div className="min-w-0 flex-1"><div title={String(file.displayName||file.originalFilename||'Resource')} className="font-display font-black uppercase truncate">{file.displayName||file.originalFilename||'RESOURCE'}</div><div className="font-mono text-[9px] uppercase text-neutral-500 mt-1 truncate">{external ? `${file.provider||'EXTERNAL'} · EXTERNAL RESOURCE` : `${String(file.mimeType||'FILE')} · ${sizeLabel(Number(file.sizeBytes||0))}`}{file.status==='archived'?' · HISTORICAL':''}</div></div>
    <button onClick={()=>void handleAction()} disabled={disabled||loading} className={`w-full sm:w-auto sm:shrink-0 border-2 border-black px-3 py-2 font-mono text-[9px] font-black uppercase inline-flex items-center justify-center gap-2 ${disabled?'bg-neutral-200 text-neutral-500 cursor-not-allowed':'bg-[var(--color-primary)] hover:bg-black hover:text-[var(--color-primary)]'}`}>{loading?<Loader2 className="w-4 h-4 animate-spin"/>:<Download className="w-4 h-4"/>}{loading?(external?'OPENING':'PREPARING'):(external?'OPEN RESOURCE':'DOWNLOAD')}</button>
  </div>;
};

export const PurchasesView:React.FC<Props> = ({onNavigate}) => {
  const user=useAuthUser();
  const [purchases,setPurchases]=useState<DigitalPurchase[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');

  const load=async()=>{
    if(!user){setPurchases([]);setLoading(false);return;}
    setLoading(true);setError('');
    try { const result=await listMyDigitalPurchases(); setPurchases(Array.isArray(result.purchases)?result.purchases:[]); }
    catch(e){ setError(e instanceof Error?e.message:'Could not load purchases.'); }
    finally { setLoading(false); }
  };
  useEffect(()=>{void load();},[user?.uid]);

  if(!user) return <section className="max-w-3xl mx-auto px-4 py-20 sm:py-28 text-center"><Package className="w-12 h-12 mx-auto mb-4"/><div className="font-mono text-[10px] uppercase text-neutral-500">PRIVATE PURCHASE LIBRARY</div><h1 className="font-display font-black text-4xl sm:text-6xl uppercase mt-2">MY PURCHASES</h1><p className="mt-4 text-neutral-600">Sign in to access your digital products and secure downloads.</p><button onClick={()=>void loginWithGoogle()} className="mt-6 border-2 border-black bg-[var(--color-primary)] px-5 py-3 font-mono text-[10px] font-black uppercase">SIGN IN WITH GOOGLE</button></section>;

  return <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-14">
    <header className="border-4 border-black bg-[var(--color-primary)] neo-shadow-lg p-5 sm:p-8 mb-8 flex flex-wrap items-end justify-between gap-5">
      <div><button onClick={()=>onNavigate('dashboard')} className="font-mono text-[10px] uppercase underline">← MY OFFSCRPT</button><div className="font-mono text-[10px] uppercase font-black mt-6">DIGITAL LIBRARY</div><h1 className="font-display font-black text-4xl sm:text-6xl uppercase leading-none mt-2">MY PURCHASES</h1><p className="mt-3 max-w-2xl">Your purchased digital products, files and secure downloads in one account-owned library.</p></div>
      <button onClick={()=>void load()} className="border-2 border-black bg-white px-4 py-3 font-mono text-[10px] font-black uppercase inline-flex items-center gap-2"><RefreshCw className="w-4 h-4"/> REFRESH</button>
    </header>

    {loading ? <div className="py-24 flex justify-center"><Loader2 className="w-10 h-10 animate-spin"/></div> : error ? <div className="border-4 border-black bg-red-50 p-6 neo-shadow"><div className="font-mono text-[10px] uppercase text-red-600 font-black">PURCHASES COULD NOT LOAD</div><div className="font-display font-black text-2xl uppercase mt-2">{error}</div><button onClick={()=>void load()} className="mt-4 border-2 border-black bg-white px-4 py-2 font-mono text-[10px] font-black uppercase">TRY AGAIN</button></div> : !purchases.length ? <div className="border-4 border-black bg-white p-10 text-center neo-shadow"><Package className="w-10 h-10 mx-auto"/><h2 className="font-display font-black text-3xl uppercase mt-4">NO PURCHASES YET</h2><p className="font-mono text-[10px] text-neutral-500 uppercase mt-2">Products you buy will appear here with secure download access.</p><button onClick={()=>onNavigate('explore')} className="mt-5 border-2 border-black bg-[var(--color-primary)] px-4 py-3 font-mono text-[10px] font-black uppercase">EXPLORE PRODUCTS</button></div> : <div className="space-y-6">
      {purchases.map(p=>{
        const image=previewImage(p);
        const active=p.canDownload;
        return <article key={p.id} className="border-4 border-black bg-white neo-shadow overflow-hidden">
          <div className="grid lg:grid-cols-[220px_1fr]">
            <div className="aspect-square lg:aspect-auto min-h-[180px] bg-neutral-100 border-b-4 lg:border-b-0 lg:border-r-4 border-black flex items-center justify-center overflow-hidden">
              {image ? <img src={image} alt="" className="w-full h-full object-cover" /> : <Package className="w-14 h-14"/>}
            </div>
            <div className="p-5">
              <div className="flex flex-wrap gap-2 items-center justify-between"><div className="font-mono text-[9px] uppercase text-neutral-500">PURCHASED · {dateLabel(p.purchasedAt)}</div><div className={`font-mono text-[9px] font-black uppercase inline-flex items-center gap-1 border-2 border-black px-2 py-1 ${active ? 'bg-[#00FF41]' : 'bg-neutral-200'}`}>{active ? <CheckCircle2 className="w-3.5 h-3.5"/> : null}{p.entitlementStatus}</div></div>
              <h2 className="font-display font-black text-3xl sm:text-4xl uppercase leading-none mt-2">{p.product.title}</h2>
              {p.product.subtitle && <p className="mt-2 text-neutral-600 max-w-2xl">{p.product.subtitle}</p>}
              <div className="font-mono text-[9px] uppercase text-neutral-500 mt-4">{p.product.creatorUsername ? `BY @${p.product.creatorUsername}` : (p.product.creatorDisplayName ? `BY ${p.product.creatorDisplayName}` : 'OFFSCRPT CREATOR')} · {money(p.order.total,p.order.currency)} · {p.files.filter(f=>String(f.resourceType||'upload')==='upload').length} FILE{p.files.filter(f=>String(f.resourceType||'upload')==='upload').length===1?'':'S'} · {p.files.filter(f=>String(f.resourceType||'')==='external').length} LINK{p.files.filter(f=>String(f.resourceType||'')==='external').length===1?'':'S'}</div>
              <div className="mt-5 flex flex-wrap gap-2"><><button onClick={()=>onNavigate('product',p.product.id)} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black uppercase inline-flex items-center gap-2"><ExternalLink className="w-4 h-4"/> VIEW PRODUCT</button><button onClick={()=>onNavigate('product',p.product.id)} className="border-2 border-black bg-[var(--color-primary)] px-3 py-2 font-mono text-[9px] font-black uppercase inline-flex items-center gap-2"><CheckCircle2 className="w-4 h-4"/> REVIEW</button></><div className="border-2 border-black bg-black text-white px-3 py-2 font-mono text-[9px] font-black uppercase inline-flex items-center gap-2"><ShieldCheck className="w-4 h-4"/> ACCOUNT-LOCKED ACCESS</div></div>
              <div className="mt-5 space-y-2">{active && p.files.length ? p.files.map(file=><FileRow key={file.id} file={file}/>) : <div className="border-2 border-dashed border-black p-5 font-mono text-[10px] uppercase text-neutral-500">DOWNLOAD ACCESS IS CURRENTLY UNAVAILABLE FOR THIS PURCHASE ({p.entitlementStatus}).</div>}</div>
            </div>
          </div>
        </article>;
      })}
    </div>}
  </section>;
};

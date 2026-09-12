import React, { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign, LockKeyhole, Package, Plus, RefreshCw, ShieldCheck, ShoppingBag, WalletCards } from 'lucide-react';
import type { CommunityUser } from '../types';
import { auth } from '../lib/firebase';
import { createCommercePrice, createCommerceProduct, listCommercePrices, listCreatorCommerceProducts, listUserCommerceOrders, setCommerceProductStatus, setCommerceProductVisibility, type CommerceOrder, type CommerceProduct, type CommercePublicPrice } from '../lib/commerce';
import { notifyToast } from '../lib/toast';

interface Props { userProfile: CommunityUser | null; }

const money=(amount:number,currency:string)=>new Intl.NumberFormat(undefined,{style:'currency',currency}).format((Number(amount)||0)/100);

export const CommerceFoundationPanel: React.FC<Props> = ({userProfile}) => {
  const [products,setProducts]=useState<CommerceProduct[]>([]);
  const [orders,setOrders]=useState<CommerceOrder[]>([]);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [title,setTitle]=useState('');
  const [description,setDescription]=useState('');
  const [amount,setAmount]=useState('49900');
  const [currency,setCurrency]=useState('INR');
  const [notice,setNotice]=useState('');
  const [visibility,setVisibility]=useState<'public'|'private'>('public');
  const [priceMap,setPriceMap]=useState<Record<string,CommercePublicPrice[]>>({});
  const isCreator=Boolean(userProfile?.uid && (userProfile.isAuthor || userProfile.role?.toLowerCase().includes('creator')));

  const refresh=async()=>{
    if(!userProfile?.uid)return; setLoading(true);
    try{const [p,o]=await Promise.all([listCreatorCommerceProducts(userProfile.uid),listUserCommerceOrders(userProfile.uid)]);setProducts(p);setOrders(o);}
    catch(e:any){setNotice(e?.message||'Commerce data could not be loaded.');}
    finally{setLoading(false);}
  };
  useEffect(()=>{void refresh();},[userProfile?.uid]);

  const activeProducts=useMemo(()=>products.filter(p=>p.status==='active'),[products]);

  const create=async()=>{
    if(!userProfile?.uid)return notifyToast('Sign in required.','error');
    if(!isCreator)return notifyToast('Creator commerce is not configured for this account.','error');
    const value=Math.floor(Number(amount)); if(!Number.isSafeInteger(value)||value<=0)return notifyToast('Enter a valid amount in minor currency units. Example: ₹499 = 49900.','error');
    setBusy(true);setNotice('');
    try{
      const result=await createCommerceProduct({title,description,type:'digital_product',visibility,currency,price:{amount:value,currency,billingType:'one_time'}});
      setTitle('');setDescription('');setVisibility('public');setNotice(`Draft product created: ${result.product.id}`); await refresh();
    }catch(e:any){notifyToast(e?.message||'Could not create product.','error');}
    finally{setBusy(false);}
  };

  const activate=async(productId:string)=>{setBusy(true);try{await setCommerceProductStatus(productId,'active');notifyToast('Product activated in Firestore.','success');await refresh();}catch(e:any){notifyToast(e?.message||'Could not activate product.','error');}finally{setBusy(false);}};

  const toggleVisibility=async(product:CommerceProduct)=>{setBusy(true);try{const next=product.visibility==='public'?'private':'public';await setCommerceProductVisibility(product.id,next);notifyToast(next==='public'?'Product is public in your storefront.':'Product hidden from your storefront.','success');await refresh();}catch(e:any){notifyToast(e?.message||'Could not update product visibility.','error');}finally{setBusy(false);}};
  const loadPrices=async(productId:string)=>{if(priceMap[productId])return;try{const prices=await listCommercePrices(productId);setPriceMap(m=>({...m,[productId]:prices}));}catch(error){void error;}};
  if(!userProfile)return <div className="border-2 border-black bg-white p-6 font-mono text-xs">SIGN IN TO USE COMMERCE FOUNDATION.</div>;

  return <section className="space-y-5">
    <div className="border-4 border-black bg-black text-white p-5 sm:p-7 neo-shadow-lg">
      <div className="flex items-center gap-2 font-mono text-[10px] font-black text-[var(--color-primary)]"><CircleDollarSign className="w-4 h-4"/> COMMERCE FOUNDATION · V86</div>
      <h2 className="font-display font-black text-3xl sm:text-4xl uppercase mt-2">Commerce Core</h2>
      <p className="text-sm text-neutral-300 mt-3 max-w-3xl">Server-authoritative orders, Razorpay payments, entitlements and creator revenue ledger infrastructure. Full subscriptions, storefronts, products and courses arrive in later builds.</p>
      <div className="flex flex-wrap gap-2 mt-5 font-mono text-[9px] font-black uppercase"><span className="border-2 border-[var(--color-primary)] px-3 py-2">RAZORPAY</span><span className="border-2 border-white px-3 py-2">UID: {userProfile.uid.slice(0,8)}…</span><span className="border-2 border-white px-3 py-2">CURRENCY: {currency}</span></div>
    </div>

    <div className="grid lg:grid-cols-2 gap-4">
      <div className="border-2 border-black bg-white p-5 space-y-3">
        <div className="flex items-center gap-2 font-display font-black uppercase text-xl"><Plus className="w-5 h-5"/> CREATE PRODUCT</div>
        {!isCreator&&<div className="border-2 border-black bg-yellow-100 p-3 font-mono text-[9px]">CREATOR ELIGIBILITY NOT ACTIVE FOR THIS ACCOUNT.</div>}
        <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Product title" className="w-full border-2 border-black p-3 font-mono text-xs" maxLength={160}/>
        <textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="Product description" className="w-full border-2 border-black p-3 font-mono text-xs min-h-24" maxLength={5000}/>
        <div className="grid grid-cols-2 gap-2"><input value={amount} onChange={e=>setAmount(e.target.value.replace(/[^0-9]/g,''))} inputMode="numeric" placeholder="Amount in minor units" className="border-2 border-black p-3 font-mono text-xs"/><select value={currency} onChange={e=>setCurrency(e.target.value)} className="border-2 border-black p-3 font-mono text-xs"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select></div>
        <label className="block border-2 border-black p-3 font-mono text-[9px] font-black uppercase">STORE VISIBILITY<select value={visibility} onChange={e=>setVisibility(e.target.value as 'public'|'private')} className="w-full mt-2 border-2 border-black p-2 font-mono text-xs bg-white"><option value="public">Public storefront</option><option value="private">Private</option></select></label>
        <button disabled={busy||!title.trim()||!isCreator} onClick={()=>void create()} className="w-full border-2 border-black bg-[var(--color-primary)] px-4 py-3 font-mono text-[10px] font-black uppercase disabled:opacity-40">CREATE DRAFT</button>
      </div>

      <div className="border-2 border-black bg-white p-5 space-y-3">
        <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 font-display font-black uppercase text-xl"><Package className="w-5 h-5"/> PRODUCTS</div><button onClick={()=>void refresh()} className="border-2 border-black px-3 py-2 font-mono text-[9px] font-black"><RefreshCw className="inline w-3 h-3"/> REFRESH</button></div>
        {loading?<div className="font-mono text-xs">LOADING…</div>:products.length===0?<div className="border-2 border-dashed border-black p-5 font-mono text-xs">NO COMMERCE PRODUCTS YET.</div>:<div className="space-y-2 max-h-80 overflow-auto">{products.map(p=><div key={p.id} onMouseEnter={()=>void loadPrices(p.id)} className="border-2 border-black p-3"><div className="flex items-start justify-between gap-3"><div><div className="font-display font-black uppercase break-words">{p.title}</div><div className="font-mono text-[9px] mt-1">{p.status.toUpperCase()} · {p.type} · {p.currency} · {p.visibility.toUpperCase()}</div>{priceMap[p.id]?.[0]&&<div className="font-mono text-[9px] mt-1">{money(priceMap[p.id][0].amount,priceMap[p.id][0].currency)}</div>}</div><div className="flex flex-wrap gap-1 justify-end">{p.status==='draft'&&<button disabled={busy} onClick={()=>void activate(p.id)} className="border-2 border-black bg-white px-2 py-1 font-mono text-[8px] font-black">ACTIVATE</button>}{p.status==='active'&&<button disabled={busy} onClick={()=>void toggleVisibility(p)} className="border-2 border-black bg-[var(--color-secondary)] px-2 py-1 font-mono text-[8px] font-black">{p.visibility==='public'?'HIDE':'PUBLISH'}</button>}</div></div>{p.status==='active'&&p.priceIds?.[0]&&<div className="mt-2 flex flex-wrap gap-2"><button disabled={busy} onClick={()=>window.open(`${window.location.origin}/#product/${p.id}`,"_blank","noopener,noreferrer")} className="border-2 border-black bg-black text-white px-3 py-2 font-mono text-[9px] font-black uppercase">OPEN CHECKOUT</button>{p.visibility==='public'?<button onClick={()=>window.open(`${window.location.origin}/#product/${p.id}`,'_blank','noopener,noreferrer')} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black uppercase">VIEW PRODUCT</button>:<span className="border-2 border-black bg-neutral-100 px-3 py-2 font-mono text-[9px] font-black uppercase">PRIVATE STORE</span>}</div>}</div>)}</div>}
      </div>
    </div>

    <div className="grid lg:grid-cols-2 gap-4">
      <div className="border-2 border-black bg-white p-5"><div className="flex items-center gap-2 font-display font-black uppercase text-xl"><ShoppingBag className="w-5 h-5"/> MY PURCHASES</div><div className="mt-3 space-y-2">{orders.length===0?<div className="font-mono text-xs text-neutral-600">No purchases yet. Publish a product and complete a Razorpay checkout.</div>:orders.map(o=><div key={o.id} className="border-2 border-black p-3 flex flex-wrap justify-between gap-3"><div><div className="font-mono text-[9px] font-black">ORDER {o.id.slice(0,10)}…</div><div className="font-display font-black mt-1">{money(o.total,o.currency)}</div><div className="font-mono text-[8px]">{String(o.status).toUpperCase()}</div></div></div>)}</div></div>
      <div className="border-2 border-black bg-white p-5 space-y-3"><div className="flex items-center gap-2 font-display font-black uppercase text-xl"><ShieldCheck className="w-5 h-5"/> SECURITY MODEL</div><div className="grid grid-cols-2 gap-2 font-mono text-[9px] uppercase"><div className="border-2 border-black p-3"><LockKeyhole className="w-4 h-4 mb-2"/>SERVER AUTHORITATIVE</div><div className="border-2 border-black p-3"><WalletCards className="w-4 h-4 mb-2"/>IMMUTABLE LEDGER</div><div className="border-2 border-black p-3">NO CLIENT PRICE TRUST</div><div className="border-2 border-black p-3">IDEMPOTENT PAYMENT FLOW</div></div><p className="font-mono text-[9px] text-neutral-600">V90 uses server-authoritative Razorpay payment verification. Live/test mode is controlled only by server environment configuration.</p></div>
    </div>
    {notice&&<div className="border-2 border-black bg-yellow-100 p-3 font-mono text-[9px] font-black">{notice}</div>}
  </section>;
};

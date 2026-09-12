import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, Copy, ExternalLink, Heart, Image as ImageIcon, Share2, ShoppingBag, UserRound, X } from 'lucide-react';
import type { CommunityUser, PageView } from '../types';
import { getCommerceProduct, listCommercePrices, hasCommerceAccess, createCommerceCheckout, confirmRazorpayPayment, type CommerceProduct, type CommercePublicPrice } from '../lib/commerce';
import { getProfileByUsername } from '../lib/community';
import { auth, loginWithGoogle } from '../lib/firebase';
import { notifyToast } from '../lib/toast';
import { listMarketplaceProducts, isMarketplaceProductSaved, toggleMarketplaceSave, recordMarketplaceEvent } from '../lib/marketplace';
import { MarketplaceProductCard } from './MarketplaceProductCard';

interface Props { productId:string; userProfile:CommunityUser|null; onNavigate:(page:PageView,param?:string)=>void; }
const money=(amount:number,currency:string)=>new Intl.NumberFormat(undefined,{style:'currency',currency}).format((Number(amount)||0)/100);
const safeUsername=(value:string)=>String(value||'').replace(/^@/,'').trim();

export const CommerceProductView:React.FC<Props>=({productId,userProfile,onNavigate})=>{
  const [product,setProduct]=useState<CommerceProduct|null>(null);
  const [prices,setPrices]=useState<CommercePublicPrice[]>([]);
  const [creator,setCreator]=useState<CommunityUser|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [owned,setOwned]=useState(false);
  const [error,setError]=useState('');
  const [activeImage,setActiveImage]=useState(0);
  const [lightboxOpen,setLightboxOpen]=useState(false);
  const lightboxCloseRef=useRef<HTMLButtonElement|null>(null);
  const [saved,setSaved]=useState(false);
  const [related,setRelated]=useState<CommerceProduct[]>([]);
  const [relatedPrices,setRelatedPrices]=useState<Record<string,CommercePublicPrice|undefined>>({});
  const [creatorProducts,setCreatorProducts]=useState<CommerceProduct[]>([]);
  const [creatorProductPrices,setCreatorProductPrices]=useState<Record<string,CommercePublicPrice|undefined>>({});

  useEffect(()=>{
    let active=true;
    (async()=>{
      setLoading(true); setError('');
      try{
        const p=await getCommerceProduct(productId);
        if(!p){ if(active){setProduct(null);setError('PRODUCT NOT AVAILABLE.');} return; }
        const [priceRows,creatorRow]=await Promise.all([
          listCommercePrices(p.id),
          p.creatorUsername ? getProfileByUsername(safeUsername(String(p.creatorUsername))) : Promise.resolve(null),
        ]);
        if(!active)return;
        const alreadyOwned=auth.currentUser ? await hasCommerceAccess(auth.currentUser.uid,'product',p.id).catch(()=>false) : false;
        if(!active)return;
        setProduct(p); recordMarketplaceEvent('product_open',p.id,{title:p.title,source:'product-page'}); setPrices(priceRows); setCreator(creatorRow); setOwned(alreadyOwned); setActiveImage(0);
        const [savedState,relatedPage,creatorPage]=await Promise.all([auth.currentUser ? isMarketplaceProductSaved(p.id).catch(()=>false) : Promise.resolve(false), listMarketplaceProducts({category:String(p.category||''),type:p.type,sort:'popular',limit:12}).catch(()=>({products:[],prices:{}} as any)), listMarketplaceProducts({creatorId:p.creatorId,sort:'newest',limit:12}).catch(()=>({products:[],prices:{}} as any))]);
        if(!active)return;
        setSaved(Boolean(savedState));
        const relatedRows=(relatedPage.products||[]).filter((x:CommerceProduct)=>x.id!==p.id).slice(0,6);
        const creatorRows=(creatorPage.products||[]).filter((x:CommerceProduct)=>x.id!==p.id).slice(0,6);
        setRelated(relatedRows); setRelatedPrices(relatedPage.prices||{}); setCreatorProducts(creatorRows); setCreatorProductPrices(creatorPage.prices||{});
      }catch(e:any){ if(active)setError(e?.message||'Could not load this product.'); }
      finally{if(active)setLoading(false);}
    })();
    return ()=>{active=false;};
  },[productId]);

  const primaryPrice=useMemo(()=>prices[0]||null,[prices]);
  // Keep every hook unconditional: this component renders loading/error states
  // before the product data arrives, so gallery must be derived before any
  // early return to preserve React hook order.
  const gallery=useMemo(()=>{
    const values=[...(product?.gallery||[])];
    if(product?.thumbnail && !values.includes(product.thumbnail)) values.unshift(product.thumbnail);
    return values.filter(Boolean).slice(0,12);
  },[product]);

  useEffect(()=>{
    if(!product || typeof document==='undefined')return;
    const previousTitle=document.title;
    document.title=`${product.title} — OFFSCRPT`;
    let descriptionMeta=document.querySelector<HTMLMetaElement>('meta[name=description]');
    if(!descriptionMeta){descriptionMeta=document.createElement('meta');descriptionMeta.name='description';document.head.appendChild(descriptionMeta);}
    const previousDescription=descriptionMeta.getAttribute('content');
    descriptionMeta.setAttribute('content',product.subtitle||product.description.slice(0,160));
    const canonicalHref=`${window.location.origin}/product/${encodeURIComponent(product.id)}`;
    let canonical=document.querySelector<HTMLLinkElement>('link[rel=canonical]');
    if(!canonical){canonical=document.createElement('link');canonical.rel='canonical';document.head.appendChild(canonical);}
    const previousCanonical=canonical.getAttribute('href');
    canonical.setAttribute('href',canonicalHref);
    return()=>{
      document.title=previousTitle;
      if(previousDescription===null)descriptionMeta?.remove(); else descriptionMeta?.setAttribute('content',previousDescription);
      if(previousCanonical===null)canonical?.remove(); else canonical?.setAttribute('href',previousCanonical);
    };
  },[product]);

  useEffect(()=>{
    if(!lightboxOpen)return;
    const previousFocus=document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.setTimeout(()=>lightboxCloseRef.current?.focus(),0);
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape')setLightboxOpen(false);
      if(event.key==='ArrowLeft' && gallery.length>1)setActiveImage(i=>(i-1+gallery.length)%gallery.length);
      if(event.key==='ArrowRight' && gallery.length>1)setActiveImage(i=>(i+1)%gallery.length);
    };
    window.addEventListener('keydown',onKey);
    return()=>{window.removeEventListener('keydown',onKey);previousFocus?.focus();};
  },[lightboxOpen,gallery.length]);

  const saveToggle=async()=>{
    if(!product)return;
    if(!auth.currentUser){
      try{const signedIn=await loginWithGoogle();if(!signedIn)return;}catch(e:any){notifyToast(e?.message||'Sign-in failed.','error');return;}
    }
    try{const next=await toggleMarketplaceSave(product,saved);setSaved(next);notifyToast(next?'Saved product.':'Removed from saved products.','success');}
    catch(e:any){notifyToast(e?.message||'Could not update saved product.','error');}
  };

  const copyProductLink=async()=>{
    const url=`${window.location.origin}${window.location.pathname}#product/${encodeURIComponent(productId)}`;
    try{await navigator.clipboard.writeText(url);notifyToast('Product link copied.','success');recordMarketplaceEvent('share',productId,{source:'product-page',method:'copy'});}catch{notifyToast('Could not copy the product link.','error');}
  };
  const shareProduct=async()=>{
    const url=`${window.location.origin}${window.location.pathname}#product/${encodeURIComponent(productId)}`;
    try{ if(navigator.share) await navigator.share({title:product?.title||'OFFSCRPT product',url}); else {await navigator.clipboard.writeText(url);notifyToast('Product link copied.','success');} recordMarketplaceEvent('share' as any,productId,{source:'product-page'}); }catch{ /* cancelled share or unavailable clipboard */ }
  };

  const loadRazorpay=async():Promise<any>=>{
    if((window as any).Razorpay)return (window as any).Razorpay;
    await new Promise<void>((resolve,reject)=>{
      const existing=document.querySelector('script[data-razorpay-checkout]') as HTMLScriptElement|null;
      if(existing){existing.addEventListener('load',()=>resolve(),{once:true});existing.addEventListener('error',()=>reject(new Error('Razorpay Checkout could not be loaded.')),{once:true});return;}
      const script=document.createElement('script');
      script.src='https://checkout.razorpay.com/v1/checkout.js';
      script.async=true; script.dataset.razorpayCheckout='true';
      script.onload=()=>resolve(); script.onerror=()=>reject(new Error('Razorpay Checkout could not be loaded.'));
      document.head.appendChild(script);
    });
    return (window as any).Razorpay;
  };

  const purchase=async()=>{
    if(!product||!primaryPrice)return notifyToast('This product is not currently purchasable.','error');
    if(!auth.currentUser){
      try{const signedIn=await loginWithGoogle();if(!signedIn)return;}catch(e:any){notifyToast(e?.message||'Sign-in failed.','error');return;}
    }
    setBusy(true);
    try{
      const checkout=await createCommerceCheckout(product.id,primaryPrice.id,crypto.randomUUID());
      const Razorpay=(await loadRazorpay());
      if(!Razorpay)throw new Error('Razorpay Checkout is unavailable.');
      const options={
        key: checkout.checkout.keyId,
        amount: checkout.checkout.amount,
        currency: checkout.checkout.currency,
        name: checkout.checkout.name,
        description: checkout.checkout.description,
        order_id: checkout.checkout.razorpayOrderId,
        prefill: checkout.checkout.prefill,
        config:{display:{language:'en'}},
        handler: async(response:any)=>{
          try{
            notifyToast('Payment received. Verifying your purchase…','success');
            const done=await confirmRazorpayPayment({
              orderId:checkout.order.id,
              razorpayPaymentId:String(response?.razorpay_payment_id||''),
              razorpayOrderId:String(response?.razorpay_order_id||''),
              razorpaySignature:String(response?.razorpay_signature||'')
            });
            setOwned(done.order.status==='paid' && Boolean(done.entitlement));
            if(done.order.status==='paid') notifyToast('Payment verified. Purchase access has been granted.','success');
            else notifyToast('Payment is still being confirmed.','success');
          }catch(e:any){
            notifyToast(e?.message||'Payment verification failed. Your access will not be granted until payment is verified.','error');
          }finally{setBusy(false);}
        },
        modal:{ondismiss:()=>setBusy(false),handleback:true,escape:true,backdropclose:false}
      };
      const rzp=new Razorpay(options);
      rzp.on('payment.failed',()=>{setBusy(false);notifyToast('Payment failed. No access was granted. You can try again.','error');});
      rzp.open();
    }catch(e:any){setBusy(false);notifyToast(e?.message||'Could not start Razorpay Checkout.','error');}
  };

  if(loading)return <div className="max-w-5xl mx-auto px-4 py-24 text-center font-mono text-xs uppercase">LOADING PRODUCT…</div>;
  if(!product)return <div className="max-w-3xl mx-auto px-4 py-24"><div className="border-4 border-black bg-white p-8 text-center"><div className="font-mono text-[10px] font-black">{error||'PRODUCT NOT FOUND.'}</div><button onClick={()=>onNavigate('creators')} className="mt-5 border-2 border-black bg-[var(--color-primary)] px-4 py-2 font-mono text-[10px] font-black uppercase">BACK TO SHOPS</button></div></div>;

  const currentImage=gallery[activeImage]||'';

  return <div className="min-h-screen bg-[#f6f6f3]">
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-8">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 font-mono text-[8px] font-black uppercase text-neutral-500 mb-3">
        <button type="button" onClick={()=>onNavigate('shop')} className="hover:text-black underline">SHOP</button><span aria-hidden="true">/</span>
        {product.category&&<><button type="button" onClick={()=>{onNavigate('shop');window.setTimeout(()=>{window.location.hash=`shop?category=${encodeURIComponent(product.category||'')}`;},0);}} className="hover:text-black underline">{product.category}</button><span aria-hidden="true">/</span></>}
        <span className="text-black truncate max-w-[240px]">{product.title}</span>
      </nav>
      <button onClick={()=>onNavigate('shop')} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black uppercase inline-flex items-center gap-2 shadow-[3px_3px_0_#000]"><ArrowLeft className="w-3 h-3"/> BACK TO SHOP</button>
      <div className="grid lg:grid-cols-[minmax(0,1.15fr)_420px] gap-6 mt-5 items-start">
        <section className="space-y-5">
          <div className="border-4 border-black bg-white overflow-hidden shadow-[7px_7px_0_#000]">
            <div className="aspect-[4/3] sm:aspect-[5/4] bg-neutral-100 relative">
              {currentImage ? <>
                <button type="button" className="w-full h-full block cursor-zoom-in" onClick={()=>{setLightboxOpen(true);recordMarketplaceEvent('product_gallery_open',productId,{source:'product-page'});}} aria-label="Open product image fullscreen">
                  <img src={currentImage} alt={`${product.title} preview`} className="w-full h-full object-cover"/>
                </button>
                {gallery.length>1&&<>
                  <button aria-label="Previous image" onClick={()=>{setActiveImage(i=>(i-1+gallery.length)%gallery.length);recordMarketplaceEvent('product_gallery_next',productId,{direction:'previous'});}} className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 border-2 border-black bg-white flex items-center justify-center shadow-[3px_3px_0_#000]"><ChevronLeft className="w-5 h-5"/></button>
                  <button aria-label="Next image" onClick={()=>{setActiveImage(i=>(i+1)%gallery.length);recordMarketplaceEvent('product_gallery_next',productId,{direction:'next'});}} className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 border-2 border-black bg-white flex items-center justify-center shadow-[3px_3px_0_#000]"><ChevronRight className="w-5 h-5"/></button>
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 border-2 border-black bg-white px-2 py-1 font-mono text-[8px] font-black">{activeImage+1}/{gallery.length}</div>
                </>}
              </> : <div className="w-full h-full flex items-center justify-center"><ImageIcon className="w-12 h-12"/></div>}
            </div>
          </div>
          {gallery.length>1&&<div className="grid grid-cols-5 sm:grid-cols-6 gap-2">
            {gallery.map((url,index)=><button key={`${url}-${index}`} aria-label={`View image ${index+1}`} onClick={()=>{setActiveImage(index);recordMarketplaceEvent('product_gallery_open',productId,{index});}} className={`aspect-square border-2 border-black overflow-hidden bg-white ${index===activeImage?'ring-2 ring-offset-2 ring-black':''}`}><img src={url} alt="" className="w-full h-full object-cover"/></button>)}
          </div>}
          <article className="border-4 border-black bg-white p-5 sm:p-8 shadow-[7px_7px_0_#000]">
            <div className="font-mono text-[9px] font-black text-neutral-500 uppercase">OFFSCRPT PRODUCT · {String(product.subtype||product.type).replaceAll('_',' ')}</div>
            <h1 className="font-display font-black text-4xl sm:text-6xl uppercase leading-[.9] mt-2 break-words">{product.title}</h1>
            {product.subtitle&&<p className="mt-3 font-mono text-xs sm:text-sm uppercase text-neutral-600">{product.subtitle}</p>}
            <div className="mt-5 flex flex-wrap gap-2">
              <span className="border-2 border-black px-3 py-2 font-mono text-[8px] font-black uppercase bg-[var(--color-primary)]">{product.currency}</span>
              <span className="border-2 border-black px-3 py-2 font-mono text-[8px] font-black uppercase">DIGITAL PRODUCT</span>
              {product.version&&<span className="border-2 border-black px-3 py-2 font-mono text-[8px] font-black uppercase">V{product.version}</span>}
            </div>
            <div className="mt-7 whitespace-pre-wrap text-sm sm:text-base leading-7">{product.description}</div>
            {product.whatIsIncluded&&<div className="mt-8 border-t-4 border-black pt-5"><div className="font-mono text-[9px] font-black uppercase">WHAT'S INCLUDED</div><div className="mt-2 text-sm whitespace-pre-wrap">{String(product.whatIsIncluded)}</div></div>}
            {product.requirements&&<div className="mt-8 border-t-4 border-black pt-5"><div className="font-mono text-[9px] font-black uppercase">REQUIREMENTS</div><div className="mt-2 text-sm whitespace-pre-wrap">{String(product.requirements)}</div></div>}
            {product.usageRestrictions&&<div className="mt-8 border-t-4 border-black pt-5"><div className="font-mono text-[9px] font-black uppercase">LICENSE / USAGE</div><div className="mt-2 text-sm whitespace-pre-wrap">{String(product.usageRestrictions)}</div></div>}
          </article>
          {creator&&<section className="border-4 border-black bg-white p-5 shadow-[7px_7px_0_#000]"><div className="font-mono text-[9px] font-black uppercase text-neutral-500">CREATOR</div><button onClick={()=>onNavigate('creator',creator.username)} className="mt-3 w-full flex items-center gap-3 text-left"><div className="w-14 h-14 border-2 border-black bg-neutral-100 overflow-hidden shrink-0">{creator.photoURL?<img src={creator.photoURL} alt="" className="w-full h-full object-cover"/>:<UserRound className="w-full h-full p-3"/>}</div><div className="min-w-0"><div className="font-display font-black text-2xl uppercase truncate">{creator.displayName}</div><div className="font-mono text-[9px] text-neutral-500 uppercase">@{creator.username}</div></div><ExternalLink className="w-4 h-4 ml-auto"/></button></section>}
          {creatorProducts.length>0&&<section><div className="font-mono text-[9px] font-black uppercase text-neutral-500 mb-2">FROM THIS CREATOR</div><h2 className="font-display font-black text-3xl uppercase mb-4">MORE FROM {creator?.displayName||'CREATOR'}</h2><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{creatorProducts.map(p=><MarketplaceProductCard key={p.id} product={p} price={creatorProductPrices[p.id]} onOpen={(id)=>{recordMarketplaceEvent('related_product_open',id,{source:'product-page'});onNavigate('product',id)}}/>)}</div></section>}
          {related.length>0&&<section><div className="font-mono text-[9px] font-black uppercase text-neutral-500 mb-2">DISCOVERY</div><h2 className="font-display font-black text-3xl uppercase mb-4">RELATED PRODUCTS</h2><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{related.map(p=><MarketplaceProductCard key={p.id} product={p} price={relatedPrices[p.id]} owned={p.id===productId?owned:false} onOpen={(id)=>{recordMarketplaceEvent('related_product_open',id,{source:'product-page'});onNavigate('product',id)}}/>)}</div></section>}
        </section>
        <aside className="border-4 border-black bg-white shadow-[7px_7px_0_#000] lg:sticky lg:top-24 overflow-hidden">
          <div className="p-5 sm:p-6">
            <div className="font-mono text-[9px] font-black uppercase text-neutral-500">BUY THIS PRODUCT</div>
            <div className="mt-2 text-4xl sm:text-5xl font-display font-black">{primaryPrice?money(primaryPrice.amount,primaryPrice.currency):'UNAVAILABLE'}</div>
            {creator&&<button onClick={()=>onNavigate('creator',creator.username)} className="mt-5 w-full border-2 border-black p-3 text-left inline-flex items-center gap-3 bg-neutral-50 hover:bg-[var(--color-primary)]">
              <div className="w-11 h-11 border-2 border-black bg-white overflow-hidden shrink-0">{creator.photoURL?<img src={creator.photoURL} alt="" className="w-full h-full object-cover"/>:<UserRound className="w-full h-full p-2"/>}</div>
              <div className="min-w-0"><div className="font-mono text-[8px] text-neutral-500 uppercase">CREATED BY</div><div className="font-mono text-[10px] font-black uppercase truncate">@{creator.username}</div></div>
              <ExternalLink className="w-4 h-4 ml-auto"/>
            </button>}
            <div className="mt-4 grid grid-cols-2 gap-2"><button onClick={()=>void saveToggle()} className={`border-2 border-black px-3 py-3 font-mono text-[9px] font-black uppercase inline-flex items-center justify-center gap-2 ${saved?'bg-[var(--color-primary)]':'bg-white'}`}><Heart className={`w-4 h-4 ${saved?'fill-current':''}`}/>{saved?'SAVED':'SAVE'}</button><button onClick={()=>void shareProduct()} className="border-2 border-black bg-white px-3 py-3 font-mono text-[9px] font-black uppercase inline-flex items-center justify-center gap-2 hover:bg-[var(--color-secondary)]"><Share2 className="w-4 h-4"/> SHARE</button></div>
            <button type="button" onClick={()=>void copyProductLink()} className="mt-2 w-full border-2 border-black bg-white px-3 py-2 font-mono text-[8px] font-black uppercase inline-flex items-center justify-center gap-2 hover:bg-neutral-100"><Copy className="w-3 h-3"/> COPY LINK</button>
            {owned?<div className="mt-5 space-y-2"><div className="border-2 border-black bg-[var(--color-primary)] text-black p-4 font-mono text-[10px] font-black uppercase flex items-center gap-2"><CheckCircle2 className="w-4 h-4"/> YOU OWN THIS</div><button type="button" onClick={()=>onNavigate('purchases')} className="w-full border-2 border-black bg-black text-white px-4 py-4 font-mono text-[10px] font-black uppercase hover:bg-[var(--color-secondary)]">OPEN MY PURCHASES →</button></div>:
              <button disabled={busy||!primaryPrice} onClick={()=>void purchase()} className="mt-5 w-full border-2 border-black bg-black text-white px-4 py-4 font-mono text-[10px] font-black uppercase disabled:opacity-40 inline-flex items-center justify-center gap-2 hover:bg-[var(--color-primary)] hover:text-black"><ShoppingBag className="w-4 h-4"/>{busy?'PROCESSING…':'BUY NOW'}</button>}
            <div className="mt-4 text-xs leading-5 text-neutral-600">Secure commerce access is confirmed server-side. Purchased digital files are available from My Purchases through the protected download flow.</div>
          </div>
        </aside>
      </div>
    </div>
    {lightboxOpen && currentImage && <div className="fixed inset-0 z-[500] bg-black/90 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Product image viewer" onClick={()=>setLightboxOpen(false)}>
      <button ref={lightboxCloseRef} type="button" onClick={()=>setLightboxOpen(false)} aria-label="Close image viewer" className="absolute top-4 right-4 w-11 h-11 border-2 border-white bg-black text-white flex items-center justify-center"><X className="w-5 h-5"/></button>
      {gallery.length>1&&<><button type="button" onClick={(event)=>{event.stopPropagation();setActiveImage(i=>(i-1+gallery.length)%gallery.length);}} aria-label="Previous image" className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 border-2 border-white bg-black text-white flex items-center justify-center"><ChevronLeft className="w-6 h-6"/></button><button type="button" onClick={(event)=>{event.stopPropagation();setActiveImage(i=>(i+1)%gallery.length);}} aria-label="Next image" className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 border-2 border-white bg-black text-white flex items-center justify-center"><ChevronRight className="w-6 h-6"/></button></>}
      <img src={currentImage} alt={`${product.title} full preview`} onClick={event=>event.stopPropagation()} className="max-w-full max-h-[90vh] object-contain border-4 border-white bg-white"/>
    </div>}
  </div>;
};

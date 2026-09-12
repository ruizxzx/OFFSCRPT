import React, { useEffect, useState } from 'react';
import { BadgeCheck, Building2, CheckCircle2, LockKeyhole, RefreshCw, ShieldCheck, Store, WalletCards } from 'lucide-react';
import type { CommunityUser } from '../types';
import { createCreatorSeller, disableCreatorSeller, enableCreatorSeller, getCreatorSeller, refreshCreatorSeller, type CreatorSellerProfile, type SellerOnboardingInput } from '../lib/commerce';
import { notifyToast } from '../lib/toast';

interface Props { userProfile: CommunityUser | null; }

const initial=(u:CommunityUser):SellerOnboardingInput=>({
  email:u.email||'', phone:'', legalBusinessName:u.displayName||'', customerFacingBusinessName:u.displayName||'',
  businessType:'individual', contactName:u.displayName||'', category:'digital_goods', subcategory:'digital_products',
  description:'Digital products sold through OFFSCRPT.', street1:'', street2:'', city:'', state:'', postalCode:''
});

const stateLabel=(s:string)=>({not_started:'SETUP REQUIRED',collecting_information:'INFORMATION REQUIRED',creating_account:'CREATING ACCOUNT',created:'ACCOUNT CREATED',pending_review:'PENDING REVIEW',active:'ACTIVE',suspended:'SUSPENDED',rejected:'REJECTED',error:'ERROR',reconciliation_required:'RECONCILIATION REQUIRED'} as Record<string,string>)[s]||s.toUpperCase();

export const CreatorSellerOnboardingPanel: React.FC<Props> = ({userProfile}) => {
  const [seller,setSeller]=useState<CreatorSellerProfile|null>(null);
  const [form,setForm]=useState<SellerOnboardingInput|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');

  const load=async()=>{
    if(!userProfile)return;
    setLoading(true); setNotice('');
    try{const r=await getCreatorSeller(); setSeller(r.seller); if(!form) setForm(initial(userProfile));}
    catch(e:any){setNotice(e?.message||'Seller status could not be loaded.');}
    finally{setLoading(false);}
  };
  useEffect(()=>{void load();},[userProfile?.uid]);

  if(!userProfile)return null;
  const update=(key:keyof SellerOnboardingInput,value:string)=>setForm(prev=>prev?({...prev,[key]:value}):prev);

  const submit=async()=>{
    if(!form)return;
    setBusy(true);setNotice('');
    try{const r=await createCreatorSeller(form);setSeller(r.seller);setNotice(r.message||'Razorpay Linked Account created.');notifyToast('Seller account connected.','success');}
    catch(e:any){setNotice(e?.message||'Seller onboarding failed.');notifyToast(e?.message||'Seller onboarding failed.','error');}
    finally{setBusy(false);}
  };
  const refreshStatus=async()=>{setBusy(true);try{const r=await refreshCreatorSeller();setSeller(r.seller);setNotice(`Provider status: ${String(r.provider?.status||r.seller.razorpayAccountStatus||'unknown').toUpperCase()}.`);}catch(e:any){setNotice(e?.message||'Seller status refresh failed.');}finally{setBusy(false);}};
  const enable=async()=>{setBusy(true);try{const r=await enableCreatorSeller();setSeller(r.seller);setNotice('Selling is enabled for this creator.');notifyToast('Selling enabled.','success');}catch(e:any){setNotice(e?.message||'Could not enable selling.');}finally{setBusy(false);}};
  const disable=async()=>{setBusy(true);try{const r=await disableCreatorSeller();setSeller(r.seller);setNotice('Selling disabled. Your provider account mapping is preserved.');}catch(e:any){setNotice(e?.message||'Could not disable selling.');}finally{setBusy(false);}};

  const needsForm=!seller?.razorpayAccountId || seller.onboardingStatus==='not_started' || seller.onboardingStatus==='reconciliation_required' || seller.onboardingStatus==='error';

  return <section className="space-y-4">
    <div className="border-4 border-black bg-[var(--color-primary)] p-5 neo-shadow">
      <div className="flex items-center gap-2 font-mono text-[10px] font-black uppercase"><Store className="w-4 h-4"/> V92 · SELLER ACCOUNT</div>
      <h2 className="font-display font-black text-3xl sm:text-4xl uppercase mt-2">Creator Selling</h2>
      <p className="font-mono text-[10px] mt-2 max-w-3xl">Connect your OFFSCRPT seller identity to a Razorpay Route Linked Account. OFFSCRPT stores the provider account mapping and status; Razorpay handles its own KYC, banking and regulated payment-account verification.</p>
    </div>

    <div className="border-2 border-black bg-white p-5">
      <div className="flex flex-wrap justify-between gap-3 items-start">
        <div>
          <div className="font-mono text-[9px] font-black uppercase">SELLER STATUS</div>
          <div className="font-display font-black text-2xl uppercase mt-1">{loading?'LOADING…':stateLabel(seller?.onboardingStatus||'not_started')}</div>
          {seller?.razorpayAccountId&&<div className="font-mono text-[9px] mt-2">RAZORPAY ACCOUNT · {seller.razorpayAccountId.slice(0,7)}••••••</div>}
        </div>
        <div className="flex flex-wrap gap-2"><button onClick={()=>void refreshStatus()} disabled={busy||loading||!seller?.razorpayAccountId} className="border-2 border-black px-3 py-2 font-mono text-[9px] font-black uppercase"><RefreshCw className="inline w-3 h-3 mr-1"/>REFRESH STATUS</button>{seller?.sellerEnabled&&<button onClick={()=>void disable()} disabled={busy} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black uppercase">DISABLE SELLING</button>}</div>
      </div>
      {!loading && seller?.health&&<div className="grid md:grid-cols-3 gap-2 mt-4"><div className="border-2 border-black p-3"><div className="font-mono text-[8px]">PROVIDER</div><div className="font-display font-black uppercase mt-1">{seller.razorpayAccountStatus||'—'}</div></div><div className="border-2 border-black p-3"><div className="font-mono text-[8px]">HEALTH</div><div className="font-display font-black uppercase mt-1">{seller.health}</div></div><div className="border-2 border-black p-3"><div className="font-mono text-[8px]">SELLING</div><div className="font-display font-black uppercase mt-1">{seller.sellerEnabled?'ENABLED':'DISABLED'}</div></div></div>}
    </div>

    {needsForm&&<div className="border-2 border-black bg-white p-5 space-y-3">
      <div className="flex items-center gap-2 font-display font-black uppercase text-xl"><Building2 className="w-5 h-5"/> SELLER ONBOARDING</div>
      <div className="font-mono text-[9px] text-neutral-600">Use your real legal/business information. Bank/KYC submission is handled by Razorpay during provider verification; OFFSCRPT does not store card, UPI PIN or banking credentials.</div>
      <div className="grid md:grid-cols-2 gap-2">
        <input value={form?.email||''} onChange={e=>update('email',e.target.value)} placeholder="Business email" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.phone||''} onChange={e=>update('phone',e.target.value)} placeholder="Business phone" className="border-2 border-black p-3 font-mono text-xs" inputMode="tel"/>
        <input value={form?.legalBusinessName||''} onChange={e=>update('legalBusinessName',e.target.value)} placeholder="Legal business name" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.customerFacingBusinessName||''} onChange={e=>update('customerFacingBusinessName',e.target.value)} placeholder="Customer-facing business name" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.contactName||''} onChange={e=>update('contactName',e.target.value)} placeholder="Contact name" className="border-2 border-black p-3 font-mono text-xs"/>
        <select value={form?.businessType||'individual'} onChange={e=>update('businessType',e.target.value)} className="border-2 border-black p-3 font-mono text-xs">
          <option value="individual">Individual</option><option value="proprietorship">Proprietorship</option><option value="partnership">Partnership</option><option value="llp">LLP</option><option value="private_limited">Private Limited</option><option value="public_limited">Public Limited</option><option value="trust">Trust</option><option value="society">Society</option><option value="ngo">NGO</option>
        </select>
        <input value={form?.category||''} onChange={e=>update('category',e.target.value)} placeholder="Business category" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.subcategory||''} onChange={e=>update('subcategory',e.target.value)} placeholder="Business subcategory" className="border-2 border-black p-3 font-mono text-xs"/>
      </div>
      <textarea value={form?.description||''} onChange={e=>update('description',e.target.value)} placeholder="Business description" className="w-full min-h-20 border-2 border-black p-3 font-mono text-xs" maxLength={255}/>
      <div className="font-display font-black uppercase text-sm">REGISTERED BUSINESS ADDRESS</div>
      <div className="grid md:grid-cols-2 gap-2">
        <input value={form?.street1||''} onChange={e=>update('street1',e.target.value)} placeholder="Street address" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.street2||''} onChange={e=>update('street2',e.target.value)} placeholder="Address line 2 (optional)" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.city||''} onChange={e=>update('city',e.target.value)} placeholder="City" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.state||''} onChange={e=>update('state',e.target.value)} placeholder="State" className="border-2 border-black p-3 font-mono text-xs"/>
        <input value={form?.postalCode||''} onChange={e=>update('postalCode',e.target.value)} placeholder="Postal code" className="border-2 border-black p-3 font-mono text-xs" inputMode="numeric"/>
        <div className="border-2 border-black p-3 font-mono text-xs flex items-center gap-2"><BadgeCheck className="w-4 h-4"/>COUNTRY: INDIA (IN)</div>
      </div>
      <div className="border-2 border-black bg-neutral-100 p-3 font-mono text-[9px]"><WalletCards className="inline w-4 h-4 mr-2"/>BANKING + KYC: COMPLETE THROUGH THE RAZORPAY ROUTE VERIFICATION FLOW. OFFSCRPT DOES NOT STORE BANK CREDENTIALS.</div>
      <button disabled={busy||loading||!form} onClick={()=>void submit()} className="w-full border-2 border-black bg-black text-white px-4 py-3 font-mono text-[10px] font-black uppercase disabled:opacity-40">{busy?'CONNECTING…':'CONNECT RAZORPAY SELLER ACCOUNT'}</button>
    </div>}

    {seller?.razorpayAccountId&&!seller.sellerEnabled&&seller.onboardingStatus!=='suspended'&&<div className="border-2 border-black bg-white p-5"><div className="flex items-center gap-2 font-display font-black uppercase text-xl"><ShieldCheck className="w-5 h-5"/> SELLING READINESS</div><p className="font-mono text-[9px] mt-2 text-neutral-600">The provider account exists. Refresh its status, complete any required Razorpay verification, then enable selling when the account is eligible.</p><button disabled={busy} onClick={()=>void enable()} className="mt-4 border-2 border-black bg-[var(--color-primary)] px-4 py-3 font-mono text-[10px] font-black uppercase">ENABLE SELLING</button></div>}
    {seller?.sellerEnabled&&<div className="border-2 border-black bg-[var(--color-primary)] p-5 flex items-center gap-3"><CheckCircle2 className="w-6 h-6"/><div><div className="font-display font-black uppercase text-xl">SELLING ENABLED</div><div className="font-mono text-[9px] mt-1">Future V93 commission rules can resolve this creator to the linked Razorpay account.</div></div></div>}
    {notice&&<div className="border-2 border-black bg-yellow-100 p-3 font-mono text-[9px] font-black">{notice}</div>}
    <div className="border-2 border-black bg-white p-4 font-mono text-[9px] flex gap-2 items-start"><LockKeyhole className="w-4 h-4 shrink-0"/>OFFSCRPT stores the seller/provider mapping and status only. Do not submit payment credentials, card data, UPI PINs or banking passwords to OFFSCRPT.</div>
  </section>;
};

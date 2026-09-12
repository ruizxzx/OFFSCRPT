import React, { useCallback, useEffect, useState } from 'react';
import { Activity, CircleDollarSign, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { auth } from '../lib/firebase';
import { adminListCreatorSellers, adminSetCreatorSellerStatus, type AdminSellerRow } from '../lib/commerce';
import { notifyToast } from '../lib/toast';
import { CommissionAdminPanel } from './CommissionAdminPanel';

const collections = [
  ['commerceProducts','PRODUCTS'],['commercePrices','PRICES'],['commerceOrders','ORDERS'],['commercePayments','PAYMENTS'],
  ['commerceRefunds','REFUNDS'],['entitlements','ENTITLEMENTS'],['creatorRevenue','REVENUE LEDGER'],['creatorPayouts','PAYOUT LEDGER'],
  ['commerceAuditLogs','AUDIT EVENTS'],['commerceWebhookEvents','WEBHOOK EVENTS']
] as const;

export const CommerceAdminPanel: React.FC = () => {
  const [counts,setCounts]=useState<Record<string,number>>({});
  const [loading,setLoading]=useState(false);
  const [sellers,setSellers]=useState<AdminSellerRow[]>([]);
  const [sellerLoading,setSellerLoading]=useState(false);
  const refresh=useCallback(async()=>{
    setLoading(true);
    try{
      const user=auth.currentUser;
      if(!user) throw new Error('Sign in required.');
      const token=await user.getIdToken();
      const response=await fetch('/api/commerce?action=diagnostics',{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});
      const payload:any=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(String(payload?.error||'Commerce diagnostics unavailable.'));
      setCounts(payload.counts||{});
      if(payload.errors && Object.keys(payload.errors).length) notifyToast('Some commerce diagnostics could not be loaded.','error');
    }catch(e:any){ notifyToast(e?.message||'Commerce diagnostics unavailable.','error'); }
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  const loadSellers=useCallback(async()=>{setSellerLoading(true);try{const r=await adminListCreatorSellers();setSellers(r.sellers||[]);}catch(e:any){notifyToast(e?.message||'Seller list unavailable.','error');}finally{setSellerLoading(false);}},[]);
  useEffect(()=>{void loadSellers();},[loadSellers]);
  const setSellerStatus=async(creatorId:string,status:'active'|'suspended'|'created')=>{try{await adminSetCreatorSellerStatus(creatorId,status);notifyToast(`Seller ${status}.`,'success');await loadSellers();}catch(e:any){notifyToast(e?.message||'Seller update failed.','error');}};
  const cards=collections.map(([name,label])=>({name,label,value:counts[name] ?? 0}));
  return <div className="space-y-5">
    <header className="border-4 border-black bg-black text-white p-6 neo-shadow-lg"><div className="font-mono text-[10px] font-black text-[var(--color-primary)] flex items-center gap-2"><CircleDollarSign className="w-4 h-4"/> MASTER CONTROL · COMMERCE</div><h2 className="font-display font-black text-4xl uppercase mt-2">Commerce Diagnostics</h2><p className="text-sm text-neutral-300 mt-2 max-w-3xl">Operational commerce diagnostics plus server-authoritative V92 seller and V93 finance controls.</p></header>
    <div className="flex flex-wrap gap-2"><button onClick={()=>void refresh()} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black uppercase"><RefreshCw className="inline w-3 h-3"/> {loading?'LOADING':'REFRESH'}</button><span className="border-2 border-black bg-[var(--color-primary)] px-3 py-2 font-mono text-[9px] font-black uppercase"><ShieldCheck className="inline w-3 h-3"/> SERVER-AUTHORITATIVE</span></div>
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">{cards.map(c=><div key={c.name} className="border-2 border-black bg-white p-4"><div className="font-mono text-[8px] font-black uppercase flex items-center gap-1"><Database className="w-3 h-3"/>{c.label}</div><div className="font-display font-black text-3xl mt-2">{c.value.toLocaleString()}</div><div className="font-mono text-[8px] text-neutral-500 mt-1">/{c.name}</div></div>)}</div>
    <div className="border-2 border-black bg-white p-5 space-y-3"><div className="flex justify-between gap-3 items-center"><div className="font-display font-black uppercase">V92 SELLER MANAGEMENT</div><button onClick={()=>void loadSellers()} className="border-2 border-black px-3 py-2 font-mono text-[9px] font-black"><RefreshCw className="inline w-3 h-3 mr-1"/>{sellerLoading?'LOADING':'REFRESH'}</button></div><div className="space-y-2">{sellerLoading?<div className="font-mono text-xs">LOADING SELLERS…</div>:sellers.length===0?<div className="border-2 border-dashed border-black p-5 font-mono text-xs">NO SELLER PROFILES FOUND.</div>:sellers.map(s=><div key={s.creatorId} className="border-2 border-black p-3 grid lg:grid-cols-[2fr_1fr_1fr_1fr] gap-3 items-center"><div><div className="font-display font-black uppercase">{s.legalBusinessName||s.customerFacingBusinessName||s.creatorId.slice(0,8)}</div><div className="font-mono text-[8px] mt-1">CREATOR {s.creatorId} · SELLER {s.id}</div></div><div className="font-mono text-[8px] uppercase">{s.onboardingStatus}</div><div className="font-mono text-[8px] uppercase">{s.razorpayAccountStatus||'NO ACCOUNT'}</div><div className="flex flex-wrap gap-1 justify-end"><button onClick={()=>void setSellerStatus(s.creatorId,'active')} className="border-2 border-black bg-[var(--color-primary)] px-2 py-1 font-mono text-[8px] font-black">ACTIVATE</button><button onClick={()=>void setSellerStatus(s.creatorId,'suspended')} className="border-2 border-black bg-white px-2 py-1 font-mono text-[8px] font-black">SUSPEND</button></div></div>)}</div></div>
    <CommissionAdminPanel /><div className="border-2 border-black bg-white p-5 font-mono text-[9px]"><Activity className="w-4 h-4 mb-2"/><div className="font-black uppercase">Operational rule</div><p className="mt-2 text-neutral-600">Counts are diagnostics only. Do not infer successful payment, entitlement validity, or payout eligibility from a counter. Seller status changes are server-authorized and audited; inspect the underlying record when investigating an incident.</p></div>
  </div>;
};

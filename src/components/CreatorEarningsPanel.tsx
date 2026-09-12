import React, { useCallback, useEffect, useState } from 'react';
import { CircleDollarSign, RefreshCw, ShieldCheck } from 'lucide-react';
import { getCreatorEarnings, type CreatorEarningsSummary } from '../lib/commerce';
import { notifyToast } from '../lib/toast';

const inr=(value:number)=>`₹${Number(value||0).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:2})}`;

export const CreatorEarningsPanel: React.FC = () => {
  const [summary,setSummary]=useState<CreatorEarningsSummary|null>(null);
  const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{setLoading(true);try{setSummary(await getCreatorEarnings());}catch(e:any){notifyToast(e?.message||'Earnings unavailable.','error');}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  return <section className="space-y-4">
    <div className="border-4 border-black bg-[var(--color-primary)] p-5 neo-shadow">
      <div className="font-mono text-[10px] font-black uppercase flex items-center gap-2"><CircleDollarSign className="w-4 h-4"/> V93 · EARNINGS</div>
      <h2 className="font-display font-black text-3xl sm:text-4xl uppercase mt-2">Creator Earnings</h2>
      <p className="font-mono text-[10px] mt-2 max-w-3xl">Server-calculated sales allocation after the configured OFFSCRPT commission rule. This is not a withdrawable balance; creator payouts are a later V94 stage.</p>
    </div>
    <div className="flex justify-end"><button onClick={()=>void load()} disabled={loading} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black uppercase"><RefreshCw className="inline w-3 h-3 mr-1"/>{loading?'LOADING':'REFRESH'}</button></div>
    <div className="grid sm:grid-cols-3 gap-3">
      {[["GROSS SALES",summary?.grossSales],['OFFSCRPT COMMISSION',summary?.platformCommission],['CREATOR NET',summary?.netEarnings],['REFUNDED',summary?.refundedGross],['COMMISSION REVERSED',summary?.reversedCommission],['CREATOR REVERSED',summary?.reversedCreatorAmount]].map(([label,value])=><div key={String(label)} className="border-2 border-black bg-white p-5"><div className="font-mono text-[9px] font-black uppercase">{label}</div><div className="font-display font-black text-3xl mt-2">{summary?inr(Number(value||0)):'—'}</div><div className="font-mono text-[8px] uppercase mt-2 text-neutral-500">{summary?.currency||'INR'}</div></div>)}
    </div>
    <div className="border-2 border-black bg-white p-4 font-mono text-[9px] flex gap-2 items-start"><ShieldCheck className="w-4 h-4 shrink-0"/><div><div className="font-black uppercase">SERVER-AUTHORITATIVE</div><div className="mt-1 text-neutral-600">Values are read from canonical financial allocations. They do not represent a payout or withdrawable balance.</div></div></div>
  </section>;
};

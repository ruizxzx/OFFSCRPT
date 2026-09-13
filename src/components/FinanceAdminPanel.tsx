import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, Download, RefreshCw, Search, ShieldAlert, TrendingDown, TrendingUp } from 'lucide-react';
import { getFinanceReport, getFinanceDimension, getFinanceHealth, exportFinanceCsv, type FinanceReport, type FinanceDimensionRow, type FinanceHealth } from '../lib/commerce';
import { notifyToast } from '../lib/toast';

function money(paise:number, currency='INR'){ return `${currency==='INR'?'₹':''}${(Number(paise||0)/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`; }
function pct(v:number|null|undefined){ return v===null||v===undefined?'—':`${v>=0?'+':''}${v.toFixed(2)}%`; }

const ranges:{label:string;days:number}[]=[{label:'7D',days:7},{label:'30D',days:30},{label:'90D',days:90}];

export const FinanceAdminPanel:React.FC=()=>{
  const [range,setRange]=useState(30); const [report,setReport]=useState<FinanceReport|null>(null); const [health,setHealth]=useState<FinanceHealth|null>(null);
  const [dimension,setDimension]=useState<'creator'|'product'|'order'|'payout'|'refund'>('creator'); const [rows,setRows]=useState<FinanceDimensionRow[]>([]);
  const [loading,setLoading]=useState(false); const [query,setQuery]=useState('');
  const windowPayload=useMemo(()=>{const to=new Date();const from=new Date(to);from.setUTCDate(from.getUTCDate()-range);return {from:from.toISOString(),to:to.toISOString(),groupBy:range<=30?'day':range<=90?'week':'month',currency:'INR'};},[range]);
  const load=useCallback(async()=>{setLoading(true);try{const [r,h,d]=await Promise.all([getFinanceReport(windowPayload),getFinanceHealth(windowPayload),getFinanceDimension(dimension,windowPayload)]);setReport(r);setHealth(h);setRows(d.rows||[]);}catch(e:any){notifyToast?.(e?.message||'Finance data unavailable.','error');}finally{setLoading(false);}},[windowPayload,dimension]);
  useEffect(()=>{void load();},[load]);
  const s=report?.summary;
  const filtered=rows.filter((r:any)=>{const q=query.trim().toLowerCase();if(!q)return true;return JSON.stringify(r).toLowerCase().includes(q);}).slice(0,100);
  const series=report?.series;
  const max=Math.max(1,...(series?.revenue||[]).map(x=>Number(x.amountPaise||0)));
  const exportIt=async(type:string)=>{try{const out=await exportFinanceCsv({type,...windowPayload});const blob=new Blob([out.csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=out.filename;a.click();URL.revokeObjectURL(url);}catch(e:any){notifyToast?.(e?.message||'Export failed.','error');}};
  return <div className="space-y-5">
    <header className="border-4 border-black bg-black text-white p-6 neo-shadow-lg">
      <div className="font-mono text-[10px] font-black text-[var(--color-primary)]">MASTER CONTROL · FINANCE</div>
      <div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="font-display font-black text-4xl uppercase mt-2">Finance Intelligence</h2><p className="text-sm text-neutral-300 mt-2 max-w-3xl">Server-derived financial reporting across verified sales, V93 allocations and V94 creator liabilities/payouts.</p></div>
      <button onClick={()=>void load()} className="border-2 border-white px-3 py-2 font-mono text-[9px] font-black"><RefreshCw className="inline w-3 h-3 mr-1"/>{loading?'LOADING':'REFRESH'}</button></div>
    </header>
    <div className="flex flex-wrap items-center gap-2"><div className="font-mono text-[9px] font-black uppercase">Period</div>{ranges.map(r=><button key={r.days} onClick={()=>setRange(r.days)} className={`border-2 border-black px-3 py-2 font-mono text-[9px] font-black ${range===r.days?'bg-[var(--color-primary)]':'bg-white'}`}>{r.label}</button>)}</div>
    {!s?<div className="border-2 border-dashed border-black p-6 font-mono text-xs">{loading?'LOADING FINANCE…':'No financial activity for this period.'}</div>:
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">{[
        ['Gross Sales',money(s.grossSalesPaise)],['Commission',money(s.platformCommissionPaise)],['Creator Liability',money(s.pendingCreatorLiabilityPaise+s.availableCreatorLiabilityPaise+s.reservedCreatorLiabilityPaise)],['Payouts',money(s.paidOutToCreatorsPaise)],['Refunds',money(s.refundedAmountPaise)],['Net Revenue',money(s.netPlatformRevenuePaise)]
      ].map(([k,v])=><div key={k} className="border-2 border-black bg-white p-4"><div className="font-mono text-[8px] font-black uppercase">{k}</div><div className="font-display text-xl md:text-2xl font-black mt-2">{v}</div></div>)}</div>
      <div className="grid md:grid-cols-3 gap-3">
        <div className="border-2 border-black bg-white p-4"><div className="font-mono text-[8px] font-black">PAID ORDERS</div><div className="font-display text-3xl font-black">{s.paidOrders.toLocaleString()}</div><div className="font-mono text-[8px] mt-1">AOV {money(s.averageOrderValuePaise)}</div></div>
        <div className="border-2 border-black bg-white p-4"><div className="font-mono text-[8px] font-black">REFUND RATE</div><div className="font-display text-3xl font-black">{(Number.isFinite(Number(s.refundRate))?Number(s.refundRate):0).toFixed(2)}%</div><div className="font-mono text-[8px] mt-1">Refund count {s.refundCount}</div></div>
        <div className="border-2 border-black bg-white p-4"><div className="font-mono text-[8px] font-black">PERIOD CHANGE</div><div className="font-display text-3xl font-black flex items-center gap-2">{(report.comparison.grossSales??0)>=0?<TrendingUp className="w-6 h-6"/>:<TrendingDown className="w-6 h-6"/>}{pct(report.comparison.grossSales)}</div><div className="font-mono text-[8px] mt-1">vs previous period</div></div>
      </div>
      <div className="border-2 border-black bg-white p-5">
        <div className="flex flex-wrap justify-between gap-3 items-center"><div><div className="font-display font-black uppercase">Revenue Trend</div><div className="font-mono text-[8px] text-neutral-500">Gross sales by period</div></div><div className="font-mono text-[8px]">SOURCE: CANONICAL FINANCE DATA</div></div>
        <div className="mt-5 h-56 flex items-end gap-1 overflow-hidden">{(series?.revenue||[]).map((p:any)=><div key={p.period} title={`${p.period}: ${money(p.amountPaise)}`} className="flex-1 min-w-[4px] bg-black" style={{height:`${Math.max(4,Number(p.amountPaise||0)/max*100)}%`}}/> )}</div>
        {!series?.revenue?.length&&<div className="font-mono text-xs mt-5">No financial activity for this period.</div>}
      </div>
      <div className="border-2 border-black bg-white p-5 space-y-4">
        <div className="flex flex-wrap justify-between gap-3 items-center"><div className="font-display font-black uppercase">Finance Drilldown</div><div className="flex flex-wrap gap-1">{(['creator','product','order','payout','refund'] as const).map(d=><button key={d} onClick={()=>setDimension(d)} className={`border-2 border-black px-2 py-1 font-mono text-[8px] font-black uppercase ${dimension===d?'bg-[var(--color-primary)]':'bg-white'}`}>{d}</button>)}</div></div>
        <div className="flex gap-2 items-center border-2 border-black px-2"><Search className="w-4 h-4"/><input value={query} onChange={e=>setQuery(e.target.value)} className="flex-1 py-2 outline-none font-mono text-xs" placeholder="Search finance records"/></div>
        <div className="overflow-x-auto"><table className="w-full text-left border-collapse"><thead><tr className="border-b-2 border-black">{(filtered[0]?Object.keys(filtered[0]).filter(k=>!k.endsWith('Paise')).slice(0,8):['ID','Value']).map(k=><th key={k} className="font-mono text-[8px] font-black uppercase p-2">{k}</th>)}</tr></thead><tbody>{filtered.map((r:any,i)=><tr key={`${r.id||r.payoutId||i}`} className="border-b border-neutral-200"><td className="p-2 font-mono text-[9px]">{r.id||r.payoutId||'—'}</td>{Object.entries(r).filter(([k])=>k!=='id'&&!k.endsWith('Paise')).slice(0,7).map(([k,v])=><td key={k} className="p-2 font-mono text-[9px]">{typeof v==='number'?Number(v).toLocaleString('en-IN'):String(v??'—')}</td>)}</tr>)}</tbody></table></div>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div className="border-2 border-black bg-white p-5"><div className="flex items-center gap-2"><ShieldAlert className="w-4 h-4"/><div className="font-display font-black uppercase">Finance Health</div></div><div className="font-mono text-xs mt-3 uppercase">{health?.status||'UNKNOWN'} · {health?.critical||0} critical · {health?.warnings||0} warnings</div>{health?.issues?.slice(0,6).map((x:any)=><div key={`${x.type}:${x.id}`} className="border-2 border-black p-2 mt-2 font-mono text-[8px]">{x.severity} · {x.type} · {x.id}</div>)}</div>
        <div className="border-2 border-black bg-white p-5"><div className="font-display font-black uppercase">Exports</div><div className="flex flex-wrap gap-2 mt-3">{['summary','orders','creators','products','payouts','refunds'].map(t=><button key={t} onClick={()=>void exportIt(t)} className="border-2 border-black bg-white px-3 py-2 font-mono text-[8px] font-black"><Download className="inline w-3 h-3 mr-1"/>{t}</button>)}</div></div>
      </div>
    </>}
  </div>;
};

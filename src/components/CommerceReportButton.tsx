import React, { useState } from 'react';
import { Flag, X } from 'lucide-react';
import { auth } from '../lib/firebase';
import { createCommerceReport, type CommerceReportReason } from '../lib/commerce';
import { notifyToast } from '../lib/toast';

const REASONS: Array<[CommerceReportReason,string]> = [
  ['spam','Spam'],['harassment','Harassment'],['hate_or_abusive_content','Hate / abusive content'],['misleading','Misleading'],['fake_review','Fake review'],['copyright','Copyright'],['prohibited_content','Prohibited content'],['fraud_concern','Fraud concern'],['duplicate_content','Duplicate content'],['other','Other'],
];
export const CommerceReportButton:React.FC<{targetType:'review'|'product'|'creator'|'order';targetId:string;label?:string}> = ({targetType,targetId,label='REPORT'}) => {
  const [open,setOpen]=useState(false); const [reason,setReason]=useState<CommerceReportReason>('spam'); const [description,setDescription]=useState(''); const [busy,setBusy]=useState(false);
  const submit=async()=>{ if(!auth.currentUser){notifyToast('Sign in to submit a report.','error');return;} setBusy(true); try{await createCommerceReport({targetType,targetId,reasonCode:reason,description}); notifyToast('Report submitted for moderation.','success');setOpen(false);setDescription('');}catch(e:any){notifyToast(e?.message||'Could not submit report.','error');}finally{setBusy(false);} };
  return <>
    <button type="button" onClick={()=>setOpen(true)} className="border-2 border-black bg-white px-3 py-2 font-mono text-[8px] font-black uppercase inline-flex items-center gap-2 hover:bg-neutral-100"><Flag className="w-3 h-3"/>{label}</button>
    {open&&<div className="fixed inset-0 z-[120] bg-black/60 p-4 flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Report content">
      <div className="w-full max-w-lg border-4 border-black bg-white shadow-[8px_8px_0_#000] p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3"><h3 className="font-display text-2xl font-black uppercase">REPORT {targetType}</h3><button aria-label="Close" onClick={()=>setOpen(false)} className="border-2 border-black p-2"><X className="w-4 h-4"/></button></div>
        <p className="font-mono text-[9px] text-neutral-500 mt-2">Reports are reviewed by authorized moderators. A report is not proof of a violation.</p>
        <label className="block mt-5 font-mono text-[9px] font-black uppercase">Reason<select value={reason} onChange={e=>setReason(e.target.value as CommerceReportReason)} className="mt-1 w-full border-2 border-black px-3 py-3 font-mono text-xs bg-white">{REASONS.map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label>
        <label className="block mt-4 font-mono text-[9px] font-black uppercase">Details (optional)<textarea value={description} onChange={e=>setDescription(e.target.value.slice(0,1200))} rows={5} className="mt-1 w-full border-2 border-black p-3 text-sm" placeholder="Provide useful context without sharing sensitive information."/><span className="text-[8px] text-neutral-500">{description.length}/1200</span></label>
        <div className="flex gap-2 mt-5"><button type="button" onClick={()=>void submit()} disabled={busy} className="flex-1 border-2 border-black bg-[var(--color-primary)] px-4 py-3 font-mono text-[9px] font-black uppercase disabled:opacity-50">{busy?'SUBMITTING…':'SUBMIT REPORT'}</button><button type="button" onClick={()=>setOpen(false)} disabled={busy} className="border-2 border-black bg-white px-4 py-3 font-mono text-[9px] font-black uppercase">CANCEL</button></div>
      </div>
    </div>}
  </>;
};

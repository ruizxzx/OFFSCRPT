import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CheckCircle2, ChevronRight, FileArchive, FileText, FolderOpen, History, Image, Link as LinkIcon, Loader2, PackagePlus, Pencil, Plus, Save, ShieldCheck, UploadCloud, XCircle } from 'lucide-react';
import type { CommunityUser } from '../types';
import {
  addProductLink, archiveDigitalProduct, archiveProductResource, createDigitalProduct, createDigitalProductVersion,
  listMyDigitalProducts, publishDigitalProduct, publishDigitalProductVersion,
  renameProductResource, restoreProductResource, updateDigitalProduct, updateProductLink, uploadDigitalProductFile,
  type DigitalProduct, type DigitalProductFile, type DigitalProductSubtype, type DigitalProductVersion, type DigitalProductVisibility
} from '../lib/digitalProducts';
import { notifyToast } from '../lib/toast';
import { uploadMedia } from '../lib/media';

interface Props { userProfile: CommunityUser | null; }

const CATEGORIES = ['Education','Design','Business','Technology','Productivity','Research','Writing','Templates','Marketing','Finance','Career','Lifestyle','Other'];
const SUBTYPES: Array<[DigitalProductSubtype,string]> = [
  ['pdf','PDF'],['ebook','eBook'],['template','Template'],['spreadsheet','Spreadsheet'],['presentation','Presentation'],
  ['document','Document'],['zip','ZIP'],['research_pack','Research Pack'],['dataset','Dataset'],['prompt_pack','Prompt Pack'],
  ['design_assets','Design Assets'],['audio','Audio'],['video','Video'],['guide','Guide'],['checklist','Checklist'],
  ['worksheet','Worksheet'],['resource_pack','Resource Pack'],['other','Other']
];
const LICENSES=[['personal','Personal'],['commercial','Commercial'],['extended_commercial','Extended Commercial'],['educational','Educational'],['team','Team']];

const money=(amount:number,currency:string)=>new Intl.NumberFormat(undefined,{style:'currency',currency}).format((Number(amount)||0)/100);
const sizeLabel=(bytes:number)=>{const n=Number(bytes); if(!Number.isFinite(n)||n<=0)return 'SIZE UNKNOWN'; return n<1024?`${Math.round(n)} B`:n<1024*1024?`${(n/1024).toFixed(1)} KB`:`${(n/1024/1024).toFixed(1)} MB`;};

export const DigitalProductEnginePanel:React.FC<Props>=({userProfile})=>{
  const [products,setProducts]=useState<DigitalProduct[]>([]);
  const [versions,setVersions]=useState<DigitalProductVersion[]>([]);
  const [files,setFiles]=useState<DigitalProductFile[]>([]);
  const [selectedId,setSelectedId]=useState('');
  const [selectedVersionId,setSelectedVersionId]=useState('');
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [progress,setProgress]=useState<Record<string,number>>({});
  const [form,setForm]=useState({
    title:'',subtitle:'',description:'',subtype:'pdf' as DigitalProductSubtype,category:'Education',subcategory:'',
    tags:'',license:'personal',usageRestrictions:'',requirements:'',whatIsIncluded:'',currency:'INR',amount:'49900',
    visibility:'public' as DigitalProductVisibility
  });
  const [versionForm,setVersionForm]=useState({label:'1.0',changelog:''});
  const [linkForm,setLinkForm]=useState({name:'',url:''});
  const [showLinkForm,setShowLinkForm]=useState(false);
  const autosaveTimer=useRef<ReturnType<typeof setTimeout>|null>(null);

  const selected=useMemo(()=>products.find(p=>p.id===selectedId)||null,[products,selectedId]);
  const selectedVersion=useMemo(()=>versions.find(v=>v.id===selectedVersionId)||null,[versions,selectedVersionId]);
  const selectedFiles=useMemo(()=>files.filter(f=>f.versionId===selectedVersionId),[files,selectedVersionId]);

  const refresh=async(selectId?:string)=>{
    if(!userProfile)return;
    setLoading(true);
    try{
      const data=await listMyDigitalProducts();
      setProducts(data.products);
      setVersions(data.versions);
      setFiles(data.files);
      const nextId=selectId||selectedId||data.products[0]?.id||'';
      setSelectedId(nextId);
      const product=data.products.find(p=>p.id===nextId);
      setSelectedVersionId(product?.currentVersionId||data.versions.find(v=>v.productId===nextId)?.id||'');
    }catch(e:any){setNotice(e?.message||'Unable to load digital products.');}
    finally{setLoading(false);}
  };

  useEffect(()=>{void refresh();},[userProfile?.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{
    if(!selected)return;
    setForm({
      title:selected.title||'',subtitle:selected.subtitle||'',description:selected.description||'',subtype:selected.subtype||'other',
      category:selected.category||'Education',subcategory:selected.subcategory||'',tags:(selected.tags||[]).join(', '),
      license:selected.license||'personal',usageRestrictions:selected.usageRestrictions||'',requirements:selected.requirements||'',
      whatIsIncluded:selected.whatIsIncluded||'',currency:selected.currency||'INR',amount:'',visibility:selected.visibility||'private'
    });
  },[selectedId]); // intentionally reset when selected product changes

  useEffect(()=>{
    if(!selected||saving)return;
    if(autosaveTimer.current)clearTimeout(autosaveTimer.current);
    autosaveTimer.current=setTimeout(async()=>{
      if(!form.title.trim()||!form.description.trim()||!form.category)return;
      try{
        const result=await updateDigitalProduct({
          productId:selected.id,
          expectedUpdatedAt:selected.updatedAt,
          title:form.title,subtitle:form.subtitle,description:form.description,
          subtype:form.subtype,category:form.category,subcategory:form.subcategory,
          tags:form.tags.split(',').map(x=>x.trim()).filter(Boolean),license:form.license,
          usageRestrictions:form.usageRestrictions,requirements:form.requirements,whatIsIncluded:form.whatIsIncluded,
          visibility:form.visibility
        });
        setProducts(prev=>prev.map(p=>p.id===selected.id?result.product:p));
        setNotice('Draft changes saved.');
      }catch(error){console.warn('Digital product autosave failed:',error);}
    },1200);
    return()=>{if(autosaveTimer.current)clearTimeout(autosaveTimer.current);};
  },[form,selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const createNew=async()=>{
    if(!userProfile)return;
    if(form.title.trim().length<2)return notifyToast('Add a product title.','error');
    if(form.description.trim().length<10)return notifyToast('Add a product description.','error');
    if(!form.category)return notifyToast('Select a category.','error');
    const amount=Math.floor(Number(form.amount));
    if(!Number.isSafeInteger(amount)||amount<=0)return notifyToast('Enter a valid price in minor currency units. Example: ₹499 = 49900.','error');
    setBusy(true);setNotice('');
    try{
      const result=await createDigitalProduct({
        title:form.title,subtitle:form.subtitle,description:form.description,subtype:form.subtype,category:form.category,
        subcategory:form.subcategory,tags:form.tags.split(',').map(x=>x.trim()).filter(Boolean),license:form.license,
        usageRestrictions:form.usageRestrictions,requirements:form.requirements,whatIsIncluded:form.whatIsIncluded,
        currency:form.currency,amount,visibility:form.visibility,thumbnail:'',gallery:[]
      });
      setNotice(`Draft created: ${result.product.id}`);
      setSelectedId(result.product.id); setSelectedVersionId(result.version.id);
      setProducts(prev=>[result.product,...prev]); setVersions(prev=>[result.version,...prev]);
      setForm(prev=>({...prev,amount:''}));
    }catch(e:any){notifyToast(e?.message||'Could not create digital product.','error');}
    finally{setBusy(false);}
  };

  const saveNow=async()=>{
    if(!selected)return;
    setSaving(true);
    try{
      const result=await updateDigitalProduct({
        productId:selected.id,expectedUpdatedAt:selected.updatedAt,
        title:form.title,subtitle:form.subtitle,description:form.description,
        subtype:form.subtype,category:form.category,subcategory:form.subcategory,
        tags:form.tags.split(',').map(x=>x.trim()).filter(Boolean),license:form.license,
        usageRestrictions:form.usageRestrictions,requirements:form.requirements,whatIsIncluded:form.whatIsIncluded,
        visibility:form.visibility
      });
      setProducts(prev=>prev.map(p=>p.id===selected.id?result.product:p));
      notifyToast('Draft saved.','success');
    }catch(e:any){notifyToast(e?.message||'Could not save product.','error');}
    finally{setSaving(false);}
  };

  const addVersion=async()=>{
    if(!selected)return;
    setBusy(true);
    try{
      const result=await createDigitalProductVersion(selected.id,versionForm.label||'1.1',versionForm.changelog);
      setVersions(prev=>[result.version,...prev]);setSelectedVersionId(result.version.id);
      setVersionForm({label:`${Number(result.version.versionNumber)+1}.0`,changelog:''});
      notifyToast('New draft version created.','success');
      await refresh(selected.id);
      setSelectedVersionId(result.version.id);
    }catch(e:any){notifyToast(e?.message||'Could not create version.','error');}
    finally{setBusy(false);}
  };

  const updateResourceLocal=(resource:DigitalProductFile)=>{setFiles(prev=>prev.map(f=>f.id===resource.id?{...f,...resource}:f));};
  const renameResource=async(resource:DigitalProductFile)=>{
    const next=window.prompt(`RENAME RESOURCE (MAX 60 CHARACTERS)`,String(resource.displayName||resource.originalFilename||'').slice(0,60));
    if(next===null)return;
    const name=next.trim(); if(!name||name.length>60){notifyToast('Resource name must contain 1–60 characters.','error');return;}
    setBusy(true); try{const r=await renameProductResource(resource.id,name);updateResourceLocal(r.resource);notifyToast('Resource renamed.','success');}catch(e:any){notifyToast(e?.message||'Could not rename resource.','error');}finally{setBusy(false);}
  };
  const toggleResourceArchive=async(resource:DigitalProductFile)=>{
    const archived=resource.status==='archived';
    if(!archived&&!window.confirm(`Archive "${resource.displayName||resource.originalFilename||'resource'}"? Existing purchase history will be preserved.`))return;
    setBusy(true); try{const r=archived?await restoreProductResource(resource.id):await archiveProductResource(resource.id);updateResourceLocal(r.resource);await refresh(selected?.id);setSelectedVersionId(selected?.currentVersionId||selectedVersionId);notifyToast(archived?'Resource restored.':'Resource archived.','success');}catch(e:any){notifyToast(e?.message||(archived?'Could not restore resource.':'Could not archive resource.'),'error');}finally{setBusy(false);}
  };
  const editLink=async(resource:DigitalProductFile)=>{
    const name=window.prompt('RESOURCE NAME (MAX 60 CHARACTERS)',String(resource.displayName||'').slice(0,60)); if(name===null)return;
    const trimmed=name.trim(); if(!trimmed||trimmed.length>60){notifyToast('Resource name must contain 1–60 characters.','error');return;}
    const url=window.prompt('HTTPS RESOURCE URL',String(resource.url||'')); if(url===null)return;
    setBusy(true); try{const r=await updateProductLink({resourceId:resource.id,displayName:trimmed,url});updateResourceLocal(r.resource);notifyToast('Link updated.','success');}catch(e:any){notifyToast(e?.message||'Could not update link.','error');}finally{setBusy(false);}
  };
  const addLink=async()=>{
    if(!selected||!selectedVersion)return; const name=linkForm.name.trim(),url=linkForm.url.trim();
    if(!name||name.length>60){notifyToast('Resource name must contain 1–60 characters.','error');return;}
    if(!url){notifyToast('Enter an HTTPS resource URL.','error');return;}
    setBusy(true); try{const r=await addProductLink({productId:selected.id,versionId:selectedVersion.id,displayName:name,url});setFiles(prev=>[r.resource,...prev]);setLinkForm({name:'',url:''});setShowLinkForm(false);notifyToast('External resource added.','success');}catch(e:any){notifyToast(e?.message||'Could not add external resource.','error');}finally{setBusy(false);}
  };

  const upload=async(e:React.ChangeEvent<HTMLInputElement>)=>{
    const versionId=selectedVersionId, productId=selectedId;
    const chosen:File[]=Array.from(e.target.files||[]);
    e.target.value='';
    if(!productId||!versionId||!chosen.length)return;
    setBusy(true);
    try{
      for(const file of chosen){
        const key=`${versionId}:${file.name}:${file.size}`;
        setProgress(p=>({...p,[key]:5}));
        const result=await uploadDigitalProductFile({
          productId,versionId,file,role:'product_file',
          onProgress:n=>setProgress(p=>({...p,[key]:n}))
        });
        setFiles(prev=>[result.file,...prev]);
        setVersions(prev=>prev.map(v=>v.id===versionId?{...v,fileCount:v.fileCount+1,totalSizeBytes:v.totalSizeBytes+result.file.sizeBytes,fileIds:[...v.fileIds,result.file.id]}:v));
        setProducts(prev=>prev.map(p=>p.id===productId?{...p,fileCount:(p.fileCount||0)+1,totalSizeBytes:(p.totalSizeBytes||0)+result.file.sizeBytes,updatedAt:new Date().toISOString()}:p));
      }
      notifyToast(`${chosen.length} file${chosen.length===1?'':'s'} uploaded and verified.`,`success`);
    }catch(e:any){notifyToast(e?.message||'Upload failed.','error');}
    finally{setBusy(false);}
  };

  const uploadGallery=async(e:React.ChangeEvent<HTMLInputElement>)=>{
    const productId=selectedId;
    const chosen=Array.from(e.target.files||[]).filter(file=>file.type.startsWith('image/'));
    e.target.value='';
    if(!productId||!chosen.length)return;
    const remaining=12-(selected?.gallery?.length||0);
    if(chosen.length>remaining){
      notifyToast(`A product can have up to 12 gallery images. Choose ${Math.max(remaining,0)} or fewer.`, 'error');
      return;
    }
    setBusy(true);
    try{
      const uploaded:string[]=[];
      for(const file of chosen){
        const progressKey=`gallery:${file.name}:${file.size}`;
        setProgress(p=>({...p,[progressKey]:5}));
        const result=await uploadMedia(file,'product-gallery',n=>setProgress(p=>({...p,[progressKey]:n})));
        uploaded.push(result.publicUrl);
      }
      const nextGallery=[...(selected?.gallery||[]),...uploaded].slice(0,12);
      const result=await updateDigitalProduct({
        productId,
        gallery:nextGallery,
        thumbnail:selected?.thumbnail||nextGallery[0]||''
      });
      setProducts(prev=>prev.map(p=>p.id===productId?result.product:p));
      setProgress(p=>{const next={...p}; uploaded.forEach((_,i)=>{const file=chosen[i]; delete next[`gallery:${file.name}:${file.size}`];}); return next;});
      notifyToast(`${uploaded.length} product image${uploaded.length===1?'':'s'} uploaded.`, 'success');
    }catch(e:any){
      notifyToast(e?.message||'Could not upload product images.','error');
    }finally{setBusy(false);}
  };

  const removeGalleryImage=async(url:string)=>{
    if(!selected)return;
    setBusy(true);
    try{
      const nextGallery=(selected.gallery||[]).filter(x=>x!==url);
      const nextThumb=selected.thumbnail===url ? (nextGallery[0]||'') : (selected.thumbnail||'');
      const result=await updateDigitalProduct({productId:selected.id,gallery:nextGallery,thumbnail:nextThumb});
      setProducts(prev=>prev.map(p=>p.id===selected.id?result.product:p));
      notifyToast('Product image removed.','success');
    }catch(e:any){notifyToast(e?.message||'Could not remove image.','error');}
    finally{setBusy(false);}
  };

  const setGalleryCover=async(url:string)=>{
    if(!selected)return;
    setBusy(true);
    try{
      const result=await updateDigitalProduct({productId:selected.id,thumbnail:url});
      setProducts(prev=>prev.map(p=>p.id===selected.id?result.product:p));
      notifyToast('Product cover updated.','success');
    }catch(e:any){notifyToast(e?.message||'Could not update product cover.','error');}
    finally{setBusy(false);}
  };

  const publish=async()=>{
    if(!selected)return;
    setBusy(true);
    try{
      const result=await publishDigitalProduct(selected.id);
      setProducts(prev=>prev.map(p=>p.id===selected.id?result.product:p));
      notifyToast('Digital product published and available to the storefront.','success');
      await refresh(selected.id);
    }catch(e:any){notifyToast(e?.message||'Product cannot be published yet.','error');}
    finally{setBusy(false);}
  };

  const publishVersion=async()=>{
    if(!selected||!selectedVersion)return;
    setBusy(true);
    try{
      const result=await publishDigitalProductVersion(selected.id,selectedVersion.id);
      await refresh(selected.id);setSelectedVersionId(result.version.id);
      notifyToast('Version published.','success');
    }catch(e:any){notifyToast(e?.message||'Version cannot be published.','error');}
    finally{setBusy(false);}
  };

  const archive=async()=>{
    if(!selected)return;
    setBusy(true);
    try{const result=await archiveDigitalProduct(selected.id);setProducts(prev=>prev.map(p=>p.id===selected.id?result.product:p));notifyToast('Product archived.','success');await refresh(selected.id);}
    catch(e:any){notifyToast(e?.message||'Could not archive product.','error');}
    finally{setBusy(false);}
  };

  if(!userProfile)return <div className="border-2 border-black bg-white p-6 font-mono text-xs">SIGN IN TO MANAGE DIGITAL PRODUCTS.</div>;

  return <section className="space-y-5">
    <div className="border-4 border-black bg-black text-white p-5 sm:p-7 neo-shadow-lg">
      <div className="font-mono text-[10px] font-black text-[var(--color-primary)] flex items-center gap-2"><PackagePlus className="w-4 h-4"/> DIGITAL PRODUCT ENGINE</div>
      <h2 className="font-display font-black text-3xl sm:text-4xl uppercase mt-2">Sell Digital Products</h2>
      <p className="text-sm text-neutral-300 mt-3 max-w-4xl">Create, version and publish digital products using the existing OFFSCRPT Commerce foundation. Files are uploaded to private R2 product storage and are not exposed as permanent public download URLs.</p>
      <div className="flex flex-wrap gap-2 mt-5 font-mono text-[9px] font-black uppercase">
        <span className="border-2 border-[var(--color-primary)] px-3 py-2">VENDOR PRODUCTS</span>
        <span className="border-2 border-white px-3 py-2">SECURE STORAGE FOUNDATION</span>
        <span className="border-2 border-white px-3 py-2">{products.length} PRODUCTS</span>
      </div>
    </div>

    {notice&&<div className="border-2 border-black bg-yellow-100 p-3 font-mono text-[10px] font-bold">{notice}</div>}

    <div className="grid xl:grid-cols-[280px_1fr] gap-4">
      <aside className="border-2 border-black bg-white p-4 h-fit space-y-3">
        <div className="flex items-center justify-between gap-2"><div className="font-display font-black uppercase text-xl">YOUR PRODUCTS</div><button onClick={()=>void refresh()} className="border-2 border-black p-2" title="Refresh"><History className="w-4 h-4"/></button></div>
        {loading?<div className="font-mono text-xs">LOADING…</div>:products.length===0?<div className="font-mono text-[10px] border-2 border-dashed border-black p-4">NO PRODUCTS. CREATE YOUR FIRST DIGITAL PRODUCT.</div>:<div className="space-y-2 max-h-[55vh] overflow-auto">{products.map(p=><button key={p.id} onClick={()=>{setSelectedId(p.id);setSelectedVersionId(p.currentVersionId||versions.find(v=>v.productId===p.id)?.id||'')}} className={`w-full text-left border-2 border-black p-3 ${p.id===selectedId?'bg-[var(--color-primary)]':'bg-white'}`}><div className="font-display font-black uppercase break-words">{p.title}</div><div className="font-mono text-[8px] mt-1">{p.status.replace('_',' ').toUpperCase()} · {p.subtype?.toUpperCase()}</div><div className="font-mono text-[8px] mt-1">{p.fileCount||0} FILES · V{p.currentVersionNumber||p.version||1}</div></button>)}</div>}
        <button onClick={()=>{setSelectedId('');setSelectedVersionId('');setNotice('Fill the form and create a draft product.')}} className="w-full border-2 border-black bg-black text-white px-3 py-3 font-mono text-[9px] font-black uppercase"><Plus className="inline w-3 h-3"/> NEW PRODUCT</button>
      </aside>

      <div className="space-y-4">
        {!selected?<div className="border-2 border-black bg-white p-5 sm:p-7 space-y-4">
          <div className="flex items-center gap-2"><PackagePlus className="w-5 h-5"/><h3 className="font-display font-black text-2xl uppercase">Create Digital Product</h3></div>
          <p className="font-mono text-[10px]">Start a draft. You can upload files, create versions and publish after the required checks pass.</p>
          <FormFields form={form} setForm={setForm} creation/>
          <div className="border-2 border-black bg-neutral-50 p-3 font-mono text-[9px]">PRICE: enter minor units. Example: ₹499 = 49900. The server remains authoritative for the Commerce price.</div>
          <button disabled={busy} onClick={()=>void createNew()} className="border-2 border-black bg-[var(--color-primary)] px-5 py-3 font-mono text-[10px] font-black uppercase disabled:opacity-50"><PackagePlus className="inline w-4 h-4 mr-1"/> CREATE DRAFT</button>
        </div>:
        <div className="space-y-4">
          <div className="border-2 border-black bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-mono text-[9px] font-black uppercase">{selected.status} · {selected.visibility}</div><h3 className="font-display font-black text-3xl uppercase mt-1 break-words">{selected.title}</h3><div className="font-mono text-[9px] mt-1">PRODUCT ID: {selected.id}</div></div><div className="flex flex-wrap gap-2"><button disabled={saving||busy} onClick={()=>void saveNow()} className="border-2 border-black px-3 py-2 font-mono text-[9px] font-black"><Save className="inline w-3 h-3"/> SAVE</button>{selected.status==='draft'&&<button disabled={busy||!selectedVersion?.fileCount} onClick={()=>void publish()} className="border-2 border-black bg-[var(--color-primary)] px-3 py-2 font-mono text-[9px] font-black"><CheckCircle2 className="inline w-3 h-3"/> PUBLISH</button>}{['published','active'].includes(selected.status)&&<button disabled={busy} onClick={()=>void archive()} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black"><Archive className="inline w-3 h-3"/> ARCHIVE</button>}</div></div>
            <div className="mt-4"><FormFields form={form} setForm={setForm} creation={false}/></div>
          </div>

          <div className="border-2 border-black bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-display font-black uppercase text-xl">Product media</div>
                <div className="font-mono text-[8px] uppercase">Public preview images · up to 12 · shown on product pages, profiles and storefront cards</div>
              </div>
              <label className="border-2 border-black bg-[var(--color-primary)] px-3 py-2 font-mono text-[9px] font-black uppercase cursor-pointer">
                <Image className="inline w-3 h-3"/> ADD IMAGES
                <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" multiple className="hidden" onChange={uploadGallery} disabled={busy}/>
              </label>
            </div>
            {(selected?.gallery||[]).length===0 ? (
              <div className="mt-4 border-2 border-dashed border-black p-6 text-center">
                <Image className="w-7 h-7 mx-auto"/>
                <div className="font-mono text-[9px] mt-2 uppercase">Add product photos to make the store listing visual.</div>
                <div className="font-mono text-[8px] text-neutral-500 mt-1 uppercase">Preview images use OFFSCRPT's existing public media pipeline. Protected files remain separate and private.</div>
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {(selected.gallery||[]).map((url,index)=>(
                  <div key={`${url}-${index}`} className="border-2 border-black bg-white overflow-hidden">
                    <div className="aspect-square bg-neutral-100">
                      <img src={url} alt="" className="w-full h-full object-cover"/>
                    </div>
                    <div className="p-2 space-y-1">
                      <button type="button" disabled={busy} onClick={()=>void setGalleryCover(url)} className={`w-full border border-black px-2 py-1 font-mono text-[7px] font-black uppercase ${selected.thumbnail===url?'bg-[var(--color-primary)]':'bg-white'}`}>
                        {selected.thumbnail===url?'COVER':'SET COVER'}
                      </button>
                      <button type="button" disabled={busy} onClick={()=>void removeGalleryImage(url)} className="w-full border border-black px-2 py-1 bg-white font-mono text-[7px] font-black uppercase">
                        REMOVE
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-[1fr_1.3fr] gap-4">
            <div className="border-2 border-black bg-white p-5 space-y-3">
              <div className="flex items-center justify-between"><div><div className="font-display font-black uppercase text-xl">Versions</div><div className="font-mono text-[8px]">Historical files are never overwritten.</div></div><Plus className="w-5 h-5"/></div>
              <div className="grid sm:grid-cols-2 gap-2"><input value={versionForm.label} onChange={e=>setVersionForm(v=>({...v,label:e.target.value}))} placeholder="Version label" className="border-2 border-black p-3 font-mono text-xs"/><input value={versionForm.changelog} onChange={e=>setVersionForm(v=>({...v,changelog:e.target.value}))} placeholder="Changelog" className="border-2 border-black p-3 font-mono text-xs"/></div>
              <button disabled={busy} onClick={()=>void addVersion()} className="w-full border-2 border-black bg-black text-white p-3 font-mono text-[9px] font-black uppercase">CREATE NEW VERSION</button>
              <div className="space-y-2">{versions.filter(v=>v.productId===selected.id).sort((a,b)=>b.versionNumber-a.versionNumber).map(v=><button key={v.id} onClick={()=>setSelectedVersionId(v.id)} className={`w-full border-2 border-black p-3 text-left ${v.id===selectedVersionId?'bg-[var(--color-primary)]':'bg-white'}`}><div className="flex items-center justify-between gap-2"><span className="font-display font-black uppercase">V{v.versionLabel}</span><span className="font-mono text-[8px]">{v.status.toUpperCase()}</span></div><div className="font-mono text-[8px] mt-1">{v.fileCount} FILES · {sizeLabel(v.totalSizeBytes)}</div></button>)}</div>
            </div>

            <div className="border-2 border-black bg-white p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-display font-black uppercase text-xl">PRODUCT RESOURCES</div><div className="font-mono text-[8px]">V{selectedVersion?.versionLabel||'?'} · {selectedFiles.filter(f=>String(f.resourceType||'upload')==='upload').length} FILES · {selectedFiles.filter(f=>String(f.resourceType||'')==='external').length} LINKS</div></div><div className="flex flex-wrap gap-2"><label className="border-2 border-black bg-[var(--color-primary)] px-3 py-2 font-mono text-[9px] font-black uppercase cursor-pointer"><UploadCloud className="inline w-3 h-3"/> ADD FILE<input type="file" multiple className="hidden" onChange={upload} disabled={busy}/></label><button type="button" onClick={()=>setShowLinkForm(v=>!v)} disabled={busy} className="border-2 border-black bg-white px-3 py-2 font-mono text-[9px] font-black uppercase"><LinkIcon className="inline w-3 h-3"/> ADD LINK</button></div></div>
              {showLinkForm&&<div className="border-2 border-black bg-neutral-50 p-3 grid gap-2"><input value={linkForm.name} maxLength={60} onChange={e=>setLinkForm(v=>({...v,name:e.target.value.slice(0,60)}))} placeholder="Resource name (max 60 chars)" className="border-2 border-black p-3 font-mono text-[10px]"/><div className="font-mono text-[8px] text-neutral-500 text-right">{linkForm.name.length}/60</div><input value={linkForm.url} onChange={e=>setLinkForm(v=>({...v,url:e.target.value}))} placeholder="https://drive.google.com/..." className="border-2 border-black p-3 font-mono text-[10px]"/><div className="flex gap-2"><button type="button" disabled={busy} onClick={()=>void addLink()} className="border-2 border-black bg-[var(--color-primary)] px-4 py-2 font-mono text-[9px] font-black uppercase">SAVE LINK</button><button type="button" disabled={busy} onClick={()=>{setShowLinkForm(false);setLinkForm({name:'',url:''});}} className="border-2 border-black px-4 py-2 font-mono text-[9px] font-black uppercase">CANCEL</button></div></div>}
              {!selectedVersion ? (
                <div className="border-2 border-dashed border-black p-5 font-mono text-xs">SELECT A VERSION.</div>
              ) : selectedFiles.length === 0 ? (
                <div className="border-2 border-dashed border-black p-5 text-center">
                  <FileText className="w-6 h-6 mx-auto"/>
                  <div className="font-mono text-[9px] mt-2">NO FILES YET. ADD AT LEAST ONE READY PRODUCT FILE TO PUBLISH.</div>
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedFiles.map(f => { const external=String(f.resourceType||'upload')==='external'; const archived=f.status==='archived'; return <div key={f.id} className="border-2 border-black p-3 flex flex-col sm:flex-row sm:items-center gap-3 overflow-hidden">
                      <div className="min-w-0 flex-1 flex items-center gap-2">
                        {external ? <LinkIcon className="w-4 h-4 shrink-0"/> : f.mimeType?.includes('image') ? <Image className="w-4 h-4 shrink-0"/> : f.mimeType?.includes('zip') ? <FileArchive className="w-4 h-4 shrink-0"/> : <FileText className="w-4 h-4 shrink-0"/>}
                        <div className="min-w-0 flex-1"><div title={String(f.displayName||f.originalFilename||'Resource')} className="font-mono text-[10px] font-black truncate">{f.displayName||f.originalFilename||'Resource'}</div><div className="font-mono text-[8px] uppercase truncate">{external ? `${f.provider||'external'} · external resource` : `${f.mimeType||'file'} · ${sizeLabel(Number(f.sizeBytes||0))}`} · {f.status.toUpperCase()}</div></div>
                      </div>
                      <div className="flex flex-wrap gap-2 shrink-0"><button type="button" disabled={busy} onClick={()=>void (external?editLink(f):renameResource(f))} className="border-2 border-black px-2 py-2 font-mono text-[8px] font-black uppercase"><Pencil className="inline w-3 h-3"/> {external?'EDIT LINK':'RENAME'}</button><button type="button" disabled={busy} onClick={()=>void toggleResourceArchive(f)} className={`border-2 border-black px-2 py-2 font-mono text-[8px] font-black uppercase ${archived?'bg-[var(--color-primary)]':'bg-white'}`}>{archived?'RESTORE':'ARCHIVE'}</button><ShieldCheck className={`w-4 h-4 self-center ${f.status==='ready' ? '' : 'opacity-40'}`}/></div>
                    </div>; })}
                </div>
              )}
              {Object.entries(progress).filter(([,n]:[string,number])=>n<100).map(([k,n]:[string,number])=><div key={k} className="border-2 border-black p-2"><div className="font-mono text-[8px] truncate">{k}</div><div className="h-2 border-2 border-black mt-1"><div className="h-full bg-[var(--color-primary)]" style={{width:`${n}%`}}/></div></div>)}
              {selectedVersion&&<div className="flex flex-wrap gap-2"><button disabled={busy||selectedVersion.fileCount<1} onClick={()=>void publishVersion()} className="border-2 border-black bg-black text-white px-3 py-2 font-mono text-[9px] font-black uppercase">PUBLISH THIS VERSION</button><span className="border-2 border-black px-3 py-2 font-mono text-[9px]">CURRENT VERSION: V{selected.currentVersionNumber||selected.version}</span></div>}
            </div>
          </div>

          <div className="border-2 border-black bg-neutral-50 p-4 grid sm:grid-cols-3 gap-3 font-mono text-[9px]">
            <div><div className="font-black">STORAGE</div><div>PRIVATE OBJECT KEY · NO PERMANENT DOWNLOAD URL</div></div>
            <div><div className="font-black">OWNERSHIP</div><div>FIREBASE UID + SERVER-AUTHORIZED VENDOR WRITE</div></div>
            <div><div className="font-black">FUTURE</div><div>V89 MARKETPLACE · V90 CHECKOUT · V91 SECURE DOWNLOADS</div></div>
          </div>
        </div>}
      </div>
    </div>
  </section>
};

function FormFields({form,setForm,creation}:{form:any;setForm:React.Dispatch<React.SetStateAction<any>>;creation:boolean}){
  const set=(key:string,value:any)=>setForm((f:any)=>({...f,[key]:value}));
  return <div className="grid md:grid-cols-2 gap-3">
    <Field label="TITLE" value={form.title} onChange={(v:string)=>set('title',v)} maxLength={160}/>
    <Field label="SUBTITLE" value={form.subtitle} onChange={(v:string)=>set('subtitle',v)} maxLength={220}/>
    <label className="md:col-span-2 font-mono text-[9px] font-black">DESCRIPTION<textarea value={form.description} onChange={e=>set('description',e.target.value)} maxLength={5000} className="mt-1 w-full border-2 border-black p-3 min-h-28 font-mono text-xs" placeholder="What is the buyer getting?"/></label>
    <label className="font-mono text-[9px] font-black">PRODUCT TYPE<select value={form.subtype} onChange={e=>set('subtype',e.target.value)} className="mt-1 w-full border-2 border-black p-3 bg-white font-mono text-xs">{SUBTYPES.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label className="font-mono text-[9px] font-black">CATEGORY<select value={form.category} onChange={e=>set('category',e.target.value)} className="mt-1 w-full border-2 border-black p-3 bg-white font-mono text-xs">{CATEGORIES.map(v=><option key={v}>{v}</option>)}</select></label>
    <Field label="SUBCATEGORY" value={form.subcategory} onChange={(v:string)=>set('subcategory',v)} maxLength={80}/>
    <Field label="TAGS" value={form.tags} onChange={(v:string)=>set('tags',v)} placeholder="ai, research, template"/>
    {creation&&<Field label="PRICE (MINOR UNITS)" value={form.amount} onChange={(v:string)=>set('amount',v.replace(/[^0-9]/g,''))} placeholder="49900 = ₹499"/>}
    {creation&&<label className="font-mono text-[9px] font-black">CURRENCY<select value={form.currency} onChange={e=>set('currency',e.target.value)} className="mt-1 w-full border-2 border-black p-3 bg-white font-mono text-xs"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select></label>}
    <label className="font-mono text-[9px] font-black">LICENSE<select value={form.license} onChange={e=>set('license',e.target.value)} className="mt-1 w-full border-2 border-black p-3 bg-white font-mono text-xs">{LICENSES.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    <label className="font-mono text-[9px] font-black">VISIBILITY<select value={form.visibility} onChange={e=>set('visibility',e.target.value)} className="mt-1 w-full border-2 border-black p-3 bg-white font-mono text-xs"><option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option></select></label>
    <Field label="WHAT'S INCLUDED" value={form.whatIsIncluded} onChange={(v:string)=>set('whatIsIncluded',v)} textarea/>
    <Field label="REQUIREMENTS" value={form.requirements} onChange={(v:string)=>set('requirements',v)} textarea/>
    <Field label="USAGE RESTRICTIONS" value={form.usageRestrictions} onChange={(v:string)=>set('usageRestrictions',v)} textarea/>
  </div>
}
function Field({label,value,onChange,placeholder,maxLength,textarea}:{label:string;value:string;onChange:(v:string)=>void;placeholder?:string;maxLength?:number;textarea?:boolean}){
  return <label className="font-mono text-[9px] font-black">{label}{textarea?<textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} className="mt-1 w-full border-2 border-black p-3 min-h-20 font-mono text-xs"/>:<input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} className="mt-1 w-full border-2 border-black p-3 font-mono text-xs"/>}</label>
}

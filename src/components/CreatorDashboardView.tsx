import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, BookOpen, MessageCircle, Users, UserRoundCheck, Heart, Clock, Share2, Bookmark, Eye, RotateCcw, Copy, RefreshCw } from 'lucide-react';
import type { Article, CommunityUser, PageView, Series } from '../types';
import { getCountFromServer, collection } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { getArticleAnalyticsAggregate, subscribeArticleAnalytics, type ArticleAnalyticsAggregate } from '../lib/analytics';
import { getSeriesList } from '../lib/series';
import { getSeriesArticles, createArticleRevision, getArticleRevisions, restoreArticleRevision } from '../lib/cms';
import { notifyToast } from '../lib/toast';
import { CreatorWorkflowPanel } from './CreatorWorkflowPanel';
import { getCreatorCollaboratorInvites, acceptCreatorCollaboratorInvite, declineCreatorCollaboratorInvite } from '../lib/creatorWorkspace';
import { CommerceFoundationPanel } from './CommerceFoundationPanel';
import { CreatorSellerOnboardingPanel } from './CreatorSellerOnboardingPanel';
import { DigitalProductEnginePanel } from './DigitalProductEnginePanel';

interface Props {
  articles: Article[];
  userProfile: CommunityUser | null;
  onNavigate: (page: PageView, param?: string) => void;
}

type Range = 7 | 30 | 90 | 180 | 365 | 'all';

const published = (article: Article) => article.isPublished !== false && article.mainPublicationStatus !== 'unpublished';
const timeLabel = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export const CreatorDashboardView: React.FC<Props> = ({ articles, userProfile, onNavigate }) => {
  const [range, setRange] = useState<Range>(30);
  const [stats, setStats] = useState<Record<string, ArticleAnalyticsAggregate>>({});
  const [loading, setLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState('');
  const [series, setSeries] = useState<Series[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [seriesBusy, setSeriesBusy] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [seriesData, setSeriesData] = useState<Array<{ article: Article; views: number; fiftyPlus: number; completed: number; completionRate: number; drop: number }>>([]);
  const [revisions, setRevisions] = useState<any[]>([]);
  const [compareSlugs, setCompareSlugs] = useState<string[]>([]);
  const [selectedFunnelStage, setSelectedFunnelStage] = useState<'opened'|'p25'|'p50'|'p75'|'completed'>('opened');
  const [collabInvites,setCollabInvites]=useState<any[]>([]);
  const [studioSection,setStudioSection]=useState<'analytics'|'commerce'|'seller'|'digital-products'>('analytics');

  const mine = useMemo(
    () =>
      articles.filter(
        (article) =>
          ((article.author?.uid && article.author.uid === userProfile?.uid) ||
            (article.author?.username && article.author.username === userProfile?.username)),
      ),
    [articles, userProfile?.uid, userProfile?.username],
  );

  const rangeDays = range === 'all' ? 'all' : range;

  useEffect(() => { if(userProfile?.uid){ void getCreatorCollaboratorInvites().then(setCollabInvites).catch(()=>setCollabInvites([])); }
  },[userProfile?.uid]);

  useEffect(() => {
    if (!mine.length) {
      setStats({});
      setLoading(false);
      setAnalyticsError('');
      return;
    }

    setLoading(true);
    setAnalyticsError('');
    const unsubscribers: Array<() => void> = [];
    let received = 0;
    const markReceived = () => {
      received += 1;
      if (received >= mine.length) setLoading(false);
    };

    for (const article of mine) {
      const slug = article.slug;
      unsubscribers.push(subscribeArticleAnalytics(slug, aggregate => {
        setStats(prev => ({ ...prev, [slug]: { ...aggregate, comments: prev[slug]?.comments || 0 } }));
        markReceived();
      }, rangeDays));

      void getCountFromServer(collection(db, 'articles', slug, 'comments'))
        .then(snapshot => {
          setStats(prev => ({ ...prev, [slug]: { ...(prev[slug] || { views: 0, uniqueReaders: 0, averageReadingTimeMs: 0, completionRate: 0, scrollDepth: 0, reactions: 0, bookmarks: 0, comments: 0, shares: 0, returnReaders: 0, funnel: { opened: 0, p25: 0, p50: 0, p75: 0, completed: 0 } }), comments: snapshot.data().count } }));
        })
        .catch(error => {
          console.warn(`Creator comment count read failed for ${slug}:`, error);
          setAnalyticsError(prev => prev || `Comment analytics failed for ${slug}.`);
        });
    }

    return () => unsubscribers.forEach(unsub => unsub());
  }, [mine.map((article) => article.slug).join('|'), range, refreshToken]);

  useEffect(() => {
    getSeriesList(100)
      .then((items) => setSeries(items.filter((item) => item.ownerId === userProfile?.uid || item.ownerUsername === userProfile?.username)))
      .catch((error) => console.warn('Creator series analytics unavailable:', error));
  }, [userProfile?.uid, userProfile?.username]);

  const totals = useMemo(() => {
    const rows = mine.map((article) => stats[article.slug]).filter(Boolean);
    return {
      views: rows.reduce((sum, row) => sum + (row?.views || 0), 0),
      unique: rows.reduce((sum, row) => sum + (row?.uniqueReaders || 0), 0),
      returning: rows.reduce((sum, row) => sum + (row?.returnReaders || 0), 0),
      average: rows.length ? Math.round(rows.reduce((sum, row) => sum + (row?.averageReadingTimeMs || 0), 0) / rows.length) : 0,
      completion: rows.length ? Math.round(rows.reduce((sum, row) => sum + (row?.completionRate || 0), 0) / rows.length) : 0,
      scroll: rows.length ? Math.round(rows.reduce((sum, row) => sum + (row?.scrollDepth || 0), 0) / rows.length) : 0,
      shares: rows.reduce((sum, row) => sum + (row?.shares || 0), 0),
      bookmarks: rows.reduce((sum, row) => sum + (row?.bookmarks || 0), 0),
      reactions: rows.reduce((sum, row) => sum + (row?.reactions || 0), 0),
      comments: rows.reduce((sum, row) => sum + (row?.comments || 0), 0),
    };
  }, [mine, stats]);

  const funnel = useMemo(() => {
    const rows = mine.map((article) => stats[article.slug]).filter(Boolean) as ArticleAnalyticsAggregate[];
    return {
      opened: rows.reduce((n, r) => n + Number(r.funnel?.opened || r.views || 0), 0),
      p25: rows.reduce((n, r) => n + Number(r.funnel?.p25 || 0), 0),
      p50: rows.reduce((n, r) => n + Number(r.funnel?.p50 || 0), 0),
      p75: rows.reduce((n, r) => n + Number(r.funnel?.p75 || 0), 0),
      completed: rows.reduce((n, r) => n + Number(r.funnel?.completed || 0), 0),
    };
  }, [mine, stats]);

  const funnelStageLabels: Record<typeof selectedFunnelStage,string> = { opened: 'OPENED', p25: '25%', p50: '50%', p75: '75%', completed: 'COMPLETED' };
  const funnelValue = funnel[selectedFunnelStage];
  const funnelRetention = selectedFunnelStage === 'opened' ? 100 : (() => {
    const order: Array<typeof selectedFunnelStage> = ['opened','p25','p50','p75','completed'];
    const idx = order.indexOf(selectedFunnelStage);
    const prev = funnel[order[Math.max(0, idx - 1)]];
    return prev ? Math.round((funnelValue / prev) * 1000) / 10 : 0;
  })();

  const top = useMemo(
    () =>
      [...mine].sort(
        (a, b) =>
          (stats[b.slug]?.views || Number(b.viewsCount || 0)) -
          (stats[a.slug]?.views || Number(a.viewsCount || 0)),
      )[0],
    [mine, stats],
  );

  const openSeries = async (id: string) => {
    setSelected(id);
    setSeriesBusy(true);
    try {
      const seriesArticles = await getSeriesArticles(id);
      const rows: Array<{ article: Article; views: number; fiftyPlus: number; completed: number; completionRate: number; drop: number }> = [];
      for (const article of seriesArticles) {
        const aggregate = await getArticleAnalyticsAggregate(article.slug, Number(article.viewsCount || 0), rangeDays);
        rows.push({ article, views: aggregate.funnel.opened || aggregate.views, fiftyPlus: aggregate.funnel.p50, completed: aggregate.funnel.completed, completionRate: aggregate.completionRate, drop: 0 });
      }
      for (let i = 1; i < rows.length; i += 1) rows[i].drop = Math.max(0, rows[i - 1].views - rows[i].views);
      setSeriesData(rows);
    } catch (error) {
      console.error('Series analytics load failed:', error);
      setSeriesData([]);
      notifyToast(error instanceof Error ? error.message : 'Series analytics unavailable.', 'error');
    } finally {
      setSeriesBusy(false);
    }
  };

  const openRevisions = async (article: Article) => {
    try {
      const revisionsForArticle = await getArticleRevisions(article.slug);
      setSelected(`rev:${article.slug}`);
      setRevisions(revisionsForArticle);
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : 'Could not load article history.', 'error');
      setRevisions([]);
    }
  };

  const restore = async (id: string) => {
    try {
      await restoreArticleRevision(id);
      notifyToast('Revision restored to Firestore. Reload the article to see the restored content.', 'success');
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : 'Could not restore revision.', 'error');
    }
  };

  if (!userProfile)
    return <div className="max-w-3xl mx-auto py-24 text-center font-mono text-sm">SIGN IN TO OPEN CREATOR STUDIO.</div>;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14 space-y-7">
      <header className="border-4 border-black bg-black text-white p-6 sm:p-9 neo-shadow-lg">
        <div className="font-mono text-[10px] text-[var(--color-primary)] font-black flex items-center gap-2"><BarChart3 className="w-4 h-4" /> CREATOR STUDIO</div>
        <h1 className="font-display font-black text-4xl sm:text-6xl uppercase mt-2">Creator Dashboard</h1>
        <p className="mt-3 max-w-3xl text-neutral-300">Aggregate reader analytics from real Firestore sessions and engagement events. Reader identities are never surfaced here.</p>
      </header>

      <section className="border-2 border-black bg-white p-2 flex flex-wrap gap-2">
        <button onClick={()=>setStudioSection('analytics')} className={`border-2 border-black px-4 py-2 font-mono text-[10px] font-black uppercase ${studioSection==='analytics'?'bg-[var(--color-primary)]':'bg-white'}`}>ANALYTICS</button>
        <button onClick={()=>setStudioSection('commerce')} className={`border-2 border-black px-4 py-2 font-mono text-[10px] font-black uppercase ${studioSection==='commerce'?'bg-[var(--color-primary)]':'bg-white'}`}>MONETIZATION</button><button onClick={()=>setStudioSection('seller')} className={`border-2 border-black px-4 py-2 font-mono text-[10px] font-black uppercase ${studioSection==='seller'?'bg-[var(--color-primary)]':'bg-white'}`}>SELLER ACCOUNT</button>
        <button onClick={()=>setStudioSection('digital-products')} className={`border-2 border-black px-4 py-2 font-mono text-[10px] font-black uppercase ${studioSection==='digital-products'?'bg-[var(--color-primary)]':'bg-white'}`}>DIGITAL PRODUCTS</button>
      </section>

      {studioSection === 'commerce' ? <CommerceFoundationPanel userProfile={userProfile}/> : studioSection === 'seller' ? <CreatorSellerOnboardingPanel userProfile={userProfile}/> : studioSection === 'digital-products' ? <DigitalProductEnginePanel userProfile={userProfile}/> : <>
      <section className="border-2 border-black bg-white p-4 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] font-black uppercase mr-2">RANGE</span>
        {[['7D', 7], ['30D', 30], ['90D', 90], ['6M', 180], ['1Y', 365], ['ALL', 'all']].map(([label, value]) => (
          <button key={label as string} onClick={() => setRange(value as Range)} className={`border-2 border-black px-3 py-2 font-mono text-[10px] font-black ${range === value ? 'bg-[var(--color-primary)]' : 'bg-white'}`}>{label}</button>
        ))}
        <button onClick={() => setRefreshToken(value => value + 1)} className="ml-auto border-2 border-black px-3 py-2 font-mono text-[10px] font-black">
          <RefreshCw className="inline w-3 h-3" /> REFRESH
        </button>
      </section>

      {analyticsError && <div className="border-2 border-black bg-red-100 p-4 font-mono text-xs font-bold">ANALYTICS SYNC FAILED: {analyticsError}</div>}
      {loading && <div className="border-2 border-black bg-white p-4 font-mono text-xs font-black">LOADING FIRESTORE ANALYTICS…</div>}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          ['ARTICLES', mine.length, BookOpen],
          ['READERS / OPENS', totals.views, Eye],
          ['UNIQUE READERS', totals.unique, Users],
          ['RETURNING', totals.returning, UserRoundCheck],
          ['COMMENTS', totals.comments, MessageCircle],
          ['REACTIONS', totals.reactions, Heart],
          ['SHARES', totals.shares, Share2],
          ['BOOKMARK EVENTS', totals.bookmarks, Bookmark],
          ['AVG TIME', timeLabel(totals.average), Clock],
          ['COMPLETION', `${totals.completion}%`, BarChart3],
        ].map(([label, value, Icon]: any) => <Metric key={String(label)} label={String(label)} value={String(value)} icon={<Icon className="w-4 h-4" />} />)}
      </div>

      <section className="border-4 border-black bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-display font-black text-3xl uppercase">READING FUNNEL</h2><div className="font-mono text-[9px] mt-1">REAL SESSION MILESTONES · {range === 'all' ? 'ALL TIME' : `${range}D`}</div></div><div className="font-mono text-[9px] font-black">CLICK A STAGE FOR RETENTION</div></div>
        <div className="grid md:grid-cols-5 gap-2 mt-4">{(['opened','p25','p50','p75','completed'] as const).map(stage=>{const active=selectedFunnelStage===stage; const val=funnel[stage]; const prev=stage==='opened'?val:funnel[(['opened','p25','p50','p75','completed'] as const)[Math.max(0,(['opened','p25','p50','p75','completed'] as const).indexOf(stage)-1)]]; const retention=stage==='opened'?100:(prev?Math.round((val/prev)*1000)/10:0); return <button key={stage} onClick={()=>setSelectedFunnelStage(stage)} className={`border-2 border-black p-3 text-left ${active?'bg-[var(--color-primary)]':'bg-neutral-50'}`}><div className="font-mono text-[9px] font-black">{funnelStageLabels[stage]}</div><div className="font-display font-black text-3xl mt-1">{val.toLocaleString()}</div><div className="font-mono text-[9px] mt-1">RETENTION {retention}%</div><div className="h-2 border-2 border-black mt-2"><div className="h-full bg-[var(--color-primary)]" style={{width:`${Math.max(0,Math.min(100,retention))}%`}}/></div></button>})}</div>
        <div className="mt-3 border-2 border-black p-3 font-mono text-[10px]"><span className="font-black">{funnelStageLabels[selectedFunnelStage]}</span> RETENTION FROM PREVIOUS STAGE: <span className="font-black">{funnelRetention}%</span> · COUNT: <span className="font-black">{funnelValue.toLocaleString()}</span></div>
      </section>

      {top && (
        <section className="border-4 border-black bg-[var(--color-primary)] p-6 neo-shadow">
          <div className="font-mono text-[10px] uppercase font-black">TOP ARTICLE · {stats[top.slug]?.views || Number(top.viewsCount || 0)} OPENED</div>
          <h2 className="font-display font-black text-3xl uppercase mt-1">{top.title}</h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-5">
            {[
              ['UNIQUE', stats[top.slug]?.uniqueReaders || 0],
              ['AVG TIME', timeLabel(stats[top.slug]?.averageReadingTimeMs || 0)],
              ['COMPLETION', `${stats[top.slug]?.completionRate || 0}%`],
              ['SCROLL DEPTH', `${stats[top.slug]?.scrollDepth || 0}%`],
              ['RETURNING', stats[top.slug]?.returnReaders || 0],
            ].map(([label, value]) => <div key={String(label)} className="border-2 border-black bg-white p-3"><div className="font-mono text-[9px]">{label}</div><div className="font-display font-black text-2xl">{value}</div></div>)}
          </div>
          <div className="flex flex-wrap gap-2 mt-5">
            <button onClick={() => onNavigate('article', top.slug)} className="border-2 border-black bg-black text-white px-4 py-2 font-mono text-[10px] font-black uppercase">OPEN ARTICLE →</button>
            <span className="border-2 border-black bg-white px-4 py-2 font-mono text-[10px] font-black uppercase">RANGE: {range === 'all' ? 'ALL TIME' : `${range} DAYS`}</span>
          </div>
        </section>
      )}

{collabInvites.length>0&&<section className="border-4 border-black bg-[var(--color-primary)] p-4 mb-5"><div className="font-mono text-[9px] font-black uppercase">Collaborator invitations</div><div className="space-y-2 mt-2">{collabInvites.map(i=><div key={i.id} className="border-2 border-black bg-white p-3 flex flex-wrap justify-between gap-2 font-mono text-[9px]"><span>{i.articleSlug} · {String(i.role||'viewer').toUpperCase()}</span><span className="flex gap-2"><button onClick={()=>void acceptCreatorCollaboratorInvite(i.id).then(()=>{setCollabInvites(x=>x.filter(v=>v.id!==i.id));notifyToast('Invitation accepted.','success')}).catch(e=>notifyToast(e instanceof Error?e.message:'Could not accept invitation.','error'))} className="border-2 border-black px-2 py-1">ACCEPT</button><button onClick={()=>void declineCreatorCollaboratorInvite(i.id).then(()=>setCollabInvites(x=>x.filter(v=>v.id!==i.id))).catch(e=>notifyToast(e instanceof Error?e.message:'Could not decline invitation.','error'))} className="border-2 border-black px-2 py-1">DECLINE</button></span></div>)}</div></section>}
      {top && stats[top.slug] && (
        <section className="border-4 border-black bg-white p-5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div><div className="font-mono text-[9px] uppercase">READING FUNNEL</div><h2 className="font-display font-black text-2xl uppercase">ARTICLE ANALYTICS</h2></div>
            <span className="font-mono text-[9px]">AGGREGATE ONLY · NO READER IDENTITIES</span>
          </div>
          <div className="space-y-3 mt-5">
            {[
              ['OPENED', stats[top.slug].funnel.opened],
              ['25%', stats[top.slug].funnel.p25],
              ['50%', stats[top.slug].funnel.p50],
              ['75%', stats[top.slug].funnel.p75],
              ['COMPLETED', stats[top.slug].funnel.completed],
            ].map(([label, value]: any) => (
              <div key={label}>
                <div className="flex justify-between font-mono text-[9px] font-black uppercase"><span>{label}</span><span>{Number(value).toLocaleString()}</span></div>
                <div className="h-4 border-2 border-black bg-neutral-100 mt-1"><div className="h-full bg-[var(--color-primary)]" style={{ width: `${Math.max(0, Math.min(100, Number(value) / Math.max(1, stats[top.slug].funnel.opened) * 100))}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3"><h2 className="font-display font-black text-3xl uppercase">ARTICLE COMPARISON</h2><span className="font-mono text-[9px]">REAL FIRESTORE AGGREGATES</span></div>
        <div className="overflow-x-auto border-4 border-black bg-white">
          <table className="min-w-[980px] w-full text-left border-collapse">
            <thead><tr className="bg-black text-white font-mono text-[9px] font-black uppercase">{['Article','Readers','Unique','Returning','Avg time','Completion','Scroll','Shares','Bookmarks','Reactions','Comments'].map((h) => <th key={h} className="p-3 border-r border-white">{h}</th>)}</tr></thead>
            <tbody>{mine.map((article) => { const x = stats[article.slug]; return <tr key={article.slug} className="border-t-2 border-black font-mono text-[10px]"><td className="p-3 font-display font-black max-w-[260px]">{article.title}</td><td className="p-3">{x?.views ?? Number(article.viewsCount || 0)}</td><td className="p-3">{x?.uniqueReaders ?? 0}</td><td className="p-3">{x?.returnReaders ?? 0}</td><td className="p-3">{timeLabel(x?.averageReadingTimeMs || 0)}</td><td className="p-3">{x?.completionRate ?? 0}%</td><td className="p-3">{x?.scrollDepth ?? 0}%</td><td className="p-3">{x?.shares ?? 0}</td><td className="p-3">{x?.bookmarks ?? 0}</td><td className="p-3">{x?.reactions ?? 0}</td><td className="p-3">{x?.comments ?? 0}</td></tr> })}{!mine.length && <tr><td colSpan={11} className="p-8 text-center font-mono text-xs">NO PUBLISHED ARTICLES YET.</td></tr>}</tbody>
          </table>
        </div>
      </section>

      <section className="border-4 border-black bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="font-display font-black text-3xl uppercase">COMPARE ARTICLES</h2><div className="font-mono text-[9px] mt-1">SELECT UP TO 4 · REAL FIRESTORE AGGREGATES</div></div>
          <button onClick={()=>setCompareSlugs([])} className="border-2 border-black px-3 py-2 font-mono text-[9px] font-black">CLEAR</button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">{mine.map(article=>{const active=compareSlugs.includes(article.slug); return <button key={article.slug} onClick={()=>setCompareSlugs(prev=>active?prev.filter(x=>x!==article.slug):prev.length<4?[...prev,article.slug]:prev)} className={`border-2 border-black px-3 py-2 font-mono text-[9px] font-black text-left ${active?'bg-[var(--color-primary)]':'bg-white'}`}>{active?'✓ ':''}{article.title}</button>})}</div>
        {compareSlugs.length>0 && <div className="overflow-x-auto mt-4 border-2 border-black"><table className="min-w-[900px] w-full border-collapse text-left"><thead><tr className="bg-black text-white font-mono text-[9px] font-black uppercase"><th className="p-3">Metric</th>{compareSlugs.map(slug=><th key={slug} className="p-3 border-l border-white">{mine.find(a=>a.slug===slug)?.title}</th>)}</tr></thead><tbody>{[['Views',(x:any)=>x?.views??0],['Unique readers',(x:any)=>x?.uniqueReaders??0],['Average time',(x:any)=>timeLabel(x?.averageReadingTimeMs||0)],['Completion',(x:any)=>`${x?.completionRate??0}%`],['Scroll depth',(x:any)=>`${x?.scrollDepth??0}%`],['Reactions',(x:any)=>x?.reactions??0],['Bookmarks',(x:any)=>x?.bookmarks??0],['Comments',(x:any)=>x?.comments??0],['Shares',(x:any)=>x?.shares??0]].map(([label,getter])=><tr key={String(label)} className="border-t-2 border-black font-mono text-[10px]"><td className="p-3 font-black uppercase">{String(label)}</td>{compareSlugs.map(slug=><td key={slug} className="p-3 border-l-2 border-black">{(getter as any)(stats[slug])}</td>)}</tr>)}</tbody></table></div>}
        {!compareSlugs.length && <div className="mt-4 border-2 border-dashed border-black p-6 font-mono text-xs">SELECT ARTICLES TO COMPARE PERFORMANCE ACROSS THE CURRENT RANGE.</div>}
      </section>

      <section><div className="flex items-end justify-between mb-3"><h2 className="font-display font-black text-3xl uppercase">YOUR ARTICLES</h2><span className="font-mono text-[9px]">ANALYTICS + VERSION HISTORY</span></div><div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">{mine.map((article) => { const x = stats[article.slug]; return <div key={article.slug} className="border-4 border-black bg-white p-4"><button onClick={() => onNavigate('article', article.slug)} className="text-left w-full hover:bg-[var(--color-secondary)]"><div className="font-mono text-[9px] uppercase">{article.category} · {article.readingTimeMinutes || 0} MIN</div><h3 className="font-display font-black text-xl uppercase mt-1">{article.title}</h3><div className="mt-4 grid grid-cols-2 gap-2 font-mono text-[9px]"><span>{x?.views ?? Number(article.viewsCount || 0)} VIEWS</span><span>{x?.uniqueReaders ?? 0} UNIQUE</span><span>{x?.completionRate ?? 0}% COMPLETE</span><span>{x?.shares ?? 0} SHARES</span></div></button><div className="flex gap-2 mt-3"><button onClick={() => void openRevisions(article)} className="border-2 border-black px-2 py-1 font-mono text-[9px] font-black uppercase"><RotateCcw className="inline w-3 h-3" /> HISTORY</button><button onClick={async () => { try { await createArticleRevision(article); notifyToast('Current article saved as a cloud revision.', 'success'); } catch (error) { notifyToast(error instanceof Error ? error.message : 'Snapshot failed.', 'error'); } }} className="border-2 border-black px-2 py-1 font-mono text-[9px] font-black uppercase"><Copy className="inline w-3 h-3" /> SNAPSHOT</button></div><CreatorWorkflowPanel article={article}/></div>; })}</div></section>

      <section><div className="flex items-end justify-between mb-3"><h2 className="font-display font-black text-3xl uppercase">SERIES ANALYTICS</h2><span className="font-mono text-[9px]">PART-BY-PART DROP-OFF</span></div><div className="grid md:grid-cols-2 gap-4">{series.map((item) => <button key={item.id} onClick={() => void openSeries(item.id)} className="border-4 border-black bg-white p-5 text-left hover:bg-[var(--color-secondary)]"><div className="font-mono text-[9px] uppercase">{item.articleCount || 0} PARTS · {Number(item.viewsCount || 0).toLocaleString()} SERIES VIEWS</div><h3 className="font-display font-black text-2xl uppercase mt-1">{item.title}</h3><div className="mt-4 flex justify-between font-mono text-[9px]"><span>OPEN ANALYTICS</span><span>→</span></div></button>)}</div></section>

      {selected?.startsWith('rev:') && <section className="border-4 border-black bg-white p-5"><div className="flex justify-between"><h2 className="font-display font-black text-2xl uppercase">VERSION HISTORY</h2><button onClick={() => setSelected(null)}>✕</button></div><div className="mt-4 space-y-2">{revisions.map((revision: any) => <div key={revision.id} className="border-2 border-black p-3 flex flex-wrap items-center gap-2"><div className="flex-1 font-mono text-[10px]">{revision.createdAt?.toDate?.()?.toLocaleString?.() || 'CLOUD REVISION'} · {revision.action || 'revision'}</div><button onClick={() => void restore(revision.id)} className="border-2 border-black px-2 py-1 font-mono text-[9px] font-black">RESTORE</button></div>)}{!revisions.length && <div className="font-mono text-xs">NO REVISIONS YET.</div>}</div></section>}

      {selected && !selected.startsWith('rev:') && <section className="border-4 border-black bg-white p-5"><div className="flex justify-between"><div><div className="font-mono text-[9px] uppercase">SERIES ANALYTICS</div><h2 className="font-display font-black text-2xl uppercase">{series.find((item) => item.id === selected)?.title}</h2></div><button onClick={() => setSelected(null)}>✕</button></div>{seriesBusy ? <div className="py-8 text-center font-mono text-xs">LOADING SERIES DATA…</div> : <div className="mt-5 space-y-3">{seriesData.map((row, index) => <div key={row.article.slug} className="border-2 border-black p-3"><div className="flex justify-between font-mono text-[9px] font-black"><span>PART {String(index + 1).padStart(2, '0')} · {row.article.title}</span><span>{row.views.toLocaleString()} OPENS</span></div><div className="grid grid-cols-3 gap-2 mt-3 font-mono text-[9px]"><span>50%+ {row.fiftyPlus.toLocaleString()}</span><span>COMPLETE {row.completed.toLocaleString()}</span><span>RATE {row.completionRate}%</span></div><div className="h-3 bg-neutral-100 border-2 border-black mt-2"><div className="h-full bg-[var(--color-primary)]" style={{ width: `${Math.max(2, Math.min(100, row.views / Math.max(1, seriesData[0]?.views || 1) * 100))}%` }} /></div><div className="font-mono text-[9px] mt-2">{row.drop ? `DROP-OFF FROM PREVIOUS PART: ${row.drop.toLocaleString()}` : 'START OF SERIES'}{index>0 ? ` · RETAINED ${(row.views/Math.max(1,seriesData[index-1]?.views||1)*100).toFixed(1)}%` : ''}</div></div>)}</div>}</section>}
      </> }
    </div>
  );
};

const Metric = ({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) => (
  <div className="border-2 border-black bg-white p-4">
    <div className="flex items-center gap-2 font-mono text-[9px] font-black uppercase">{icon}{label}</div>
    <div className="font-display font-black text-3xl mt-2">{value}</div>
  </div>
);

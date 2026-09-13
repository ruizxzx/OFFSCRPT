import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import {
  adminGetModerationCase,
  adminGetModerationQueue,
  adminModerationAction,
  adminSearchModeration,
  getTrustHealth,
  rebuildReviewAggregate,
  validateReviewAggregates,
  type CommerceModerationAction,
  type CommerceModerationCase,
  type CommerceReport,
} from '../lib/commerce';
import { notifyToast } from '../lib/toast';

const STATUSES = ['', 'queued', 'under_review', 'escalated', 'resolved', 'dismissed'] as const;
const PRIORITIES = ['', 'low', 'normal', 'high', 'critical'] as const;
const TYPES = ['', 'review', 'product', 'creator'] as const;
const DESTRUCTIVE = new Set(['hide', 'remove', 'restrict', 'suspend', 'reject']);

const reviewTransitions: Record<string, string[]> = {
  pending: ['published', 'rejected', 'removed'],
  published: ['flagged', 'hidden', 'removed'],
  flagged: ['under_review', 'hidden', 'removed'],
  under_review: ['published', 'hidden', 'removed', 'rejected'],
  hidden: ['published', 'removed'],
  rejected: ['pending', 'removed'],
  removed: ['hidden', 'published'],
};
const productTransitions: Record<string, string[]> = {
  active: ['hidden', 'removed', 'restricted'],
  hidden: ['active', 'removed', 'restricted'],
  restricted: ['active', 'hidden', 'removed'],
  removed: ['active', 'hidden'],
};
const creatorTransitions: Record<string, string[]> = {
  new: ['active', 'restricted', 'suspended'],
  active: ['restricted', 'suspended'],
  restricted: ['active', 'suspended'],
  suspended: ['active', 'restricted'],
};

function actionLabel(action: string) {
  return action.replaceAll('_', ' ').toUpperCase();
}

function targetActionNames(targetType: string, currentState: string) {
  const states = targetType === 'review'
    ? reviewTransitions[currentState] || []
    : targetType === 'product'
      ? productTransitions[currentState] || []
      : targetType === 'creator'
        ? creatorTransitions[currentState] || []
        : [];
  return states.map(state => state === 'published' ? 'publish' : state === 'active' ? 'restore' : state);
}

export const TrustModerationAdminPanel: React.FC = () => {
  const [cases, setCases] = useState<CommerceModerationCase[]>([]);
  const [queueCursor, setQueueCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<{ case: CommerceModerationCase; reports: CommerceReport[]; target: Record<string, unknown>; actions: CommerceModerationAction[] } | null>(null);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('queued');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('');
  const [type, setType] = useState<(typeof TYPES)[number]>('');
  const [assignedTo, setAssignedTo] = useState('');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [reason, setReason] = useState('policy_violation');
  const [notes, setNotes] = useState('');
  const [assignId, setAssignId] = useState('');
  const [aggregateProductId, setAggregateProductId] = useState('');
  const [aggregateCheck, setAggregateCheck] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminGetModerationQueue({ status, priority, targetType: type, assignedTo, limit: 50 });
      setCases(result.cases || []);
      setQueueCursor(result.nextCursor || null);
    } catch (error: any) {
      notifyToast(error?.message || 'Moderation queue unavailable.', 'error');
    } finally {
      setLoading(false);
    }
  }, [status, priority, type, assignedTo]);

  const openCase = useCallback(async (id: string) => {
    setSelectedId(id);
    try {
      const result = await adminGetModerationCase(id);
      setDetail(result);
    } catch (error: any) {
      notifyToast(error?.message || 'Could not open case.', 'error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await getTrustHealth());
    } catch (error: any) {
      notifyToast(error?.message || 'Trust health unavailable.', 'error');
    }
  }, []);

  const doAction = useCallback(async (action: string, targetType: string, targetId: string, caseId?: string) => {
    if (DESTRUCTIVE.has(action) && !window.confirm(`Confirm ${actionLabel(action)} for ${targetType} ${targetId}?`)) return;
    if (['resolve', 'dismiss', 'escalate', 'assign', 'unassign'].includes(action) && !caseId) return;
    if (action === 'assign' && !assignId.trim()) {
      notifyToast('Select a moderator ID before assigning.', 'error');
      return;
    }
    setActionBusy(true);
    try {
      await adminModerationAction({
        action,
        targetType,
        targetId,
        caseId,
        reasonCode: reason,
        notes,
        assignedTo: action === 'assign' ? assignId.trim() : undefined,
        requestId: crypto.randomUUID(),
      });
      notifyToast(`Moderation action ${actionLabel(action)} completed.`, 'success');
      if (caseId) await openCase(caseId);
      await load();
    } catch (error: any) {
      notifyToast(error?.message || 'Moderation action failed.', 'error');
    } finally {
      setActionBusy(false);
    }
  }, [assignId, load, notes, openCase, reason]);

  const runSearch = useCallback(async () => {
    const query = search.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    setLoading(true);
    try {
      const result = await adminSearchModeration(query);
      setSearchResults(result.results || []);
    } catch (error: any) {
      notifyToast(error?.message || 'Moderation search failed.', 'error');
    } finally {
      setLoading(false);
    }
  }, [search]);

  const checkAggregate = useCallback(async () => {
    const productId = aggregateProductId.trim();
    if (!productId) return;
    try {
      setAggregateCheck(await validateReviewAggregates(productId));
    } catch (error: any) {
      notifyToast(error?.message || 'Aggregate validation failed.', 'error');
    }
  }, [aggregateProductId]);

  const repairAggregate = useCallback(async () => {
    const productId = aggregateProductId.trim();
    if (!productId || !window.confirm('Explicitly rebuild this product review aggregate?')) return;
    try {
      await rebuildReviewAggregate(productId, true, crypto.randomUUID());
      notifyToast('Review aggregate rebuilt and audited.', 'success');
      await checkAggregate();
    } catch (error: any) {
      notifyToast(error?.message || 'Aggregate rebuild failed.', 'error');
    }
  }, [aggregateProductId, checkAggregate]);

  const loadMoreCases = useCallback(async () => {
    if (!queueCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await adminGetModerationQueue({ status, priority, targetType: type, assignedTo, limit: 50, cursor: queueCursor });
      setCases(previous => {
        const seen = new Set(previous.map(item => item.id));
        return [...previous, ...(result.cases || []).filter(item => !seen.has(item.id))];
      });
      setQueueCursor(result.nextCursor || null);
    } catch (error: any) {
      notifyToast(error?.message || 'Could not load more moderation cases.', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [assignedTo, loadingMore, priority, queueCursor, status, type]);

  const overview = useMemo(() => ({
    open: cases.filter(item => !['resolved', 'dismissed'].includes(item.status)).length,
    pending: cases.filter(item => item.status === 'queued').length,
    reviews: cases.filter(item => item.targetType === 'review').length,
    high: cases.filter(item => item.priority === 'high' || item.priority === 'critical').length,
  }), [cases]);

  const targetState = detail
    ? detail.case.targetType === 'review'
      ? String(detail.target?.status || 'pending')
      : detail.case.targetType === 'product'
        ? String(detail.target?.moderationStatus || 'active')
        : String(detail.target?.trustStatus || 'new')
    : '';
  const actions = detail ? targetActionNames(detail.case.targetType, targetState) : [];

  return (
    <section className="border-4 border-black bg-white shadow-[7px_7px_0_#000] p-5 sm:p-7 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-[9px] font-black text-neutral-500 uppercase flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> V96 TRUST & MODERATION
          </div>
          <h2 className="font-display font-black text-3xl sm:text-4xl uppercase mt-1">Trust Control Center</h2>
          <p className="font-mono text-[9px] text-neutral-500 mt-2 max-w-3xl">
            Server-authoritative moderation queue, review enforcement, trust health and audit history. Reports are evidence for review, not automatic proof of a violation.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="border-2 border-black px-3 py-2 font-mono text-[8px] font-black uppercase" disabled={loading}>
          <RefreshCw className="inline w-3 h-3 mr-1" /> {loading ? 'LOADING' : 'REFRESH'}
        </button>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {[
          ['OPEN CASES', overview.open],
          ['PENDING', overview.pending],
          ['REVIEW CASES', overview.reviews],
          ['HIGH PRIORITY', overview.high],
        ].map(([label, value]) => (
          <div key={String(label)} className="border-2 border-black p-4">
            <div className="font-mono text-[8px] font-black uppercase">{label}</div>
            <div className="font-display font-black text-3xl mt-1">{value}</div>
          </div>
        ))}
      </div>

      <div className="border-2 border-black p-4 flex flex-wrap gap-2 items-center">
        <select value={status} onChange={event => setStatus(event.target.value as (typeof STATUSES)[number])} className="border-2 border-black px-2 py-2 font-mono text-[8px] font-black uppercase">
          {STATUSES.map(value => <option key={value} value={value}>{value || 'ALL STATUS'}</option>)}
        </select>
        <select value={priority} onChange={event => setPriority(event.target.value as (typeof PRIORITIES)[number])} className="border-2 border-black px-2 py-2 font-mono text-[8px] font-black uppercase">
          {PRIORITIES.map(value => <option key={value} value={value}>{value || 'ALL PRIORITY'}</option>)}
        </select>
        <select value={type} onChange={event => setType(event.target.value as (typeof TYPES)[number])} className="border-2 border-black px-2 py-2 font-mono text-[8px] font-black uppercase">
          {TYPES.map(value => <option key={value} value={value}>{value || 'ALL TARGETS'}</option>)}
        </select>
        <input value={assignedTo} onChange={event => setAssignedTo(event.target.value)} placeholder="ASSIGNEE ID" className="border-2 border-black px-3 py-2 font-mono text-[8px] flex-1 min-w-[140px]" />
        <button type="button" onClick={() => void refreshHealth()} className="border-2 border-black bg-[var(--color-primary)] px-3 py-2 font-mono text-[8px] font-black uppercase">CHECK TRUST HEALTH</button>
      </div>

      {health && (
        <div className={`border-2 border-black p-4 ${health.status === 'critical' ? 'bg-red-100' : health.status === 'warning' ? 'bg-yellow-100' : 'bg-[var(--color-primary)]'}`}>
          <div className="flex items-center gap-2 font-mono text-[9px] font-black uppercase">
            {health.status === 'healthy' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
            TRUST HEALTH: {health.status}
          </div>
          <div className="font-mono text-[8px] mt-2">{health.critical} critical · {health.warnings} warnings · checked {health.checkedAt ? new Date(health.checkedAt).toLocaleString() : '—'}</div>
          <div className="space-y-1 mt-2">
            {(health.issues || []).slice(0, 8).map((issue: any, index: number) => (
              <div key={`${issue.type || 'issue'}:${issue.entityId || index}`} className="font-mono text-[8px]">{String(issue.severity || 'INFO').toUpperCase()} · {issue.type || 'issue'} · {issue.entityId || '—'}</div>
            ))}
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-5">
        <div className="border-2 border-black">
          <div className="p-3 border-b-2 border-black font-mono text-[9px] font-black uppercase">MODERATION QUEUE</div>
          <div className="max-h-[620px] overflow-auto">
            {cases.length === 0 ? (
              <div className="p-6 font-mono text-[9px] text-neutral-500">NO CASES MATCH CURRENT FILTERS.</div>
            ) : cases.map(item => (
              <button type="button" key={item.id} onClick={() => void openCase(item.id)} className={`block w-full text-left p-3 border-b-2 border-black ${selectedId === item.id ? 'bg-[var(--color-primary)]' : 'bg-white'}`}>
                <div className="flex justify-between gap-2">
                  <span className="font-mono text-[8px] font-black uppercase">{item.priority} · {item.status}</span>
                  <span className="font-mono text-[7px] text-neutral-500">{item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '—'}</span>
                </div>
                <div className="font-display font-black uppercase mt-1">{item.targetType}</div>
                <div className="font-mono text-[8px] mt-1 truncate">{item.targetId}</div>
                <div className="font-mono text-[7px] text-neutral-500 mt-1">REPORTS {item.reportCount || item.reportIds?.length || 0} · {item.assignedTo ? 'ASSIGNED' : 'UNASSIGNED'}</div>
              </button>
            ))}
          </div>
          {queueCursor && <button type="button" onClick={() => void loadMoreCases()} disabled={loadingMore} className="w-full border-t-2 border-black px-3 py-3 font-mono text-[8px] font-black uppercase">{loadingMore ? 'LOADING…' : 'LOAD MORE CASES'}</button>}
        </div>

        <div className="border-2 border-black p-4 min-h-[400px]">
          {!detail ? (
            <div className="h-full flex items-center justify-center text-center font-mono text-[9px] text-neutral-500">
              <Eye className="w-5 h-5 mr-2" /> SELECT A CASE TO INSPECT
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <div className="font-mono text-[9px] font-black uppercase">CASE {detail.case.id}</div>
                  <div className="font-display text-2xl font-black uppercase mt-1">{detail.case.targetType} · {detail.case.status}</div>
                  <div className="font-mono text-[8px] text-neutral-500 mt-1">PRIORITY {detail.case.priority} · ASSIGNEE {detail.case.assignedTo || 'NONE'}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {!['resolved', 'dismissed'].includes(detail.case.status) && <button type="button" disabled={actionBusy} onClick={() => void doAction('resolve', detail.case.targetType, detail.case.targetId, detail.case.id)} className="border-2 border-black bg-[var(--color-primary)] px-2 py-2 font-mono text-[8px] font-black">RESOLVE</button>}
                  {!['dismissed'].includes(detail.case.status) && <button type="button" disabled={actionBusy} onClick={() => void doAction('dismiss', detail.case.targetType, detail.case.targetId, detail.case.id)} className="border-2 border-black px-2 py-2 font-mono text-[8px] font-black">DISMISS</button>}
                  {!['resolved', 'dismissed', 'escalated'].includes(detail.case.status) && <button type="button" disabled={actionBusy} onClick={() => void doAction('escalate', detail.case.targetType, detail.case.targetId, detail.case.id)} className="border-2 border-black px-2 py-2 font-mono text-[8px] font-black">ESCALATE</button>}
                </div>
              </div>

              <div className="border-2 border-black p-3">
                <div className="font-mono text-[8px] font-black uppercase">TARGET</div>
                <pre className="whitespace-pre-wrap break-words text-[10px] mt-2">{JSON.stringify(detail.target, null, 2)}</pre>
              </div>

              <div className="border-2 border-black p-3">
                <div className="font-mono text-[8px] font-black uppercase">REPORTS ({detail.reports.length})</div>
                {detail.reports.length === 0 ? <div className="text-xs mt-2 text-neutral-500">No linked reports.</div> : detail.reports.map(report => (
                  <div key={report.id} className="border-t border-black mt-2 pt-2">
                    <div className="font-mono text-[8px] font-black">{report.reasonCode} · {report.status}</div>
                    <div className="text-xs mt-1">{report.description || 'No details.'}</div>
                  </div>
                ))}
              </div>

              <div className="border-2 border-black p-3">
                <div className="font-mono text-[8px] font-black uppercase">MODERATION HISTORY</div>
                {detail.actions.length === 0 ? <div className="text-xs mt-2 text-neutral-500">No recorded actions.</div> : detail.actions.map(action => (
                  <div key={action.id} className="border-t border-black mt-2 pt-2 font-mono text-[8px]">
                    <div>{actionLabel(action.action)} · {action.actorRole} · {action.reasonCode}</div>
                    <div className="text-neutral-500">{action.previousState || '—'} → {action.newState || '—'} · {action.timestamp ? new Date(action.timestamp).toLocaleString() : '—'}</div>
                  </div>
                ))}
              </div>

              <div className="border-2 border-black p-3">
                <div className="font-mono text-[8px] font-black uppercase">ACTION CONTROLS · CURRENT {targetState}</div>
                <select value={reason} onChange={event => setReason(event.target.value)} className="mt-2 border-2 border-black px-2 py-2 font-mono text-[8px] font-black uppercase">
                  <option value="policy_violation">policy violation</option>
                  <option value="spam">spam</option>
                  <option value="harassment">harassment</option>
                  <option value="fake_review">fake review</option>
                  <option value="copyright">copyright</option>
                  <option value="prohibited_content">prohibited content</option>
                  <option value="misleading_content">misleading content</option>
                  <option value="other">other</option>
                </select>
                <textarea value={notes} onChange={event => setNotes(event.target.value.slice(0, 3000))} rows={3} placeholder="Internal moderator notes" className="mt-2 w-full border-2 border-black p-2 text-xs" />
                <div className="flex flex-wrap gap-2 mt-2">
                  {actions.map(action => (
                    <button type="button" key={action} disabled={actionBusy} onClick={() => void doAction(action, detail.case.targetType, detail.case.targetId, detail.case.id)} className={`border-2 border-black px-3 py-2 font-mono text-[8px] font-black uppercase ${DESTRUCTIVE.has(action) ? 'bg-red-50' : ''}`}>
                      {actionLabel(action)}
                    </button>
                  ))}
                  <input value={assignId} onChange={event => setAssignId(event.target.value)} placeholder="MODERATOR ID" className="border-2 border-black px-2 py-2 font-mono text-[8px] flex-1 min-w-[140px]" />
                  <button type="button" disabled={actionBusy || !assignId.trim()} onClick={() => void doAction('assign', detail.case.targetType, detail.case.targetId, detail.case.id)} className="border-2 border-black px-3 py-2 font-mono text-[8px] font-black">ASSIGN</button>
                  {detail.case.assignedTo && <button type="button" disabled={actionBusy} onClick={() => void doAction('unassign', detail.case.targetType, detail.case.targetId, detail.case.id)} className="border-2 border-black px-3 py-2 font-mono text-[8px] font-black">UNASSIGN</button>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-2 border-black p-4">
        <div className="font-mono text-[8px] font-black uppercase flex items-center gap-2"><Search className="w-3 h-3" /> SERVER-SIDE MODERATION SEARCH</div>
        <div className="flex flex-wrap gap-2 mt-2">
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="review / case / report / creator / product / order ID" className="flex-1 min-w-[220px] border-2 border-black px-3 py-2 font-mono text-[8px]" />
          <button type="button" onClick={() => void runSearch()} className="border-2 border-black bg-black text-white px-3 py-2 font-mono text-[8px] font-black">SEARCH</button>
        </div>
        {searchResults.length > 0 && <div className="mt-3 space-y-1">{searchResults.slice(0, 20).map(result => <div key={`${result.collection}:${result.id}`} className="border border-black p-2 font-mono text-[8px]"><span className="font-black">{result.collection}</span> · {result.id} · {result.targetType || ''} · {result.status || ''}</div>)}</div>}
      </div>

      <div className="border-2 border-black p-4">
        <div className="font-mono text-[8px] font-black uppercase">REVIEW AGGREGATE INTEGRITY</div>
        <div className="flex flex-wrap gap-2 mt-2">
          <input value={aggregateProductId} onChange={event => setAggregateProductId(event.target.value)} placeholder="PRODUCT ID" className="border-2 border-black px-3 py-2 font-mono text-[8px] flex-1 min-w-[180px]" />
          <button type="button" onClick={() => void checkAggregate()} className="border-2 border-black px-3 py-2 font-mono text-[8px] font-black">VALIDATE</button>
          <button type="button" onClick={() => void repairAggregate()} className="border-2 border-black bg-[var(--color-primary)] px-3 py-2 font-mono text-[8px] font-black">REPAIR (EXPLICIT)</button>
        </div>
        {aggregateCheck && <div className="mt-3 font-mono text-[8px]">{aggregateCheck.healthy ? 'HEALTHY' : 'MISMATCH DETECTED'} · expected {JSON.stringify(aggregateCheck.expected)} · actual {JSON.stringify(aggregateCheck.actual)}</div>}
      </div>
    </section>
  );
};

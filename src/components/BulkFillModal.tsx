import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ListChecks, Loader2, CheckCircle2, ArrowLeftRight } from 'lucide-react';
import type { Foreman, LogEntry } from '../types';
import { upazilaKey } from '../utils/upazilas';
import { TERM_PRESETS, termCountsOf, termList } from '../utils/terms';
import { FILL_FIELDS, FillKey, fillFieldOf, planFill, planForeman, planTerm } from '../utils/bulkFill';
import { MatchBy, buildIndexes, scanIds, splitPairs } from '../utils/bulkScan';
import {
  BulkModal, BulkSegment, bulkBtnBrand, bulkBtnGhost, bulkBtnGo, bulkField, bulkTextarea,
} from './BulkModal';

export type BulkOp = 'fill' | 'foreman' | 'term';
export type BulkResult = { updated: number; unchanged: number; missing: number };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  logs: LogEntry[];
  foremen?: Foreman[];
  /** Which operations to offer (default: all that have a handler). */
  ops?: BulkOp[];
  initialOp?: BulkOp;
  onApplyFill?: (field: FillKey, items: { id: string; value: string }[]) => Promise<BulkResult>;
  onApplyForeman?: (ids: string[], foremanId: string) => Promise<BulkResult>;
  onApplyTerm?: (ids: string[], term: string) => Promise<BulkResult>;
  /** Optional: jump to the list filtered to this term after marking. */
  onShowTerm?: (term: string) => void;
}

const OP_LABEL: Record<BulkOp, string> = { fill: 'Fill a field', foreman: 'Foreman', term: 'Term' };

export const BulkFillModal: React.FC<Props> = ({
  isOpen, onClose, logs, foremen = [], ops, initialOp, onApplyFill, onApplyForeman, onApplyTerm, onShowTerm,
}) => {
  const available = useMemo<BulkOp[]>(() => {
    const all: BulkOp[] = ['fill', 'foreman', 'term'];
    const has: Record<BulkOp, boolean> = { fill: Boolean(onApplyFill), foreman: Boolean(onApplyForeman), term: Boolean(onApplyTerm) };
    return all.filter((o) => has[o] && (!ops || ops.includes(o)));
  }, [ops, onApplyFill, onApplyForeman, onApplyTerm]);

  const [op, setOp] = useState<BulkOp>('fill');
  const [matchBy, setMatchBy] = useState<MatchBy>('nms');
  const [idsText, setIdsText] = useState('');
  const [field, setField] = useState<FillKey>('mac');
  const [valuesText, setValuesText] = useState('');
  const [overwrite, setOverwrite] = useState(true);
  const [foremanId, setForemanId] = useState('');
  const [preset, setPreset] = useState(TERM_PRESETS[0]);
  const [custom, setCustom] = useState('');
  const [clearTerm, setClearTerm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<(BulkResult & { what: string; term?: string }) | null>(null);

  // start clean every time the window is opened
  useEffect(() => {
    if (!isOpen) return;
    setOp(initialOp && available.includes(initialOp) ? initialOp : available[0] || 'fill');
    setMatchBy('nms'); setIdsText(''); setField('mac'); setValuesText(''); setOverwrite(true); setForemanId('');
    setPreset(TERM_PRESETS[0]); setCustom(''); setClearTerm(false); setBusy(false); setError(''); setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const indexes = useMemo(() => buildIndexes(logs), [logs]);
  const termCounts = useMemo(() => termCountsOf(logs), [logs]);
  const terms = useMemo(() => termList(termCounts), [termCounts]);
  const foremanChoices = useMemo(
    () => foremen.filter((f) => f.active && !f.deletedAt).sort((a, b) => a.name.localeCompare(b.name)),
    [foremen],
  );
  const targetForeman = foremen.find((f) => f.id === foremanId);
  const activeTerm = (custom.trim() || preset).trim();

  // The scan runs on every keystroke; a very long paste is allowed to lag a little behind the typing.
  const deferredIds = useDeferredValue(idsText);
  const deferredValues = useDeferredValue(valuesText);
  const scanning = deferredIds !== idsText || deferredValues !== valuesText;
  const scan = useMemo(() => (deferredIds.trim() ? scanIds(deferredIds, indexes, matchBy) : null), [deferredIds, indexes, matchBy]);

  const plan = useMemo(() => {
    if (!scan) return null;
    if (op === 'fill') return planFill(scan, deferredValues, field, overwrite, logs);
    if (op === 'foreman') return planForeman(scan, foremanId, targetForeman?.name || '');
    return planTerm(scan, activeTerm, clearTerm);
  }, [scan, op, deferredValues, field, overwrite, logs, foremanId, targetForeman, activeTerm, clearTerm]);
  const fillPlan = plan && op === 'fill' ? plan as ReturnType<typeof planFill> : null;

  if (!isOpen) return null;

  const def = fillFieldOf(field);
  const needs: string | undefined =
    op === 'foreman' && !foremanId ? 'Choose the foreman first.'
      : op === 'term' && !clearTerm && !activeTerm ? 'Choose or type a term first.'
        : undefined;
  const count = plan?.ready.length || 0;
  const canApply = Boolean(plan) && count > 0 && !needs && !busy && !scanning;
  const pairs = op === 'fill' && !valuesText.trim() ? splitPairs(idsText) : null;

  const pickOp = (o: BulkOp) => { setOp(o); setError(''); };
  const pickMatch = (m: MatchBy) => { setMatchBy(m); setError(''); if (m === 'edc' && field === 'edcNo') setField('mac'); };

  const apply = async () => {
    if (!plan || !canApply) return;
    setBusy(true); setError('');
    try {
      let r: BulkResult;
      let what: string;
      let term: string | undefined;
      if (op === 'fill' && onApplyFill) {
        r = await onApplyFill(field, plan.ready.map((x) => ({ id: x.log!.id, value: x.value })));
        what = def.label;
      } else if (op === 'foreman' && onApplyForeman) {
        r = await onApplyForeman(plan.ready.map((x) => x.log!.id), foremanId);
        what = `Foreman → ${targetForeman?.name || ''}`;
      } else if (op === 'term' && onApplyTerm) {
        r = await onApplyTerm(plan.ready.map((x) => x.log!.id), clearTerm ? '' : activeTerm);
        what = clearTerm ? 'Term cleared' : `Marked ${activeTerm}`;
        term = clearTerm ? undefined : activeTerm;
      } else return;
      setResult({ ...r, what, term });
    } catch (e: any) {
      setError(e?.message || 'Could not save. Nothing was changed - try again.');
    } finally { setBusy(false); }
  };

  // ---------- operation pickers ----------
  const controls = (
    <div className="space-y-3">
      {available.length > 1 && (
        <div>
          <p className="mb-1.5 font-semibold text-slate-700">What do you want to do?</p>
          <BulkSegment label="Bulk fill action" value={op} onChange={pickOp} options={available.map((o) => ({ key: o, label: OP_LABEL[o] }))} />
        </div>
      )}

      {op === 'fill' && (
        <div>
          <label htmlFor="bulk-field" className="mb-1.5 block font-semibold text-slate-700">Field to fill</label>
          <select id="bulk-field" value={field} onChange={(e) => { setField(e.target.value as FillKey); setError(''); }} className={`${bulkField} w-full cursor-pointer`}>
            {FILL_FIELDS.map((f) => (
              <option key={f.key} value={f.key} disabled={matchBy === 'edc' && f.key === 'edcNo'}>{f.label}{matchBy === 'edc' && f.key === 'edcNo' ? ' (you are finding by EDC no.)' : ''}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-slate-500">{def.hint}</p>
        </div>
      )}

      {op === 'foreman' && (
        <div>
          <label htmlFor="bulk-foreman" className="mb-1.5 block font-semibold text-slate-700">Move the connections to</label>
          <select id="bulk-foreman" value={foremanId} onChange={(e) => { setForemanId(e.target.value); setError(''); }} className={`${bulkField} w-full cursor-pointer`}>
            <option value="">Choose a foreman…</option>
            {foremanChoices.map((f) => (
              <option key={f.id} value={f.id}>{f.name}{upazilaKey(f.area) ? ` (${upazilaKey(f.area)})` : ''}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-slate-500">Each connection's upazila and foreman phone follow the new foreman.</p>
        </div>
      )}

      {op === 'term' && (
        <div className="space-y-2">
          <BulkSegment label="Term action" value={clearTerm ? 'clear' : 'set'} onChange={(v) => setClearTerm(v === 'clear')}
            options={[{ key: 'set', label: 'Mark as term' }, { key: 'clear', label: 'Clear term' }]} />
          {!clearTerm && (
            <div className="space-y-2">
              <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Term" className={`${bulkField} w-full cursor-pointer`}>
                {terms.map((t) => <option key={t} value={t}>{t} - {termCounts[t] || 0}</option>)}
              </select>
              <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="or type a custom term" aria-label="Custom term" className={`${bulkField} w-full`} />
              <p className="text-[11px] text-slate-500">Marking as <b className="text-[#1b2a4e]">{activeTerm || '-'}</b></p>
            </div>
          )}
          {clearTerm && <p className="text-[11px] text-slate-500">The term is taken off every matched connection.</p>}
        </div>
      )}
    </div>
  );

  // ---------- the values to fill in ----------
  const mismatch = fillPlan && fillPlan.total !== fillPlan.valueCount;
  const extraInputs = op === 'fill' ? (
    <div>
      <label htmlFor="bulk-values" className="mb-1 block font-semibold text-slate-700">Paste the {def.label.toLowerCase()} values</label>
      <textarea id="bulk-values" value={valuesText} rows={7} placeholder={def.example} spellCheck={false} className={bulkTextarea}
        onChange={(e) => { setValuesText(e.target.value); setError(''); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); } }} />
      <p className="mt-1 text-[11px] text-slate-500">One per line, <b>in the same order</b> as the IDs (line 1 goes to the first ID, and so on).</p>
      <label className="mt-1.5 inline-flex items-center gap-1.5 text-slate-600">
        <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
        Replace values that are already filled (recommended)
      </label>
    </div>
  ) : null;

  const notices = (
    <>
      {pairs && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-sky-900">
          <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 min-w-[12rem]">These lines hold two columns (ID and value), like a copy from Excel.</span>
          <button type="button" onClick={() => { setIdsText(pairs.ids); setValuesText(pairs.values); }} className="h-6 px-2.5 text-[11px] font-semibold text-sky-900 bg-white border border-sky-300 rounded-full hover:bg-sky-100">Split into IDs and values</button>
        </div>
      )}
      {scan?.extraColumns && !pairs && op !== 'fill' && (
        <p className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-sky-900">Some lines have more than one column. Only the first column of each line is read as an ID.</p>
      )}
      {fillPlan && fillPlan.valueCount > 0 && mismatch && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-800">
          {fillPlan.total} IDs but {fillPlan.valueCount} values. Check the order before filling.
        </p>
      )}
      {fillPlan && fillPlan.extraValues.length > 0 && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-800">
          {fillPlan.extraValues.length} extra value{fillPlan.extraValues.length === 1 ? '' : 's'} at the end have no ID and will be ignored.
        </p>
      )}
      {op === 'fill' && scan && !valuesText.trim() && !pairs && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-slate-600">The IDs are scanned. Paste the values to see what would be filled.</p>
      )}
      {op === 'foreman' && plan && targetForeman && plan.ready.length > 0 && (
        <p className="text-slate-600"><b className="text-emerald-700">{plan.ready.length}</b> will move to {targetForeman.name}.</p>
      )}
    </>
  );

  const nowLabel = op === 'fill' ? 'Now' : op === 'foreman' ? 'Foreman now' : 'Term now';
  const newLabel = op === 'fill' ? 'New' : op === 'foreman' ? 'New foreman' : 'New term';
  const readyLabel = op === 'fill' ? 'Will fill' : op === 'foreman' ? 'Will move' : clearTerm ? 'Will clear' : 'Will mark';
  const actionText =
    op === 'fill' ? `Fill ${count} connection${count === 1 ? '' : 's'}`
      : op === 'foreman' ? `Move ${count} connection${count === 1 ? '' : 's'}`
        : clearTerm ? `Clear term on ${count}` : `Mark ${count} as ${activeTerm || 'term'}`;

  // ---------- after a successful run ----------
  const done = result ? (
    <div className="py-6 text-center space-y-2">
      <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" />
      <p className="text-sm font-semibold text-slate-900">{result.updated} connection{result.updated === 1 ? '' : 's'} updated</p>
      <p className="text-slate-500">{result.what}{result.unchanged ? ` · ${result.unchanged} already had it` : ''}{result.missing ? ` · ${result.missing} no longer exist` : ''}</p>
      <p className="text-[11px] text-slate-400">Every change is recorded in the connection's history and in Activity.</p>
    </div>
  ) : undefined;

  const footer = result ? (
    <>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { setResult(null); setValuesText(''); setForemanId(''); }} className={bulkBtnGhost}>Same list, another action</button>
        <button type="button" onClick={() => { setResult(null); setIdsText(''); setValuesText(''); }} className={bulkBtnGhost}>New list</button>
      </div>
      <div className="flex items-center gap-2">
        {onShowTerm && result.term && (
          <button type="button" onClick={() => { onShowTerm(result.term!); onClose(); }} className="h-8 px-3 text-xs font-semibold text-brand-900 bg-brand-50 border border-brand-200 rounded-lg hover:bg-brand-100">Show these in the list</button>
        )}
        <button type="button" onClick={onClose} className={bulkBtnBrand}>Close</button>
      </div>
    </>
  ) : (
    <>
      <span className="text-[11px] text-slate-500 truncate">
        {plan ? `${plan.ready.length} ready · ${plan.skipped} skipped · ${plan.notFound} not matched · ${plan.errors} errors` : 'Nothing is saved until you press the button.'}
      </span>
      <button type="button" onClick={apply} disabled={!canApply} className={bulkBtnGo}>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{actionText}
      </button>
    </>
  );

  return (
    <BulkModal
      isOpen={isOpen} onClose={onClose} icon={ListChecks} title="Bulk fill"
      subtitle="Paste NMS IDs or EDC numbers. They are scanned straight away, and nothing is saved until you press the button."
      controls={controls} matchBy={matchBy} onMatchBy={pickMatch}
      disabledMatch={op === 'fill' && field === 'edcNo' ? { edc: 'The EDC book no. is the field being filled, so connections cannot be found by it' } : undefined}
      idsText={idsText} onIdsText={(t) => { setIdsText(t); setError(''); }}
      extraInputs={extraInputs} scan={scan} plan={plan} scanning={scanning} notices={notices}
      nowLabel={nowLabel} newLabel={newLabel} readyLabel={readyLabel} blocker={needs}
      error={error} done={done} footer={footer} onSubmit={apply}
    />
  );
};

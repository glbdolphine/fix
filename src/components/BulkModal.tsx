import React, { useEffect, useState } from 'react';
import { X, Check, Copy, ArrowLeftRight, AlertTriangle, Loader2 } from 'lucide-react';
import { displayName } from '../utils/names';
import { ScrollLock } from './ScrollLock';
import { MATCH_BY, MATCH_LABEL, MatchBy, ScanResult } from '../utils/bulkScan';
import { BulkPlan, BulkRow, BulkStatus, CATEGORY } from '../utils/bulkPlan';

// The one window every bulk fill uses (fill a field, foreman, term, forms received, bills received).
// It owns the layout, the paste box, the "find by" switch and the live scan: the moment IDs are pasted the
// table shows what matched, what did not, what is an error and what was fixed - before anything is saved.
// Each operation only supplies its own controls, its plan and its buttons.

export type BulkFilter = 'all' | 'ready' | 'skipped' | 'notfound' | 'error' | 'fixed';

const SHOWN = 300;

const BADGE: Record<BulkStatus, { label: string; cls: string }> = {
  change: { label: '', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  same: { label: 'Same', cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  has_value: { label: 'Has value', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  not_found: { label: 'Not matched', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  ambiguous: { label: 'Shared ID', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  repeated: { label: 'Repeated', cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  invalid: { label: 'Invalid', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  no_value: { label: 'No value', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  blocked: { label: 'Blocked', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};

const ROW_TONE: Record<string, string> = {
  ready: '',
  skipped: 'bg-slate-50/60',
  notfound: 'bg-amber-50/40',
  error: 'bg-rose-50/40',
};

export const bulkField = 'h-9 px-3 text-xs font-medium text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl hover:bg-white focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-colors';
export const bulkTextarea = 'w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl hover:bg-white focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-colors';
export const bulkBtnGhost = 'inline-flex items-center justify-center gap-1.5 h-8 px-3 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40';
export const bulkBtnBrand = 'inline-flex items-center justify-center gap-1.5 h-8 px-4 text-xs font-semibold text-white bg-brand-800 rounded-lg hover:bg-brand-900 disabled:opacity-40';
export const bulkBtnGo = 'inline-flex items-center justify-center gap-1.5 h-8 px-4 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-40';

/** Small segmented switch used for the operation / action pickers inside the modal. */
export function BulkSegment<T extends string>({ value, options, onChange, label }: {
  value: T; options: { key: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="inline-flex flex-wrap p-1 rounded-xl bg-slate-100 gap-1" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} disabled={o.disabled} title={o.title} onClick={() => onChange(o.key)}
          className={`h-7 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${value === o.key ? 'bg-white text-brand-800 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const CHIP_TONE: Record<BulkFilter, string> = {
  all: 'border-brand-300 bg-brand-50 text-brand-900',
  ready: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  skipped: 'border-slate-300 bg-slate-100 text-slate-700',
  notfound: 'border-amber-300 bg-amber-50 text-amber-800',
  error: 'border-rose-300 bg-rose-50 text-rose-800',
  fixed: 'border-sky-300 bg-sky-50 text-sky-800',
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  /** Operation-specific pickers (what to fill, which foreman, which term...). */
  controls?: React.ReactNode;
  matchBy: MatchBy;
  onMatchBy: (m: MatchBy) => void;
  /** Columns that cannot be used right now, with the reason. */
  disabledMatch?: Partial<Record<MatchBy, string>>;
  idsText: string;
  onIdsText: (t: string) => void;
  /** Extra paste boxes (the values to fill in). */
  extraInputs?: React.ReactNode;
  scan: ScanResult | null;
  plan: BulkPlan | null;
  /** The scan is still catching up with a very long paste. */
  scanning?: boolean;
  notices?: React.ReactNode;
  nowLabel: string;
  newLabel: string;
  /** Badge for a row that will be written, e.g. "Will fill". */
  readyLabel: string;
  /** A reason nothing can be applied right now. */
  blocker?: string;
  error?: string;
  /** Replaces the body after a successful run. */
  done?: React.ReactNode;
  footer: React.ReactNode;
  onSubmit?: () => void;
}

export const BulkModal: React.FC<Props> = ({
  isOpen, onClose, icon: Icon, title, subtitle, controls, matchBy, onMatchBy, disabledMatch = {}, idsText, onIdsText,
  extraInputs, scan, plan, scanning, notices, nowLabel, newLabel, readyLabel, blocker, error, done, footer, onSubmit,
}) => {
  const [filter, setFilter] = useState<BulkFilter>('all');
  const [copied, setCopied] = useState('');

  useEffect(() => { if (!plan) setFilter('all'); }, [plan]);
  if (!isOpen) return null;

  const names = MATCH_LABEL[matchBy];
  const placeholder = matchBy === 'nms' ? '55716\n55964\n55678' : matchBy === 'edc' ? '584\n1157\n391' : '1\n2\n3';

  const copy = async (key: string, rows: BulkRow[]) => {
    try {
      await navigator.clipboard.writeText(rows.map((r) => r.token).join('\n'));
      setCopied(key); setTimeout(() => setCopied(''), 1500);
    } catch { /* clipboard blocked - nothing to do */ }
  };

  const inFilter = (r: BulkRow) => (filter === 'all' ? true : filter === 'fixed' ? Boolean(r.fix) : CATEGORY[r.status] === filter);
  const shown = plan ? plan.rows.filter(inFilter) : [];

  // not matched here, but they match another column: offer the switch in one click
  const altBy = scan ? MATCH_BY.filter((m) => m !== matchBy && scan.alt[m] > 0).sort((a, b) => scan.alt[b] - scan.alt[a])[0] : undefined;

  const chips: { key: BulkFilter; label: string; n: number }[] = plan ? [
    { key: 'all', label: 'All', n: plan.total },
    { key: 'ready', label: readyLabel, n: plan.ready.length },
    { key: 'skipped', label: 'Skipped', n: plan.skipped },
    { key: 'notfound', label: 'Not matched', n: plan.notFound },
    { key: 'error', label: 'Errors', n: plan.errors },
    { key: 'fixed', label: 'Fixes', n: plan.fixed },
  ] : [];

  const pasteHelp = matchBy === 'edc'
    ? 'Only the EDC book no. column is searched. 1, 01 and ০১ are the same number.'
    : matchBy === 'logno'
      ? 'Only the connection (log) number is searched.'
      : 'Only the NMS ID column is searched.';

  return (
    <div className="no-print fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/40 backdrop-blur-xs">
      <ScrollLock />
      <div role="dialog" aria-modal="true" aria-label={title} className="bg-white w-full max-w-5xl rounded-2xl shadow-xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-brand-50">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5"><Icon className="w-4 h-4 shrink-0" /><span className="truncate">{title}</span></h2>
            <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-500 hover:text-slate-900 rounded hover:bg-white" title="Close" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="overflow-y-auto text-xs min-h-0">
          {done ? (
            <div className="p-4">{done}</div>
          ) : (
            <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
              {/* Left: what to do and the pasted lists */}
              <div className="space-y-3 min-w-0">
                {controls}

                <div>
                  <p className="mb-1.5 font-semibold text-slate-700">Find the connections by</p>
                  <div className="inline-flex flex-wrap p-1 rounded-xl bg-slate-100 gap-1" role="group" aria-label="Find connections by">
                    {MATCH_BY.map((m) => (
                      <button key={m} type="button" aria-pressed={matchBy === m} disabled={Boolean(disabledMatch[m])} title={disabledMatch[m]} onClick={() => onMatchBy(m)}
                        className={`h-7 px-3 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${matchBy === m ? 'bg-white text-brand-800 shadow-xs' : 'text-slate-500 hover:text-slate-800'}`}>
                        {MATCH_LABEL[m].short}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-500">{pasteHelp}</p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="bulk-ids" className="font-semibold text-slate-700">Paste the {names.long}</label>
                    {idsText && <button type="button" onClick={() => onIdsText('')} className="text-[11px] font-semibold text-slate-500 hover:text-slate-800">Clear</button>}
                  </div>
                  <textarea id="bulk-ids" autoFocus value={idsText} rows={9} placeholder={placeholder} spellCheck={false} className={bulkTextarea}
                    onChange={(e) => onIdsText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit) { e.preventDefault(); onSubmit(); } }} />
                  <p className="mt-1 text-[11px] text-slate-500">One per line. They are checked against every connection as soon as you paste.</p>
                </div>

                {extraInputs}
              </div>

              {/* Right: the live scan */}
              <div className="space-y-3 min-w-0">
                {!plan || !scan ? (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-6 text-center text-slate-500">
                    <p className="font-semibold text-slate-700">Nothing scanned yet</p>
                    <p className="mt-1">Paste your list on the left. You will see which {names.long} match, which do not and what needs fixing here, and nothing is saved until you press the button below.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-slate-700"><b className="text-emerald-700">{plan.matched}</b> of <b>{plan.total}</b> {plan.total === 1 ? names.short : names.long} matched</span>
                      {scanning && <span className="inline-flex items-center gap-1 text-slate-400"><Loader2 className="w-3 h-3 animate-spin" />Scanning…</span>}
                      {plan.warnings > 0 && <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="w-3 h-3" />{plan.warnings} to double-check</span>}
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {chips.map((c) => (
                        <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)} disabled={c.n === 0 && c.key !== 'all'}
                          className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[11px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${filter === c.key ? CHIP_TONE[c.key] : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                          {c.label}<span className="tabular-nums">{c.n}</span>
                        </button>
                      ))}
                      <span className="ml-auto flex items-center gap-1.5">
                        {plan.notFound > 0 && (
                          <button type="button" onClick={() => copy('nf', plan.rows.filter((r) => r.status === 'not_found'))} className={bulkBtnGhost + ' !h-7 !px-2.5'}>
                            {copied === 'nf' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}Copy not matched
                          </button>
                        )}
                        {plan.errors > 0 && (
                          <button type="button" onClick={() => copy('er', plan.rows.filter((r) => CATEGORY[r.status] === 'error'))} className={bulkBtnGhost + ' !h-7 !px-2.5'}>
                            {copied === 'er' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}Copy errors
                          </button>
                        )}
                      </span>
                    </div>

                    {altBy && scan && (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-sky-900">
                        <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
                        <span className="flex-1 min-w-[12rem]"><b>{scan.alt[altBy]}</b> not matched {scan.alt[altBy] === 1 ? 'ID is' : 'IDs are'} {MATCH_LABEL[altBy].short} of a connection. Did you paste {MATCH_LABEL[altBy].long}?</span>
                        <button type="button" onClick={() => onMatchBy(altBy)} disabled={Boolean(disabledMatch[altBy])} className="h-6 px-2.5 text-[11px] font-semibold text-sky-900 bg-white border border-sky-300 rounded-full hover:bg-sky-100 disabled:opacity-40">Switch to {MATCH_LABEL[altBy].short}</button>
                      </div>
                    )}
                    {scan.extraColumns && !notices && (
                      <p className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-sky-900">Some lines have more than one column. Only the first column of each line is read as an ID.</p>
                    )}
                    {notices}
                    {blocker && <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-800">{blocker}</p>}

                    <div className="border border-slate-200 rounded-lg overflow-auto max-h-[22rem]">
                      <table className="w-full text-[11px]">
                        <thead className="bg-slate-50 text-slate-500 sticky top-0">
                          <tr>
                            <th className="px-2 py-1.5 text-left">#</th>
                            <th className="px-2 py-1.5 text-left">{names.short}</th>
                            <th className="px-2 py-1.5 text-left">Connection</th>
                            <th className="px-2 py-1.5 text-left">{nowLabel}</th>
                            <th className="px-2 py-1.5 text-left">{newLabel}</th>
                            <th className="px-2 py-1.5 text-left">Result</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {shown.slice(0, SHOWN).map((r) => (
                            <tr key={r.n} className={ROW_TONE[CATEGORY[r.status]]}>
                              <td className="px-2 py-1 text-slate-400">{r.n}</td>
                              <td className="px-2 py-1 font-mono">{r.token}</td>
                              <td className="px-2 py-1 max-w-[12rem] truncate" title={r.log ? displayName(r.log) : ''}>{r.log ? `#${r.log.logNo} · ${displayName(r.log)}` : '-'}</td>
                              <td className="px-2 py-1 font-mono text-slate-500 max-w-[9rem] truncate" title={r.now}>{r.now || '-'}</td>
                              <td className="px-2 py-1 font-mono max-w-[9rem] truncate" title={r.next}>{r.next || '-'}</td>
                              <td className="px-2 py-1">
                                <span className={`inline-block px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${BADGE[r.status].cls}`}>
                                  {r.status === 'change' ? (r.replaces ? 'Will replace' : readyLabel) : BADGE[r.status].label}
                                </span>
                                {r.note && <span className="ml-1.5 text-slate-500">{r.note}</span>}
                                {r.warn && <span className="ml-1.5 text-amber-700">{r.warn}</span>}
                                {r.fix && <span className="ml-1.5 inline-flex items-center gap-0.5 text-sky-700"><Check className="w-3 h-3" />{r.fix}</span>}
                              </td>
                            </tr>
                          ))}
                          {shown.length === 0 && <tr><td colSpan={6} className="px-2 py-4 text-center text-slate-400">Nothing in this group.</td></tr>}
                        </tbody>
                      </table>
                      {shown.length > SHOWN && <p className="px-2 py-1.5 text-center text-slate-400">Showing the first {SHOWN} of {shown.length} rows (all will be processed).</p>}
                    </div>
                  </>
                )}
                {error && <p className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-800">{error}</p>}
              </div>
            </div>
          )}
          {done && error && <p className="mx-4 mb-4 rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-800">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">{footer}</div>
      </div>
    </div>
  );
};

import React, { useDeferredValue, useMemo, useState } from 'react';
import { ListChecks, Loader2 } from 'lucide-react';
import type { LogEntry, MarkAction } from '../types';
import { MatchBy, buildIndexes, scanIds } from '../utils/bulkScan';
import { planFromScan } from '../utils/bulkPlan';
import { BulkModal, BulkSegment, bulkBtnGhost, bulkBtnGo } from './BulkModal';

// Bulk fill for the Forms and Bills tabs. Same window, same instant scan as every other bulk fill; what is
// different is the action: it marks a signed form / a bill as received (or not received) for the month shown
// on the page. Pressing the button hands the matched connections to the page's usual confirm step
// (month, admin approval), exactly as before.

interface Props {
  isOpen: boolean;
  onClose: () => void;
  kind: 'form' | 'bill';
  logs: LogEntry[];
  /** The month the marks are for, as shown on the page. */
  monthText: string;
  /** Is the connection already in the state this action would leave it in? */
  isDone: (log: LogEntry, action: MarkAction) => boolean;
  /** What the connection has now, for the table. */
  stateText: (log: LogEntry) => string;
  /** Connections that cannot take the mark at all, with the reason (e.g. no form is expected). */
  ineligible?: (log: LogEntry) => string | undefined;
  /** A reason an action cannot run right now (e.g. "pick a month first"). */
  blocked?: (action: MarkAction) => string | undefined;
  onMark: (target: LogEntry[], action: MarkAction) => void;
}

export const BulkMarkModal: React.FC<Props> = ({ isOpen, onClose, kind, logs, monthText, isDone, stateText, ineligible, blocked, onMark }) => {
  // The pasted list is kept while the window is closed, so cancelling the confirm step does not lose it.
  const [action, setAction] = useState<MarkAction>('received');
  const [matchBy, setMatchBy] = useState<MatchBy>('nms');
  const [idsText, setIdsText] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const word = kind === 'form' ? 'form' : 'bill';
  const indexes = useMemo(() => buildIndexes(logs), [logs]);
  const deferredIds = useDeferredValue(idsText);
  const scanning = deferredIds !== idsText;
  const scan = useMemo(() => (deferredIds.trim() ? scanIds(deferredIds, indexes, matchBy) : null), [deferredIds, indexes, matchBy]);

  const plan = useMemo(() => {
    if (!scan) return null;
    const next = action === 'received' ? 'Received' : 'Not received';
    return planFromScan(scan, (log) => {
      const now = stateText(log);
      const no = ineligible?.(log);
      if (no) return { status: 'blocked', now, next: '-', note: no };
      if (isDone(log, action)) return { status: 'same', now, next, note: action === 'received' ? 'Already received' : 'Already not received' };
      return { status: 'change', now, next };
    });
  }, [scan, action, isDone, stateText, ineligible]);

  if (!isOpen) return null;

  const blocker = blocked?.(action);
  const count = plan?.ready.length || 0;
  const canApply = Boolean(plan) && count > 0 && !blocker && !scanning;
  const verb = action === 'received' ? 'received' : 'not received';

  const apply = () => {
    if (!plan || !canApply) return;
    setError(''); setSent(true);
    onMark(plan.ready.map((r) => r.log!), action);
  };

  const controls = (
    <div>
      <p className="mb-1.5 font-semibold text-slate-700">Mark the {word}s as</p>
      <BulkSegment label={`Mark ${word}s as`} value={action} onChange={(a) => { setAction(a); setSent(false); }}
        options={[{ key: 'received', label: 'Received' }, { key: 'not_received', label: 'Not received' }]} />
      <p className="mt-1 text-[11px] text-slate-500">For <b className="text-[#1b2a4e]">{monthText}</b>. You confirm the month and the details on the next step.</p>
    </div>
  );

  const footer = (
    <>
      <span className="text-[11px] text-slate-500 truncate">
        {plan ? `${plan.ready.length} ready · ${plan.skipped} skipped · ${plan.notFound} not matched · ${plan.errors} errors` : 'Nothing is saved until you press the button.'}
      </span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className={bulkBtnGhost}>{sent ? 'Done' : 'Close'}</button>
        <button type="button" onClick={apply} disabled={!canApply} className={bulkBtnGo}>
          {scanning && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Mark {count} {verb}
        </button>
      </div>
    </>
  );

  return (
    <BulkModal
      isOpen={isOpen} onClose={onClose} icon={ListChecks} title={`Bulk fill · ${kind === 'form' ? 'Forms' : 'Bills'} received`}
      subtitle="Paste NMS IDs or EDC numbers. They are scanned straight away, and nothing is saved until you confirm."
      controls={controls} matchBy={matchBy} onMatchBy={(m) => { setMatchBy(m); setError(''); }}
      idsText={idsText} onIdsText={(t) => { setIdsText(t); setError(''); setSent(false); }}
      scan={scan} plan={plan} scanning={scanning}
      nowLabel="Now" newLabel="Will be" readyLabel="Will mark" blocker={blocker}
      error={error} footer={footer} onSubmit={apply}
    />
  );
};

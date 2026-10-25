import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Compass, MapPinned, Target, Users } from 'lucide-react';
import type { Foreman, LogEntry, TeamMember } from '../types';
import { buildCoverageReport } from '../utils/unionStats';
import { buildTargetRows, computeStats, pct, Tally } from '../utils/targets';
import { loadTargets } from '../utils/cloud';
import { usePersistedState } from '../utils/persist';
import { ForemanDirectory } from './ForemanDirectory';
import { CoverageAnalytics } from './CoverageAnalytics';
import { TargetsPanel } from './TargetsPanel';

export type FieldSection = 'foremen' | 'coverage' | 'targets';
const SECTIONS: FieldSection[] = ['foremen', 'coverage', 'targets'];

interface Props {
  logs: LogEntry[];
  foremen: Foreman[];
  teamMembers: TeamMember[];
  isAdmin: boolean;
  onCreateMember: (input: { foremanId: string; name: string; phone: string; role: string }) => Promise<void>;
  onUpdateMember: (id: string, input: { name: string; phone: string; role: string; active: boolean }) => Promise<void>;
  onDeleteMember: (id: string) => Promise<void>;
  onCreate: (input: { name: string; area: string; phone: string; photoUrl?: string }) => Promise<void>;
  onUpdate: (id: string, input: { name: string; area: string; phone: string; active: boolean; photoUrl?: string; roam?: boolean; roamAreas?: string[] }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onOpenUpazila: (upazilaKey: string) => void;
  onFix: (field: 'unionName' | 'upazila', items: { id: string; value: string }[]) => Promise<unknown>;
  onOpenLog: (id: string) => void;
  onRefreshLogs: () => Promise<unknown> | void;
}

const INK = 'text-[#1b2a4e]';

// Every colour below is a theme token (white / slate-50..700 / brand-50..300 / brand-700), so the whole hub
// follows the night-mode remap in index.css. No fixed light-only colours and no semi-transparent white.

// One tab per section. The big number is the section's headline figure, so the row doubles as a summary.
const SectionTab: React.FC<{
  active: boolean; onClick: () => void; icon: React.ElementType; label: string; value: string; sub: string; bar?: number;
}> = ({ active, onClick, icon: Icon, label, value, sub, bar }) => (
  <button
    type="button" role="tab" aria-selected={active} onClick={onClick}
    className={`group relative overflow-hidden text-left rounded-2xl border px-4 py-3 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
      active
        ? 'bg-brand-50 border-brand-300 shadow-[0_10px_24px_-16px_rgba(30,50,110,0.45)]'
        : 'bg-slate-50 border-slate-100 hover:bg-white hover:border-slate-200'
    }`}
  >
    <div className="flex items-center gap-3">
      <span className={`grid place-items-center w-10 h-10 shrink-0 rounded-xl transition-colors ${
        active
          ? 'bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-md shadow-brand-600/25'
          : 'bg-white border border-slate-100 text-slate-500 group-hover:text-brand-700'
      }`}><Icon className="w-[18px] h-[18px]" /></span>
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-bold leading-tight ${active ? INK : 'text-slate-700'}`}>{label}</div>
        <div className="text-[11px] text-slate-500 truncate">{sub}</div>
      </div>
      <div className={`text-[24px] leading-none font-extrabold font-display tabular-nums ${active ? 'text-brand-700' : 'text-slate-600'}`}>{value}</div>
    </div>
    {bar !== undefined && (
      <span className="block mt-3 h-1.5 rounded-full bg-slate-200/70 overflow-hidden">
        <span className={`block h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width] duration-500 ${active ? '' : 'opacity-70'}`} style={{ width: `${Math.max(0, Math.min(100, bar))}%` }} />
      </span>
    )}
    {active && <span className="absolute inset-x-5 bottom-0 h-[3px] rounded-t-full bg-gradient-to-r from-brand-400 to-brand-600" aria-hidden />}
  </button>
);

export const FieldHub: React.FC<Props> = ({
  logs, foremen, teamMembers, isAdmin, onCreateMember, onUpdateMember, onDeleteMember, onCreate, onUpdate, onDelete,
  onOpenUpazila, onFix, onOpenLog, onRefreshLogs,
}) => {
  const [stored, setSection] = usePersistedState<FieldSection>('fieldhub.section', 'foremen');
  const section: FieldSection = SECTIONS.includes(stored) ? stored : 'foremen';

  // Headline figures for the tabs.
  const report = useMemo(() => buildCoverageReport(logs, foremen), [logs, foremen]);
  const coveredUpazilas = report.upazilas.filter((u) => u.count > 0).length;
  const activeForemen = foremen.filter((f) => f.active).length;

  // Target totals: loaded here so the tab shows them before Targets is opened, then kept live by the Targets section.
  const [targets, setTargets] = useState<Tally | null>(null);
  useEffect(() => {
    let alive = true;
    loadTargets().then((rows) => { if (alive) setTargets(computeStats(buildTargetRows(rows, logs)).overall); }).catch(() => { /* tab just shows a dash */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onSummary = useCallback((t: Tally) => setTargets((p) => (p && p.total === t.total && p.connected === t.connected ? p : t)), []);

  return (
    <div className="w-full flex flex-col gap-4 pb-4">
      <section className="relative overflow-hidden bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.28)]">
        <span className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-brand-50 to-transparent pointer-events-none" aria-hidden />

        <header className="relative flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pt-5">
          <span className="grid place-items-center w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-lg shadow-brand-600/30 shrink-0"><Compass className="w-6 h-6" /></span>
          <div className="min-w-0 flex-1">
            <h1 className={`text-2xl font-extrabold tracking-tight leading-tight ${INK}`}>Field Hub</h1>
            <p className="text-[13px] text-slate-500">Your foremen, the areas they cover and the institutes still to connect, all in one place.</p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-brand-50 border border-brand-200 text-[11px] font-semibold text-brand-700 tabular-nums">
              <Users className="w-3.5 h-3.5" />{activeForemen} active foremen
            </span>
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-slate-50 border border-slate-100 text-[11px] font-semibold text-slate-600 tabular-nums">
              <MapPinned className="w-3.5 h-3.5" />{coveredUpazilas}/{report.upazilas.length} upazilas
            </span>
          </div>
        </header>

        <div role="tablist" aria-label="Field Hub sections" className="relative grid grid-cols-1 sm:grid-cols-3 gap-2.5 p-4 pt-5">
          <SectionTab active={section === 'foremen'} onClick={() => setSection('foremen')} icon={Users} label="Foremen"
            value={foremen.length.toLocaleString()} sub={`${activeForemen} active · contacts & allocations`} />
          <SectionTab active={section === 'coverage'} onClick={() => setSection('coverage')} icon={MapPinned} label="Coverage"
            value={report.total.toLocaleString()} sub={`connections · ${coveredUpazilas} of ${report.upazilas.length} upazilas`}
            bar={pct(coveredUpazilas, report.upazilas.length)} />
          <SectionTab active={section === 'targets'} onClick={() => setSection('targets')} icon={Target} label="Targets"
            value={targets ? `${pct(targets.connected, targets.total)}%` : '–'}
            sub={targets ? (targets.total ? `${targets.connected.toLocaleString()} of ${targets.total.toLocaleString()} connected · ${targets.left.toLocaleString()} left` : 'No target list yet') : 'Loading…'}
            bar={targets ? pct(targets.connected, targets.total) : undefined} />
        </div>
      </section>

      <div role="tabpanel">
        {section === 'foremen' && (
          <ForemanDirectory embedded foremen={foremen} logs={logs} teamMembers={teamMembers}
            onCreateMember={onCreateMember} onUpdateMember={onUpdateMember} onDeleteMember={onDeleteMember}
            onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} isAdmin={isAdmin} />
        )}
        {section === 'coverage' && (
          <CoverageAnalytics embedded logs={logs} foremen={foremen} onOpenUpazila={onOpenUpazila} onFix={onFix} onOpenLog={onOpenLog} />
        )}
        {section === 'targets' && (
          <TargetsPanel embedded logs={logs} onOpenLog={onOpenLog} isAdmin={isAdmin} onRefresh={onRefreshLogs} onSummary={onSummary} />
        )}
      </div>
    </div>
  );
};

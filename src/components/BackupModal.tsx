import React, { useRef, useState } from 'react';
import { LogEntry, FieldSuggestionsMap } from '../types';
import { parseAppBackup, ParsedBackup } from '../utils/storage';
import { exportBatchLogsExcel } from '../utils/exportExcel';
import { exportBatchLogsPdf } from '../utils/exportPdf';
import { X, Download, Upload, FileSpreadsheet, FileText, Trash2, CheckCircle2, AlertTriangle, Database, ShieldCheck, RefreshCw, GitMerge, Loader2, Eraser } from 'lucide-react';
import { AdminPasswordDialog } from './AdminPasswordDialog';
import { ScrollLock } from './ScrollLock';

interface BackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  logs: LogEntry[];
  /** Older, connections-only backup files. */
  onRestoreLogs: (logs: LogEntry[], suggestions: FieldSuggestionsMap, merge: boolean, password: string) => Promise<void>;
  /** Whole-database backup files. */
  onRestoreFull: (backup: unknown, password: string) => Promise<void>;
  onDownloadFull: () => Promise<void>;
  onWipeAll: (password: string, phrase: string) => Promise<void>;
  onClearAllLogs: (password: string) => Promise<void>;
  isAdmin: boolean;
}

export const BackupModal: React.FC<BackupModalProps> = ({
  isOpen,
  onClose,
  logs,
  onRestoreLogs,
  onRestoreFull,
  onDownloadFull,
  onWipeAll,
  onClearAllLogs,
  isAdmin,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isWipeOpen, setIsWipeOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<ParsedBackup | null>(null);
  const [mergeOption, setMergeOption] = useState<'replace' | 'merge'>('replace');

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setSuccessMsg(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        // The file is only read here. Nothing changes until the admin confirms with their password.
        setPendingRestore(parseAppBackup(text));
      } catch (err: any) {
        setErrorMsg(err.message || 'Failed to read backup file.');
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handleFullDownload = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setDownloading(true);
    try {
      await onDownloadFull();
      setSuccessMsg('Full backup downloaded. Keep the file somewhere safe and private: it contains sign-in details.');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Could not create the backup.');
    } finally {
      setDownloading(false);
    }
  };

  const fullSummary = (c: Record<string, number>) =>
    `${c.logs ?? 0} connections, ${c.foremen ?? 0} foremen, ${c.approvals ?? 0} approvals, ${c.activity ?? 0} activity entries, ${c.attachments ?? 0} attached forms, ${c.targets ?? 0} targets and ${c.users ?? 0} user accounts`;

  const INK = 'text-[#1b2a4e]';
  const card = 'rounded-2xl border border-slate-100 bg-white p-4';
  const SectionHead: React.FC<{ n: string; title: string; hint: string }> = ({ n, title, hint }) => (
    <div className="flex items-start gap-3 mb-3.5">
      <span className="grid place-items-center w-7 h-7 rounded-xl bg-brand-50 text-brand-700 text-[12px] font-extrabold shrink-0">{n}</span>
      <div className="min-w-0">
        <h3 className={`text-[14px] font-bold ${INK}`}>{title}</h3>
        <p className="text-[12px] text-slate-500 mt-0.5">{hint}</p>
      </div>
    </div>
  );

  return (
    <>
      <div className="no-print fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
        <ScrollLock />
        <div role="dialog" aria-modal="true" aria-label="Data backup and restore"
          className="bg-white w-full max-w-xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[92vh]">
          {/* Header */}
          <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center gap-3">
            <span className="grid place-items-center w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-lg shadow-brand-600/30"><Database className="w-5 h-5" /></span>
            <div className="min-w-0">
              <h2 className={`text-base font-bold ${INK}`}>Data Backup &amp; Restore</h2>
              <p className="text-xs text-slate-500">Back up or restore the whole system: <span className="font-semibold tabular-nums">{logs.length}</span> connections and everything attached to them.</p>
            </div>
            <button onClick={onClose} aria-label="Close" title="Close"
              className="ml-auto grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors"><X className="w-4 h-4" /></button>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50/60 p-5 space-y-4 text-xs">
            {errorMsg && (
              <div className="px-4 py-3 bg-rose-50 text-rose-700 rounded-2xl flex items-start gap-2.5 font-medium">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
                <span className="min-w-0 break-words">{errorMsg}</span>
              </div>
            )}
            {successMsg && (
              <div className="px-4 py-3 bg-emerald-50 text-emerald-800 rounded-2xl flex items-start gap-2.5 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
                <span className="min-w-0 break-words">{successMsg}</span>
              </div>
            )}

            {/* 1. Export */}
            <section className={card}>
              <SectionHead n="1" title="Backup everything" hint={isAdmin
                ? 'One file with the whole database: connections, bills and forms, foremen and teams, approvals, activity log, saved values, targets, attached forms, settings and user accounts.'
                : 'Download the connections as a spreadsheet or a printable report.'} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {isAdmin && (
                <button type="button" onClick={handleFullDownload} disabled={downloading}
                  className="group flex flex-col items-start gap-2.5 p-3.5 text-left text-white bg-gradient-to-br from-brand-500 to-brand-700 hover:from-brand-600 hover:to-brand-800 rounded-2xl shadow-md shadow-brand-600/30 hover:-translate-y-px active:translate-y-0 transition-all disabled:opacity-70 disabled:hover:translate-y-0">
                  <span className="grid place-items-center w-8 h-8 rounded-xl bg-white/20">{downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}</span>
                  <span>
                    <span className="block text-[13px] font-bold">{downloading ? 'Preparing…' : 'Full backup'}</span>
                    <span className="block text-[11px] text-white/75">.json · restores everything</span>
                  </span>
                </button>
                )}
                <button type="button" onClick={() => exportBatchLogsExcel(logs)}
                  className="flex flex-col items-start gap-2.5 p-3.5 text-left bg-white border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/50 rounded-2xl hover:-translate-y-px active:translate-y-0 transition-all">
                  <span className="grid place-items-center w-8 h-8 rounded-xl bg-emerald-50 text-emerald-700"><FileSpreadsheet className="w-4 h-4" /></span>
                  <span>
                    <span className={`block text-[13px] font-bold ${INK}`}>Excel</span>
                    <span className="block text-[11px] text-slate-400">.xlsx · spreadsheet</span>
                  </span>
                </button>
                <button type="button" onClick={() => exportBatchLogsPdf(logs)}
                  className="flex flex-col items-start gap-2.5 p-3.5 text-left bg-white border border-slate-200 hover:border-rose-300 hover:bg-rose-50/50 rounded-2xl hover:-translate-y-px active:translate-y-0 transition-all">
                  <span className="grid place-items-center w-8 h-8 rounded-xl bg-rose-50 text-rose-600"><FileText className="w-4 h-4" /></span>
                  <span>
                    <span className={`block text-[13px] font-bold ${INK}`}>PDF report</span>
                    <span className="block text-[11px] text-slate-400">.pdf · printable</span>
                  </span>
                </button>
              </div>
            </section>

            {/* 2. Restore (admin only) */}
            {isAdmin && (
            <section className={card}>
              <SectionHead n="2" title="Restore from backup file" hint="A full backup replaces everything in the system with the contents of the file. Older connections-only backup files can be replaced or merged, as chosen below." />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-3" role="radiogroup" aria-label="Restore mode">
                {([
                  ['replace', RefreshCw, 'Replace existing connections', 'For older connections-only files'],
                  ['merge', GitMerge, 'Merge with current connections', 'For older connections-only files'],
                ] as const).map(([k, Icon, title, hint]) => {
                  const on = mergeOption === k;
                  return (
                    <button key={k} type="button" role="radio" aria-checked={on} onClick={() => setMergeOption(k)}
                      className={`flex items-start gap-2.5 p-3 text-left rounded-2xl border transition-colors ${on ? 'bg-brand-50 border-brand-300 ring-2 ring-brand-100' : 'bg-white border-slate-200 hover:border-slate-300'}`}>
                      <span className={`grid place-items-center w-8 h-8 rounded-xl shrink-0 ${on ? 'bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-md shadow-brand-600/25' : 'bg-slate-100 text-slate-500'}`}><Icon className="w-4 h-4" /></span>
                      <span className="min-w-0">
                        <span className={`block text-[12.5px] font-bold ${on ? 'text-brand-900' : INK}`}>{title}</span>
                        <span className="block text-[11px] text-slate-400">{hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <input ref={fileInputRef} type="file" accept=".json" onChange={handleFileChange} className="hidden" id="backup-file-input" />
              <button type="button" onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 h-12 text-[12.5px] font-semibold text-brand-800 border-2 border-dashed border-brand-200 hover:border-brand-400 bg-brand-50/50 hover:bg-brand-50 rounded-2xl transition-colors">
                <Upload className="w-4 h-4" />
                <span>Select .json backup file to restore</span>
              </button>
              <p className="mt-2.5 flex items-center gap-1.5 text-[11px] text-slate-400"><ShieldCheck className="w-3.5 h-3.5" />You will be asked for your admin password before anything changes.</p>
            </section>
            )}

            {/* Danger zone (admin only) */}
            {isAdmin && (
            <section className="rounded-2xl border border-rose-100 bg-rose-50/50 p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
              <span className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-orange-400 to-rose-600 text-white shadow-md shadow-rose-600/25 shrink-0"><Trash2 className="w-4 h-4" /></span>
              <div className="flex-1 min-w-[12rem]">
                <h3 className="text-[13.5px] font-bold text-rose-700">Clear all connections</h3>
                <p className="text-[11.5px] text-slate-500 mt-0.5">Moves every shared connection to the admin bin. Everyone will lose access to them.</p>
              </div>
              <button type="button" onClick={() => setIsClearConfirmOpen(true)} disabled={logs.length === 0}
                className="h-9 px-4 text-xs font-semibold text-rose-700 bg-white hover:bg-rose-100 border border-rose-200 rounded-xl disabled:opacity-40 disabled:hover:bg-white transition-colors">
                Clear all connections
              </button>
            </section>
            )}

            {isAdmin && (
            <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
              <span className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-rose-500 to-rose-800 text-white shadow-md shadow-rose-700/30 shrink-0"><Eraser className="w-4 h-4" /></span>
              <div className="flex-1 min-w-[12rem]">
                <h3 className="text-[13.5px] font-bold text-rose-800">Wipe the entire database</h3>
                <p className="text-[11.5px] text-slate-600 mt-0.5">Permanently deletes every connection (and the bin), bill and form record, foreman and team member, approval, activity entry, saved value, target and attached form. Only user accounts and the security log are kept. A safety copy is saved in data/backups first.</p>
              </div>
              <button type="button" onClick={() => setIsWipeOpen(true)}
                className="h-9 px-4 text-xs font-semibold text-white bg-gradient-to-br from-rose-600 to-rose-800 hover:from-rose-700 hover:to-rose-900 rounded-xl shadow-md shadow-rose-700/25 transition-colors">
                Wipe everything
              </button>
            </section>
            )}
          </div>

          {/* Footer */}
          <div className="shrink-0 px-6 py-3.5 border-t border-slate-100 flex items-center justify-end">
            <button onClick={onClose}
              className="h-10 px-6 text-xs font-semibold text-white bg-gradient-to-br from-brand-500 to-brand-700 hover:from-brand-600 hover:to-brand-800 rounded-xl shadow-md shadow-brand-600/30 transition-all">
              Done
            </button>
          </div>
        </div>
      </div>

      {isAdmin && isClearConfirmOpen && (
        <AdminPasswordDialog
          title="Clear all connections?"
          message={`This moves all ${logs.length} connections to the admin bin. Type your admin password to confirm.`}
          confirmLabel="Clear all"
          onConfirm={async (password) => {
            await onClearAllLogs(password);
            setIsClearConfirmOpen(false);
            setSuccessMsg('All connections were moved to the admin bin.');
          }}
          onCancel={() => setIsClearConfirmOpen(false)}
        />
      )}
      {isAdmin && pendingRestore && pendingRestore.kind === 'full' && (
        <AdminPasswordDialog
          title="Restore the full backup?"
          message={`Everything currently in the system will be replaced by the backup${pendingRestore.exportedAt ? ` made on ${new Date(pendingRestore.exportedAt).toLocaleString()}` : ''}: ${fullSummary(pendingRestore.counts)}. A safety copy of today's data is saved first. Type your admin password to confirm.`}
          confirmLabel="Restore everything"
          destructive
          onConfirm={async (password) => {
            await onRestoreFull(pendingRestore.backup, password);
            setSuccessMsg('Everything was restored from the backup.');
            setPendingRestore(null);
          }}
          onCancel={() => setPendingRestore(null)}
        />
      )}
      {isAdmin && pendingRestore && pendingRestore.kind === 'logs' && (
        <AdminPasswordDialog
          title={mergeOption === 'replace' ? 'Replace all connections?' : 'Merge backup into current connections?'}
          message={`${pendingRestore.logs.length} connections from the backup file will ${mergeOption === 'replace' ? 'replace every current connection' : 'be added to the current connections'}. This older kind of file holds connections only (with their bill, form and term marks); it has no foremen, approvals or activity log. Type your admin password to confirm.`}
          confirmLabel={mergeOption === 'replace' ? 'Replace connections' : 'Merge connections'}
          destructive={mergeOption === 'replace'}
          onConfirm={async (password) => {
            await onRestoreLogs(pendingRestore.logs, pendingRestore.suggestions, mergeOption === 'merge', password);
            setSuccessMsg(`Restored ${pendingRestore.logs.length} connections successfully.`);
            setPendingRestore(null);
          }}
          onCancel={() => setPendingRestore(null)}
        />
      )}
      {isAdmin && isWipeOpen && (
        <AdminPasswordDialog
          title="Wipe the entire database?"
          message="This permanently deletes ALL data in the system. It cannot be undone from inside the app (a safety copy is kept in data/backups). Make a full backup first if you may need anything back."
          confirmLabel="Wipe everything"
          requirePhrase="WIPE"
          onConfirm={async (password, phrase) => {
            await onWipeAll(password, phrase || '');
            setIsWipeOpen(false);
            setSuccessMsg('The database was wiped.');
          }}
          onCancel={() => setIsWipeOpen(false)}
        />
      )}
    </>
  );
};

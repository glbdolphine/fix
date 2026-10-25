import React from 'react';
import { Loader2, DatabaseBackup } from 'lucide-react';

interface Props {
  since?: number;
}

/**
 * Full-screen notice shown on every open screen while a backup is being copied.
 * It sits on top of the app (the app underneath is NOT unmounted), so anything a person was typing is still there
 * when the backup finishes and the notice disappears by itself.
 */
export const MaintenanceOverlay: React.FC<Props> = ({ since }) => {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return (
    <div role="alertdialog" aria-modal="true" aria-live="assertive" aria-label="System under maintenance"
      className="no-print fixed inset-0 z-[1000] flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-md">
      <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl border border-slate-100 p-8 text-center">
        <span className="mx-auto grid place-items-center w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 mb-4">
          <DatabaseBackup className="w-7 h-7" />
        </span>
        <h2 className="text-lg font-bold text-[#1b2a4e]">System under maintenance</h2>
        <p className="text-sm text-slate-600 mt-2">
          A data backup is in progress. Nobody can add, edit or delete anything until it is finished.
          This takes about a minute. Please wait; this screen will close by itself and nothing you typed is lost.
        </p>
        <div className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 tabular-nums">
          <Loader2 className="w-4 h-4 animate-spin" />
          {since ? `Waiting ${mm}:${ss}` : 'Waiting…'}
        </div>
      </div>
    </div>
  );
};

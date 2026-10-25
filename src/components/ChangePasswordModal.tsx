import React, { useState } from 'react';
import { X, KeyRound } from 'lucide-react';
import { ScrollLock } from './ScrollLock';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (currentPassword: string, password: string) => Promise<void>;
}

export const ChangePasswordModal: React.FC<Props> = ({ isOpen, onClose, onSave }) => {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!isOpen) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!current) return setError('Enter your current password.');
    if (password.length < 10) return setError('Password must be at least 10 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try { await onSave(current, password); setCurrent(''); setPassword(''); setConfirm(''); }
    catch (e: any) { setError(e?.message || 'Could not change password.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="no-print fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
      <ScrollLock />
      <form onSubmit={submit} className="bg-white w-full max-w-sm rounded-xl shadow-xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><KeyRound className="w-4 h-4" />Change password</h2>
          <button type="button" onClick={onClose}><X className="w-4 h-4 text-slate-500" /></button>
        </div>
        <input autoFocus type="password" autoComplete="current-password" required value={current} onChange={e=>setCurrent(e.target.value)} placeholder="Current password" className="w-full h-10 px-3 text-xs border rounded mb-2" />
        <input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="New password" className="w-full h-10 px-3 text-xs border rounded mb-2" />
        <input type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="Repeat new password" className="w-full h-10 px-3 text-xs border rounded" />
        {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={onClose} className="px-3 py-2 text-xs border rounded">Cancel</button>
          <button disabled={busy} className="px-3 py-2 text-xs text-white bg-brand-800 rounded disabled:opacity-60">{busy ? 'Saving…' : 'Save password'}</button>
        </div>
      </form>
    </div>
  );
};

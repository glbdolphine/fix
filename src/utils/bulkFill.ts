import { LogEntry } from '../types';
import { upazilaKey } from './upazilas';
import { BulkPlan, planFromScan } from './bulkPlan';
import { ScanResult } from './bulkScan';

export type FillKey =
  | 'mac' | 'routerSerial' | 'edcNo' | 'emisEiinDghs' | 'lat' | 'long' | 'fiberLength'
  | 'unionName' | 'upazila' | 'headTeacherName' | 'headTeacherPhone'
  | 'nameBn' | 'nameEn' | 'remarks';

type Cleaned = { value: string } | { error: string };

export interface FillFieldDef {
  key: FillKey;
  label: string;
  example: string;
  hint: string;
  clean: (raw: string) => Cleaned;
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bnToEn = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const hasBangla = (s: string) => /[ঀ-৿]/.test(s);

export function cleanMac(raw: string): Cleaned {
  // 12 hex digits, with ':' '-' '.' or spaces between them (or none at all)
  const hex = raw.trim().replace(/[\s:.\-]/g, '');
  if (!/^[0-9A-Fa-f]{12}$/.test(hex)) return { error: 'Not a valid MAC (needs 12 hex digits)' };
  return { value: hex.toUpperCase().match(/.{2}/g)!.join(':') };
}

const coordinate = (limit: number, name: string) => (raw: string): Cleaned => {
  const t = bnToEn(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { error: `${name} must be a plain number` };
  if (Math.abs(Number(t)) > limit) return { error: `${name} must be between -${limit} and ${limit}` };
  return { value: t };
};

export const FILL_FIELDS: FillFieldDef[] = [
  {
    key: 'mac', label: 'MAC address',
    example: '20:23:51:77:DA:CD\n20-23-51-77-C2-35',
    hint: 'Any separator works (: - . or none). Saved as 20:23:51:77:DA:CD.',
    clean: cleanMac,
  },
  {
    key: 'routerSerial', label: 'Router serial',
    example: '22640VJ005240\n22640VJ005241',
    hint: 'Saved in capitals.',
    clean: (raw) => { const v = tidy(raw).toUpperCase(); return v ? { value: v } : { error: 'Empty' }; },
  },
  {
    key: 'edcNo', label: 'EDC book no.',
    example: '930\n929',
    hint: 'Bangla digits are converted.',
    clean: (raw) => { const v = bnToEn(tidy(raw)).replace(/\.0$/, ''); return v ? { value: v } : { error: 'Empty' }; },
  },
  {
    key: 'emisEiinDghs', label: 'Emis / EIIN / DGHS',
    example: '107452\n107453',
    hint: 'Bangla digits are converted.',
    clean: (raw) => { const v = bnToEn(tidy(raw)).replace(/\.0$/, ''); return v ? { value: v } : { error: 'Empty' }; },
  },
  {
    key: 'lat', label: 'Latitude',
    example: '24.8785\n24.7176',
    hint: 'One number per line.',
    clean: coordinate(90, 'Latitude'),
  },
  {
    key: 'long', label: 'Longitude',
    example: '91.8841\n92.3551',
    hint: 'One number per line.',
    clean: coordinate(180, 'Longitude'),
  },
  {
    key: 'fiberLength', label: 'Fiber length (m)',
    example: '200\n250',
    hint: 'A number of metres. A trailing "m" is dropped.',
    clean: (raw) => {
      const t = bnToEn(raw).trim().replace(/\s*(m|meters?|metres?|মিটার)\.?$/i, '').trim();
      return /^\d+(\.\d+)?$/.test(t) ? { value: t } : { error: 'Fiber length must be a number' };
    },
  },
  {
    key: 'unionName', label: 'Union / address',
    example: 'মানিকপুর\nদেওয়ান বাজার',
    hint: 'Saved exactly as pasted.',
    clean: (raw) => { const v = tidy(raw); return v ? { value: v } : { error: 'Empty' }; },
  },
  {
    key: 'upazila', label: 'Upazila',
    example: 'Golapganj\nSylhet Sadar',
    hint: 'English or Bangla spelling; saved as the standard English name.',
    clean: (raw) => { const k = upazilaKey(tidy(raw)); return k ? { value: k } : { error: 'Unknown upazila' }; },
  },
  {
    key: 'headTeacherName', label: 'Head teacher name',
    example: 'সাজেদা আক্তার নার্গিস\nসিদ্দার্থ শংকর দে',
    hint: 'Saved exactly as pasted.',
    clean: (raw) => { const v = tidy(raw); return v ? { value: v } : { error: 'Empty' }; },
  },
  {
    key: 'headTeacherPhone', label: 'Head teacher phone',
    example: '01778342594\n01818084167',
    hint: 'Saved as 11 digits. A lost leading 0 or a +88 prefix is fixed.',
    clean: (raw) => {
      let d = bnToEn(raw).replace(/[^\d+]/g, '');
      d = d.replace(/^\+?880/, '0').replace(/^\+/, '');
      if (/^1\d{9}$/.test(d)) d = '0' + d; // Excel dropped the leading zero
      return /^01\d{9}$/.test(d) ? { value: d } : { error: 'Not an 11-digit mobile number' };
    },
  },
  {
    key: 'nameBn', label: 'Institute name (Bangla)',
    example: 'সরকারি প্রাথমিক বিদ্যালয়',
    hint: 'Also becomes the name shown in the connections.',
    clean: (raw) => {
      const v = tidy(raw);
      if (!v) return { error: 'Empty' };
      return hasBangla(v) ? { value: v } : { error: 'Not Bangla text' };
    },
  },
  {
    key: 'nameEn', label: 'Institute name (English)',
    example: 'Government Primary School',
    hint: 'Kept for reference; the connections show the Bangla name.',
    clean: (raw) => {
      const v = tidy(raw);
      if (!v) return { error: 'Empty' };
      return hasBangla(v) ? { error: 'Contains Bangla text' } : { value: v };
    },
  },
  {
    key: 'remarks', label: 'Remarks',
    example: 'Router replaced\nCable checked',
    hint: 'Saved exactly as pasted.',
    clean: (raw) => { const v = tidy(raw); return v ? { value: v } : { error: 'Empty' }; },
  },
];

export const fillFieldOf = (key: FillKey) => FILL_FIELDS.find((f) => f.key === key)!;

/** One value per line, in the same order as the IDs. */
export const parseValues = (text: string): string[] =>
  text.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);

export interface FillPlan extends BulkPlan {
  valueCount: number;
  extraValues: string[];   // values with no ID to go to
}

const uniqueKey = (field: FillKey, v: string) =>
  field === 'mac' ? v.replace(/[^0-9a-f]/gi, '').toLowerCase() : v.trim().toLowerCase();

/** Fill one field: the Nth pasted ID gets the Nth pasted value. */
export function planFill(scan: ScanResult, valuesText: string, field: FillKey, overwrite: boolean, logs: LogEntry[]): FillPlan {
  const def = fillFieldOf(field);
  const values = parseValues(valuesText);

  const plan = planFromScan(scan, (log, _row, i) => {
    const raw = i < values.length ? values[i] : null;
    const current = String(log[field] ?? '');
    if (raw === null) return { status: 'no_value', now: current, next: '', note: 'No value on this line' };
    const cleaned = def.clean(raw);
    if ('error' in cleaned) return { status: 'invalid', now: current, next: raw, note: cleaned.error };
    const value = cleaned.value;
    const shown = tidy(raw);
    const fix = value !== shown ? `Cleaned “${shown}” → ${value}` : undefined;
    if (current === value) return { status: 'same', now: current, next: value, value, note: 'Already has this value', fix };
    if (current.trim() && !overwrite) return { status: 'has_value', now: current, next: value, value, note: 'Already has a different value', fix };
    return { status: 'change', now: current, next: value, value, replaces: Boolean(current.trim()), fix };
  });

  // MAC and router serial are unique per connection: warn when one is about to be used twice
  if (field === 'mac' || field === 'routerSerial') {
    const holders = new Map<string, LogEntry[]>();
    for (const l of logs) {
      if (l.deletedAt) continue;
      const v = String(l[field] ?? '');
      if (!v.trim()) continue;
      const k = uniqueKey(field, v);
      holders.set(k, [...(holders.get(k) || []), l]);
    }
    const claimed = new Map<string, number>(); // value -> first line in the pasted list
    for (const r of plan.rows) {
      if (r.status !== 'change') continue;
      const k = uniqueKey(field, r.value);
      const first = claimed.get(k);
      if (first !== undefined) { r.warn = `Same ${def.label} as line ${first} of your list`; continue; }
      claimed.set(k, r.n);
      const others = (holders.get(k) || []).filter((l) => l.id !== r.log!.id);
      // another connection that is itself about to get a different value is not a clash
      const real = others.filter((l) => {
        const inPlan = plan.rows.find((x) => x.log?.id === l.id && x.status === 'change');
        return !inPlan || uniqueKey(field, inPlan.value) === k;
      });
      if (real.length) r.warn = `Also on connection #${real.map((l) => l.logNo).join(', #')}`;
    }
    plan.warnings = plan.rows.filter((r) => r.status === 'change' && r.warn).length;
  }

  return { ...plan, valueCount: values.length, extraValues: values.slice(scan.total) };
}

/** Mark connections as a term (First Term, ...), or take the term off. */
export function planTerm(scan: ScanResult, term: string, clear: boolean): BulkPlan {
  return planFromScan(scan, (log) => {
    const had = (log.term || '').trim();
    if (clear) {
      return had
        ? { status: 'change', now: had, next: '(none)' }
        : { status: 'same', now: '-', next: '(none)', note: 'Has no term to clear' };
    }
    if (had === term) return { status: 'same', now: had, next: term, note: `Already ${term}` };
    return { status: 'change', now: had, next: term, replaces: Boolean(had) };
  });
}

/** Move connections to one foreman. */
export function planForeman(scan: ScanResult, foremanId: string, foremanName: string): BulkPlan {
  return planFromScan(scan, (log) => {
    if (foremanId && log.foremanId === foremanId) return { status: 'same', now: log.foremanName || '', next: foremanName, note: `Already with ${foremanName}` };
    return { status: 'change', now: log.foremanName || '', next: foremanName || '-', replaces: Boolean(log.foremanName?.trim()) };
  });
}

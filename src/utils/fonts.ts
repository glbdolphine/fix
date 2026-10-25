/**
 * Single source of truth for the fonts used by every export (PDF, Excel, Word) and by print.
 *   English / numbers -> Fustat      Bangla -> Kalpurush
 * To change a font for ALL exports, change it here (and in server/fonts.ts for the Word form).
 *
 * Note: PDFs embed the fonts, so they look the same everywhere. Excel and Word files only store the font
 * NAME, so the computer that opens them needs Fustat and Kalpurush installed (otherwise it substitutes).
 */
export const FONT_EN = 'Fustat';
export const FONT_BN = 'Kalpurush';

const BANGLA = /[ঀ-৿]/;

export const hasBangla = (text: unknown): boolean => BANGLA.test(String(text ?? ''));

/** Font for a whole cell: Kalpurush if it contains any Bangla, otherwise Fustat. */
export const fontNameFor = (text: unknown): string => (hasBangla(text) ? FONT_BN : FONT_EN);

/** Plain text of an ExcelJS cell value (handles hyperlink / rich text objects). */
export function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as { text?: unknown; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('');
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    return '';
  }
  return String(v);
}

/** Makes sure the browser has loaded both fonts before text is measured or drawn on a canvas. */
export async function ensureFontsLoaded(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load('16px Fustat', 'Abc123'),
      document.fonts.load('bold 16px Fustat', 'Abc123'),
      document.fonts.load('16px Kalpurush', 'অআকখ'),
      document.fonts.load('bold 16px Kalpurush', 'অআকখ'),
    ]);
    await document.fonts.ready;
  } catch { /* fall back to whatever the browser has */ }
}

import type * as XlsxTypes from 'xlsx';

export type Xlsx = typeof XlsxTypes;

/** Loads the spreadsheet library only when an import/export actually needs it (keeps the main bundle small). */
export async function loadXlsx(): Promise<Xlsx> {
  const m: any = await import('xlsx');
  return (m.utils ? m : m.default) as Xlsx;
}

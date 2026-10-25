import { fontNameFor } from './fonts';

export type SheetRow = Record<string, string | number | null | undefined>;

function saveBlob(buf: ArrayBuffer | Uint8Array, filename: string) {
  const blob = new Blob([buf as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * Downloads a simple one-sheet .xlsx made from row objects (keys of the first row = column headers).
 * Every cell gets Fustat (English / numbers) or Kalpurush (Bangla); the header row is bold with a frozen
 * header and filter buttons. Use this for any plain table export so the fonts stay consistent.
 */
export async function downloadRowsXlsx(filename: string, sheetName: string, rows: SheetRow[]): Promise<void> {
  const mod: any = await import('exceljs');
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');

  const headers = rows.length ? Object.keys(rows[0]) : [];
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((h) => r[h] ?? ''));

  headers.forEach((h, i) => {
    let longest = h.length;
    for (const r of rows) longest = Math.max(longest, String(r[h] ?? '').length);
    ws.getColumn(i + 1).width = Math.min(60, Math.max(10, longest + 2));
  });

  ws.eachRow((row: any, rowNumber: number) => {
    row.eachCell({ includeEmpty: true }, (cell: any) => {
      cell.font = { name: fontNameFor(cell.value), size: 11, bold: rowNumber === 1 };
      if (rowNumber === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F3EC' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
      }
    });
  });
  if (headers.length) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }
  saveBlob(await wb.xlsx.writeBuffer(), filename);
}

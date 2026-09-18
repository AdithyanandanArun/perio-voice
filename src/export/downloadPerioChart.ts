/**
 * The only file-writing / DOM-touching piece of the export. Everything it
 * needs (rows, sheet data) is pure and lives elsewhere in this directory, so
 * this function is a thin, hard-to-get-wrong wrapper: build the two sheets,
 * hand them to the xlsx writer, trigger the download.
 *
 * `write-excel-file` is loaded with a dynamic `import()` so its code never
 * ships in the main bundle — only when a clinician actually clicks
 * "Download Excel". It bundles its own dependencies (no CDN), so this works
 * offline once the app itself has loaded.
 */

import type { ClinicalSession } from '../domain/types';
import { buildExamSheetData, buildPerioChartSheetData, EXAM_SHEET_NAME, PERIO_SHEET_NAME } from './xlsxDocument';
import { buildPerioChartRows, perioChartFilename, type ExamMeta } from './perioRows';

export async function downloadPerioChart(session: ClinicalSession, meta: ExamMeta): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const rows = buildPerioChartRows(session);
  const sheets = [
    { sheet: PERIO_SHEET_NAME, data: buildPerioChartSheetData(rows) },
    { sheet: EXAM_SHEET_NAME, data: buildExamSheetData(meta) },
  ];
  await writeXlsxFile(sheets).toFile(perioChartFilename(meta.examDate));
}

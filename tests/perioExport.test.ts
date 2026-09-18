import { describe, expect, it } from 'vitest';
import readExcelFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';

import { createInitialSession } from '../src/domain/session';
import { chartKey, emptyRecord, emptyTooth } from '../src/domain/chart';
import type { ClinicalSession, PerioRecord, ToothRecord } from '../src/domain/types';
import { buildPerioChartRows, isoDate, perioChartFilename, type PerioChartRow } from '../src/export/perioRows';
import { buildExamSheetData, buildPerioChartSheetData, PERIO_CHART_HEADER } from '../src/export/xlsxDocument';

function withRecord(session: ClinicalSession, record: PerioRecord): ClinicalSession {
  return { ...session, charts: { ...session.charts, [chartKey(record.tooth, record.surface)]: record } };
}

function withTooth(session: ClinicalSession, tooth: ToothRecord): ClinicalSession {
  return { ...session, teeth: { ...session.teeth, [tooth.tooth]: tooth } };
}

function rowFor(rows: readonly PerioChartRow[], tooth: number): PerioChartRow {
  const row = rows.find((candidate) => candidate.tooth === tooth);
  if (!row) throw new Error(`no row for tooth ${tooth}`);
  return row;
}

describe('buildPerioChartRows', () => {
  it('produces exactly 32 rows in ascending tooth order', () => {
    const rows = buildPerioChartRows(createInitialSession());
    expect(rows).toHaveLength(32);
    expect(rows.map((row) => row.tooth)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
  });

  it('maps buccal and lingual sites to the six clinical columns in the documented order', () => {
    let session = createInitialSession();
    session = withRecord(session, {
      ...emptyRecord(8, 'buccal'),
      probingDepths: [3, 4, 5],
      updatedAt: 1,
    });
    session = withRecord(session, {
      ...emptyRecord(8, 'lingual'),
      probingDepths: [6, 7, 8], // stored as [ML, L, DL]
      updatedAt: 1,
    });
    const row = rowFor(buildPerioChartRows(session), 8);
    // Buccal triple reads forward: MB, B, DB.
    expect(row.pd.MB).toBe(3);
    expect(row.pd.B).toBe(4);
    expect(row.pd.DB).toBe(5);
    // Lingual triple is stored [ML, L, DL] but charted DL -> L -> ML.
    expect(row.pd.DL).toBe(8);
    expect(row.pd.L).toBe(7);
    expect(row.pd.ML).toBe(6);
  });

  it('computes CAL only when both probing depth and recession exist at a site, and blanks otherwise', () => {
    let session = createInitialSession();
    session = withRecord(session, {
      ...emptyRecord(14, 'buccal'),
      probingDepths: [4, null, 3],
      recession: [1, 2, null],
      updatedAt: 1,
    });
    const row = rowFor(buildPerioChartRows(session), 14);
    expect(row.cal.MB).toBe(5); // 4 + 1
    expect(row.cal.B).toBeNull(); // recession present, pd missing
    expect(row.cal.DB).toBeNull(); // pd present, recession missing
  });

  it('leaves every unrecorded value blank (null) rather than zero-filling', () => {
    const rows = buildPerioChartRows(createInitialSession());
    const row = rowFor(rows, 20);
    for (const site of ['MB', 'B', 'DB', 'DL', 'L', 'ML'] as const) {
      expect(row.pd[site]).toBeNull();
      expect(row.recession[site]).toBeNull();
      expect(row.cal[site]).toBeNull();
    }
    expect(row.bleeding).toBe('');
    expect(row.mobility).toBeNull();
    expect(row.furcation).toBeNull();
    expect(row.status).toBe('not charted');
  });

  it('reports bleeding, mobility/furcation and status from the right records', () => {
    let session = createInitialSession();
    session = withRecord(session, { ...emptyRecord(3, 'buccal'), bleeding: true, updatedAt: 1 });
    session = withRecord(session, { ...emptyRecord(3, 'lingual'), bleeding: true, updatedAt: 1 });
    session = withTooth(session, { ...emptyTooth(3), mobility: 2, furcation: 1, updatedAt: 1 });
    session = withTooth(session, { ...emptyTooth(30), missing: true, updatedAt: 1 });

    const chartedRow = rowFor(buildPerioChartRows(session), 3);
    expect(chartedRow.bleeding).toBe('B, L');
    expect(chartedRow.mobility).toBe(2);
    expect(chartedRow.furcation).toBe(1);
    expect(chartedRow.status).toBe('charted');

    const skippedRow = rowFor(buildPerioChartRows(session), 30);
    expect(skippedRow.status).toBe('skipped');

    const untouchedRow = rowFor(buildPerioChartRows(session), 31);
    expect(untouchedRow.status).toBe('not charted');
  });
});

describe('perioChartFilename', () => {
  it('formats as perio-chart-YYYY-MM-DD.xlsx', () => {
    const date = new Date(2026, 8, 18); // September 18, 2026 (local)
    expect(isoDate(date)).toBe('2026-09-18');
    expect(perioChartFilename(date)).toBe('perio-chart-2026-09-18.xlsx');
  });
});

describe('generated workbook', () => {
  it('parses back with matching header and values via read-excel-file', async () => {
    let session = createInitialSession();
    session = withRecord(session, {
      ...emptyRecord(9, 'buccal'),
      probingDepths: [3, 3, 4],
      recession: [1, 0, 1],
      bleeding: true,
      updatedAt: 1,
    });
    const rows = buildPerioChartRows(session);
    const sheetData = buildPerioChartSheetData(rows);
    const examData = buildExamSheetData({
      examDate: new Date(2026, 8, 18, 9, 30, 0),
      clinicianName: 'Dr. Simi Surendran',
      appVersion: '0.2.0',
    });

    const buffer = await writeXlsxFile(
      [
        { sheet: 'Perio chart', data: sheetData },
        { sheet: 'Exam', data: examData },
      ],
    ).toBuffer();

    const parsed = await readExcelFile(buffer);
    expect(parsed.map((sheet) => sheet.sheet)).toEqual(['Perio chart', 'Exam']);

    const perioSheet = parsed[0]!.data;
    expect(perioSheet[0]).toEqual(PERIO_CHART_HEADER);
    expect(perioSheet).toHaveLength(33); // header + 32 teeth

    const tooth9Index = rows.findIndex((row) => row.tooth === 9) + 1; // +1 for header row
    const tooth9 = perioSheet[tooth9Index]!;
    expect(tooth9[0]).toBe(9);
    expect(tooth9[1]).toBe(3); // PD MB
    expect(tooth9[2]).toBe(3); // PD B
    expect(tooth9[3]).toBe(4); // PD DB
    expect(tooth9[19]).toBe('B'); // Bleeding column

    const examSheet = parsed[1]!.data;
    expect(examSheet[0]).toEqual(['Field', 'Value']);
    expect(examSheet.find((entry) => entry[0] === 'Clinician')?.[1]).toBe('Dr. Simi Surendran');
    expect(examSheet.find((entry) => entry[0] === 'App version')?.[1]).toBe('0.2.0');
  });
});

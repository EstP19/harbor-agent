import type { StructuredObservation } from './radiology-extractor.ts';
import {laboratorySourceLines} from './laboratory-labelled-rows.ts';
import {normalizeLaboratoryFlag} from '../../lib/laboratory-flag.ts';

export interface LaboratoryReferenceRange { min?: number; max?: number; operator?: string; raw_text?: string; }
export interface LaboratoryTestResult {
  test_name: string;
  value: number | string;
  flag: 'NORMAL' | 'H' | 'L' | 'CRITICAL' | 'ABNORMAL';
  unit?: string;
  reference_range?: LaboratoryReferenceRange;
}
export interface LaboratoryPanel { category: string; headers?: string[]; results: LaboratoryTestResult[]; }
export interface LaboratoryExtractionResult {
  printedLabName?: string;
  patientName?: string;
  reportDate?: string;
  tableHeaders?: string[];
  panels: LaboratoryPanel[];
  abnormal_results_summary: string[];
}

interface ParsedLabRow {
  testName: string;
  rawValue: string;
  printedFlag?: 'H' | 'L';
  unit?: string;
  rawReference?: string;
}

function markerKey(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
    : '';
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(/^[<>]=?\s*/, '').replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedFlag(value: unknown): StructuredObservation['printedFlag'] {
  return normalizeLaboratoryFlag(value) ?? undefined;
}

/**
 * Keeps the model's observation identity/value while enriching it with the
 * authoritative range and unit evidence present in laboratoryData.panels.
 * Panel rows are also the deduplication boundary for repeated equivalent
 * results such as CRP 0.2 mg/dL and CRP 2 mg/L.
 */
export function synchronizeLaboratoryObservations(
  laboratoryData: LaboratoryExtractionResult | undefined,
  observations: StructuredObservation[],
): StructuredObservation[] {
  const panelResults = (laboratoryData?.panels ?? []).flatMap(panel => panel.results ?? []);
  const firstResultByMarker = new Map<string, LaboratoryTestResult>();
  for (const result of panelResults) {
    const key = markerKey(result.test_name);
    if (key && !firstResultByMarker.has(key)) firstResultByMarker.set(key, result);
  }

  const synchronized: StructuredObservation[] = [];
  const seenMarkers = new Set<string>();
  for (const observation of observations) {
    const key = markerKey(observation.literalMarker);
    if (!key || seenMarkers.has(key)) continue;
    seenMarkers.add(key);
    const result = firstResultByMarker.get(key);
    const reference = result?.reference_range;
    const panelNumericValue = numericValue(result?.value);
    synchronized.push({
      ...observation,
      ...(normalizeLaboratoryFlag(observation.printedFlag)?{printedFlag:normalizeLaboratoryFlag(observation.printedFlag)!}:{}),
      ...(panelNumericValue !== undefined && observation.numericValue === undefined ? { numericValue: panelNumericValue } : {}),
      ...(result?.unit && !observation.unitCode ? { unitCode: result.unit } : {}),
      ...(result?.unit && !observation.literalUnit ? { literalUnit: result.unit } : {}),
      ...(result?.flag && !observation.printedFlag ? { printedFlag: normalizedFlag(result.flag) } : {}),
      ...(reference?.min !== undefined && observation.lowerBound === undefined ? { lowerBound: reference.min } : {}),
      ...(reference?.max !== undefined && observation.upperBound === undefined ? { upperBound: reference.max } : {}),
      ...(reference?.raw_text && !observation.rangeText ? { rangeText: reference.raw_text } : {}),
    });
  }

  for (const [key, result] of firstResultByMarker) {
    if (seenMarkers.has(key)) continue;
    seenMarkers.add(key);
    const reference = result.reference_range;
    const value = numericValue(result.value);
    synchronized.push({
      literalMarker: result.test_name,
      ...(value !== undefined ? { numericValue: value } : {}),
      ...(result.unit ? { unitCode: result.unit, literalUnit: result.unit } : {}),
      printedFlag: normalizedFlag(result.flag),
      ...(reference?.min !== undefined ? { lowerBound: reference.min } : {}),
      ...(reference?.max !== undefined ? { upperBound: reference.max } : {}),
      ...(reference?.raw_text ? { rangeText: reference.raw_text } : {}),
      confidence: value === undefined ? 0.9 : 0.98,
    });
  }

  return synchronized;
}

const QUALITATIVE_VALUE = '(?:negative|positive|reactive|non[- ]?reactive|negatief|positief|detected|not detected|present|absent)';
const NUMERIC_VALUE = '[<>]?\\s*-?\\d+(?:[.,]\\d+)?';
const RESULT_VALUE = `(?:${NUMERIC_VALUE}|${QUALITATIVE_VALUE})`;
const REFERENCE_VALUE = `(?:[<>]=?\\s*-?\\d+(?:[.,]\\d+)?|-?\\d+(?:[.,]\\d+)?\\s*-\\s*-?\\d+(?:[.,]\\d+)?|${QUALITATIVE_VALUE})`;

function toNumber(value: string): number | undefined {
  const parsed = Number(value.replace(/^[<>]=?\s*/, '').replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseReference(rawReference?: string): LaboratoryReferenceRange | undefined {
  if (!rawReference) return undefined;
  const raw = rawReference.trim();
  const threshold = raw.match(/^([<>]=?)\s*(-?\d+(?:[.,]\d+)?)$/);
  if (threshold) {
    const value = toNumber(threshold[2]);
    if (value === undefined) return { raw_text: raw };
    return { ...(threshold[1].startsWith('<') ? { max: value } : { min: value }), operator: threshold[1], raw_text: raw };
  }
  const range = raw.match(/^(-?\d+(?:[.,]\d+)?)\s*-\s*(-?\d+(?:[.,]\d+)?)$/);
  if (range) {
    const min = toNumber(range[1]);
    const max = toNumber(range[2]);
    // Preserve suspicious OCR ranges literally instead of inventing corrected clinical bounds.
    if (min !== undefined && max !== undefined && min <= max) return { min, max, raw_text: raw };
  }
  return { raw_text: raw };
}

function parseLabRow(line: string): ParsedLabRow | undefined {
  const normalized = line
    .replace(/^[+|—–-]\s*/, '')
    .replace(/^\d{1,3}[.)]\s*/, '')
    .replace(/\s+l:{1,2}\s+(?=[<>]?\d)/g, ' L ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^---\s*p[aá]gina/i.test(normalized)) return undefined;

  // Match Pattern 1: TestName + Value + optional [H/L] + Unit + ReferenceRange
  // e.g., "WBC 9.69 H 10*9/L 4.23-9.07" or "Trombocyten 772 H 10*9/L 163-337"
  const m1 = normalized.match(new RegExp(
    `^(.+?)\\s+(${RESULT_VALUE})\\s+([HL])\\s+(.+?)\\s+(${REFERENCE_VALUE})$`, 'i'
  ));
  if (m1) {
    return {
      testName: m1[1].trim(),
      rawValue: m1[2].replace(/\s+/g, ''),
      printedFlag: m1[3].toUpperCase() as 'H' | 'L',
      unit: m1[4].trim(),
      rawReference: m1[5].replace(/\s+/g, ''),
    };
  }

  // Match Pattern 2: TestName + Value + Unit + ReferenceRange
  // e.g., "HGB 15.0 g/dL 13.7-17.5" or "CRP 0.2 mg/dL <0.5" or "RBC 4.95 10*12/L 4.63-6.08"
  const m2 = normalized.match(new RegExp(
    `^(.+?)\\s+(${RESULT_VALUE})\\s+(.+?)\\s+(${REFERENCE_VALUE})$`, 'i'
  ));
  if (m2) {
    return {
      testName: m2[1].trim(),
      rawValue: m2[2].replace(/\s+/g, ''),
      unit: m2[3].trim(),
      rawReference: m2[4].replace(/\s+/g, ''),
    };
  }

  // Match Pattern 3: TestName + optional [H/L] + Value + ReferenceRange (optional Unit at end)
  // e.g., "WBC H 9.69 4.23-9.07 10*9/L"
  const m3 = normalized.match(new RegExp(
    `^(.+?)\\s+([HL])?\\s*(${RESULT_VALUE})\\s+(${REFERENCE_VALUE})(?:\\s+(.+))?$`, 'i'
  ));
  if (m3) {
    return {
      testName: m3[1].trim(),
      printedFlag: m3[2]?.toUpperCase() as 'H' | 'L' | undefined,
      rawValue: m3[3].replace(/\s+/g, ''),
      rawReference: m3[4].replace(/\s+/g, ''),
      unit: m3[5]?.trim(),
    };
  }

  // Match Pattern 4: TestName + Value + optional [H/L] + Unit
  // e.g., "Glucose 110 H mg/dL" or "HGB 15.0 g/dL"
  const m4 = normalized.match(new RegExp(
    `^(.+?)\\s+(${RESULT_VALUE})(?:\\s+([HL]))?\\s+([%µμA-Za-z*][A-Za-z0-9µμ%*/.^_-]{0,24})$`, 'i'
  ));
  if (m4) {
    return {
      testName: m4[1].trim(),
      rawValue: m4[2].replace(/\s+/g, ''),
      printedFlag: m4[3]?.toUpperCase() as 'H' | 'L' | undefined,
      unit: m4[4].trim(),
    };
  }

  // Key-value pair: "Glucose: 95 mg/dL"
  const keyValue = normalized.match(new RegExp(`^(.+?)\\s*:\\s*(${RESULT_VALUE})(?:\\s+(.+))?$`, 'i'));
  if (!keyValue) return undefined;
  return { testName: keyValue[1].trim(), rawValue: keyValue[2].replace(/\s+/g, ''), unit: keyValue[3]?.trim() };
}

function flagFromRange(value: number | undefined, reference?: LaboratoryReferenceRange): 'NORMAL' | 'H' | 'L' {
  if (value === undefined || !reference) return 'NORMAL';
  if (reference.operator?.startsWith('<') && reference.max !== undefined && value >= reference.max) return 'H';
  if (reference.operator?.startsWith('>') && reference.min !== undefined && value <= reference.min) return 'L';
  if (reference.max !== undefined && value > reference.max) return 'H';
  if (reference.min !== undefined && value < reference.min) return 'L';
  return 'NORMAL';
}

export function extractLaboratoryLocally(text: string): {
  laboratoryData: LaboratoryExtractionResult;
  observations: StructuredObservation[];
} {
  const source=laboratorySourceLines(text);
  const lines = source.lines.map(line => line.trim()).filter(Boolean);
  const abnormalSummary: string[] = [];
  const observations: StructuredObservation[] = [];

  let detectedHeaders = ['Prueba / Análisis', 'Resultado', 'Unidad', 'Rango de Referencia'];
  const panels: LaboratoryPanel[] = [];
  let currentPanel: LaboratoryPanel = { category: 'Resultados Extraídos', headers: detectedHeaders, results: [] };
  panels.push(currentPanel);

  for (const line of lines) {
    if (line.startsWith('data:') || line.startsWith('JVBERi') || line.includes('base64,')) continue;

    // Detect header lines (e.g., "Test Resultaat Eenheid Referentiewaarde")
    if (/\b(test|prueba|resultaat|resultado|eenheid|unidad|referentiewaarde|rango|referencia)\b/i.test(line) && !/\d/.test(line)) {
      const parts = line.split(/\s{2,}|\t/).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        detectedHeaders = parts;
        currentPanel.headers = detectedHeaders;
      }
      continue;
    }

    // Detect section/panel header lines (e.g., "Hematologie (Bloed)", "Chemie (Bloed)")
    if (/^([A-Z][a-zñA-Z0-9\s/()-]{3,40})$/.test(line) && !parseLabRow(line) && !/\d{2,}/.test(line)) {
      const catName = line.replace(/\(.*\)/, '').trim() || line.trim();
      if (
        !/^(page|p[aá]gina|printdatum|fecha|datum|time|tijd|patient|paciente|doctor|medico|laboratory|laboratorio)/i.test(catName)
      ) {
        if (currentPanel.results.length === 0 && currentPanel.category === 'Resultados Extraídos') {
          currentPanel.category = catName;
        } else {
          currentPanel = { category: catName, headers: detectedHeaders, results: [] };
          panels.push(currentPanel);
        }
        continue;
      }
    }

    const row = parseLabRow(line);
    if (!row) continue;
    const testName = row.testName.replace(/^\d{1,3}[.)]\s*/, '').trim();
    if (
      testName.length < 2 ||
      /\b\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}\b/i.test(testName) ||
      /\bISO\s*\d/i.test(testName) ||
      /^(page|p[aá]gina|printdatum|fecha|datum|time|tijd|patient|paciente|doctor|medico|laboratory|laboratorio|result verified|test performed|units reported|interpretation|reported|door|gerapporteerd|ref(?:erence)?[.: ])/i.test(testName)
    ) continue;

    // A reported result such as ">90" is a bound, not an exact value of 90.
    const numericValue = /^[<>]/.test(row.rawValue) ? undefined : toNumber(row.rawValue);
    const value = numericValue ?? row.rawValue;
    const reference = parseReference(row.rawReference);
    const flag = source.flags.get(line) || row.printedFlag || flagFromRange(numericValue, reference);

    currentPanel.results.push({ test_name: testName, value, flag, unit: row.unit, reference_range: reference });
    if (flag !== 'NORMAL') abnormalSummary.push(`${testName}: ${value} ${row.unit || ''} (${flag === 'H' ? 'Alto' : 'Bajo'})`.trim());

    observations.push({
      literalMarker: testName,
      numericValue,
      unitCode: row.unit,
      literalUnit: row.unit,
      printedFlag: flag === 'H' ? 'HIGH' : flag === 'L' ? 'LOW' : 'NORMAL',
      lowerBound: reference?.min,
      upperBound: reference?.max,
      rangeText: reference?.raw_text,
      confidence: numericValue === undefined ? 0.9 : 0.95,
    });
  }

  const activePanels = panels.filter(p => p.results.length > 0);
  const reportDate = text.match(/\b\d{1,2}[-/]([A-Za-z]{3}|\d{1,2})[-/]\d{4}(?:\s+\d{1,2}:\d{2})?\b/)?.[0];

  const laboratoryData: LaboratoryExtractionResult = {
      printedLabName: 'Informe de Laboratorio',
      reportDate,
      tableHeaders: detectedHeaders,
      panels: activePanels.length > 0 ? activePanels : panels,
      abnormal_results_summary: abnormalSummary,
  };

  return {
    laboratoryData,
    observations: synchronizeLaboratoryObservations(laboratoryData, observations),
  };
}

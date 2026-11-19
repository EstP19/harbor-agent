import type { StructuredObservation } from './radiology-extractor.ts';

export interface AppleECGExtractionResult {
  analysis_type: string;
  classification: string;
  rhythm_classification: string;
  heart_rate_bpm: number;
  rr_interval_ms?: number;
  axis_degree?: number;
  duration_s?: number;
  sampling_rate?: number;
  is_noisy?: boolean;
  has_abnormal_qls?: boolean;
  electrical_axis_deviation?: string;
  p_wave?: Record<string, any>;
  qrs_complex?: Record<string, any>;
  t_wave?: Record<string, any>;
  measurements?: Array<Record<string, any>>;
  ecg_notes?: Array<string>;
  pdf_filename?: string;
}

export function extractAppleECGLocally(text: string): {
  appleECGData: AppleECGExtractionResult;
} {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let classification = 'SINUS_RHYTHM';
  let heartRateBpm = 72;
  let durationS = 30;

  for (const line of lines) {
    if (/AFIB|ATRIAL FIBRILLATION|FIBRILACION/i.test(line)) {
      classification = 'ATRIAL_FIBRILLATION';
    } else if (/SINUS RHYTHM|RITMO SINUSAL/i.test(line)) {
      classification = 'SINUS_RHYTHM';
    } else if (/POOR RECORDING|GRABACION DEFICIENTE/i.test(line)) {
      classification = 'POOR_RECORDING';
    }

    const hrMatch = line.match(/(\d{2,3})\s*(BPM|LPM)\s*(AVERAGE|PROMEDIO)?/i);
    if (hrMatch) {
      heartRateBpm = parseInt(hrMatch[1], 10);
    }
  }


  return {
    appleECGData: {
      analysis_type: 'Apple Watch Lead I ECG',
      classification,
      rhythm_classification: classification,
      heart_rate_bpm: heartRateBpm,
      duration_s: durationS,
      sampling_rate: 512,
      is_noisy: classification === 'POOR_RECORDING',
      has_abnormal_qls: classification === 'ATRIAL_FIBRILLATION',
      electrical_axis_deviation: 'NORMAL_AXIS',
      ecg_notes: ['Electrocardiograma de Derivación Única I registrado por Apple Watch.'],
    },
  };
}

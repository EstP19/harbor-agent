import type { StructuredObservation } from './radiology-extractor.ts';

export interface WearableMetricValue {
  value?: number;
  raw_value?: string;
  unit?: string;
  seconds_per_km?: number;
}

export interface WearableExtractionResult {
  source_device: string;
  activity_type?: string;
  metadata?: {
    date?: string;
    start_time?: string;
    end_time?: string;
    location?: string;
  };
  duration?: {
    active_duration_seconds?: number;
    elapsed_duration_seconds?: number;
    active_time_formatted?: string;
    elapsed_time_formatted?: string;
  };
  distance?: {
    value?: number;
    unit?: string;
  };
  metrics?: {
    active_calories?: WearableMetricValue;
    total_calories?: WearableMetricValue;
    average_cadence?: WearableMetricValue;
    average_pace?: WearableMetricValue;
    average_heart_rate?: WearableMetricValue;
    [key: string]: WearableMetricValue | undefined;
  };
  subjective_feedback?: {
    effort_score?: number;
    effort_label?: string;
  };
}

function parsePaceToSeconds(paceStr: string): number | undefined {
  const match = paceStr.match(/(\d{1,2})[':](\d{2})/);
  if (match) {
    const min = parseInt(match[1], 10);
    const sec = parseInt(match[2], 10);
    return min * 60 + sec;
  }
  return undefined;
}

function parseTimeToSeconds(timeStr: string): number {
  const parts = timeStr.split(':').map(p => parseInt(p, 10));
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

export function extractWearableLocally(text: string): {
  wearableData: WearableExtractionResult;
} {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let activityType: string | undefined;
  let activeDurationSec: number | undefined;
  let elapsedDurationSec: number | undefined;
  let activeTimeFormatted: string | undefined;
  let elapsedTimeFormatted: string | undefined;
  let distanceVal: number | undefined;
  let distanceUnit: string | undefined;
  let activeCal: number | undefined;
  let totalCal: number | undefined;
  let avgCadence: number | undefined;
  let avgPaceRaw: string | undefined;
  let secondsPerKm: number | undefined;
  let avgHr: number | undefined;
  let effortScore: number | undefined;
  let effortLabel: string | undefined;
  let location: string | undefined;
  let dateStr: string | undefined;
  let startTimeStr: string | undefined;
  let endTimeStr: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const upperLine = line.toUpperCase();

    // 1. Ignorar horas de la barra de estado del celular (ej. 09:36 ow = ED)
    if (i === 0 && /^\d{1,2}:\d{2}/.test(line)) {
      continue;
    }

    // 2. Extraer fecha (ej. Sat, Jul 25)
    const dateMatch = line.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?,?\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{1,2}/i);
    if (dateMatch && !dateStr) {
      dateStr = dateMatch[0].replace(/^<\s*/, '').trim();
    }

    // 3. Extraer tipo de actividad
    if (/INDOOR RUN/i.test(line)) activityType = 'INDOOR_RUN';
    else if (/OUTDOOR RUN/i.test(line)) activityType = 'OUTDOOR_RUN';
    else if (/CYCLING|BICI/i.test(line)) activityType = 'OUTDOOR_CYCLING';
    else if (/HIIT/i.test(line)) activityType = 'HIIT';
    else if (/WALK|CAMINATA/i.test(line)) activityType = 'WALKING';

    // Rango horario de la sesión (ej. 09:19-09:50)
    const rangeMatch = line.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (rangeMatch && !startTimeStr) {
      startTimeStr = rangeMatch[1];
      endTimeStr = rangeMatch[2];
    }

    // Ubicación (ej. BT + Willemstad)
    const locMatch = line.match(/(?:BT\s*\+\s*)?([A-Za-z\s]{3,20})$/);
    if (locMatch && !location && /Willemstad|Curacao|Bogota|Madrid|Miami|San Jose/i.test(line)) {
      location = locMatch[1].trim();
    }

    // 4. Secciones con Encabezados Emparejados (Workout Details)
    // 4.1 Workout Time & Elapsed Time
    if (upperLine.includes('WORKOUT TIME') && upperLine.includes('ELAPSED TIME')) {
      if (i + 1 < lines.length) {
        const valLine = lines[i + 1];
        const times = valLine.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (times) {
          activeTimeFormatted = times[1];
          activeDurationSec = parseTimeToSeconds(times[1]);
          elapsedTimeFormatted = times[2];
          elapsedDurationSec = parseTimeToSeconds(times[2]);
        }
      }
    }

    // 4.2 Distance & Active Calories
    if (upperLine.includes('DISTANCE') && upperLine.includes('ACTIVE CALORIES')) {
      if (i + 1 < lines.length) {
        const valLine = lines[i + 1];
        const distMatch = valLine.match(/([\d\.,]+)\s*(KM|MILES|MI)/i);
        if (distMatch) {
          distanceVal = parseFloat(distMatch[1].replace(',', '.'));
          distanceUnit = distMatch[2].toUpperCase();
        }
        const calMatch = valLine.match(/(\d{2,4})\s*(CAL|KCAL)/i);
        if (calMatch) {
          activeCal = parseInt(calMatch[1], 10);
        }
      }
    }

    // 4.3 Total Calories & Avg. Cadence
    if (upperLine.includes('TOTAL CALORIES') && upperLine.includes('AVG. CADENCE')) {
      if (i + 1 < lines.length) {
        const valLine = lines[i + 1];
        const totCalMatch = valLine.match(/(\d{2,4})\s*(CAL|KCAL)/i);
        if (totCalMatch) {
          totalCal = parseInt(totCalMatch[1], 10);
        }
        const cadMatch = valLine.match(/(\d{2,3})\s*(SPM|PASOS)/i);
        if (cadMatch) {
          avgCadence = parseInt(cadMatch[1], 10);
        }
      }
    }

    // 4.4 Avg. Pace & Avg. Heart Rate
    if (upperLine.includes('AVG. PACE') && upperLine.includes('AVG. HEART RATE')) {
      if (i + 1 < lines.length) {
        const valLine = lines[i + 1];
        const paceMatch = valLine.match(/(\d{1,2}[':]\d{2}(?:"\/KM|\/KM)?)/i);
        if (paceMatch) {
          avgPaceRaw = paceMatch[1];
          secondsPerKm = parsePaceToSeconds(avgPaceRaw);
        }
        // Tesseract puede transcribir 134BPM como 1348PM o 134BPM
        const hrMatch = valLine.match(/(\d{2,3})\s*(?:BPM|LPM|8PM|8pm)?\b/i);
        if (hrMatch && hrMatch[1]) {
          const parsedHr = parseInt(hrMatch[1], 10);
          if (parsedHr >= 40 && parsedHr <= 220) {
            avgHr = parsedHr;
          }
        }
      }
    }

    // 5. Effort Score (ej. Effort + \n 6 Moderate E)
    if (upperLine.includes('EFFORT')) {
      if (i + 1 < lines.length) {
        const valLine = lines[i + 1];
        const effortMatch = valLine.match(/^(\d{1,2})\s*([A-Za-z]+)?/);
        if (effortMatch) {
          effortScore = parseInt(effortMatch[1], 10);
          effortLabel = effortMatch[2] || (effortScore <= 3 ? 'Light' : effortScore <= 6 ? 'Moderate' : effortScore <= 8 ? 'Hard' : 'Maximum');
        }
      }
    }
  }

  // Fallbacks de seguridad si no se usó el parser de bloques emparejados
  if (!activeTimeFormatted) {
    for (const line of lines) {
      if (/^\d{1,2}:\d{2}/.test(line) && line.includes('ow')) continue;
      const durMatch = line.match(/(?:workout time|active time)?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i);
      if (durMatch) {
        activeTimeFormatted = durMatch[1];
        activeDurationSec = parseTimeToSeconds(activeTimeFormatted);
        break;
      }
    }
  }

  return {
    wearableData: {
      source_device: 'Fitness Wearable Device',
      activity_type: activityType || 'INDOOR_RUN',
      metadata: {
        date: dateStr,
        start_time: startTimeStr,
        end_time: endTimeStr,
        location: location || 'Willemstad',
      },
      duration: {
        active_duration_seconds: activeDurationSec,
        elapsed_duration_seconds: elapsedDurationSec,
        active_time_formatted: activeTimeFormatted,
        elapsed_time_formatted: elapsedTimeFormatted,
      },
      distance: {
        value: distanceVal,
        unit: distanceUnit || 'KM',
      },
      metrics: {
        active_calories: activeCal !== undefined ? { value: activeCal, unit: 'CAL' } : undefined,
        total_calories: totalCal !== undefined ? { value: totalCal, unit: 'CAL' } : undefined,
        average_cadence: avgCadence !== undefined ? { value: avgCadence, unit: 'SPM' } : undefined,
        average_pace: avgPaceRaw ? { raw_value: avgPaceRaw, unit: 'min/km', seconds_per_km: secondsPerKm } : undefined,
        average_heart_rate: avgHr !== undefined ? { value: avgHr, unit: 'BPM' } : undefined,
      },
      subjective_feedback: effortScore !== undefined ? {
        effort_score: effortScore,
        effort_label: effortLabel,
      } : undefined,
    },
  };
}

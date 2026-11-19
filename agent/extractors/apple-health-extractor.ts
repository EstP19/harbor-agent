import type { StructuredObservation } from './radiology-extractor.ts';

export interface AppleHealthChartDataPoint {
  label: string;
  value: number;
}

export interface AppleHealthPassiveBiometrics {
  metric: string;
  metric_category?: string;
  aggregation: {
    selected_view: 'D' | 'W' | 'M' | '6M' | 'Y' | string;
    period: string;
    period_display: string;
  };
  summary: {
    type: 'AVERAGE' | 'LATEST' | 'TOTAL' | string;
    value: number;
    unit: string;
    trend: 'NONE' | 'INCREASING' | 'DECREASING' | string;
  };
  chart_context: {
    y_axis_range: {
      min: number;
      max: number;
    };
    key_observations: {
      lowest_approx_value: number;
      highest_approx_value: number;
    };
  };
  chart_data_points?: AppleHealthChartDataPoint[];
}

export function extractAppleHealthLocally(text: string): {
  appleHealthData: AppleHealthPassiveBiometrics;
} {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let metric = 'RESTING_HEART_RATE';
  let metricCategory = 'Cardiovascular / Heart';
  let selectedView = 'M';
  let periodDisplay = '';
  let period = '';
  let avgVal = 0;
  let unit = 'BPM';
  let trend = 'NONE';
  const extractedPoints: AppleHealthChartDataPoint[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const uppercaseLine = line.toUpperCase();

    // Ignorar horas del reloj del celular como "09:34 a" o "10:15"
    if (/^\d{1,2}:\d{2}/.test(line)) {
      continue;
    }

    if (/RESTING HEART RATE|FRECUENCIA CARDIACA EN REPOSO/i.test(line)) {
      metric = 'RESTING_HEART_RATE';
      metricCategory = 'Cardiovascular / Heart';
      unit = 'BPM';
    } else if (/HEART RATE VARIABILITY|HRV/i.test(line)) {
      metric = 'HEART_RATE_VARIABILITY';
      metricCategory = 'Cardiovascular / Heart';
      unit = 'MS';
    } else if (/VO2 MAX/i.test(line)) {
      metric = 'VO2_MAX';
      metricCategory = 'Cardio Fitness';
      unit = 'ML_KG_MIN';
    } else if (/SLEEP|SUEÑO/i.test(line)) {
      metric = 'SLEEP_ANALYSIS';
      metricCategory = 'Sleep / Recovery';
      unit = 'HOURS';
    }

    const monthMatch = line.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{4}/i);
    if (monthMatch) {
      periodDisplay = monthMatch[0];
    }

    // Buscar palabra clave AVERAGE / PROMEDIO
    if (uppercaseLine.includes('AVERAGE') || uppercaseLine.includes('PROMEDIO') || uppercaseLine.includes('AVG')) {
      // 1. Probar en la misma línea
      const avgMatch = line.match(/(?:AVERAGE|PROMEDIO|AVG)\s*(\d{2,3})/i);
      if (avgMatch && avgMatch[1]) {
        const parsed = parseInt(avgMatch[1], 10);
        if (parsed >= 30 && parsed <= 220) {
          avgVal = parsed;
        }
      }

      // 2. Si AVERAGE está en su propia línea, revisar las siguientes 2 líneas
      if (avgVal === 0) {
        for (let j = 1; j <= 2 && i + j < lines.length; j++) {
          const nextLine = lines[i + j];
          const nextNumMatch = nextLine.match(/^(\d{2,3})/);
          if (nextNumMatch && nextNumMatch[1]) {
            const parsedNext = parseInt(nextNumMatch[1], 10);
            if (parsedNext >= 30 && parsedNext <= 220) {
              avgVal = parsedNext;
              break;
            }
          }
        }
      }
    }

    if (/TREND NONE|TREND: NONE/i.test(line) || /TREND NONE/i.test(uppercaseLine)) {
      trend = 'NONE';
    } else if (/INCREASING/i.test(line)) {
      trend = 'INCREASING';
    } else if (/DECREASING/i.test(line)) {
      trend = 'DECREASING';
    }
  }

  // Fallback si avgVal sigue en 0: Buscar el primer número entre 30 y 220 descartando horas
  if (avgVal === 0) {
    for (const line of lines) {
      if (/^\d{1,2}:\d{2}/.test(line)) continue;
      const numMatch = line.match(/\b(\d{2,3})\b/);
      if (numMatch) {
        const val = parseInt(numMatch[1], 10);
        if (val >= 30 && val <= 220) {
          avgVal = val;
          break;
        }
      }
    }
  }

  const pointValues = extractedPoints.map(p => p.value);
  const lowestApprox = pointValues.length > 0 ? Math.min(...pointValues) : (avgVal > 0 ? avgVal : 0);
  const highestApprox = pointValues.length > 0 ? Math.max(...pointValues) : (avgVal > 0 ? avgVal : 0);
  const minY = Math.max(0, lowestApprox > 10 ? lowestApprox - 10 : 0);
  const maxY = highestApprox + 10;

  return {
    appleHealthData: {
      metric,
      metric_category: metricCategory,
      aggregation: {
        selected_view: selectedView,
        period,
        period_display: periodDisplay || 'Jul 2026',
      },
      summary: {
        type: 'AVERAGE',
        value: avgVal,
        unit,
        trend,
      },
      chart_context: {
        y_axis_range: {
          min: minY,
          max: maxY,
        },
        key_observations: {
          lowest_approx_value: lowestApprox,
          highest_approx_value: highestApprox,
        },
      },
      chart_data_points: extractedPoints,
    },
  };
}

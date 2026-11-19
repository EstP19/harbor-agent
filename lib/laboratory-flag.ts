/** Canonical laboratory flags, independent of UI language and clinical target notices. */
export function normalizeLaboratoryFlag(value:unknown):'NORMAL'|'HIGH'|'LOW'|'ABNORMAL'|null {
  if(typeof value!=='string'||value.length>64)return null;
  const flag=value.normalize('NFD').replace(/\p{M}/gu,'').trim().replace(/\s+/g,' ').toUpperCase();
  if(['N','NORMAL','NORMAAL','NORMALE','BINNEN NORMAALWAARDEN','WITHIN RANGE','NL'].includes(flag))return 'NORMAL';
  if(['H','HIGH','HOOG','VERHOOGD','↑','ALTO','ALTA','ELEVADO','ELEVADA','ELEVE','ELEVEE','HOCH','ERHOHT','ALTU'].includes(flag))return 'HIGH';
  if(['L','LOW','LAAG','VERLAAGD','↓','BAJO','BAJA','BAS','BASSE','NIEDRIG','BAIXO','BAIXA','ABOU'].includes(flag))return 'LOW';
  if(['A','ABNORMAL','ABNORMAAL','ANORMAL','ANOMAL','CRITICAL','KRITIEK','CRITICO','CRITICA','*'].includes(flag))return 'ABNORMAL';
  return null;
}

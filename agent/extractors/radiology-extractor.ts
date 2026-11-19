export interface RadiologyMetadata {
  patient_side?: 'RIGHT' | 'LEFT' | 'BILATERAL' | 'UNSPECIFIED';
  anatomical_region?: string;
  procedures?: Array<{
    modality: string;
    description: string;
    datetime?: string;
  }>;
}

export interface RadiologyFindingKeyMeasurement {
  finding: string;
  measurement?: string;
  modality?: string;
}

export interface RadiologyExtractionResult {
  rawText?: string;
  sections?: Array<{id:string;title:string;text:string;page?:number}>;
  extractionComplete?: boolean;
  metadata: RadiologyMetadata;
  findings_key_measurements: RadiologyFindingKeyMeasurement[];
  impression: string[];
}

export interface StructuredObservation {
  conceptCode?: string;
  literalMarker: string;
  numericValue?: number;
  unitCode?: string;
  literalUnit?: string;
  printedFlag?: 'NORMAL' | 'HIGH' | 'LOW' | 'ABNORMAL';
  lowerBound?: number;
  upperBound?: number;
  rangeText?: string;
  confidence: number;
}

export function extractRadiologyLocally(text:string):{radiologyData:RadiologyExtractionResult;observations:StructuredObservation[]} {
  const sections=radiologySections(text);
  const procedures=[...text.matchAll(/^(?:Procedure details\s*-\s*)?(XR|US|CT|MRI|MR|DX|X-RAY)\s+([^\r\n]+)/gim)].map(match=>({modality:match[1].toUpperCase(),description:match[0]}));
  const findings=sections.filter(section=>/^(findings|bevindingen|hallazgos)/i.test(section.title.trim()));
  const impressions=sections.filter(section=>/^(impression|conclusion|conclusie|conclusi[oó]n)/i.test(section.title.trim()));
  return {radiologyData:{rawText:text,sections,extractionComplete:Boolean(text.trim()),metadata:{procedures},
    findings_key_measurements:findings.map(section=>({finding:section.text})),
    impression:impressions.map(section=>section.text)},observations:[]};
}

export function radiologySections(text:string) {
  const sections:Array<{id:string;title:string;text:string;page?:number}>=[];
  let title='';let content:string[]=[];let page:number|undefined;
  const flush=()=>{if(content.some(line=>line.trim()))sections.push({id:`section-${sections.length+1}`,title,text:content.join('\n'),...(page?{page}: {})});content=[];};
  for(const line of text.split(/\r?\n/)) {
    const pageMatch=line.match(/^--- Página (\d+) ---$/);
    if(pageMatch){flush();page=Number(pageMatch[1]);continue;}
    if(/^(?:procedure details\b.*|findings(?:\s*-\s*all studies)?\s*:?[ \t]*|impression\s*:|conclusion\s*:|conclusie\s*:|bevindingen\s*:|hallazgos\s*:|conclusi[oó]n\s*:|technique\s*:|techniek\s*:|t[eé]cnica\s*:|comparison\s*:|vergelijking\s*:|comparaci[oó]n\s*:|indication\s*:|indicatie\s*:|indicaci[oó]n\s*:|recommendations\s*:|advies\s*:|recomendaciones\s*:)/i.test(line.trim())){flush();title=line;content.push(line);}else content.push(line);
  }
  flush();return sections;
}

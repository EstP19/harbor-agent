import assert from 'node:assert/strict';
import test from 'node:test';
import {extractLaboratoryLocally} from '../agent/extractors/laboratory-extractor.ts';
import ocrTool from '../agent/tools/ocr-tool.ts';

const labels=[['Prueba','Resultado','Rango de referencia'],['Test','Result','Reference range'],['Bepaling','Uitslag','Referentiewaarden'],['Analyse','Résultat','Référence'],['Untersuchung','Ergebnis','Referenzbereich'],['Exame','Resultado','Intervalo de referência'],['Prueba','Resultado','Rango di referensia']];
test('seven Harbor languages: labelled results preserve marker, value, units and printed range',()=>{
  for(const [marker,result,reference] of labels){
    const parsed=extractLaboratoryLocally(`${marker}: HbA1c\n${result}: 35 mmol/mol\n${reference}: 20 - 42 mmol/mol`);
    assert.equal(parsed.observations.length,1,marker);assert.equal(parsed.observations[0].literalMarker,'HbA1c');assert.equal(parsed.observations[0].numericValue,35);assert.equal(parsed.observations[0].literalUnit,'mmol/mol');assert.equal(parsed.observations[0].lowerBound,20);assert.equal(parsed.observations[0].upperBound,42);
  }
});
test('labels and conflicting blocks never become invented laboratory markers or exact values',()=>{
  for(const text of ['Uitslag: 35 mmol/mol\nReferentiewaarden: 20 - 42 mmol/mol','Bepaling: HbA1c\nUitslag: 35 mmol/mol\nUitslag: 99 mmol/mol','Bepaling: HbA1c\nUitslag: 35 mmol/mol\nEenheid: %'])assert.equal(extractLaboratoryLocally(text).observations.length,0,text);
  const original=extractLaboratoryLocally('HbA1c 35 mmol/mol 20 - 42');assert.equal(original.observations[0].literalMarker,'HbA1c');
  const printed=extractLaboratoryLocally('Bepaling: HbA1c\nUitslag: 35 mmol/mol\nReferentiewaarden: 20 - 42 mmol/mol\nFlag: HIGH');assert.equal(printed.observations[0].printedFlag,'HIGH');
});
test('OCR model timeout reaches the local labelled parser instead of waiting for the full worker deadline',async()=>{
  const oldFetch=globalThis.fetch,oldTimeout=AbortSignal.timeout,gemini=process.env.GEMINI_API_KEY,openai=process.env.OPENAI_API_KEY;
  let budget=0;
  try{
    process.env.GEMINI_API_KEY='qa-key-not-real-2026';delete process.env.OPENAI_API_KEY;
    AbortSignal.timeout=(milliseconds:number)=>{budget=milliseconds;return oldTimeout(1);};
    globalThis.fetch=async(_input,options)=>new Promise((_resolve,reject)=>{const signal=options?.signal;if(signal?.aborted)reject(Error('aborted'));else signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});setTimeout(()=>{},5);});
    const result=await ocrTool.execute({documentContent:'Bepaling: HbA1c\nUitslag: 35 mmol/mol\nReferentiewaarden: 20 - 42 mmol/mol',documentType:'laboratory',mimeType:'text/plain'});
    assert.equal(budget,45_000);assert.equal(result.observations[0].literalMarker,'HbA1c');assert.equal(result.observations[0].numericValue,35);
  }finally{globalThis.fetch=oldFetch;AbortSignal.timeout=oldTimeout;if(gemini===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=gemini;if(openai===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=openai;}
});

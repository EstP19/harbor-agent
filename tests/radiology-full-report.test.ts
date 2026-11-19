import assert from 'node:assert/strict';
import test from 'node:test';
import {extractRadiologyLocally} from '../agent/extractors/radiology-extractor.ts';
import {extractRadiologyText} from '../agent/extractors/radiology-text-extractor.ts';
import {handleRadiologyReportHttp} from '../agent/capabilities/health-radiology-report/handler.ts';
const text='Procedure details - XR KNEE RT\nXR KNEE RT\nProcedure details - US SOFT TISSUE\nUS SOFT TISSUE\nFINDINGS:\nNo fracture. Calcifications 14 × 5.8 mm and 5.3 mm.\nIMPRESSION:\nSmall joint effusion.';
test('radiology retains all text, procedures, normal prose and multiple dimensions without lab flags',async()=>{
 const result=extractRadiologyLocally(text);assert.equal(result.radiologyData.rawText,text);assert.deepEqual(result.observations,[]);assert(result.radiologyData.sections?.some(s=>s.text.includes('No fracture.')));assert(result.radiologyData.sections?.some(s=>s.text.includes('14 × 5.8 mm and 5.3 mm')));
 const long=text.replace('FINDINGS:',`FINDINGS:\n${'Preserved morphology. '.repeat(1900)}`);const full=await extractRadiologyText({documentContent:long,mimeType:'text/plain'});assert.equal(full.extractedText,long);assert(full.radiologyData.sections?.at(-1)?.text.includes('Small joint effusion.'));assert(long.length>35000);
});
test('retired report synthesis cannot invoke a completion or return generated text',async()=>{
 const unauthorized=await handleRadiologyReportHttp({payload:{},serviceToken:'secret'});assert.equal(unauthorized.statusCode,401);
 const retired=await handleRadiologyReportHttp({payload:{},authorization:'Bearer secret',serviceToken:'secret'});assert.equal(retired.statusCode,410);assert.equal(retired.body.code,'RADIOLOGY_REPORT_DETERMINISTIC_ONLY');
});

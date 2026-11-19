import {verifyHealthServiceAuthorization} from '../health-detailed-explanation/service-auth.ts';
/** Retired: complete report explanations are assembled in Health from exact
 * approved KB texts. This boundary cannot accept completions or generate prose. */
export async function handleRadiologyReportHttp(input:{authorization?:string;serviceToken?:string;payload?:unknown}) {
 if(!verifyHealthServiceAuthorization(input.authorization,input.serviceToken))return {statusCode:401,body:{ok:false,code:'UNAUTHORIZED'}};
 return {statusCode:410,body:{ok:false,code:'RADIOLOGY_REPORT_DETERMINISTIC_ONLY'}};
}

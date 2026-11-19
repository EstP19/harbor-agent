import { createCanvas } from '@napi-rs/canvas';

export function scannedFunctionalImage(page = 1) {
  const canvas = createCanvas(1600, 1900);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111'; context.font = '42px Arial';
  const lines = page === 1 ? [
    'HARBOR HEALTH - SYNTHETIC OCR TEST',
    'SPIROMETRIE - GEEN ECHTE PATIENT',
    'FEV1: 3.20 L', 'FVC: 4.10 L', 'Verhouding: 0.78',
    'HARBOR SCAN PAGE ONE',
  ] : [
    'HARBOR HEALTH - SYNTHETIC OCR TEST',
    'FUNCTIONAL REPORT - PAGE TWO',
    'Peak flow: 450 L/min', 'Calidad de la prueba: aceptable',
    'This is software test data, not a real patient.',
    'HARBOR SCAN PAGE TWO',
  ];
  lines.forEach((line, index) => context.fillText(line, 85, 140 + index * 110));
  return canvas.toBuffer('image/jpeg');
}

/** Image-only pages: no font, text operator or hidden searchable text in the PDF. */
export function scannedFunctionalPdf() {
  return imageOnlyPdf([1, 2].map(page => ({ data: scannedFunctionalImage(page), width: 1600, height: 1900 })));
}

function imageOnlyPdf(images: Array<{ data: Buffer; width: number; height: number }>) {
  const objects: Buffer[] = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from(`<< /Type /Pages /Kids [${images.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] /Count ${images.length} >>`)];
  for (const [index, image] of images.entries()) {
    const number = 3 + index * 3;
    const height = Math.round(612 * image.height / image.width);
    const content = `q 612 0 0 ${height} 0 0 cm /Scan Do Q`;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${height}] /Resources << /XObject << /Scan ${number + 1} 0 R >> >> /Contents ${number + 2} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.data.length} >>\nstream\n`), image.data, Buffer.from('\nendstream')]));
    objects.push(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  }
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]; const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(parts.reduce((length, part) => length + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n'));
  }
  const start = parts.reduce((length, part) => length + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`));
  return Buffer.concat(parts);
}

export const harborLanguageSamples = [
  ['es', 'Resultado de la prueba funcional: capacidad respiratoria.'],
  ['en', 'Functional test result: respiratory capacity.'],
  ['nl', 'Uitslag van het functieonderzoek: ademhalingscapaciteit.'],
  ['fr', 'Résultat de l’examen fonctionnel : capacité respiratoire.'],
  ['de', 'Ergebnis der Funktionsprüfung: Atemkapazität.'],
  ['pt', 'Resultado do exame funcional: capacidade respiratória.'],
  ['pap', 'E resultado di e prueba funshonal. Konsultá bo dòkter.'],
] as const;

export function harborLanguagesImage() {
  const canvas = createCanvas(1800, 1500); const context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111'; context.font = '38px Arial';
  context.fillText('HARBOR HEALTH - SYNTHETIC MULTILINGUAL OCR TEST', 70, 100);
  harborLanguageSamples.forEach(([code, text], index) => context.fillText(`${code.toUpperCase()}: ${text}`, 70, 240 + index * 140));
  return canvas.toBuffer('image/jpeg');
}

export function harborLanguagesPdf() {
  return imageOnlyPdf([{ data: harborLanguagesImage(), width: 1800, height: 1500 }]);
}

export function productionScannedFunctionalPdf() {
  return imageOnlyPdf([
    ...[1, 2].map(page => ({ data: scannedFunctionalImage(page), width: 1600, height: 1900 })),
    { data: harborLanguagesImage(), width: 1800, height: 1500 },
  ]);
}

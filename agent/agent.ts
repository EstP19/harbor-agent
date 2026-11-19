// Polyfills para compatibilidad con Node.js / Vercel Serverless
if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = class DOMMatrix {};
}
if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {};
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class Path2D {};
}

import { defineAgent, defineDynamic } from "eve";

import { resolveModelForStep } from "./model.ts";

export default defineAgent({
  model: defineDynamic({
    events: {
      "step.started": () => resolveModelForStep(),
    },
  }),
  reasoning: "medium",
  build: {
    externalDependencies: [
      'tesseract.js', 'tesseract.js-core',
      '@tesseract.js-data/eng', '@tesseract.js-data/nld', '@tesseract.js-data/spa',
      '@tesseract.js-data/fra', '@tesseract.js-data/deu', '@tesseract.js-data/por',
    ],
  },
});

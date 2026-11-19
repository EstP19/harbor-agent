# Synthetic OCR fixture

`multilingual-functional.jpg` contains only the seven artificial language samples in `helpers/scanned-functional-fixture.ts`. It contains no patient data. It was rendered at 1800 × 1500 pixels with 38px Arial on Windows.

The raster is committed so every OS tests OCR against the exact same pixels. Regenerating it through system font substitution changes diacritics and would test different input images on different machines. The image-only PDF fixture embeds this same JPEG without a hidden text layer.

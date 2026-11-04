import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
const { calibrate, isSimpleOutline, measurementValue, measurementLabel, exportMeasurements } = await server.ssrLoadModule('/src/measurements.ts');
const scale = calibrate([0, 0], [72, 0], 12, 'ft');
const mark = (kind, points) => ({ id: 'test', page: 0, kind, points, scale });
assert.equal(measurementValue(mark('Length', [[0, 0], [216, 288]])), 60);
const rectangle = [[100, 200], [172, 200], [172, 236], [100, 236]];
assert.equal(measurementValue(mark('Area', rectangle)), 72);
assert.equal(measurementValue(mark('Area', rectangle.toReversed())), 72);
assert.equal(measurementValue(mark('Perimeter', rectangle)), 36);
assert.equal(measurementValue(mark('Count', rectangle)), 4);
assert.equal(measurementLabel(mark('Area', rectangle)), '72.00 ft²');
for (const length of [0, -1, NaN, Infinity]) assert.throws(() => calibrate([0, 0], [72, 0], length, 'ft'));
assert.throws(() => calibrate([2, 2], [2, 2], 10, 'm'));
// Rotating or translating PDF coordinates must not alter takeoff values.
assert.equal(measurementValue(mark('Area', rectangle.map(([x, y]) => [-y + 1000, x - 500]))), 72);
assert.equal(isSimpleOutline(rectangle), true);
assert.equal(isSimpleOutline([[0, 0], [10, 10], [0, 10], [10, 0]]), false);
assert.equal(isSimpleOutline([[0, 0], [10, 0], [10, 10], [5, 5], [0, 10]]), true);
const doc = await PDFDocument.create();
doc.addPage([400, 400]); doc.addPage([400, 400]);
const bytes = await doc.save();
const exported = await exportMeasurements(bytes, [mark('Area', rectangle), mark('Count', rectangle)], [2, 1]);
const loaded = await PDFDocument.load(exported);
assert.equal(loaded.getPageCount(), 2);
assert.equal(loaded.getPage(0).node.Contents(), undefined);
assert.equal(loaded.getPage(1).node.Annots().size(), 2, 'editable marks follow their source page when reordered');
console.log('ok  calibration, length, area, perimeter, counts, transforms and PDF export');

} finally { await server.close(); }

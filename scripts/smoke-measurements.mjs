import assert from 'node:assert/strict';
export async function checkMeasurements(page) {
  await page.getByRole('button', { name: 'Measure', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Drawing measurements' });
  await panel.waitFor();
  await panel.getByLabel('Snap to drawing endpoints').uncheck();
  const overlay = page.locator('.measurement-overlay.measuring').first();
  const box = await overlay.boundingBox();
  const x = box.x + 40, y = Math.max(box.y + 60, 150);
  await page.mouse.click(x, y);
  await page.mouse.click(x + 100, y);
  await page.waitForFunction(() => document.querySelector('[aria-label="Measurement tool"]').value === 'Length');
  await page.mouse.click(x, y + 30);
  await page.mouse.click(x + 100, y + 30);
  await panel.getByRole('button', { name: 'Length · p. 1 · 10.00 ft', exact: true }).waitFor();
  await panel.getByLabel('Measurement tool').selectOption('Area');
  for (const [dx, dy] of [[0, 0], [100, 0], [100, 50], [0, 50]]) await page.mouse.click(x + dx, y + 60 + dy);
  await panel.getByRole('button', { name: 'Finish', exact: true }).click();
  const area = panel.getByRole('button', { name: /^Area · p. 1 ·/ });
  await area.waitFor();
  assert.ok(Math.abs(Number((await area.innerText()).match(/· ([\d.]+) ft/)[1]) - 50) < 0.05, 'area agrees with the calibrated rectangle within pointer rounding');
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('folio'); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const rows = await new Promise(resolve => { const r = db.transaction('notes').objectStore('notes').getAll(); r.onsuccess = () => resolve(r.result); });
    db.close();
    return rows.some(row => row.drawing?.measurements.length === 2);
  });
  for (let i = 0; i < 4; i++) await page.getByTitle('Rotate (R)').click();
  await overlay.locator('text').nth(1).waitFor();
  assert.equal(await overlay.locator('text').count(), 2);
  await page.screenshot({ path: 'release/smoke/measurements.png' });
  await panel.getByRole('button', { name: 'Delete Length measurement' }).click();
  await panel.getByRole('button', { name: 'Delete Area measurement' }).click();
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  console.log('ok  drawing calibration, measurement labels, persistence and removal');
}

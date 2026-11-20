// Browser test of the beginner tools: Pinout tab, step pin list, 3D pin tags
// and the Ask Wiremap assistant. Skips when Playwright/Chromium is missing.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer } from '../viewer/serve.mjs';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional */ }

test('Ask Wiremap answers beginner requests and zooms to the pins', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async (t) => {
  const server = await startServer({ port: 0, projectsDir: fileURLToPath(new URL('../projects', import.meta.url)) });
  let browser;
  try { browser = await chromium.launch(); } catch (e) { await server.close(); t.skip(`chromium unavailable: ${e.message}`); return; }
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(new URL('/#/p/rover', server.url).href);
  await page.waitForSelector('.companion');

  const ask = async (q) => {
    await page.locator('input.cmp-input').fill(q);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(900);
    return (await page.locator('.cmp-msg.bot p').allInnerTexts()).at(-1);
  };
  if (await page.locator('.cmp-panel').isHidden()) await page.locator('.cmp-orb').click();

  const connect = await ask('how do I connect the motor to the esp32');
  assert.match(connect, /TT gear motor connects to the ESP32 through the TB6612FNG/);
  assert.ok(await page.locator('.scene-label.pin').count() > 4, 'pin name tags shown in 3D');
  assert.equal(await page.getByRole('tab', { name: '3D' }).getAttribute('aria-selected'), 'true');

  assert.match(await ask('what is GND'), /return path/);
  assert.match(await ask('where does STBY go'), /pin STBY goes to ESP32 DevKit V1 pin D23/);
  assert.match(await ask('my left motor is not spinning'), /driven by TB6612FNG pins A01, A02/);
  assert.doesNotMatch(await ask('my left motor is not spinning'), /Right TT/);
  await ask('go to pinout');
  assert.equal(await page.getByRole('tab', { name: 'Pinout' }).getAttribute('aria-selected'), 'true');
  assert.ok(await page.locator('.pinout-card').count() >= 5);
  assert.ok(await page.locator('.pinout-dest').count() > 5, 'wired pins show where they go');
  assert.match(await ask('what projects do I have'), /You have \d+ projects?/);
  assert.deepEqual(errors, []);
});

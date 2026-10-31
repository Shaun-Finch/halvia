// End-to-end check of Halvia bot's offline AI in real Chrome (WebGPU on SwiftShader).
// Downloads the model, asks a question, goes offline, reloads and asks again.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:8080';
const MODEL = process.env.MODEL || 'pocket';
const OUT = 'e2e';
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const say = (...a) => { const l = `[${new Date().toISOString().slice(11, 19)}] ` + a.join(' '); console.log(l); log.push(l); };
const FLAGSETS = [
  ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist'],
  ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
  ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
];
async function waitAi(page, states, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await page.getAttribute('#aiPill', 'data-s').catch(() => '');
    if (states.includes(s)) return s;
    if ((Date.now() - t0) % 30000 < 2000) say('  AI:', s, '|', (await page.textContent('#aiPillText').catch(() => '')), '|', (await page.textContent('#progText').catch(() => '')).slice(0, 140));
    await page.waitForTimeout(2000);
  }
  return 'timeout';
}
async function askAndWait(page, q, ms) {
  const n = await page.$$eval('.msg.bot', e => e.length);
  await page.fill('#composerIn', q); await page.press('#composerIn', 'Enter');
  const t0 = Date.now();
  await page.waitForFunction(k => document.querySelectorAll('.msg.bot').length > k, n, { timeout: 30000 });
  while (Date.now() - t0 < ms) {
    const busy = await page.$eval('#send', b => b.classList.contains('stop'));
    if (!busy) break;
    await page.waitForTimeout(2000);
  }
  if (await page.$eval('#send', b => b.classList.contains('stop'))) { say('  stopping long answer'); await page.click('#send'); await page.waitForTimeout(3000); }
  const last = await page.$$eval('.msg.bot', e => { const m = e[e.length - 1]; return { body: m.querySelector('.body').innerText, tag: (m.querySelector('.meta .tag') || {}).textContent || '' }; });
  say(`  answered in ${((Date.now() - t0) / 1000).toFixed(0)}s [${last.tag}]`);
  return last;
}
(async () => {
  let browser, page, ctx, adapter;
  for (const args of FLAGSETS) {
    browser = await chromium.launch({ channel: 'chrome', headless: true, args });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();
    await page.goto(BASE + '/bot/');
    adapter = await page.evaluate(async () => { try { const a = await navigator.gpu?.requestAdapter(); if (!a) return null; return { f16: a.features.has('shader-f16'), info: a.info ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}` : '' }; } catch (e) { return 'err ' + e.message; } });
    say('Flags', args.join(' '), '=> adapter', JSON.stringify(adapter));
    if (adapter && typeof adapter === 'object') break;
    await browser.close();
  }
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) say('  console.' + m.type(), m.text().slice(0, 300)); });
  page.on('pageerror', e => say('  pageerror', e.message));
  await page.waitForTimeout(2500);
  say('Library count:', await page.textContent('#libCount'), '| AI pill:', await page.textContent('#aiPillText'));

  // 1. Library answer before any download
  const lib = await askAndWait(page, 'What NEWS2 score needs an emergency response?', 20000);
  say('Library answer:', lib.body.slice(0, 300).replace(/\n+/g, ' / '));

  // 2. Get ready for offline with the chosen model
  await page.click('#openSet'); await page.waitForTimeout(500);
  await page.check(`input[name="model"][value="${MODEL}"]`); await page.waitForTimeout(300);
  await page.click('#readyBtn');
  const st = await waitAi(page, ['ready', 'error'], 45 * 60000);
  say('Model state after download:', st, '|', await page.textContent('#progText').catch(() => ''));
  await page.waitForTimeout(3000);
  say('Readiness:', (await page.innerText('#readyList')).replace(/\n+/g, ' | '));
  await page.screenshot({ path: OUT + '/1-ready.png' });
  await page.keyboard.press('Escape');

  if (st === 'ready') {
    await page.click('#newChat');
    const a1 = await askAndWait(page, 'What NEWS2 score needs an emergency response?', 15 * 60000);
    say('ONLINE AI answer:', a1.body.slice(0, 600).replace(/\n+/g, ' / '));
    await page.screenshot({ path: OUT + '/2-online-answer.png' });
  }

  // 3. Offline: reload, the app and model must come from this device
  await ctx.setOffline(true);
  say('--- OFFLINE ---');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(e => say('reload failed', e.message));
  await page.waitForTimeout(3000);
  say('Offline title:', await page.title(), '| net:', await page.textContent('#netPill').catch(() => 'n/a'));
  const st2 = await waitAi(page, ['ready', 'error', 'unsupported', 'none'], 20 * 60000);
  say('Offline model state:', st2, await page.textContent('#aiPillText').catch(() => ''));
  if (st2 !== 'ready') { const st3 = await waitAi(page, ['ready'], 10 * 60000); say('Offline model state (2nd wait):', st3); }
  const a2 = await askAndWait(page, 'What are the high-risk signs of sepsis in adults?', 15 * 60000);
  say('OFFLINE answer:', a2.body.slice(0, 600).replace(/\n+/g, ' / '));
  await page.screenshot({ path: OUT + '/3-offline-answer.png' });
  const p2 = await ctx.newPage();
  const r = await p2.goto(BASE + '/bot').then(() => p2.title()).catch(e => 'FAILED ' + e.message);
  say('Offline open of /bot (no slash):', r);
  await browser.close();
  fs.writeFileSync(OUT + '/result.md', '# Halvia bot offline end-to-end test\n\nModel: ' + MODEL + '\n\n```\n' + log.join('\n') + '\n```\n');
})().catch(e => { say('FATAL', e.stack); fs.writeFileSync(OUT + '/result.md', '```\n' + log.join('\n') + '\n```\n'); process.exit(0); });

import { webkit, devices } from 'playwright';
const b = await webkit.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'] });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + String(e).slice(0,400)));
p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE: ' + m.text().slice(0,300)); });
try {
  const resp = await p.goto('https://autopilot-solana.vercel.app/', { waitUntil:'load', timeout: 45000 });
  console.log('status:', resp?.status());
  await p.waitForTimeout(5000);
  const bodyText = (await p.locator('body').innerText()).slice(0,200);
  console.log('visible text:', JSON.stringify(bodyText));
  console.log('h1:', await p.locator('h1').count());
} catch (e) { console.log('NAV FAIL:', String(e).slice(0,300)); }
console.log(errs.slice(0,6).join('\n') || 'no errors');
await b.close();

/** Local browser-only simulation. Set BLOOM_PHASE1_DEMO=1 and serve the env-free copy on port 3103. */
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:3103/bloom-phase1';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
async function suite(viewport, colorScheme) {
 const context=await browser.newContext({viewport,colorScheme});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const external=[];page.on('request',r=>{if(new URL(r.url()).origin!=='http://127.0.0.1:3103') external.push(r.url());});
 const button=(name)=>page.getByRole('button',{name,exact:true});
 try {
  await page.goto(base); await page.getByText('Simulation only.').waitFor();
  await page.getByText('No active habits yet.').waitFor();
  const axe=await new AxeBuilder({page}).analyze(); assert.deepEqual(axe.violations.map(v=>v.id),[],'automated axe audit');
  await button('Add a habit').click();
  await page.getByLabel('Name',{exact:true}).fill('Read');
  await page.getByLabel('Description').fill('Quiet time');
  await button('Save habit').click(); await page.getByText('0 sessions today').waitFor();
  await button('Details').click(); await button('Set weekly session goal').click();
  await page.getByLabel('Sessions per week').fill('12'); await button('Confirm goal').click();
  await page.getByText('12 sessions per week',{exact:false}).first().waitFor();
  await button('Close details').click();
  await button('Start timer').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor();
  await button('Progress').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor(); await button('Today').click();
  await context.setOffline(true); await page.getByText('still running until a pause is confirmed',{exact:false}).waitFor(); assert.equal(await button('Pause').isDisabled(),true);
  await context.setOffline(false); await button('Pause').click(); await page.getByText('YOUR TIMER · PAUSED').waitFor();
  await page.reload(); await page.getByText('YOUR TIMER · PAUSED').waitFor();
  await button('Resume').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor();
  await button('Quick Log').click(); await page.getByLabel('Lagos completion date').fill('9999-12-31'); assert.equal(await page.getByLabel('Lagos completion date').evaluate(el=>el.validity.rangeOverflow),true); await page.getByLabel('Lagos completion date').fill('2026-01-02'); await page.getByLabel('Estimated minutes (optional)').fill('12'); await page.getByLabel('Note (optional)').fill('A past session'); await button('Save session').click();
  await button('Details').click(); await page.getByText('A past session').waitFor(); await page.getByText(/^Recorded /).waitFor();
  await button('Edit').click(); await page.getByLabel('Name',{exact:true}).fill('Read deeply'); await button('Save habit').click(); await page.getByText('known name: Read',{exact:false}).waitFor();
  await button('Set weekly session goal').click(); await page.getByLabel('No weekly target').check(); await button('Confirm goal').click(); await page.getByText('Scheduled from ',{exact:false}).filter({hasText:'No weekly target'}).waitFor();
  await button('Archive').click(); await button('Yes, archive').click(); await page.getByText('archived',{exact:false}).first().waitFor();
  await button('Complete').click(); await button('Progress').click(); await page.getByText('Weekly goal not confirmed',{exact:true}).waitFor(); await page.getByText('1 session · 1 active day',{exact:true}).waitFor();
  await button('Settings').click(); await page.getByLabel('Display name').fill('Tola'); await button('Save profile').click(); await page.getByText('Simulated profile saved',{exact:false}).waitFor(); await page.getByLabel('Theme').selectOption('dark'); await page.reload(); assert.equal(await page.getByLabel('Theme').count(),0); await button('Settings').click(); assert.equal(await page.getByLabel('Theme').inputValue(),'dark'); assert.equal(await page.getByLabel('Display name').inputValue(),'Tola');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');
  assert.deepEqual(external,[],'no network calls outside local app'); assert.deepEqual(errors,[],'no page errors');
  console.log(`PASS ${viewport.width}px ${colorScheme}: synthetic goal, lifecycle, offline, persistence, backdate, history, archive, reporting, theme, axe, no external calls`);
 } finally {await context.close();}
}
async function edgeCases() {
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 const button=(name)=>page.getByRole('button',{name,exact:true});
 try {
  await page.goto(base); await button('Add a habit').click(); await page.getByLabel('Name',{exact:true}).fill('Walk'); await button('Save habit').click(); await page.getByText('0 sessions today').waitFor();
  await button('Start timer').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor();
  const storage=await context.storageState(); const reopened=await browser.newContext({storageState:storage}); const second=await reopened.newPage(); await second.goto(base); await second.getByText('YOUR TIMER · RUNNING').waitFor(); await reopened.close();
  await page.evaluate(()=>{const k='bloom.phase1.mock.v1',s=JSON.parse(localStorage.getItem(k));s.segments.find(x=>x.ended_at===null).started_at=new Date(Date.now()-5*3600_000).toISOString();localStorage.setItem(k,JSON.stringify(s));});
  await page.reload(); await page.getByText('four hours or more',{exact:false}).waitFor(); await button('Continue timer').click(); assert.equal(await page.getByText('four hours or more',{exact:false}).count(),0);
  for (let i=0;i<2;i++) {await button('Quick Log').click();await button('Save session').click();await page.getByText(`${i+1} ${i ? 'sessions' : 'session'} today`,{exact:false}).waitFor();}
  await button('Cancel timer').click(); await button('Yes, cancel timer').click();
  await button('Progress').click(); await page.getByText('2 sessions · 1 active day',{exact:true}).waitFor(); await page.getByText('Unknown duration: 2',{exact:false}).waitFor();
  await page.evaluate(()=>{const k='bloom.phase1.mock.v1',s=JSON.parse(localStorage.getItem(k));s.goals.push({id:1,habit_id:s.habits[0].id,effective_week:null,goal_confirmed:true,weekly_session_target:9,recorded_at:new Date().toISOString()});localStorage.setItem(k,JSON.stringify(s));});
  await button('Refresh data').click(); await page.getByText('Goal schedule pending; counts remain available.').waitFor(); await page.getByText('2 sessions · 1 active day',{exact:true}).waitFor();
  console.log('PASS edge cases: four-hour continue, multiple daily logs, cancel exclusion, unknown duration, unresolved goal retains counts');
 } finally {await context.close();}
}
try {await suite({width:390,height:844},'dark');await suite({width:1440,height:900},'light');await edgeCases();}finally{await browser.close();}

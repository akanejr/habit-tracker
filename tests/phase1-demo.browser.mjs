/** Local browser-only simulation. Set BLOOM_PHASE1_DEMO=1 and serve the env-free copy on port 3103. */
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const base='http://127.0.0.1:3103/dashboard';
const seconds=clock=>{const [hours,minutes,secs]=clock.trim().split(':').map(Number);return hours*3600+minutes*60+secs;};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
async function suite(viewport, colorScheme) {
 const context=await browser.newContext({viewport,colorScheme});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const external=[];page.on('request',r=>{if(new URL(r.url()).origin!=='http://127.0.0.1:3103') external.push(r.url());});
 const button=(name)=>page.getByRole('button',{name,exact:true});
 const audit=async label=>{const results=await new AxeBuilder({page}).analyze();assert.deepEqual(results.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],`axe ${label}`);};
 try {
  await page.goto('http://127.0.0.1:3103/'); await page.getByRole('link',{name:'Explore simulated Bloom'}).click(); await page.getByText('Simulation only.').waitFor(); assert.equal(new URL(page.url()).pathname, '/dashboard');
  await page.getByText('Your space is ready.').waitFor();
  await audit('initial dashboard');
  await button('Add a habit').click();
  await page.getByLabel('Name',{exact:true}).fill('Read');
  await page.getByLabel('Description').fill('Quiet time');
  await button('Save habit').click(); await page.getByText('0 sessions today').waitFor();
  await button('Details').click(); assert.ok(new URL(page.url()).searchParams.get('habit')); await page.getByRole('heading',{name:'Read',exact:true,level:1}).waitFor(); await page.reload(); await page.getByRole('heading',{name:'Read',exact:true,level:1}).waitFor(); await button('Set weekly session goal').click();
  await page.getByLabel('Sessions per week').fill('12'); await button('Confirm goal').click();
  await page.getByText('Next confirmed change:',{exact:false}).waitFor(); await page.getByText('12 sessions per week',{exact:false}).first().waitFor();
  await button('Back to Today').click();
  await button('Start timer').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor();
  const activeCard=page.locator('.bloom-habit-card').filter({has:page.getByRole('heading',{name:'Read',exact:true})});
  assert.equal(await activeCard.getByRole('timer').count(),1,'one elapsed clock in the matching Today card');
  assert.equal(await activeCard.getByRole('button',{name:'Start timer',exact:true}).count(),0,'the active card replaces Start with timer state');
  for (const name of ['Pause','Complete','Cancel timer','Quick Log','Details']) assert.equal(await activeCard.getByRole('button',{name,exact:true}).isEnabled(),true,`${name} stays available on the active card`);
  assert.equal(await page.getByRole('timer').count(),1,'Today has one authoritative timer display');
  const firstElapsed=await page.getByRole('timer').textContent(); await page.waitForFunction(previous=>document.querySelector('[role="timer"]')?.textContent!==previous,firstElapsed,{timeout:4000});
  const beforeRunningRefresh=await page.getByRole('timer').textContent(); await page.reload(); await page.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await page.getByRole('timer').count(),1); assert.ok(seconds(await page.getByRole('timer').textContent())>=seconds(beforeRunningRefresh),'running elapsed time survives a page refresh');
  await button('Progress').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(new URL(page.url()).searchParams.get('view'),'progress'); assert.equal(await page.getByRole('timer').count(),1,'Progress reflects the same single active timer'); const progressElapsed=await page.getByRole('timer').textContent(); await page.goBack(); await page.getByRole('heading',{name:'Today’s habits'}).waitFor(); assert.equal(await page.getByRole('timer').count(),1,'browser back returns to the same timer'); assert.ok(seconds(await page.getByRole('timer').textContent())>=seconds(progressElapsed),'elapsed display does not move backwards on navigation'); await page.goForward(); await page.getByRole('heading',{name:'Progress'}).waitFor(); assert.ok(seconds(await page.getByRole('timer').textContent())>=seconds(progressElapsed),'elapsed display stays monotonic when returning to Progress'); await button('Today').click();
  await context.setOffline(true); await page.getByText('still running until a pause is confirmed',{exact:false}).waitFor(); assert.equal(await button('Pause').isDisabled(),true);
  await context.setOffline(false); await button('Pause').click(); await page.getByText('YOUR TIMER · PAUSED').waitFor();
  const pausedElapsed=await page.getByRole('timer').textContent(); await page.reload(); await page.getByText('YOUR TIMER · PAUSED').waitFor(); assert.equal(await page.getByRole('timer').textContent(),pausedElapsed,'a paused elapsed value survives refresh exactly');
  await button('Resume').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor();
  await button('Quick Log').click(); await page.getByLabel('Note (optional)').fill('Do not lose me'); await button('Pause').click(); assert.equal(await page.getByLabel('Note (optional)').inputValue(),'Do not lose me'); await button('Resume').click(); await page.getByLabel('Lagos completion date').fill('9999-12-31'); assert.equal(await page.getByLabel('Lagos completion date').evaluate(el=>el.validity.rangeOverflow),true); await page.getByLabel('Lagos completion date').fill('2026-01-02'); await page.getByLabel('Estimated minutes (optional)').fill('12'); await page.getByLabel('Note (optional)').fill('A past session'); await button('Save session').click();
  await button('Details').click(); await page.getByText('A past session').waitFor(); await page.getByText(/^Recorded /).waitFor(); await page.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await page.getByRole('timer').count(),1,'the habit detail view retains the same active timer'); assert.equal(await page.locator('.bloom-detail-page').getByRole('timer').count(),1,'the dedicated details screen contains the active timer'); assert.equal(await page.locator('.bloom-habit-card').count(),0,'details replaces the Today card list without duplicating timer UI');
  for (const name of ['Pause','Complete','Cancel timer','Quick Log','Edit Habit','Archive Habit']) assert.equal(await button(name).isEnabled(),true,`${name} remains available in Habit Details`); assert.equal(await button('Start Timer').isDisabled(),true,'a second timer is blocked from Habit Details');
  await audit('habit details'); await button('Quick Log').click(); await page.getByRole('heading',{name:'Quick Log · Read',exact:true}).waitFor(); await page.getByLabel('Lagos completion date').fill('2026-01-03'); await page.getByLabel('Note (optional)').fill('Logged from Habit Details'); await audit('Quick Log from Habit Details'); await button('Save session').click(); await page.getByText('Saved in this browser',{exact:false}).waitFor(); await page.getByText('Logged from Habit Details',{exact:true}).waitFor(); await page.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await page.getByRole('timer').count(),1,'Quick Log from Details leaves the shared timer running');
  assert.equal((await page.locator('.bloom-detail-stat').nth(0).locator('strong').textContent()).trim(),'2','all-time completed-session count'); assert.equal((await page.locator('.bloom-detail-stat').nth(1).locator('strong').textContent()).trim(),'2','distinct Lagos completion days'); assert.match(await page.locator('.bloom-detail-time-stat').innerText(),/Measured: none recorded · Estimated: 0:12:00 · Unknown duration: 1/,'details separates measured, estimated and unknown time');
  await button('Edit Habit').click(); await page.getByLabel('Name',{exact:true}).fill('Read deeply'); await button('Save habit').click(); await page.getByText('known name: Read',{exact:false}).first().waitFor();
  await button('Set weekly session goal').click(); await page.getByLabel('No weekly target').check(); await button('Confirm goal').click(); await page.getByText('Next confirmed change:',{exact:false}).filter({hasText:'No weekly target'}).waitFor();
  await button('Archive Habit').click(); await button('Yes, archive habit').click(); await page.getByText('archived',{exact:false}).first().waitFor();
  await button('Complete').click(); await button('Progress').click(); await page.getByText('Weekly goal not confirmed',{exact:true}).waitFor(); await page.getByText('1 session · 1 active day',{exact:true}).waitFor();
  await button('Settings').click(); await page.getByLabel('Display name').fill('Tola'); await button('Save profile').click(); await page.getByText('Simulated profile saved',{exact:false}).waitFor(); await page.getByLabel('Theme').selectOption('dark'); await page.reload(); await page.getByLabel('Theme').waitFor(); assert.equal(await page.getByLabel('Theme').inputValue(),'dark'); assert.equal(await page.getByLabel('Display name').inputValue(),'Tola');
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
  const originalElapsed=await page.getByRole('timer').textContent(); const storage=await context.storageState(); const reopened=await browser.newContext({storageState:storage}); const second=await reopened.newPage(); await second.goto(base); await second.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await second.getByRole('timer').count(),1,'reopening shows one timer, not a second session'); assert.ok(seconds(await second.getByRole('timer').textContent())>=seconds(originalElapsed),'reopened timer resumes from the persisted segment'); await reopened.close();
  await page.evaluate(()=>{const k='bloom.phase1.mock.v1',s=JSON.parse(localStorage.getItem(k));s.segments.find(x=>x.ended_at===null).started_at=new Date(Date.now()-5*3600_000).toISOString();localStorage.setItem(k,JSON.stringify(s));});
  await page.reload(); await page.getByText('four hours or more',{exact:false}).waitFor(); assert.equal(await page.getByText('YOUR TIMER · RUNNING').count(),1,'four hours does not auto-stop the timer'); assert.ok(seconds(await page.getByRole('timer').textContent())>=5*3600); assert.equal(await button('Pause').isEnabled(),true); await button('Continue timer').click(); assert.equal(await page.getByText('four hours or more',{exact:false}).count(),0); assert.equal(await page.getByText('YOUR TIMER · RUNNING').count(),1,'dismissing the warning leaves the same session running');
  for (let i=0;i<2;i++) {await button('Quick Log').click();await button('Save session').click();await page.getByText(`${i+1} ${i ? 'sessions' : 'session'} today`,{exact:false}).waitFor();}
  await button('Cancel timer').click(); await button('Yes, cancel timer').click();
  await button('Progress').click(); await page.getByText('2 sessions · 1 active day',{exact:true}).waitFor(); await page.getByText('Unknown duration: 2',{exact:false}).waitFor();
  await page.evaluate(()=>{const k='bloom.phase1.mock.v1',s=JSON.parse(localStorage.getItem(k));s.goals.push({id:1,habit_id:s.habits[0].id,effective_week:null,goal_confirmed:true,weekly_session_target:9,recorded_at:new Date().toISOString()});localStorage.setItem(k,JSON.stringify(s));});
  await button('Refresh data').click(); await page.getByText('Goal schedule pending; counts remain available.').waitFor(); await page.getByText('2 sessions · 1 active day',{exact:true}).waitFor();
  console.log('PASS edge cases: four-hour continue, multiple daily logs, cancel exclusion, unknown duration, unresolved goal retains counts');
 } finally {await context.close();}
}
async function browserClosureReopen() {
 const profile=await mkdtemp(join(tmpdir(),'bloom-phase1-profile-')); let context;
 const options={headless:true,viewport:{width:390,height:844},args:['--no-sandbox']};
 try {
  context=await chromium.launchPersistentContext(profile,options); let page=context.pages()[0]??await context.newPage();
  await page.goto(base); await page.getByRole('button',{name:'Add a habit',exact:true}).click(); await page.getByLabel('Name',{exact:true}).fill('Persistent timer'); await page.getByRole('button',{name:'Save habit',exact:true}).click(); await page.getByRole('button',{name:'Start timer',exact:true}).click(); await page.getByText('YOUR TIMER · RUNNING').waitFor(); const before=await page.getByRole('timer').textContent();
  await context.close(); context=null;
  context=await chromium.launchPersistentContext(profile,options); page=context.pages()[0]??await context.newPage(); await page.goto(base); await page.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await page.getByRole('timer').count(),1,'the persisted browser profile reopens one shared timer'); assert.ok(seconds(await page.getByRole('timer').textContent())>=seconds(before),'timer state survives closing and reopening the browser process');
  console.log('PASS persistent browser profile survives full Chromium close and reopen without starting a second timer');
 } finally {if(context) await context.close(); await rm(profile,{recursive:true,force:true});}
}
async function pausedDurationAndLagosMidnight() {
 const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'dark'}),page=await context.newPage();
 const button=(name)=>page.getByRole('button',{name,exact:true});
 try {
  await page.clock.install({time:new Date('2026-11-22T22:59:30.000Z')}); await page.goto(base);
  await button('Add a habit').click(); await page.getByLabel('Name',{exact:true}).fill('Midnight walk'); await button('Save habit').click();
  await button('Details').click(); await page.getByRole('heading',{name:'Midnight walk',exact:true,level:1}).waitFor(); await button('Set weekly session goal').click(); await page.getByLabel('Sessions per week').fill('1'); await button('Confirm goal').click(); await page.getByText('Next confirmed change:',{exact:false}).filter({hasText:'1 session per week'}).waitFor(); await button('Back to Today').click();
  await button('Start timer').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor();
  await page.clock.fastForward(10_000); await button('Pause').click(); await page.getByText('YOUR TIMER · PAUSED').waitFor(); const paused=await page.getByRole('timer').textContent(); assert.equal(seconds(paused),10,'first active segment is displayed');
  await page.clock.fastForward(60_000); assert.equal(await page.getByRole('timer').textContent(),paused,'paused wall time is excluded from the elapsed timer');
  await button('Resume').click(); await page.getByText('YOUR TIMER · RUNNING').waitFor(); await page.clock.fastForward(5_000); await button('Complete').click();
  await page.getByText('1 session today',{exact:false}).waitFor(); await button('Details').click(); await page.getByRole('heading',{name:'Midnight walk',exact:true,level:1}).waitFor();
  await page.getByText('2026-11-23',{exact:true}).waitFor(); await page.getByText('0:00:15 measured',{exact:false}).waitFor(); await page.getByText('This week: 1 completed session · 1 active day.',{exact:true}).waitFor(); await page.getByText('Weekly target: 1 completed session.',{exact:true}).waitFor(); assert.equal(await page.getByRole('progressbar',{name:'Weekly session goal for Midnight walk'}).getAttribute('aria-valuenow'),'1','goal progress reflects the completed session in the effective Lagos week'); assert.equal((await page.locator('.bloom-detail-stat').nth(0).locator('strong').textContent()).trim(),'1'); assert.equal((await page.locator('.bloom-detail-stat').nth(1).locator('strong').textContent()).trim(),'1'); assert.match(await page.locator('.bloom-detail-time-stat').innerText(),/Measured: 0:00:15 · Estimated: none recorded · Unknown duration: 0/); await page.locator('.bloom-detail-history').getByText('0:00:15 measured',{exact:false}).waitFor();
  console.log('PASS fake-clock edge: detail metrics and 1/1 weekly goal; 10s + 5s active segments exclude 60s paused; completion at Lagos 00:00:45 is attributed to Monday 2026-11-23');
 } finally {await context.close();}
}
try {await suite({width:390,height:844},'dark');await suite({width:1440,height:900},'light');await edgeCases();await browserClosureReopen();await pausedDurationAndLagosMidnight();}finally{await browser.close();}

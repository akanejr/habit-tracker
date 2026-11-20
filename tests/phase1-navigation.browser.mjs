/** UI navigation on the synthetic dashboard, with no hosted connection. */
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
async function journey(viewport, colorScheme) {
const c=await browser.newContext({viewport,colorScheme}),p=await c.newPage();
const btn=(name)=>p.getByRole('button',{name,exact:true});
const audit=async label=>{const results=await new AxeBuilder({page:p}).analyze(); assert.deepEqual(results.violations.map(x=>({id:x.id,nodes:x.nodes.map(n=>n.target)})),[],`axe ${label}`);};
try {
 await p.goto('http://127.0.0.1:3103/dashboard'); await p.getByText('Your space is ready.').waitFor();
 await btn('Add a habit').click(); await p.getByLabel('Name',{exact:true}).fill('Walk'); await audit('create habit');
 p.once('dialog',d=>d.dismiss()); await btn('Progress').click(); assert.equal(await p.getByLabel('Name',{exact:true}).inputValue(),'Walk');
 p.once('dialog',d=>d.accept()); await btn('Progress').click(); await p.getByRole('heading',{name:'Progress'}).waitFor(); await audit('empty progress');
 await btn('Today').click(); await btn('Add a habit').click(); await p.getByLabel('Name',{exact:true}).fill('Walk'); await p.getByLabel('Description').fill('Morning movement'); await btn('Save habit').click(); await p.getByText('0 sessions today').waitFor();
 await btn('Add a habit').click(); await p.getByLabel('Name',{exact:true}).fill('Read'); await btn('Save habit').click();
 const walkCard=p.locator('.bloom-habit-card').filter({has:p.getByRole('heading',{name:'Walk',exact:true})}); await walkCard.scrollIntoViewIfNeeded(); const scrollBeforeDetails=await p.evaluate(()=>window.scrollY); await walkCard.click({position:{x:12,y:12}}); await p.getByRole('heading',{name:'Walk',exact:true,level:1}).waitFor(); assert.equal(new URL(p.url()).searchParams.get('habit')!==null,true); assert.equal(await p.getByRole('heading',{name:'Today’s habits'}).count(),0,'details is a dedicated screen, not an expansion below Today'); await p.getByText('Morning movement',{exact:true}).first().waitFor(); await audit('habit card navigation'); await p.goBack(); await p.getByRole('heading',{name:'Today’s habits'}).waitFor(); await p.waitForFunction(y=>Math.abs(window.scrollY-y)<2,scrollBeforeDetails,{timeout:3000});
 const readCard=p.locator('.bloom-habit-card').filter({has:p.getByRole('heading',{name:'Read',exact:true})}); await readCard.click({position:{x:12,y:12}}); await p.getByRole('heading',{name:'Read',exact:true,level:1}).waitFor(); assert.equal(new URL(p.url()).searchParams.get('habit')!==null,true,'the second card opens its own habit'); await btn('Back to Today').click(); await p.getByRole('heading',{name:'Today’s habits'}).waitFor();
 await p.getByRole('button',{name:'Quick Log'}).first().click(); assert.equal(new URL(p.url()).searchParams.has('habit'),false,'Quick Log does not activate the card link'); await p.getByLabel('Note (optional)').fill('Do not carry to another habit'); p.once('dialog',d=>d.accept()); await p.getByRole('button',{name:'Quick Log'}).last().click(); await p.getByRole('heading',{name:'Quick Log · Read'}).waitFor(); assert.equal(await p.getByLabel('Note (optional)').inputValue(),''); await btn('Cancel').click();
 await p.getByRole('button',{name:'Start timer'}).first().click(); assert.equal(new URL(p.url()).searchParams.has('habit'),false,'Start Timer remains an independent action'); await p.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await p.getByRole('timer').count(),1); assert.equal(await p.getByRole('button',{name:'Start timer',exact:true}).count(),1); assert.equal(await p.getByRole('button',{name:'Start timer',exact:true}).isDisabled(),true,'another habit cannot start a second timer'); await audit('running timer on Today'); await p.getByRole('button',{name:'Pause',exact:true}).click(); await p.getByText('YOUR TIMER · PAUSED').waitFor(); assert.equal(await p.getByRole('button',{name:'Start timer',exact:true}).isDisabled(),true,'a paused timer also blocks another habit'); await p.getByRole('button',{name:'Resume',exact:true}).click(); await p.getByText('YOUR TIMER · RUNNING').waitFor();
 await p.getByRole('button',{name:'Quick Log'}).last().click(); await p.getByLabel('Note (optional)').fill('Quick Log during Walk timer'); await p.getByRole('button',{name:'Save session'}).click(); await p.getByText('Saved in this browser',{exact:false}).waitFor(); assert.equal(new URL(p.url()).searchParams.has('habit'),false,'saving Quick Log does not navigate to Details'); assert.equal(await p.getByText('YOUR TIMER · RUNNING').count(),1,'Quick Log leaves the other habit timer running');
 await p.getByRole('button',{name:'Quick Log'}).last().click(); await p.getByLabel('Note (optional)').fill('An unsaved note'); await audit('quick log');
 p.once('dialog',d=>d.dismiss()); await p.goBack(); assert.equal(await p.getByLabel('Note (optional)').inputValue(),'An unsaved note'); assert.equal(new URL(p.url()).pathname,'/dashboard');
 p.once('dialog',d=>d.accept()); await btn('Progress').click(); await p.getByRole('heading',{name:'Progress'}).waitFor(); await audit('progress');
 await p.getByRole('button',{name:'Walk',exact:true}).click(); await p.locator('#detail-title').waitFor(); assert.equal(await p.getByRole('timer').count(),1); assert.equal(await p.locator('.bloom-detail-page').getByRole('timer').count(),1,'the dedicated details view contains the same active timer'); assert.equal(await p.getByRole('heading',{name:'Progress',exact:true}).count(),0,'details replaces Progress rather than expanding below it'); await audit('habit details'); await btn('Set weekly session goal').click(); await audit('goal form'); await btn('Cancel').click();
 await btn('Settings').click(); await audit('settings'); await p.getByLabel('Display name').fill('Unsaved');
 p.once('dialog',d=>d.accept()); await btn('Today').click(); await btn('Settings').click(); assert.equal(await p.getByLabel('Display name').inputValue(),'');
 await p.goto('http://127.0.0.1:3103/dashboard?view=progress&habit=missing'); await p.getByText('Habit not found').waitFor(); await btn('Back to Progress').click(); await p.getByRole('heading',{name:'Progress'}).waitFor();
 console.log(`PASS ${viewport.width}px ${colorScheme} navigation: draft guards, browser back, one active timer, deep links, missing detail, and axe across forms/views`);
}finally{await c.close();}
}
async function keyboardAndTabs() {
 const context=await browser.newContext({viewport:{width:390,height:844}}); const p=await context.newPage();
 try {
  await p.goto('http://127.0.0.1:3103/dashboard');
  await p.getByRole('button',{name:'Add a habit'}).focus(); await p.keyboard.press('Enter'); await p.locator('#edit-title').waitFor(); await p.waitForFunction(()=>document.activeElement?.id==='edit-title');
  await p.keyboard.press('Tab'); assert.equal(await p.getByLabel('Name',{exact:true}).evaluate(el=>el===document.activeElement),true); await p.keyboard.type('Meditate');
  await p.getByRole('button',{name:'Save habit'}).focus(); await p.keyboard.press('Enter'); await p.getByText('0 sessions today',{exact:false}).waitFor();
  const other=await context.newPage(); await other.goto('http://127.0.0.1:3103/dashboard'); await other.getByText('Meditate').waitFor();
  const cardLink=p.getByRole('link',{name:'Open details for Meditate'}); await cardLink.focus(); assert.equal(await cardLink.evaluate(el=>el===document.activeElement),true); await p.keyboard.press('Enter'); await p.getByRole('heading',{name:'Meditate',exact:true,level:1}).waitFor(); await p.waitForFunction(()=>document.activeElement?.id==='detail-title'); await p.getByRole('button',{name:'Back to Today'}).click(); await p.getByRole('heading',{name:'Today’s habits'}).waitFor();
  await p.getByRole('button',{name:'Start timer'}).click(); await other.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await other.getByRole('timer').count(),1); assert.equal(await other.getByRole('button',{name:'Start timer',exact:true}).count(),0,'the only active habit card shows its timer instead of another Start action');
  await other.getByRole('button',{name:'Pause',exact:true}).click(); await p.getByText('YOUR TIMER · PAUSED').waitFor(); assert.equal(await other.getByRole('button',{name:'Start timer',exact:true}).count(),0,'the active card has no Start action while the shared session is paused'); assert.equal(await other.getByRole('button',{name:'Resume',exact:true}).count(),1);
  console.log('PASS keyboard focus and cross-tab refresh in browser-local simulation');
 } finally {await context.close();}
}
async function reducedMotion() {
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'}),p=await context.newPage();
 const btn=name=>p.getByRole('button',{name,exact:true});
 try {
  await p.goto('http://127.0.0.1:3103/dashboard'); await btn('Add a habit').click(); await p.getByLabel('Name',{exact:true}).fill('Breathe'); await btn('Save habit').click(); await btn('Start timer').click(); await p.getByText('YOUR TIMER · RUNNING').waitFor();
  assert.equal(await p.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
  assert.equal(await p.locator('.bloom-timer-indicator').evaluate(el=>getComputedStyle(el).animationName),'none','running timer animation is disabled for reduced-motion users');
  await btn('Details').click(); await p.getByRole('heading',{name:'Breathe',exact:true,level:1}).waitFor(); assert.equal(await p.locator('.bloom-timer-indicator').evaluate(el=>getComputedStyle(el).animationName),'none','the shared timer in Details also respects reduced motion');
  console.log('PASS reduced-motion preference disables the pulse in Today and Habit Details');
 } finally {await context.close();}
}
try {await journey({width:390,height:844},'dark'); await journey({width:1440,height:900},'light'); await keyboardAndTabs(); await reducedMotion();}finally{await browser.close();}

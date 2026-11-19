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
 await p.goto('http://127.0.0.1:3103/dashboard'); await p.getByText('No active habits yet.').waitFor();
 await btn('Add a habit').click(); await p.getByLabel('Name',{exact:true}).fill('Walk'); await audit('create habit');
 p.once('dialog',d=>d.dismiss()); await btn('Progress').click(); assert.equal(await p.getByLabel('Name',{exact:true}).inputValue(),'Walk');
 p.once('dialog',d=>d.accept()); await btn('Progress').click(); await p.getByRole('heading',{name:'Progress'}).waitFor(); await audit('empty progress');
 await btn('Today').click(); await btn('Add a habit').click(); await p.getByLabel('Name',{exact:true}).fill('Walk'); await btn('Save habit').click(); await p.getByText('0 sessions today').waitFor();
 await btn('Add a habit').click(); await p.getByLabel('Name',{exact:true}).fill('Read'); await btn('Save habit').click();
 await p.getByRole('button',{name:'Quick Log'}).first().click(); await p.getByLabel('Note (optional)').fill('Do not carry to another habit'); p.once('dialog',d=>d.accept()); await p.getByRole('button',{name:'Quick Log'}).last().click(); await p.getByRole('heading',{name:'Quick Log · Read'}).waitFor(); assert.equal(await p.getByLabel('Note (optional)').inputValue(),''); await btn('Cancel').click();
 await p.getByRole('button',{name:'Start timer'}).first().click(); await p.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await p.getByRole('button',{name:'Start timer'}).nth(1).isDisabled(),true);
 await p.getByRole('button',{name:'Quick Log'}).last().click(); await p.getByLabel('Note (optional)').fill('An unsaved note'); await audit('quick log');
 p.once('dialog',d=>d.dismiss()); await p.goBack(); assert.equal(await p.getByLabel('Note (optional)').inputValue(),'An unsaved note'); assert.equal(new URL(p.url()).pathname,'/dashboard');
 p.once('dialog',d=>d.accept()); await btn('Progress').click(); await p.getByRole('heading',{name:'Progress'}).waitFor(); await audit('progress');
 await p.getByRole('button',{name:'Walk',exact:true}).click(); await p.locator('#detail-title').waitFor(); await audit('habit details'); await btn('Set weekly session goal').click(); await audit('goal form'); await btn('Cancel').click();
 await btn('Settings').click(); await audit('settings'); await p.getByLabel('Display name').fill('Unsaved');
 p.once('dialog',d=>d.accept()); await btn('Today').click(); await btn('Settings').click(); assert.equal(await p.getByLabel('Display name').inputValue(),'');
 await p.goto('http://127.0.0.1:3103/dashboard?view=progress&habit=missing'); await p.getByText('Habit not found').waitFor(); await btn('Back to progress').click(); await p.getByRole('heading',{name:'Progress'}).waitFor();
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
  await p.getByRole('button',{name:'Start timer'}).click(); await other.getByText('YOUR TIMER · RUNNING').waitFor(); assert.equal(await other.getByRole('button',{name:'Start timer'}).isDisabled(),true);
  await other.getByRole('button',{name:'Pause',exact:true}).click(); await p.getByText('YOUR TIMER · PAUSED').waitFor();
  console.log('PASS keyboard focus and cross-tab refresh in browser-local simulation');
 } finally {await context.close();}
}
try {await journey({width:390,height:844},'dark'); await journey({width:1440,height:900},'light'); await keyboardAndTabs();}finally{await browser.close();}

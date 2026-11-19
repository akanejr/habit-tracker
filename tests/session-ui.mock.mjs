// Browser integration with an in-memory PostgREST mock, NOT a live Supabase integration test.
// Start the local-only harness described in docs/bloom-local-testing.md before running.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';

const browser = await chromium.launch({headless:true});
const context = await browser.newContext({viewport:{width:390,height:844},colorScheme:'dark'});
const page = await context.newPage();
page.on('pageerror',e=>console.error('BROWSER ERROR:',e.message));
page.on('console',message=>{ if(message.type()==='error') console.error('CONSOLE:',message.text()); });
const uid='00000000-0000-4000-8000-000000000001', hid='10000000-0000-4000-8000-000000000001';
let habits=[{id:hid,user_id:uid,name:'Read',description:'A quiet moment',frequency:'daily',target_per_week:null,preferred_time:null,color:null,icon:null,is_active:true,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}];
let sessions=[], segments=[], versions=[];
const ledger=new Map(); let dropped=false, maintenance=true;
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const reply = (route,status,body) => route.fulfill({status,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS','content-type':'application/json'},body:JSON.stringify(body)});
await page.route('http://127.0.0.1:54321/**',async route=>{
  const request=route.request(); const url=new URL(request.url());
  if(request.method()==='OPTIONS') return reply(route,200,{});
  const path=url.pathname.split('/').at(-1);
  if(request.method()==='GET') {
    let rows=path==='habits'?habits:path==='habit_sessions'?sessions:path==='habit_session_segments'?segments:path==='habit_versions'?versions:[];
    const sessionFilter=url.searchParams.get('session_id'); if(sessionFilter) rows=rows.filter(s=>s.session_id===sessionFilter.slice(3));
    return reply(route,200,rows);
  }
  const p=request.postDataJSON(), key=p.p_request_id;
  if(ledger.has(key)) return reply(route,200,ledger.get(key));
  if(path==='bloom_start_session' && maintenance) { maintenance=false; return reply(route,400,{code:'55000',message:'Bloom writes are temporarily frozen'}); }
  if(path==='bloom_start_session') {
    const id=crypto.randomUUID(), start=new Date(Date.now()-5*3600_000).toISOString();
    sessions.push({id,user_id:uid,habit_id:p.p_habit_id,source:'timed',status:'running',created_at:start,started_at:start,completed_at:null,completed_on:null,duration_ms:null,estimated_ms:null,note:null});
    segments.push({id:1,session_id:id,user_id:uid,started_at:start,ended_at:null}); ledger.set(key,{session_id:id});
  } else if(path==='bloom_quick_log') {
    const id=crypto.randomUUID();sessions.push({id,user_id:uid,habit_id:p.p_habit_id,source:'quick',status:'completed',created_at:new Date().toISOString(),completed_on:p.p_date,duration_ms:null,estimated_ms:p.p_estimated_ms,note:p.p_note});ledger.set(key,{session_id:id});
    // Simulate a committed response lost to the browser.
    if(!dropped){dropped=true;return reply(route,503,{message:'synthetic dropped response'});}
  } else if(['bloom_pause_session','bloom_resume_session','bloom_complete_session','bloom_cancel_session'].includes(path)) {
    const s=sessions.find(s=>s.id===p.p_session_id); const now=new Date().toISOString();
    if(s.status==='running'){const seg=segments.find(x=>x.session_id===s.id && x.ended_at===null);seg.ended_at=now;}
    if(path==='bloom_pause_session')s.status='paused';
    if(path==='bloom_resume_session'){s.status='running';segments.push({id:segments.length+1,session_id:s.id,user_id:uid,started_at:now,ended_at:null});}
    if(path==='bloom_complete_session'){s.status='completed';s.completed_at=now;s.completed_on=today;s.duration_ms=18000000;}
    if(path==='bloom_cancel_session')s.status='cancelled';
    ledger.set(key,{session_id:s.id});
  } else if(path==='bloom_archive_habit') {habits.find(h=>h.id===p.p_habit_id).is_active=false;ledger.set(key,{habit_id:p.p_habit_id});}
  else throw new Error(`Unexpected mock endpoint ${path}`);
  return reply(route,200,ledger.get(key));
});
async function waitText(text){await page.getByText(text,{exact:false}).first().waitFor({timeout:10000});}
try {
  await page.goto('http://localhost:3100/bloom-harness');
  await page.getByRole('button',{name:'Start timer'}).waitFor();
  const audit = await new AxeBuilder({page}).analyze();
  assert.deepEqual(audit.violations.map(v => ({id:v.id, nodes:v.nodes.map(n=>n.target)})), [], 'automated accessibility violations');
  await context.setOffline(true); await waitText('offline');
  assert.equal(await page.getByRole('button',{name:'Start timer'}).isDisabled(),true);
  await context.setOffline(false);
  await page.getByRole('button',{name:'Start timer'}).click(); await waitText('Maintenance or a pending dependency');
  await page.getByRole('button',{name:'Retry safely'}).click(); await waitText('YOUR TIMER');
  await waitText('four hours or more');
  await page.reload(); await waitText('four hours or more');
  await page.getByRole('button',{name:'Pause',exact:true}).click(); await waitText('PAUSED');
  await page.getByRole('button',{name:'Resume',exact:true}).click(); await waitText('RUNNING');
  await page.getByRole('button',{name:'Quick Log',exact:true}).click();
  await page.getByLabel('Estimated minutes (optional)').fill('12');
  await page.getByLabel('Note (optional)').fill('Mock quick entry');
  await page.getByRole('button',{name:'Save session'}).click(); await waitText('Action needs confirmation'); assert.equal(await page.getByLabel('Note (optional)').isDisabled(),true);
  const before=sessions.filter(s=>s.source==='quick').length;
  await page.reload(); await waitText('Action needs confirmation');
  await page.getByRole('button',{name:'Retry safely'}).click(); await waitText('1 session today');
  assert.equal(sessions.filter(s=>s.source==='quick').length,before);
  await page.getByRole('button',{name:'Details',exact:true}).click(); await waitText('Mock quick entry');
  await page.getByRole('button',{name:'Archive',exact:true}).click(); await page.getByRole('button',{name:'Yes, archive'}).click();
  await waitText('archived'); await page.getByRole('button',{name:'Complete',exact:true}).click();
  await page.getByRole('button',{name:'Progress',exact:true}).click(); await waitText('2 sessions · 1 active day');
  await waitText('Estimated: 0:12:00');
  await page.getByRole('button',{name:'Settings',exact:true}).click(); await waitText('Self-service deletion is not available');
  assert.equal(await page.getByRole('button',{name:'Delete account unavailable'}).isDisabled(),true);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  assert.equal(overflow,false,'mobile viewport should not overflow horizontally');
  console.log('PASS mocked browser: mobile/dark, automated accessibility scan, offline, maintenance and retry, start, four-hour warning, reload persistence, pause/resume, Quick Log during timer, uncertain retry, history, archive then complete, Progress, disabled deletion, no horizontal overflow');
} catch (error) { console.error('PAGE:', await page.locator('body').innerText().catch(() => 'unavailable')); throw error; } finally { await browser.close(); }

import test from 'node:test';
import assert from 'node:assert/strict';
import {addDays,nextWeek,goalForWeek,weeklySummary,dailyHabitProgress,timerDisplayMs,FOUR_HOURS_MS} from '../lib/sessions/core.ts';

const log=(id,habit,date,extra={})=>({id,habit_id:habit,status:'completed',source:'quick',completed_on:date,duration_ms:null,estimated_ms:null,...extra});
test('calendar arithmetic crosses month, year and leap day',()=>{assert.equal(addDays('2024-02-28',1),'2024-02-29');assert.equal(nextWeek('2024-12-30'),'2025-01-06');assert.throws(()=>addDays('2025-02-30',1));assert.throws(()=>nextWeek('2025-01-01')); });
test('goal history preserves unconfirmed, no target, and future changes',()=>{const g=[{id:1,habit_id:'a',effective_week:'2026-11-09',goal_confirmed:false,weekly_session_target:null},{id:2,habit_id:'a',effective_week:'2026-11-16',goal_confirmed:true,weekly_session_target:12},{id:3,habit_id:'a',effective_week:'2026-11-23',goal_confirmed:true,weekly_session_target:null}];assert.deepEqual(goalForWeek(g,'a','2026-11-09'),{kind:'unconfirmed'});assert.deepEqual(goalForWeek(g,'a','2026-11-16'),{kind:'target',value:12});assert.deepEqual(goalForWeek(g,'a','2026-11-23'),{kind:'none'});});
test('same effective week uses newest id and unresolved schedules fail closed',()=>{const v=(id,target,week='2026-11-16')=>({id,habit_id:'a',effective_week:week,goal_confirmed:true,weekly_session_target:target});assert.deepEqual(goalForWeek([v('9007199254740993',4),v('9007199254740994',8)],'a','2026-11-16'),{kind:'target',value:8});assert.throws(()=>goalForWeek([v(8,99,null)],'a','2026-11-16'));assert.throws(()=>goalForWeek([v(9007199254740994,8)],'a','2026-11-16'));});
test('weekly sessions, distinct active days and separate duration types',()=>{const s=[log('1','a','2025-01-01',{duration_ms:1000,source:'timed'}),log('2','a','2025-01-01',{estimated_ms:3000}),log('3','a','2025-01-02'),log('3','a','2025-01-02'),log('4','a','2025-01-06'),log('5','b','2025-01-01')];assert.deepEqual(weeklySummary(s,'a','2024-12-30',{kind:'target',value:2}),{sessions:3,activeDays:2,measuredMs:1000,estimatedMs:3000,unknownDurationSessions:1,goal:{kind:'target',value:2},achieved:true});});
test('completed sessions remain counted past goal; cancelled ignored',()=>{const s=Array.from({length:14},(_,i)=>log(String(i),'a','2025-01-01'));s.push(log('cancel','a','2025-01-01',{status:'cancelled'}));const w=weeklySummary(s,'a','2024-12-30',{kind:'target',value:2});assert.equal(w.sessions,14);assert.equal(w.activeDays,1);assert.equal(w.achieved,true);});
test('daily progress counts distinct visible habits and avoids empty-day perfection',()=>{const s=[log('1','a','2025-01-01'),log('2','a','2025-01-01'),log('3','c','2025-01-01')];assert.deepEqual(dailyHabitProgress(['a','b','a'],s,'2025-01-01'),{completed:1,total:2,percentage:50});assert.equal(dailyHabitProgress([],s,'2025-01-01').percentage,0);});
test('timer display excludes pause and never writes authoritative duration',()=>{const s={id:'x',status:'running',duration_ms:null};const seg=[{session_id:'x',started_at:'2026-11-01T00:00:00Z',ended_at:'2026-11-01T01:00:00Z'},{session_id:'x',started_at:'2026-11-01T02:00:00Z',ended_at:null}];assert.equal(timerDisplayMs(s,seg,Date.parse('2026-11-01T03:00:00Z')),7200000);assert.equal(s.duration_ms,null,'display interpolation leaves persisted duration untouched');assert.equal(timerDisplayMs({...s,status:'completed',duration_ms:42},seg,0),42);assert.throws(()=>timerDisplayMs({...s,status:'paused'},seg,Date.now()));assert.equal(FOUR_HOURS_MS,14400000);});
test('unknown goal is not counted as achievement and invalid durations rejected',()=>{assert.equal(weeklySummary([],'a','2024-12-30',{kind:'none'}).achieved,null);assert.throws(()=>weeklySummary([log('x','a','2025-01-01',{duration_ms:1,estimated_ms:2})],'a','2024-12-30',{kind:'none'}));});

test('Lagos day and week cross on Sunday at 23:00 UTC', async()=>{
  const {lagosDate,weekStart}=await import('../lib/habits/dates.ts');
  const before=lagosDate(new Date('2026-11-22T22:59:59.999Z'));
  const after=lagosDate(new Date('2026-11-22T23:00:00.000Z'));
  assert.equal(before,'2026-11-22'); assert.equal(weekStart(before),'2026-11-16');
  assert.equal(after,'2026-11-23'); assert.equal(weekStart(after),'2026-11-23');
});

test('paused timer stays constant and long-running timer is never truncated',()=>{
  const seg=[{session_id:'x',started_at:'2026-11-01T00:00:00Z',ended_at:'2026-11-01T05:00:00Z'}];
  assert.equal(timerDisplayMs({id:'x',status:'paused',duration_ms:null},seg,Date.parse('2026-11-02T00:00:00Z')),5*60*60*1000);
  assert.ok(timerDisplayMs({id:'x',status:'paused',duration_ms:null},seg,Date.now())>FOUR_HOURS_MS);
  assert.throws(()=>timerDisplayMs({id:'x',status:'running',duration_ms:null},[...seg,{session_id:'x',started_at:'2026-11-01T05:00:00Z',ended_at:null},{session_id:'x',started_at:'2026-11-01T06:00:00Z',ended_at:null}],Date.now()));
});

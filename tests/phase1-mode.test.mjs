import test from 'node:test';
import assert from 'node:assert/strict';
import {isPhaseOneSimulation} from '../lib/phase1-mode.ts';

test('simulation requires explicit opt-in and rejects hosted or production configuration',()=>{
 const original={flag:process.env.BLOOM_PHASE1_DEMO,url:process.env.NEXT_PUBLIC_SUPABASE_URL,vercel:process.env.VERCEL_ENV};
 const put=(key,value)=>value===undefined?delete process.env[key]:process.env[key]=value;
 try {
  delete process.env.BLOOM_PHASE1_DEMO;delete process.env.NEXT_PUBLIC_SUPABASE_URL;delete process.env.VERCEL_ENV;assert.equal(isPhaseOneSimulation(),false);
  process.env.BLOOM_PHASE1_DEMO='1';assert.equal(isPhaseOneSimulation(),true);
  process.env.NEXT_PUBLIC_SUPABASE_URL='http://127.0.0.1:54321';assert.equal(isPhaseOneSimulation(),true);
  process.env.NEXT_PUBLIC_SUPABASE_URL='https://example.invalid';assert.equal(isPhaseOneSimulation(),false);
  process.env.NEXT_PUBLIC_SUPABASE_URL='not a url';assert.equal(isPhaseOneSimulation(),false);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;process.env.VERCEL_ENV='production';assert.equal(isPhaseOneSimulation(),false);
 } finally {put('BLOOM_PHASE1_DEMO',original.flag);put('NEXT_PUBLIC_SUPABASE_URL',original.url);put('VERCEL_ENV',original.vercel);}
});

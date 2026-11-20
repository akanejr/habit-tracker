import test from 'node:test';
import assert from 'node:assert/strict';
import {isPhaseOneSimulation} from '../lib/phase1-mode.ts';

const original = {
  flag: process.env.BLOOM_PHASE1_DEMO,
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  vercel: process.env.VERCEL_ENV
};

const restore = () => {
  original.flag === undefined ? delete process.env.BLOOM_PHASE1_DEMO : process.env.BLOOM_PHASE1_DEMO = original.flag;
  original.url === undefined ? delete process.env.NEXT_PUBLIC_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL = original.url;
  original.vercel === undefined ? delete process.env.VERCEL_ENV : process.env.VERCEL_ENV = original.vercel;
};

test('returns false when demo flag is missing', () => {
  try {
    delete process.env.BLOOM_PHASE1_DEMO;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    delete process.env.VERCEL_ENV;
    assert.equal(isPhaseOneSimulation(), false);
  } finally { restore(); }
});

test('returns false when demo flag is incorrect value', () => {
  try {
    process.env.BLOOM_PHASE1_DEMO = 'true';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    delete process.env.VERCEL_ENV;
    assert.equal(isPhaseOneSimulation(), false);
  } finally { restore(); }
});

test('returns false when Supabase URL is missing', () => {
  try {
    process.env.BLOOM_PHASE1_DEMO = '1';
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.VERCEL_ENV;
    assert.equal(isPhaseOneSimulation(), false);
  } finally { restore(); }
});

test('returns false when Supabase URL is empty', () => {
  try {
    process.env.BLOOM_PHASE1_DEMO = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = '';
    delete process.env.VERCEL_ENV;
    assert.equal(isPhaseOneSimulation(), false);
  } finally { restore(); }
});

test('returns false when Supabase URL is malformed', () => {
  try {
    process.env.BLOOM_PHASE1_DEMO = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'not a url';
    delete process.env.VERCEL_ENV;
    assert.equal(isPhaseOneSimulation(), false);
  } finally { restore(); }
});

test('returns true when Supabase URL is localhost', () => {
  try {
    process.env.BLOOM_PHASE1_DEMO = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    delete process.env.VERCEL_ENV;
    assert.equal(isPhaseOneSimulation(), true);
  } finally { restore(); }
});

test('returns false when Supabase URL is hosted (not localhost)', () => {
  try {
    process.env.BLOOM_PHASE1_DEMO = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.VERCEL_ENV;
    assert.equal(isPhaseOneSimulation(), false);
  } finally { restore(); }
});

test('returns false when environment is production', () => {
  try {
    process.env.BLOOM_PHASE1_DEMO = '1';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.VERCEL_ENV = 'production';
    assert.equal(isPhaseOneSimulation(), false);
  } finally { restore(); }
});

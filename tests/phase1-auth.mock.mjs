/** UI-only auth tests; intercepted synthetic responses, never a real Auth service. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const c=await b.newContext({viewport:{width:390,height:844}}),p=await c.newPage();
let requests=0;
await p.route('http://127.0.0.1:54321/**',async route=>{
 const req=route.request(); if(req.method()==='OPTIONS') return route.fulfill({status:200,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS'}});
 requests++;
 const path=new URL(req.url()).pathname;
 const body=path.endsWith('/token')?{code:'invalid_credentials',message:'Invalid login credentials'}:path.endsWith('/signup')?{id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',email:'person@example.test',created_at:new Date().toISOString(),identities:[]}:{};
 return route.fulfill({status:path.endsWith('/token')?400:200,headers:{'access-control-allow-origin':'*','content-type':'application/json'},body:JSON.stringify(body)});
});
try{
 await p.goto('http://localhost:3100/login');await p.getByLabel('Email address').fill('person@example.test');await p.getByLabel('Password',{exact:true}).fill('wrong-password');await p.getByRole('button',{name:'Log in',exact:true}).click();await p.getByText('That email and password don’t match.',{exact:false}).waitFor();
 await p.goto('http://localhost:3100/signup');await p.getByLabel('Full name').fill('Test User');await p.getByLabel('Email address').fill('person@example.test');await p.getByLabel('Password',{exact:true}).fill('example-password');await p.getByLabel('Confirm password').fill('wrong-password');await p.getByRole('button',{name:'Create my account'}).click();await p.getByText('Your passwords don’t match.',{exact:false}).waitFor();
 await p.getByLabel('Confirm password').fill('example-password');await p.getByRole('button',{name:'Create my account'}).click();await p.getByRole('heading',{name:'Check your inbox'}).waitFor();assert.equal(new URL(p.url()).pathname,'/signup');
 await p.goto('http://localhost:3100/forgot-password');await p.getByLabel('Email address').fill('person@example.test');await p.getByRole('button',{name:'Send reset link'}).click();await p.getByRole('heading',{name:'Check your inbox'}).waitFor();
 await p.goto('http://localhost:3100/resend-confirmation');await p.getByLabel('Email address').fill('person@example.test');await p.getByRole('button',{name:'Send verification link'}).click();await p.getByRole('heading',{name:'Check your inbox'}).waitFor();
 await p.goto('http://localhost:3100/reset-password');await p.getByText('This reset link is invalid or has expired.',{exact:false}).waitFor();assert.equal(requests,4);
 console.log('PASS mocked auth UI: invalid login, password mismatch, unverified signup, recovery, resend and invalid reset link');
}finally{await b.close();}

import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const supabaseRequests = [];
const allRequests = [];

page.on('request', request => {
  const url = request.url();
  allRequests.push(url);
  if (url.includes('supabase.co') || url.includes('retkelaxegvlkuzhgosz')) {
    supabaseRequests.push({
      url,
      method: request.method(),
      resourceType: request.resourceType()
    });
  }
});

console.log('Testing network isolation in simulation mode...\n');

// Test 1: Dashboard load
await page.goto('http://127.0.0.1:3103/dashboard', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Test 2: Create a habit
await page.click('button:has-text("Add a habit")');
await page.fill('input[name="name"]', 'Test Habit');
await page.click('button:has-text("Save habit")');
await page.waitForTimeout(1000);

// Test 3: Start a timer
await page.click('button:has-text("Start timer")');
await page.waitForTimeout(2000);

// Test 4: Pause and resume
await page.click('button:has-text("Pause")');
await page.waitForTimeout(1000);
await page.click('button:has-text("Resume")');
await page.waitForTimeout(1000);

// Test 5: Complete timer
await page.click('button:has-text("Complete")');
await page.waitForTimeout(1000);

// Test 6: Quick log
await page.click('button:has-text("Quick Log")');
await page.fill('input[name="minutes"]', '30');
await page.click('button:has-text("Save session")');
await page.waitForTimeout(1000);

// Test 7: Navigate to details
await page.click('button:has-text("Details")');
await page.waitForTimeout(1000);

// Test 8: Navigate to progress
await page.click('button:has-text("Progress")');
await page.waitForTimeout(1000);

// Test 9: Navigate to settings
await page.click('button:has-text("Settings")');
await page.waitForTimeout(1000);

await browser.close();

console.log('Total requests made:', allRequests.length);
console.log('Supabase requests made:', supabaseRequests.length);

if (supabaseRequests.length > 0) {
  console.log('\n❌ FAIL: Supabase requests detected:');
  supabaseRequests.forEach(req => {
    console.log(`  - ${req.method} ${req.url} (${req.resourceType})`);
  });
  process.exit(1);
} else {
  console.log('\n✅ PASS: No Supabase requests detected in simulation mode');
  console.log('All data operations used localStorage only');
  process.exit(0);
}

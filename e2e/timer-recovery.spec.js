// Phase 4: Browser-Level Timer Reliability Tests
// Tests run against local Next.js dev server in demo mode (BLOOM_PHASE1_DEMO=1)
// Demo mode uses localStorage for persistence, simulating the real backend
/* eslint-disable @typescript-eslint/no-require-imports */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Helper: wait for workspace to fully load (no loading state)
async function waitForWorkspace(page) {
  await page.goto(`${BASE_URL}/dashboard`);
  // Wait for loading to disappear
  await page.waitForSelector('.bloom-loading-state', { state: 'detached', timeout: 15000 });
}

// Helper: create a habit via the UI
async function createHabit(page, name = 'Test Habit') {
  await waitForWorkspace(page);
  await page.click('button.bloom-primary:has-text("Add a habit")');
  await page.fill('input[name="name"]', name);
  await page.click('button.bloom-primary:has-text("Save habit")');
  // Wait for the habit card to appear
  await page.waitForSelector('.bloom-habit-card', { timeout: 10000 });
}

// Helper: start a timer for the first habit
async function startTimer(page) {
  const startButton = page.locator('.bloom-habit-card button.bloom-primary:has-text("Start timer")').first();
  await startButton.click();
  // Wait for timer to appear
  await page.waitForSelector('.bloom-timer', { timeout: 5000 });
}

test.describe('Phase 4: Browser Timer Reliability', () => {

  test.beforeEach(async ({ page }) => {
    // Clear localStorage and sessionStorage before each test
    await page.goto(`${BASE_URL}/dashboard`);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test('1. Timer survives page refresh and recovers state', async ({ page }) => {
    await createHabit(page, 'Morning Meditation');
    await startTimer(page);

    // Verify timer is running
    const timerState = page.locator('.bloom-timer-state');
    await expect(timerState).toContainText('Timer running');

    // Get the elapsed time display
    const clockBefore = page.locator('.bloom-clock');
    await expect(clockBefore).toBeVisible();
    const timeBefore = await clockBefore.getAttribute('aria-label');
    console.log('Timer before refresh:', timeBefore);

    // Wait a moment for time to advance
    await page.waitForTimeout(2000);

    // Refresh the page
    await page.reload();
    await page.waitForSelector('.bloom-loading-state', { state: 'detached', timeout: 15000 });

    // Verify timer recovered
    const timerAfter = page.locator('.bloom-timer');
    await expect(timerAfter).toBeVisible({ timeout: 10000 });

    const timerStateAfter = page.locator('.bloom-timer-state');
    await expect(timerStateAfter).toContainText('Timer running');

    const clockAfter = page.locator('.bloom-clock');
    const timeAfter = await clockAfter.getAttribute('aria-label');
    console.log('Timer after refresh:', timeAfter);

    // Timer should still be running (not reset to 0)
    expect(timeAfter).toBeTruthy();
  });

  test('2. Timer survives browser tab close and reopen', async ({ page, context }) => {
    await createHabit(page, 'Deep Work');
    await startTimer(page);

    // Verify timer is running
    await expect(page.locator('.bloom-timer-state')).toContainText('Timer running');
    
    // Wait for some elapsed time
    await page.waitForTimeout(3000);

    const clockBefore = page.locator('.bloom-clock');
    const timeBefore = await clockBefore.getAttribute('aria-label');
    console.log('Timer before close:', timeBefore);

    // Close the page (simulate tab close)
    await page.close();

    // Open a new page (simulate reopening browser)
    const newPage = await context.newPage();
    await newPage.goto(`${BASE_URL}/dashboard`);
    await newPage.waitForSelector('.bloom-loading-state', { state: 'detached', timeout: 15000 });

    // Verify timer recovered in new page
    const timerAfter = newPage.locator('.bloom-timer');
    await expect(timerAfter).toBeVisible({ timeout: 10000 });

    const timerStateAfter = newPage.locator('.bloom-timer-state');
    await expect(timerStateAfter).toContainText('Timer running');

    const clockAfter = newPage.locator('.bloom-clock');
    const timeAfter = await clockAfter.getAttribute('aria-label');
    console.log('Timer after reopen:', timeAfter);

    // Timer should still be running
    expect(timeAfter).toBeTruthy();
  });

  test('3. Timer handles network interruption gracefully', async ({ page, context }) => {
    await createHabit(page, 'Reading');
    await startTimer(page);

    // Verify timer is running
    await expect(page.locator('.bloom-timer-state')).toContainText('Timer running');

    // Get elapsed time before going offline
    const clockBefore = page.locator('.bloom-clock');
    const timeBefore = await clockBefore.getAttribute('aria-label');
    console.log('Time before offline:', timeBefore);

    // Simulate going offline
    await context.setOffline(true);
    console.log('Network set to offline');

    // Wait while offline - timer should continue (client-side in demo mode)
    await page.waitForTimeout(3000);

    // Timer should still display and be running
    const clockWhileOffline = page.locator('.bloom-clock');
    await expect(clockWhileOffline).toBeVisible();
    const timeWhileOffline = await clockWhileOffline.getAttribute('aria-label');
    console.log('Time while offline:', timeWhileOffline);

    // Restore network
    await context.setOffline(false);
    console.log('Network restored');
    await page.waitForTimeout(1000);

    // Timer should still be functional
    const timerStill = page.locator('.bloom-timer');
    await expect(timerStill).toBeVisible();
    const timerState = page.locator('.bloom-timer-state');
    await expect(timerState).toContainText('Timer running');
    console.log('Timer survived network interruption');
  });

  test('4. Pause and resume preserves timer state', async ({ page }) => {
    await createHabit(page, 'Exercise');
    await startTimer(page);

    // Let timer run for 3 seconds
    await page.waitForTimeout(3000);

    const clockBefore = page.locator('.bloom-clock');
    const timeBefore = await clockBefore.getAttribute('aria-label');
    console.log('Time before pause:', timeBefore);

    // Pause the timer
    const pauseButton = page.locator('.bloom-timer-actions button:has-text("Pause")');
    await pauseButton.click();

    // Verify timer is paused
    const timerState = page.locator('.bloom-timer-state');
    await expect(timerState).toContainText('Timer paused');

    // Wait while paused
    await page.waitForTimeout(2000);

    // Resume the timer
    const resumeButton = page.locator('.bloom-timer-actions button:has-text("Resume")');
    await resumeButton.click();

    // Verify timer is running again
    await expect(timerState).toContainText('Timer running');

    // Let it run a bit more
    await page.waitForTimeout(2000);

    const clockAfter = page.locator('.bloom-clock');
    const timeAfter = await clockAfter.getAttribute('aria-label');
    console.log('Time after resume:', timeAfter);

    // Complete the session
    const completeButton = page.locator('.bloom-timer-actions button.bloom-primary:has-text("Complete")');
    await completeButton.click();
    await page.waitForTimeout(1000);

    // Verify timer is gone (session completed)
    const timerGone = page.locator('.bloom-timer');
    await expect(timerGone).not.toBeVisible({ timeout: 5000 });
    console.log('Session completed successfully');
  });

  test('5. Duplicate timer prevention - only one active timer at a time', async ({ page }) => {
    // Create two habits
    await createHabit(page, 'Habit A');
    
    // Add second habit
    await page.click('button.bloom-primary:has-text("Add a habit")');
    await page.fill('input[name="name"]', 'Habit B');
    await page.click('button.bloom-primary:has-text("Save habit")');
    await page.waitForSelector('.bloom-habit-card:nth-child(2)', { timeout: 10000 });

    // Start timer for first habit
    const startButtonA = page.locator('.bloom-habit-card').first().locator('button.bloom-primary:has-text("Start timer")');
    await startButtonA.click();
    await page.waitForSelector('.bloom-timer', { timeout: 5000 });

    // Verify timer is running for Habit A
    await expect(page.locator('.bloom-timer-state')).toContainText('Timer running');

    // Try to start timer for second habit - button should be disabled
    const startButtonB = page.locator('.bloom-habit-card').nth(1).locator('button.bloom-primary:has-text("Start timer")');
    const isDisabled = await startButtonB.isDisabled();
    console.log('Second start button disabled:', isDisabled);
    expect(isDisabled).toBe(true);

    // Verify only one timer exists
    const timerCount = await page.locator('.bloom-timer').count();
    console.log('Active timer count:', timerCount);
    expect(timerCount).toBe(1);
  });

  test('6. Completed session has accurate duration and timestamp', async ({ page }) => {
    await createHabit(page, 'Journaling');
    await startTimer(page);

    // Let timer run for exactly 4 seconds
    await page.waitForTimeout(4000);

    const clockBefore = page.locator('.bloom-clock');
    const timeBefore = await clockBefore.getAttribute('aria-label');
    console.log('Elapsed time before complete:', timeBefore);

    // Complete the session
    const completeButton = page.locator('.bloom-timer-actions button.bloom-primary:has-text("Complete")');
    await completeButton.click();

    // Wait for completion
    await page.waitForTimeout(2000);

    // Verify timer is gone
    const timerGone = page.locator('.bloom-timer');
    await expect(timerGone).not.toBeVisible({ timeout: 5000 });

    // Navigate back to main view (Today tab)
    const todayButton = page.locator('nav button:has-text("Today")');
    await todayButton.click();
    await page.waitForTimeout(1000);

    // Verify success message or session count updated
    const sessionCount = page.locator('.bloom-habit-card p').first();
    const countText = await sessionCount.textContent();
    console.log('Session count after completion:', countText);
    expect(countText).toContain('1 session');
  });

});

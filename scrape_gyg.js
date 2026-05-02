const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'gyg_analytics.json');
const CACHE_FILE = path.join(__dirname, 'gyg_analytics_cache.json');

function normalizeTitle(value) {
    return String(value || "")
        .replace(/[\u200e\u200f\ufeff\u2060]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^product list\s*/i, '')
        .replace(/^\d+\s*/i, '')
        .replace(/^[\-–—•·\u2022]+\s*/g, '')
        .trim();
}

function simplifyTitle(value) {
    return normalizeTitle(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseEnvBool(name, defaultValue) {
    const raw = process.env[name];
    if (raw === undefined || raw === null) return defaultValue;
    const normalized = String(raw).trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function parseEnvInt(name, defaultValue) {
    const raw = process.env[name];
    if (raw === undefined || raw === null) return defaultValue;
    const n = Number(String(raw).trim());
    return Number.isFinite(n) ? Math.trunc(n) : defaultValue;
}

function parseNumberFromText(text) {
    const m = String(text || '').match(/\b\d{1,3}(?:,\d{3})*\b/);
    return m ? m[0].replace(/,/g, '') : null;
}

function parseEnvCsv(name) {
    const raw = process.env[name];
    if (!raw) return [];
    return String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeJsonSafe(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function buildCacheMap(cachedRows) {
    const map = new Map();
    for (const item of cachedRows) {
        if (item && item.productId) {
            map.set(`id:${item.productId}`, item);
        }
        if (item && item.productName) {
            map.set(`name:${item.productName.toLowerCase()}`, item);
        }
    }
    return map;
}

function enrichRowsWithCache(rows, cacheMap) {
    return rows.map((row) => {
        const byId = row.productId ? cacheMap.get(`id:${row.productId}`) : null;
        const byName = row.productName ? cacheMap.get(`name:${row.productName.toLowerCase()}`) : null;
        const cached = byId || byName || null;
        const cachedPeriodReviews = cached && cached.periodReviews ? String(cached.periodReviews).trim() : "";
        const periodReviews = cachedPeriodReviews && cachedPeriodReviews !== "Error" ? cachedPeriodReviews : "-";
        return {
            ...row,
            periodReviews: periodReviews
        };
    });
}

// Basic HOTP/TOTP Implementation to avoid ESM import issues with otplib in CommonJS
function base32tohex(base32) {
    let base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    let hex = "";

    for (let i = 0; i < base32.length; i++) {
        let val = base32chars.indexOf(base32.charAt(i).toUpperCase());
        if (val === -1) throw new Error("Invalid base32 character in key");
        bits += val.toString(2).padStart(5, '0');
    }

    for (let i = 0; i + 4 <= bits.length; i += 4) {
        let chunk = bits.substr(i, 4);
        hex = hex + parseInt(chunk, 2).toString(16);
    }
    return hex;
}

function generateTOTP(secret) {
    let key = base32tohex(secret);
    
    // Ensure key is even length
    if(key.length % 2 !== 0) {
        key += '0';
    }

    let epoch = Math.round(new Date().getTime() / 1000.0);
    let time = Math.floor(epoch / 30).toString(16).padStart(16, '0');

    // Create HMAC SHA-1
    const hmac = crypto.createHmac('sha1', Buffer.from(key, 'hex'));
    hmac.update(Buffer.from(time, 'hex'));
    const hash = hmac.digest();

    let offset = hash[hash.length - 1] & 0xf;
    let binary =
        ((hash[offset] & 0x7f) << 24) |
        ((hash[offset + 1] & 0xff) << 16) |
        ((hash[offset + 2] & 0xff) << 8) |
        (hash[offset + 3] & 0xff);

    let otp = (binary % 1000000).toString().padStart(6, '0');
    return otp;
}

async function scrapeGYG(email, password, secret) {
    const MAX_RETRIES = 3;
    let attempt = 0;
    let success = false;
    let lastError = null;
    const cachedRows = readJsonSafe(CACHE_FILE);
    const cacheMap = buildCacheMap(cachedRows);
    const activityIdByTitle = new Map();
    const performanceByTourId = new Map();

    const headless = parseEnvBool('BROWSER_HEADLESS', true);
    console.log(`[INFO] Playwright launch config: headless=${headless} (BROWSER_HEADLESS=${process.env.BROWSER_HEADLESS ?? 'unset'})`);
    const maxReviewProducts = parseEnvInt('GYG_MAX_REVIEW_PRODUCTS', 0);
    if (maxReviewProducts > 0) {
        console.log(`[INFO] Limiting per-product review scraping to ${maxReviewProducts} products (GYG_MAX_REVIEW_PRODUCTS=${process.env.GYG_MAX_REVIEW_PRODUCTS}).`);
    }

    const usePortalReviews = parseEnvBool('GYG_USE_PORTAL_REVIEWS', false);
    if (!usePortalReviews) {
        console.log('[INFO] Skipping supplier-portal per-product review links (GYG_USE_PORTAL_REVIEWS=false).');
    }

    const maxLoginRetries = parseEnvInt('GYG_LOGIN_MAX_RETRIES', 6);
    const maxProductsRetries = parseEnvInt('GYG_PRODUCTS_MAX_RETRIES', 5);
    const productsSettleMs = parseEnvInt('GYG_PRODUCTS_SETTLE_MS', 15000);
    const productsReloadWaitMs = parseEnvInt('GYG_PRODUCTS_RELOAD_WAIT_MS', 12000);

    while (attempt < MAX_RETRIES && !success) {
        attempt++;
        console.log(`\n--- Starting Scrape Attempt ${attempt} of ${MAX_RETRIES} ---`);
        
        const browser = await chromium.launch({
            headless,
            args: [
                '--disable-infobars',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
            ],
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', // Updated user agent
            viewport: { width: 1920, height: 1080 },
            deviceScaleFactor: 1,
            hasTouch: false,
            isMobile: false,
            locale: 'en-US',
            timezoneId: 'Africa/Cairo',
            permissions: ['geolocation']
        });

        const page = await context.newPage();

        let apiProductsData = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('graphql') || url.includes('performance')) {
                try {
                    const json = await response.json();
                    // Just dump all responses to a file for debugging
                    fs.appendFileSync('debug_all_api.log', JSON.stringify({url, json}) + '\n\n');
                    
                    // Look for product analytics data
                    if (json.data && json.data.supplierDashboard && json.data.supplierDashboard.productPerformance) {
                        apiProductsData = json.data.supplierDashboard.productPerformance;
                    } else if (json.products && Array.isArray(json.products)) {
                        apiProductsData = json.products;
                    } else if (json.data && Array.isArray(json.data) && json.data[0] && json.data[0].revenue) {
                        apiProductsData = json.data;
                    }

                    const items = json && json.data && json.data.activitySearch && Array.isArray(json.data.activitySearch.items)
                        ? json.data.activitySearch.items
                        : null;
                    if (items) {
                        for (const it of items) {
                            const id = it && it.id ? String(it.id).trim() : "";
                            const title = it && it.sourceText && it.sourceText.title ? String(it.sourceText.title) : "";
                            if (!id || !title) continue;
                            const normalized = normalizeTitle(title);
                            const simplified = simplifyTitle(title);
                            if (normalized) activityIdByTitle.set(normalized.toLowerCase(), id);
                            if (simplified) activityIdByTitle.set(simplified, id);
                        }
                    }

                    if (url.includes('/nuxt_api/auth/') && url.includes('/performance/product') && json && json.data) {
                        const conv = Array.isArray(json.data.productPerformanceConversionRate) ? json.data.productPerformanceConversionRate : [];
                        const bookings = Array.isArray(json.data.productPerformanceBookings) ? json.data.productPerformanceBookings : [];
                        const rating = Array.isArray(json.data.productPerformanceRating) ? json.data.productPerformanceRating : [];

                        for (const b of bookings) {
                            const id = b && b['fact_booking.tour_id'] !== undefined ? String(b['fact_booking.tour_id']) : '';
                            const val = b && b['fact_booking.bookings'] !== undefined ? Number(b['fact_booking.bookings']) : null;
                            if (id) {
                                const cur = performanceByTourId.get(id) || {};
                                if (Number.isFinite(val)) cur.bookings = val;
                                performanceByTourId.set(id, cur);
                            }
                        }
                        for (const r of rating) {
                            const id = r && r['fact_booking.tour_id'] !== undefined ? String(r['fact_booking.tour_id']) : '';
                            const val = r && r['review.average_rating'] !== undefined ? Number(r['review.average_rating']) : null;
                            if (id) {
                                const cur = performanceByTourId.get(id) || {};
                                if (Number.isFinite(val)) cur.rating = val;
                                performanceByTourId.set(id, cur);
                            }
                        }
                        for (const c of conv) {
                            const id = c && c['tour_cr.tour_id'] !== undefined ? String(c['tour_cr.tour_id']) : '';
                            const val = c && c['tour_cr.tour_cr'] !== undefined ? Number(c['tour_cr.tour_cr']) : null;
                            if (id) {
                                const cur = performanceByTourId.get(id) || {};
                                if (Number.isFinite(val)) cur.conversionRate = val;
                                performanceByTourId.set(id, cur);
                            }
                        }
                    }
                } catch (e) {}
            }
        });

        const SESSION_FILE = path.join(__dirname, 'gyg_session.json');

        const securityMaxWaitMs = parseEnvInt('GYG_SECURITY_MAX_WAIT_MS', 180000);
        const securityReloadAfterMs = parseEnvInt('GYG_SECURITY_RELOAD_AFTER_MS', 30000);

        async function isSecurityVerificationPage() {
            try {
                const url = page.url() || '';
                const title = (await page.title().catch(() => '')) || '';
                const bodyText = (await page.textContent('body').catch(() => '')) || '';
                const t = title.toLowerCase();
                const b = bodyText.toLowerCase();
                return (
                    url.includes('cdn-cgi') ||
                    t.includes('security verification') ||
                    b.includes('performing security verification') ||
                    b.includes('cloudflare')
                );
            } catch {
                return false;
            }
        }

        async function waitForSecurityVerification() {
            const start = Date.now();
            let didReload = false;
            while (Date.now() - start < securityMaxWaitMs) {
                const isVerify = await isSecurityVerificationPage();
                if (!isVerify) return;

                if (headless) {
                    throw new Error(
                        'Security verification page detected. Re-run with BROWSER_HEADLESS=false to complete verification in the browser.',
                    );
                }

                if (!didReload && Date.now() - start >= securityReloadAfterMs) {
                    didReload = true;
                    try {
                        console.warn('[SECURITY] Verification still pending. Reloading the page once...');
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                    } catch {}
                }

                console.warn(
                    '[SECURITY] Waiting for security verification to complete. Please finish the verification in the opened browser window...',
                );
                await page.waitForTimeout(3000);
            }

            if (await isSecurityVerificationPage()) {
                try {
                    await page.screenshot({ path: 'debug_security_verification.png' });
                } catch {}
                throw new Error(
                    `Security verification did not complete within ${Math.round(securityMaxWaitMs / 1000)}s. Try again or complete it manually in the browser and re-run.`,
                );
            }
        }

        async function clearAuthState(reason) {
            console.warn(`[AUTH] Clearing auth state: ${reason}`);
            try { await context.clearCookies(); } catch {}
            try {
                await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(500);
            } catch {}
            try {
                await page.goto('https://supplier.getyourguide.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForTimeout(1500);
                await page.evaluate(() => {
                    try { localStorage.clear(); } catch {}
                    try { sessionStorage.clear(); } catch {}
                });
            } catch {}
            try {
                if (fs.existsSync(SESSION_FILE)) {
                    fs.unlinkSync(SESSION_FILE);
                }
            } catch {}
        }

        async function hasSessionErrorBanner() {
            try {
                const el = await page.$('text="There was an error with your session"');
                return !!el;
            } catch {
                return false;
            }
        }

        async function performLogin() {
            console.log("Navigating to login page...");
            await page.goto('https://supplier.getyourguide.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await waitForSecurityVerification();
            await page.waitForTimeout(3000);

            try {
                const cookieBtn = await page.$('button:has-text("I agree"), button:has-text("Accept")');
                if (cookieBtn) {
                    await cookieBtn.click();
                    await page.waitForTimeout(2000);
                }
            } catch(e) {}

            try {
                if (await hasSessionErrorBanner()) {
                    await clearAuthState('Session error banner on login page');
                    await page.goto('https://supplier.getyourguide.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await page.waitForTimeout(2000);
                }
            } catch(e) {}

            console.log("Filling login credentials...");
            await page.fill('input[type="email"], input[name="email"]', email);
            await page.waitForTimeout(1000);
            await page.fill('input[type="password"], input[name="password"]', password);
            await page.waitForTimeout(1000);
            await page.click('button:has-text("Log in"), button[type="submit"]');

            try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch(e) {}
            await page.waitForTimeout(3000);

            const is2FA = await page.url().includes('second-factor');
            if (is2FA) {
                console.log("2FA requested. Generating token...");
                const token = generateTOTP(secret);
                
                await page.waitForSelector('input[inputmode="numeric"]', { timeout: 10000 });
                const inputs = await page.$$('input[inputmode="numeric"]');
                
                if(inputs.length === 6) {
                    await inputs[0].click();
                    await page.waitForTimeout(500);
                    for (let i = 0; i < 6; i++) {
                        await inputs[i].fill(token[i]);
                        await page.waitForTimeout(400);
                    }
                    await page.waitForTimeout(1500);
                    await page.click('button:has-text("Verify code")');
                } else {
                     const singleInput = await page.$('input[name="code"]');
                     if(singleInput) {
                         await singleInput.fill(token);
                         await page.waitForTimeout(1000);
                         await page.click('button:has-text("Verify code")');
                     }
                }
                
                try { await page.waitForNavigation({ timeout: 15000 }); } catch (e) {}
            }

            await page.waitForTimeout(5000);

            if (await hasSessionErrorBanner()) {
                await clearAuthState('Session error banner after submitting login');
                throw new Error('Session error banner persisted after login submit');
            }
            
            if (page.url().includes('/auth/login') || page.url().includes('second-factor')) {
                throw new Error("Still on login or 2FA page. Login failed.");
            }

            try {
                await page.waitForSelector('text=Ahmed', { timeout: 15000 });
            } catch(e) {
                await page.waitForLoadState('networkidle', { timeout: 15000 });
            }
            
            console.log("Adding human-like delay...");
            await page.waitForTimeout(5000); 
            await page.mouse.move(100, 200);
            await page.waitForTimeout(2000);
            await page.mouse.wheel(0, 500);
            await page.waitForTimeout(3000);

            console.log("Saving session cookies...");
            const cookies = await context.cookies();
            fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
        }

        async function ensureLoggedIn() {
            for (let i = 1; i <= maxLoginRetries; i++) {
                try {
                    console.log(`[AUTH] Login attempt ${i}/${maxLoginRetries}`);
                    await performLogin();
                    try {
                        await page.goto('https://supplier.getyourguide.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
                        await page.waitForTimeout(4000);
                    } catch {}
                    return;
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    console.warn(`[AUTH] Login attempt ${i} failed: ${msg}`);
                    try { await page.screenshot({ path: `debug_login_attempt_${i}.png` }); } catch {}
                    if (i < maxLoginRetries) {
                        try { await page.waitForTimeout(5000 + i * 3000); } catch {}
                    } else {
                        throw e;
                    }
                }
            }
        }

        async function navigateWithLogin(targetUrl) {
            console.log(`Navigating to: ${targetUrl}`);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await waitForSecurityVerification();
            await page.waitForTimeout(5000);

            if (page.url().includes('/auth/login') || page.url().includes('second-factor')) {
                console.log("Session invalid or logged out. Performing login...");
                await ensureLoggedIn();
                console.log(`Navigating back to: ${targetUrl}`);
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await waitForSecurityVerification();
                await page.waitForTimeout(5000);
            }
        }

        async function loadProductsTable(targetUrl) {
            for (let i = 1; i <= maxProductsRetries; i++) {
                console.log(`[PRODUCTS] Load attempt ${i}/${maxProductsRetries}`);
                try {
                    await navigateWithLogin(targetUrl);
                    if (await isServiceErrorPage(page)) {
                        throw new Error("Service error page (We'll be right back)");
                    }

                    console.log(`Waiting for page internal API calls to settle (${productsSettleMs} ms)...`);
                    await page.waitForTimeout(productsSettleMs);

                    console.log('Waiting for "Performance by product" section and table...');
                    await page.waitForSelector('text=/Performance by product/i', { timeout: 60000 });
                    await page.waitForSelector('table tbody tr', { timeout: 60000 });
                    await page.waitForFunction(() => {
                        const heading = Array.from(document.querySelectorAll('*')).find((el) => {
                            const t = el && el.textContent ? el.textContent.trim() : '';
                            return /^Performance by product/i.test(t);
                        });
                        const table = document.querySelector('table');
                        if (!heading || !table) return false;
                        const rows = table.querySelectorAll('tbody tr');
                        if (!rows || rows.length === 0) return false;
                        const first = rows[0];
                        const tds = first ? first.querySelectorAll('td') : null;
                        if (!tds || tds.length < 5) return false;
                        const product = tds[0] && tds[0].textContent ? tds[0].textContent.trim() : '';
                        return Boolean(product);
                    }, { timeout: 60000 });
                    return;
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    console.warn(`[PRODUCTS] Load attempt ${i} failed: ${msg}`);
                    try {
                        await page.screenshot({ path: `debug_products_load_attempt_${i}.png` });
                        const errHtml = await page.evaluate(() => document.body && document.body.innerHTML ? document.body.innerHTML : "");
                        fs.writeFileSync(`debug_products_load_attempt_${i}.html`, errHtml);
                    } catch {}

                    try {
                        if (page.url().includes('/auth/login') || page.url().includes('second-factor')) {
                            console.log("[PRODUCTS] Detected login while loading products. Re-authenticating...");
                            await ensureLoggedIn();
                        }
                    } catch {}

                    try {
                        const loading = await page.evaluate(() => {
                            const table = document.querySelector('table');
                            if (!table) return true;
                            const rows = table.querySelectorAll('tbody tr');
                            if (!rows || rows.length === 0) return true;
                            const first = rows[0];
                            return !!(first && first.querySelector('.p-skeleton'));
                        });
                        if (loading) console.warn('[PRODUCTS] Table still loading / empty. Will reload and retry.');
                    } catch {}

                    if (i < maxProductsRetries) {
                        try {
                            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
                        } catch {}
                        await page.waitForTimeout(productsReloadWaitMs);
                    } else {
                        throw e;
                    }
                }
            }
        }

        async function isServiceErrorPage(p) {
            try {
                const text = await p.evaluate(() => (document.body && document.body.innerText ? document.body.innerText : ""));
                const normalized = String(text).toLowerCase();
                return normalized.includes("an error occurred") && normalized.includes("we’ll be right back".toLowerCase()) ||
                    normalized.includes("an error occurred") && normalized.includes("we'll be right back");
            } catch {
                return false;
            }
        }

        async function acceptCookieBannerIfPresent(p) {
            try {
                const btn = await p.$('button:has-text("Accept"), button:has-text("I agree"), button:has-text("Agree"), button:has-text("Accept all")');
                if (btn) {
                    await btn.click();
                    await p.waitForTimeout(1000);
                }
            } catch {}
        }

        async function scrapePublicSupplierReviewsCounts() {
            const enabled = parseEnvBool('GYG_PUBLIC_SUPPLIER_REVIEWS', true);
            if (!enabled) {
                console.log('[PUBLIC] Supplier-page reviews scrape disabled (GYG_PUBLIC_SUPPLIER_REVIEWS=false).');
                return new Map();
            }

            const supplierUrl = process.env.GYG_PUBLIC_SUPPLIER_URL || 'https://www.getyourguide.com/fts-travelss-s707722/';
            const maxActivities = parseEnvInt('GYG_PUBLIC_MAX_ACTIVITIES', 0);
            const targetIds = new Set(parseEnvCsv('GYG_PUBLIC_TARGET_IDS'));
            const MAX_ACTIVITY_RETRIES = 3;

            const p = await context.newPage();
            const results = new Map();
            try {
                console.log(`[PUBLIC] Opening supplier page: ${supplierUrl}`);
                await p.goto(supplierUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await p.waitForTimeout(3000);
                await acceptCookieBannerIfPresent(p);

                if (await isServiceErrorPage(p)) {
                    console.warn('[PUBLIC] Supplier page shows service error. Skipping public scrape.');
                    return results;
                }

                await p.waitForLoadState('domcontentloaded');
                await p.waitForTimeout(2000);

                try {
                    for (let i = 0; i < 4; i++) {
                        await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await p.waitForTimeout(1500);
                    }
                } catch {}

                const activityLinks = await p.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a[href]'))
                        .map((a) => a.getAttribute('href'))
                        .filter(Boolean)
                        .map((h) => String(h));

                    const normalizeHref = (h) => {
                        try {
                            return new URL(h, location.origin).toString();
                        } catch {
                            return null;
                        }
                    };

                    const candidates = links
                        .map(normalizeHref)
                        .filter(Boolean)
                        .filter((u) => /t\d{4,}/.test(u));

                    const uniq = [];
                    const seen = new Set();
                    for (const u of candidates) {
                        if (seen.has(u)) continue;
                        seen.add(u);
                        uniq.push(u);
                    }
                    return uniq;
                });

                const filtered = activityLinks.filter((u) => /t\d{4,}/.test(u));
                let toProcess = filtered;
                if (targetIds.size > 0) {
                    toProcess = filtered.filter((u) => {
                        const m = u.match(/t(\d{4,})/);
                        return m && targetIds.has(m[1]);
                    });
                }
                if (maxActivities > 0) {
                    toProcess = toProcess.slice(0, maxActivities);
                }
                console.log(`[PUBLIC] Found ${filtered.length} activity links; processing ${toProcess.length}.`);

                for (const url of toProcess) {
                    const idMatch = url.match(/t(\d{4,})/);
                    const productId = idMatch ? idMatch[1] : null;
                    if (!productId) continue;
                    if (results.has(productId)) continue;

                    for (let attemptNo = 1; attemptNo <= MAX_ACTIVITY_RETRIES; attemptNo++) {
                        console.log(`[PUBLIC] Activity t${productId}: attempt ${attemptNo}/${MAX_ACTIVITY_RETRIES}`);
                        try {
                            await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                            await p.waitForTimeout(2500);
                            await acceptCookieBannerIfPresent(p);

                            if (await isServiceErrorPage(p)) {
                                throw new Error("Service error page (We'll be right back)");
                            }

                            const selector = '#top-rating-adp > span.simple-activity-rating--reviews-count > a > span > span > span';
                            let text = null;
                            try {
                                await p.waitForSelector(selector, { timeout: 15000 });
                                text = await p.$eval(selector, (el) => (el && el.textContent ? el.textContent : ''));
                            } catch {
                                const fallback = await p.evaluate(() => {
                                    const body = document.body && document.body.innerText ? document.body.innerText : '';
                                    const m = String(body).match(/\b(\d{1,3}(?:,\d{3})*)\s+reviews\b/i);
                                    return m ? m[1] : null;
                                });
                                text = fallback || '';
                            }

                            const n = parseNumberFromText(text);
                            if (n && /^\d+$/.test(String(n))) {
                                results.set(productId, n);
                                console.log(`[PUBLIC] Activity t${productId}: totalReviews=${n}`);
                                break;
                            }

                            const isNoReviews = await p.evaluate(() => {
                                const body = document.body && document.body.innerText ? document.body.innerText : '';
                                const txt = String(body).toLowerCase();
                                if (txt.includes('no reviews')) return true;
                                if (txt.includes('be the first to review')) return true;
                                if (txt.includes('this activity has no reviews')) return true;
                                return false;
                            });
                            if (isNoReviews) {
                                results.set(productId, '0');
                                console.log(`[PUBLIC] Activity t${productId}: totalReviews=0 (no reviews yet)`);
                                break;
                            }

                            throw new Error('Could not parse total reviews count');
                        } catch (e) {
                            const msg = e && e.message ? e.message : String(e);
                            console.warn(`[PUBLIC] Activity t${productId}: failed attempt ${attemptNo}: ${msg}`);
                            try { await p.screenshot({ path: `debug_public_activity_t${productId}_attempt_${attemptNo}.png` }); } catch {}
                            if (attemptNo < MAX_ACTIVITY_RETRIES) {
                                await p.waitForTimeout(3000 + attemptNo * 2000);
                            }
                        }
                    }

                    if (!results.has(productId)) {
                        results.set(productId, '0');
                        console.log(`[PUBLIC] Activity t${productId}: totalReviews=0 (default)`);
                    }
                }

                return results;
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                console.warn(`[PUBLIC] Supplier scrape failed: ${msg}`);
                try { await p.screenshot({ path: `debug_public_supplier_error.png` }); } catch {}
                return results;
            } finally {
                try { await p.close(); } catch {}
            }
        }

        async function extractReviewsReceivedValue() {
            return await page.evaluate(() => {
                const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
                const rawText = document.body && document.body.innerText ? document.body.innerText : "";
                const bodyText = normalize(rawText);
                if (!bodyText) return null;

                const label = "reviews received";
                if (!bodyText.includes(label)) return null;

                const direct = String(rawText).replace(/\s+/g, " ").match(/reviews received\s*([0-9][0-9,]*)/i);
                if (direct && direct[1]) return direct[1].replace(/,/g, "");

                const candidates = Array.from(document.querySelectorAll('div, span, p, h1, h2, h3, h4, h5, h6'))
                    .map((el) => ({ el, t: normalize(el.innerText) }))
                    .filter((x) => x.t === label || x.t.includes(label));

                const pickNumberFromText = (t) => {
                    const m = String(t).match(/\b\d{1,3}(?:,\d{3})*\b/);
                    return m ? m[0].replace(/,/g, "") : null;
                };

                for (const c of candidates.slice(0, 20)) {
                    const root = c.el.closest('section, article, div') || c.el.parentElement;
                    if (!root) continue;

                    const nearbyText = normalize(root.innerText);
                    const num = pickNumberFromText(nearbyText);
                    if (num) return num;

                    const next = c.el.nextElementSibling;
                    if (next) {
                        const num2 = pickNumberFromText(next.innerText);
                        if (num2) return num2;
                    }
                }

                return null;
            });
        }

        async function getPeriodReviewsForProduct(productId, startDate, endDate) {
            const targetUrl = `https://supplier.getyourguide.com/performance/analytics?pf_start_date=${startDate}&pf_end_date=${endDate}&active_tab=reviews&pf_product=${productId}`;
            const MAX_LINK_RETRIES = 3;

            for (let i = 1; i <= MAX_LINK_RETRIES; i++) {
                console.log(`[REVIEWS] Product ${productId}: attempt ${i}/${MAX_LINK_RETRIES}`);
                try {
                    await navigateWithLogin(targetUrl);

                    if (await isServiceErrorPage(page)) {
                        throw new Error("Service error page (We'll be right back)");
                    }

                    const value = await extractReviewsReceivedValue();
                    if (value && /^\d+$/.test(String(value))) {
                        console.log(`[REVIEWS] Product ${productId}: Reviews received=${value}`);
                        return value;
                    }

                    throw new Error("Could not locate Reviews received value");
                } catch (e) {
                    const msg = e && e.message ? e.message : String(e);
                    console.warn(`[REVIEWS] Product ${productId}: failed attempt ${i}: ${msg}`);
                    try {
                        await page.screenshot({ path: `debug_reviews_${productId}_attempt_${i}.png` });
                    } catch {}
                    if (i < MAX_LINK_RETRIES) {
                        await page.waitForTimeout(5000 + i * 2000);
                    }
                }
            }
            console.warn(`[REVIEWS] Product ${productId}: giving up after ${MAX_LINK_RETRIES} attempts`);
            return null;
        }

        try {
            const publicOnly = parseEnvBool('GYG_PUBLIC_ONLY', false);
            if (publicOnly) {
                const publicTotalsByProductId = await scrapePublicSupplierReviewsCounts();
                const rows = Array.from(publicTotalsByProductId.entries()).map(([productId, total]) => ({
                    productId,
                    productName: '',
                    periodReviews: String(total)
                }));
                writeJsonSafe(OUTPUT_FILE, rows);
                console.log(`[PUBLIC] Wrote ${rows.length} rows to gyg_analytics.json (GYG_PUBLIC_ONLY=true).`);
                success = true;
                continue;
            }

            // Calculate Dates based on Cairo Time (UTC+2)
            const now = new Date();
            // Create a date object offset to Cairo time
            const cairoTime = new Date(now.toLocaleString("en-US", {timeZone: "Africa/Cairo"}));
            // Subtract one day to get yesterday's date in Cairo
            cairoTime.setDate(cairoTime.getDate() - 1);
            
            // Format to YYYY-MM-DD
            const year = cairoTime.getFullYear();
            const month = String(cairoTime.getMonth() + 1).padStart(2, '0');
            const day = String(cairoTime.getDate()).padStart(2, '0');
            
            const endDate = `${year}-${month}-${day}`;
            const startDate = "2026-01-11"; 

            const analyticsUrl = 'https://supplier.getyourguide.com/performance?managed_by=707722&page=1&duration=all';
            
            if (fs.existsSync(SESSION_FILE)) {
                console.log("Found session file. Attempting to restore session...");
                try {
                    const sessionData = fs.readFileSync(SESSION_FILE, 'utf8');
                    const cookies = JSON.parse(sessionData);
                    if (cookies && cookies.length > 0) {
                        await context.addCookies(cookies);
                        console.log("Cookies loaded.");
                    }
                } catch (e) {
                    console.error("Failed to load session cookies:", e.message);
                }
            }

            await loadProductsTable(analyticsUrl);

            // Monitor for unexpected logouts during the process
            page.on('framenavigated', async (frame) => {
                if (frame === page.mainFrame()) {
                    const url = frame.url();
                    if (url.includes('/auth/login')) {
                        console.error("Unexpected logout detected during navigation! URL: " + url);
                    }
                }
            });

            console.log('Extracting "Performance by product" table (all pages)...');

            async function getPaginatorMaxPage() {
                try {
                    const nums = await page.$$eval('.p-paginator-page', (els) =>
                        els
                            .map((el) => (el && el.textContent ? el.textContent.trim() : ''))
                            .map((t) => parseInt(t, 10))
                            .filter((n) => Number.isFinite(n) && n > 0),
                    );
                    if (!nums || nums.length === 0) return 1;
                    return Math.max(...nums);
                } catch {
                    return 1;
                }
            }

            async function getFirstProductText() {
                try {
                    return await page.evaluate(() => {
                        const table = document.querySelector('table');
                        const first = table ? table.querySelector('tbody tr') : null;
                        const td = first ? first.querySelector('td') : null;
                        return td && td.textContent ? td.textContent.trim() : '';
                    });
                } catch {
                    return '';
                }
            }

            async function extractCurrentPageRows() {
                return await page.evaluate(() => {
                    const results = [];
                    const heading = Array.from(document.querySelectorAll('*')).find((el) => {
                        const t = el && el.textContent ? el.textContent.trim() : '';
                        return /^Performance by product/i.test(t);
                    });
                    let root = heading;
                    while (root && root !== document.body) {
                        if (root.querySelector && root.querySelector('table tbody tr')) break;
                        root = root.parentElement;
                    }
                    const table = root && root.querySelector ? root.querySelector('table') : document.querySelector('table');
                    if (!table) return results;

                    const rows = Array.from(table.querySelectorAll('tbody tr'));
                    rows.forEach((row, index) => {
                        if (row.querySelector('.p-skeleton')) return;
                        const cells = row.querySelectorAll('td');
                        if (!cells || cells.length < 5) return;

                        // Fix Data Bleeding: Extract clean title using the internal structure
                        let title = "";
                        const titleSpan = cells[0].querySelector('a > span');
                        if (titleSpan && titleSpan.textContent) {
                            title = titleSpan.textContent.trim().replace(/[\u200e\u200f\ufeff\u2060]/g, '');
                        } else {
                            title = cells[0] && cells[0].textContent ? cells[0].textContent.trim().replace(/[\u200e\u200f\ufeff\u2060]/g, '') : '';
                            if (title.includes('Revenue') || title.includes('Bookings') || title.includes('Conversion')) {
                                title = title.split(/(?:Revenue|Bookings|Conversion)/i)[0].trim();
                            }
                        }

                        if (!title) return;

                        let productId = '';
                        const link = row.querySelector('a[href]');
                        if (link && link.getAttribute('href')) {
                            const href = link.getAttribute('href');
                            const abs = (() => {
                                try { return new URL(href, location.origin).toString(); } catch { return href; }
                            })();
                            const m1 = abs.match(/pf_product=(\d+)/);
                            const m2 = abs.match(/t(\d{4,})/);
                            const m3 = abs.match(/product[=/](\d+)/i);
                            productId = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || '';
                        }

                        results.push({
                            id: index + 1,
                            productId,
                            productName: title,
                            revenue: cells[1] && cells[1].textContent ? cells[1].textContent.trim() : '',
                            bookings: cells[3] && cells[3].textContent ? cells[3].textContent.trim() : '',
                            conversionRate: cells[2] && cells[2].textContent ? cells[2].textContent.trim() : '',
                            rating: cells[4] && cells[4].textContent ? cells[4].textContent.trim() : '',
                        });
                    });
                    return results;
                });
            }

            const maxPage = await getPaginatorMaxPage();
            const allRows = [];
            for (let pNo = 1; pNo <= maxPage; pNo++) {
                if (pNo > 1) {
                    const prev = await getFirstProductText();
                    const btn = page.locator(`.p-paginator-page[aria-label="Page ${pNo}"]`).first();
                    await btn.click({ timeout: 15000 });
                    await page.waitForTimeout(500);
                    await page.waitForFunction((prevText) => {
                        const table = document.querySelector('table');
                        const first = table ? table.querySelector('tbody tr') : null;
                        const td = first ? first.querySelector('td') : null;
                        const cur = td && td.textContent ? td.textContent.trim() : '';
                        return cur && cur !== prevText;
                    }, prev, { timeout: 60000 });
                    if (await isServiceErrorPage(page)) {
                        throw new Error("Service error page (We'll be right back)");
                    }
                }

                const rows = await extractCurrentPageRows();
                console.log(`[PRODUCTS] Page ${pNo}/${maxPage}: extracted ${rows.length} rows.`);
                allRows.push(...rows);
            }

            console.log(`Extracted ${allRows.length} rows from Performance by product.`);
            if (!allRows || allRows.length === 0) {
                throw new Error('Products table returned 0 rows (likely logged out or DOM changed).');
            }

            let finalData = allRows;

            if (activityIdByTitle.size > 0) {
                console.log(`[INFO] Captured ${activityIdByTitle.size} activity ids from API responses.`);
            }
            if (performanceByTourId.size > 0) {
                console.log(`[INFO] Captured ${performanceByTourId.size} tour performance ids from API responses.`);
            }

            finalData = finalData.map((row) => {
                const existingId = row.productId ? String(row.productId).trim() : "";
                if (existingId) return row;
                const name = row.productName ? String(row.productName) : "";
                const normalized = normalizeTitle(name);
                const simplified = simplifyTitle(name);
                let fromApi = null;
                if (normalized) fromApi = activityIdByTitle.get(normalized.toLowerCase()) || null;
                if (!fromApi && simplified) fromApi = activityIdByTitle.get(simplified) || null;
                if (!fromApi && (normalized || simplified) && activityIdByTitle.size > 0) {
                    const n = (normalized || '').toLowerCase();
                    const s = simplified || '';
                    let best = null;
                    for (const [k, id] of activityIdByTitle.entries()) {
                        if (!k) continue;
                        if (n && (n.includes(k) || k.includes(n))) {
                            if (!best || k.length > best.k.length) best = { k, id };
                            continue;
                        }
                        if (s && (s.includes(k) || k.includes(s))) {
                            if (!best || k.length > best.k.length) best = { k, id };
                        }
                    }
                    fromApi = best ? best.id : null;
                }
                return {
                    ...row,
                    productId: fromApi || ""
                };
            });

            const parseIntLoose = (s) => {
                const n = Number(String(s || '').replace(/,/g, '').trim());
                return Number.isFinite(n) ? Math.trunc(n) : null;
            };
            const parseFloatLoose = (s) => {
                const n = Number(String(s || '').replace(/,/g, '').replace('%', '').trim());
                return Number.isFinite(n) ? n : null;
            };

            if (performanceByTourId.size > 0) {
                finalData = finalData.map((row) => {
                    const existingId = row.productId ? String(row.productId).trim() : '';
                    if (existingId) return row;

                    const rowBookings = parseIntLoose(row.bookings);
                    const rowRating = parseFloatLoose(row.rating);
                    const rowCrPct = parseFloatLoose(row.conversionRate);
                    const rowCr = Number.isFinite(rowCrPct) ? rowCrPct / 100 : null;

                    let best = null;
                    for (const [tourId, perf] of performanceByTourId.entries()) {
                        let score = 0;
                        if (rowBookings !== null && Number.isFinite(perf.bookings)) {
                            if (perf.bookings === rowBookings) score += 6;
                            else if (Math.abs(perf.bookings - rowBookings) <= 2) score += 4;
                        }
                        if (rowRating !== null && Number.isFinite(perf.rating)) {
                            if (Math.abs(perf.rating - rowRating) <= 0.02) score += 5;
                            else if (Math.abs(perf.rating - rowRating) <= 0.05) score += 3;
                        }
                        if (rowCr !== null && Number.isFinite(perf.conversionRate)) {
                            if (Math.abs(perf.conversionRate - rowCr) <= 0.001) score += 3;
                            else if (Math.abs(perf.conversionRate - rowCr) <= 0.003) score += 1;
                        }
                        if (score > 0 && (!best || score > best.score)) {
                            best = { tourId, score };
                        }
                    }

                    if (best && best.score >= 6) {
                        return {
                            ...row,
                            productId: best.tourId
                        };
                    }

                    return row;
                });
            }

            if (parseEnvBool('GYG_DEBUG_TITLE_MATCH', false)) {
                for (const row of finalData.slice(0, 15)) {
                    const rawName = row.productName ? String(row.productName) : '';
                    const normalized = rawName
                        .replace(/[\u200e\u200f\ufeff\u2060]/g, '')
                        .replace(/^\d+\s*/i, '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                    const hit = normalized ? activityIdByTitle.get(normalized) : null;
                    console.log(`[DEBUG] titleMatch: name="${rawName.replace(/\s+/g, ' ').trim()}" normalized="${normalized}" hit=${hit || 'none'}`);
                }
            }

            const processed = new Set();
            const periodReviewsByProductId = new Map();
            let missingProductId = 0;
            if (usePortalReviews) {
                for (const row of finalData) {
                    const productId = row.productId ? String(row.productId).trim() : "";
                    if (!productId) {
                        missingProductId++;
                        continue;
                    }
                    if (processed.has(productId)) continue;
                    if (maxReviewProducts > 0 && processed.size >= maxReviewProducts) {
                        break;
                    }
                    processed.add(productId);

                    const value = await getPeriodReviewsForProduct(productId, startDate, endDate);
                    if (value) {
                        periodReviewsByProductId.set(productId, value);
                    }

                    await page.waitForTimeout(1500);
                }

                if (missingProductId > 0) {
                    console.warn(`[REVIEWS] Skipped ${missingProductId} rows with missing productId (pf_product).`);
                }

                console.log(`[REVIEWS] Completed per-product review scraping: success=${periodReviewsByProductId.size}, total=${processed.size}`);
            }

            const publicTotalsByProductId = await scrapePublicSupplierReviewsCounts();
            if (publicTotalsByProductId && publicTotalsByProductId.size > 0) {
                console.log(`[PUBLIC] Collected total reviews for ${publicTotalsByProductId.size} activities from supplier page.`);
            }

            finalData = finalData.map((row) => {
                const productId = row.productId ? String(row.productId).trim() : "";
                const fromLink = productId ? periodReviewsByProductId.get(productId) : null;
                const fromPublic = productId ? publicTotalsByProductId.get(productId) : null;
                const fromCacheById = productId ? cacheMap.get(`id:${productId}`)?.periodReviews : null;
                const fromCacheByName = row.productName ? cacheMap.get(`name:${row.productName.toLowerCase()}`)?.periodReviews : null;
                const periodReviews = fromLink || fromPublic || fromCacheById || fromCacheByName || "-";
                return {
                    ...row,
                    periodReviews
                };
            });

            writeJsonSafe(OUTPUT_FILE, finalData);
            writeJsonSafe(CACHE_FILE, finalData);
            console.log("Final data saved to gyg_analytics.json and cache updated.");
            success = true;

        } catch (error) {
            lastError = error;
            console.error(`Attempt ${attempt} failed:`, error.message);
            await page.screenshot({ path: `error_screenshot_attempt_${attempt}.png` });
            console.log("Saved error screenshot.");
            
            if (attempt < MAX_RETRIES) {
                console.log(`Waiting 15 seconds before attempt ${attempt + 1}...`);
                await new Promise(r => setTimeout(r, 15000));
            } else {
                console.error("All attempts failed.");
            }
        } finally {
            await browser.close();
        }
    }

    if (!success) {
        if (cachedRows.length > 0) {
            writeJsonSafe(OUTPUT_FILE, cachedRows);
            console.warn("All live attempts failed. Using cached GYG analytics data to keep report generation stable.");
            return;
        }
        throw lastError || new Error("GYG scraping failed with no cached fallback available.");
    }
}

const args = process.argv.slice(2);
if (args.length !== 3) {
    console.error("Usage: node scrape.js <email> <password> <2fa_secret>");
    process.exit(1);
}

scrapeGYG(args[0], args[1], args[2]).catch((err) => {
    console.error(err.message);
    process.exit(1);
});

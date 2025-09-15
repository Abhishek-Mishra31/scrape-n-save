import express, { Request, Response } from 'express';
import puppeteer from 'puppeteer-extra';
import { Browser, Page, Protocol } from 'puppeteer';
import cors from 'cors';
import * as cheerio from 'cheerio';
import 'dotenv/config';
import fs from 'fs';
import { loginAndGetSessionCookie } from './linkedinLogin';
// Removed stealth plugin - causes timeouts on production servers

interface ScrapeRequestBody {
    profileUrl: string;
}

// -------------------- Optimisation Helpers --------------------
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        console.log("Launching shared Puppeteer browser (cold-start)…");
        browserPromise = puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            protocolTimeout: 180000, // 3 minutes for protocol timeout
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox", 
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-features=TranslateUI",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-gpu",
                "--single-process",
                "--no-zygote",
                "--renderer-process-limit=1",
                "--js-flags=--max-old-space-size=64",
                "--memory-pressure-off",
                "--disable-extensions",
                "--disable-plugins",
            ],
        });
    }
    return browserPromise;
}

let cookiesLoaded = false;
async function ensureCookies(page: Page) {
    if (cookiesLoaded) return;
    await loadCookies(page);
    cookiesLoaded = true;
}

// -------------------- Express --------------------
const app = express();
const PORT: number = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(cors());
// Stealth plugin removed entirely to prevent protocol timeouts

/**
 * Loads cookies from a JSON file or logs in to generate them,
 * then sets them on the Puppeteer page instance.
 * @param page - The Puppeteer page to set cookies on.
 */
async function loadCookies(page: Page): Promise<void> {
    let cookies: Protocol.Network.Cookie[];

    if (!fs.existsSync("linked_cookies.json")) {
        console.log("Cookies file not found, running login script...");
        const fetchedCookies = await loginAndGetSessionCookie();
        if (!fetchedCookies) {
            throw new Error("Failed to log in and get cookies.");
        }
        cookies = fetchedCookies;
        fs.writeFileSync("linked_cookies.json", JSON.stringify(cookies, null, 2));
    } else {
        const cookiesJson = fs.readFileSync("linked_cookies.json", 'utf-8');
        cookies = JSON.parse(cookiesJson);
    }
    const puppeteerCookies = cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || '.linkedin.com',
        path: cookie.path || '/',
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None' | undefined
    }));

    console.log("Setting cookies in browser...");
    await page.setCookie(...puppeteerCookies);
    console.log("Cookies loaded and set successfully.");
}

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({ message: 'LinkedIn Scraper API', status: 'running' });
});

// endpoint that will scrape the profile using linkedin profile url
app.post("/scrape", async (req: Request<{}, {}, ScrapeRequestBody>, res: Response) => {
    const { profileUrl } = req.body;

    if (!profileUrl) {
        return res.status(400).json({ error: "Profile URL is required" });
    }

    let browser: Browser;
    let page: Page | undefined;
    try {
        browser = await getBrowser();
        page = await browser.newPage();
        
        // If USE_MOBILE=true, emulate iPhone to use lightweight mobile LinkedIn
        if (process.env.USE_MOBILE === 'true') {
            const { devices } = require('puppeteer');
            const iPhone = devices['iPhone 12'];
            await page.emulate(iPhone);
        }
        
        // Block images and heavy resources to speed up scraping
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        page.setDefaultNavigationTimeout(Number(process.env.NAV_TIMEOUT_MS) || 60000);
        page.setDefaultTimeout(Number(process.env.PAGE_TIMEOUT_MS) || 60000);

        await ensureCookies(page);

        console.log("Navigating to LinkedIn profile...");
        // Use mobile site if enabled to reduce payload
        const targetUrl = process.env.USE_MOBILE === 'true'
            ? profileUrl.replace('www.linkedin.com', 'm.linkedin.com')
            : profileUrl;
        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
        });
        console.log("Navigation successful.");

        // Quick wait for profile name with fallback
        const NAME_SELECTOR = process.env.USE_MOBILE === 'true'
            ? 'div[class*="profile-topcard-person-entity__name"], h1'
            : 'h1';
        try {
            await page.waitForSelector(NAME_SELECTOR, {
                visible: true,
                timeout: Number(process.env.ELEM_TIMEOUT_MS) || 30000,
            });
        } catch(e) {
            console.warn('Name selector not found within timeout, continuing anyway');
        }

        console.log("Extracting page content using evaluate...");
        // Use page.evaluate instead of page.content() to avoid protocol timeouts
        const pageData = await page.evaluate(() => {
            const getName = () => {
                const h1 = document.querySelector('h1');
                if (h1 && h1.textContent) return h1.textContent.trim();
                const nameDiv = document.querySelector('div[class*="profile-topcard-person-entity__name"]');
                return nameDiv ? nameDiv.textContent?.trim() || '' : '';
            };
            
            const getLocation = () => {
                const locEl = document.querySelector('.text-body-small.inline.t-black--light.break-words');
                return locEl ? locEl.textContent?.trim() || '' : '';
            };
            
            return {
                name: getName(),
                location: getLocation(),
                title: document.title || '',
                url: window.location.href
            };
        });
        
        console.log(`Extracted data: name='${pageData.name}', location='${pageData.location}'`);
        
        // Use the direct extracted data
        const name: string = pageData.name || '';
        const location: string = pageData.location || '';
        // Simplified parsing - avoid heavy DOM operations that cause timeouts
        const countryDetected = location.includes(',') ? location.split(',').slice(-1)[0].trim() : '';
        
        const getFirstLast = (full: string) => {
            const parts = full.split(' ').filter(p => p);
            return {
                firstName: parts[0] || '',
                lastName: parts.slice(1).join(' ') || ''
            };
        };

        const { firstName, lastName } = getFirstLast(name);
        
        // For now, return basic profile data to prevent timeouts
        // Full scraping can be added back once core functionality is stable

        const profileData = {
            fullName: name,
            firstName,
            lastName,
            source: 'LinkedIn',
            city: (location ? location.split(',')[0] : '').trim(),
            state: (location && location.includes(',') ? location.split(',')[1] : '').trim(),
            gender: '', // Simplified for now
            country: countryDetected,
            linkedinUrl: profileUrl,
            workedPreviously: 'unknown', // Will implement after core is stable
            degree: '', // Will implement after core is stable
            workExperiences: [], // Simplified to prevent timeouts
            projectExperiences: [], // Simplified to prevent timeouts
            educationExperiences: [], // Simplified to prevent timeouts
            scrapedAt: new Date().toISOString()
        };

        const dataFile = 'scrappedData.json';
        try {
            fs.writeFileSync(dataFile, JSON.stringify(profileData, null, 2));
            console.log(`Scraped data saved to ${dataFile}`);
        } catch (writeErr) {
            console.error('Failed to write scraped data to file:', writeErr);
        }

        console.log("Scraping completed. Sending response...");
        const responsePayload = {
            ...profileData,
            message: "Profile scraped and saved successfully",
            savedTo: dataFile,
        };

        res.json(responsePayload);

    } catch (error: any) {
        console.error("Error scraping LinkedIn profile:", error);
        res.status(500).json({
            error: "Failed to scrape LinkedIn profile",
            details: error.message,
        });
    } finally {
        if (page) {
            try { await page.close(); } catch (e) { console.warn('Failed to close page', e); }
        }
    }
});

(async () => {
    if (!fs.existsSync("linked_cookies.json")) {
        console.log("Cookies file not found, running login script on startup...");
        await loginAndGetSessionCookie();
    }
})();

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

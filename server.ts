import express, { Request, Response } from 'express';
import puppeteer from 'puppeteer-extra';
import { Browser, Page, Protocol, CookieParam } from 'puppeteer';
import cors from 'cors';
import * as cheerio from 'cheerio';
import 'dotenv/config';
import fs from 'fs';
import { loginAndGetSessionCookie } from './linkedinLogin';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

interface ScrapeRequestBody {
    profileUrl: string;
}

interface ContactRequestBody {
    name: string;
    email: string;
    message: string;
}

interface SearchRequestBody {
    username: string;
}

interface LinkedInProfile {
    name: string;
    headline: string;
    location: string;
    imageUrl: string | null;
    profileUrl: string;
}

const app = express();
const PORT: number = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(cors());
puppeteer.use(StealthPlugin());

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

// endpoint that will scrape the profile using linkedin profile url
app.post("/scrape", async (req: Request<{}, {}, ScrapeRequestBody>, res: Response) => {
    const { profileUrl } = req.body;

    if (!profileUrl) {
        return res.status(400).json({ error: "Profile URL is required" });
    }

    let browser: Browser | undefined;
    try {
        console.log("Launching Puppeteer...");
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-features=TranslateUI",
                "--disable-web-security",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        });

        const page = await browser.newPage();
        // Increase default navigation timeout (can override with NAV_TIMEOUT_MS env var)
        page.setDefaultNavigationTimeout(Number(process.env.NAV_TIMEOUT_MS) || 90000);
        page.setDefaultTimeout(Number(process.env.PAGE_TIMEOUT_MS) || 90000);

        console.log("Loading cookies...");
        await loadCookies(page);
        console.log("Cookies loaded successfully.");

        console.log("Navigating to LinkedIn profile...");
        await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: Number(process.env.NAV_TIMEOUT_MS) || 90000 });
        console.log("Navigation successful.");

        console.log("Waiting for profile name element...");
        await page.waitForSelector("h1", { timeout: 60000 });
        console.log("Profile name element found.");

        const pageContent = await page.content();
        const $ = cheerio.load(pageContent);

        console.log("Scraping data...");

        const name: string = $("h1").text().trim();
        const imageUrl: string | undefined = $("div.pv-top-card--photo img").attr("src");
        const location: string = $(".text-body-small.inline.t-black--light.break-words").first().text().trim();
        
        const extractDates = (range: string) => {
            const matches = range.match(/[A-Za-z]{3}\s\d{4}/g) || [];
            const start = matches[0] || '';
            const end = /present/i.test(range) ? '' : (matches[1] || '');
            return { start, end };
        };
       
        const countryDetected = location.includes(',') ? location.split(',').slice(-1)[0].trim() : '';
        const pronounText = $('span.text-body-small.v-align-middle').first().text().trim().toLowerCase();
        let genderDetected = '';
        if (/he|him|mr\./i.test(pronounText)) {
            genderDetected = 'Male';
        } else if (/she|her|ms\.|mrs\./i.test(pronounText)) {
            genderDetected = 'Female';
        }

        const experience = $(".pvs-list__paged-list-item")
            .map((i, el) => {
                let text = $(el).text().trim().replace(/\s+/g, " ");
                return text ? text : null;
            })
            .get()
            .filter((item): item is string => item !== null);

        const education: string[] = Array.isArray(experience[1]) ? experience[1] : [];

        const projectExperiences: any[] = [];
        try {
            const projSection = $('section').filter((i, el) => $(el).find('#projects').length > 0);
            projSection.find('> div ul > li').each((i, li) => {
                const $li = $(li);
                const projectName = $li.find('div.t-bold span[aria-hidden="true"]').first().text().trim();
                if (!projectName || /screenshot|\.png|\.jpg|\.jpeg|\.gif|\.svg/i.test(projectName)) return;

                const dateRange = $li.find('span.t-14.t-normal').first().text().trim();
                let startRaw = '', endRaw = '';
                if (dateRange) {
                    const dates = extractDates(dateRange);
                    startRaw = dates.start;
                    endRaw = dates.end;
                }
                const stillWorking = /present/i.test(dateRange);
                if (stillWorking) endRaw = '';

                const description = $li.find('.inline-show-more-text--is-collapsed').text().trim();

                projectExperiences.push({
                    projectName,
                    startDate: startRaw,
                    endDate: endRaw,
                    skills: [],
                    stillWorking,
                    description,
                    gitUrl: '',
                    hostUrl: ''
                });
            });

            const uniqueProj = new Map<string, any>();
            projectExperiences.forEach(p => {
                if (!uniqueProj.has(p.projectName)) uniqueProj.set(p.projectName, p);
            });
            while (projectExperiences.length) projectExperiences.pop();
            projectExperiences.push(...Array.from(uniqueProj.values()));
        } catch (e) {
            console.warn('Failed to parse projects section', e);
        }

        let skills: string[] = [];
        try {
            const skillsSection = $('section').filter((i, el) => $(el).find('#skills').length > 0);
            skills = skillsSection.find('div.hoverable-link-text span[aria-hidden="true"], div.t-bold span[aria-hidden="true"]').map((i, el) => $(el).text().trim()).get();
            skills = Array.from(new Set(skills.filter(s => s)));
        } catch (e) {
            console.warn('Failed to parse skills section', e);
        }

        const getFirstLast = (full: string) => {
            const parts = full.split(' ').filter(p => p);
            return {
                firstName: parts[0] || '',
                lastName: parts.slice(1).join(' ') || ''
            };
        };

        const { firstName, lastName } = getFirstLast(name);

        const workExperiences: any[] = [];
        try {
            const expSection = $('section').filter((i, el) => $(el).find('#experience').length > 0);
            expSection.find('> div ul > li').each((i, li) => {
                const $li = $(li);
                const roleText = $li.find('div.hoverable-link-text span[aria-hidden="true"]').first().text().trim() ||
                    $li.find('span.t-bold span[aria-hidden="true"]').first().text().trim();

                const companyBlock = $li.find('span.t-14.t-normal').first().text().trim();
                const [companyNameRaw, workTypeRaw] = companyBlock.split(' · ').map(s => s.trim());

                const dateRange = $li.find('span.t-14.t-normal.t-black--light').first().text().trim();
                const locationText = $li.find('span.t-14.t-normal.t-black--light').eq(1).text().trim();

                const description = $li.find('.inline-show-more-text--is-collapsed').text().trim();

                const stillWorking = /present/i.test(dateRange);

                if (!roleText) return;

                workExperiences.push({
                    jobTitle: roleText,
                    companyName: companyNameRaw || '',
                    startDate: '',
                    endDate: '',
                    skills: [],
                    stillWorking,
                    description,
                    location: locationText || location,
                    workType: workTypeRaw || ''
                });
            });
            const uniqueMap = new Map<string, any>();
            workExperiences.forEach(w => {
                const key = `${w.jobTitle}|${w.companyName}`;
                if (!uniqueMap.has(key)) uniqueMap.set(key, w);
            });
            while (workExperiences.length) workExperiences.pop();
            workExperiences.push(...Array.from(uniqueMap.values()));
        } catch (e) {
            console.warn('Failed to parse experience section', e);
        }

        const educationExperiences: any[] = [];
        try {
            const eduSection = $('section').filter((i, el) => $(el).find('#education').length > 0);
            eduSection.find('> div ul > li').each((i, li) => {
                const $li = $(li);

                const collegeName = $li.find('div.hoverable-link-text span[aria-hidden="true"]').first().text().trim();
                if (!collegeName) return;

                const degreeLine = $li.find('span.t-14.t-normal').first().text().trim();
                const [degreeRaw, fieldRaw] = degreeLine.split(',').map(s => s.trim());

                const dateRange = $li.find('span.t-14.t-normal.t-black--light').first().text().trim();
                const { start: eduStart, end: eduEnd } = extractDates(dateRange);
                const startRaw = eduStart;
                const endRaw = eduEnd;
                const stillStudying = /present/i.test(dateRange);

                educationExperiences.push({
                    courseName: degreeRaw || '',
                    field: fieldRaw || '',
                    collegeName,
                    startDate: startRaw || '',
                    endDate: endRaw || '',
                    skills: [],
                    stillStudying,
                    description: degreeLine,
                    grade: '',
                    location: location || '',
                    educationType: degreeRaw || ''
                });
            });
        } catch (e) {
            console.warn('Failed to parse education section', e);
        }

        const profileData = {
            fullName: name,
            firstName,
            lastName,
            source: 'LinkedIn',
            city: (location ? location.split(',')[0] : '').trim(),
            state: (location && location.includes(',') ? location.split(',')[1] : '').trim(),
            gender: genderDetected,
            country: countryDetected,
            linkedinUrl: profileUrl,
workedPreviously: workExperiences.length > 0 ? 'yes' : 'no',
degree: (educationExperiences[0]?.courseName || educationExperiences[0]?.educationType || educationExperiences[0]?.field || ''),
            workExperiences,
            projectExperiences,
            educationExperiences,
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
        if (browser) {
            console.log("Closing Puppeteer...");
            await browser.close();
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
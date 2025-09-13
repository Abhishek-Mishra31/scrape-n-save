"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const puppeteer_extra_1 = __importDefault(require("puppeteer-extra"));
const cors_1 = __importDefault(require("cors"));
const cheerio = __importStar(require("cheerio"));
require("dotenv/config");
const fs_1 = __importDefault(require("fs"));
const linkedinLogin_1 = require("./linkedinLogin");
const puppeteer_extra_plugin_stealth_1 = __importDefault(require("puppeteer-extra-plugin-stealth"));
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT);
app.use(express_1.default.json());
app.use((0, cors_1.default)());
puppeteer_extra_1.default.use((0, puppeteer_extra_plugin_stealth_1.default)());
/**
 * Loads cookies from a JSON file or logs in to generate them,
 * then sets them on the Puppeteer page instance.
 * @param page - The Puppeteer page to set cookies on.
 */
function loadCookies(page) {
    return __awaiter(this, void 0, void 0, function* () {
        let cookies;
        if (!fs_1.default.existsSync("linked_cookies.json")) {
            console.log("Cookies file not found, running login script...");
            const fetchedCookies = yield (0, linkedinLogin_1.loginAndGetSessionCookie)();
            if (!fetchedCookies) {
                throw new Error("Failed to log in and get cookies.");
            }
            cookies = fetchedCookies;
            fs_1.default.writeFileSync("linked_cookies.json", JSON.stringify(cookies, null, 2));
        }
        else {
            const cookiesJson = fs_1.default.readFileSync("linked_cookies.json", 'utf-8');
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
            sameSite: cookie.sameSite
        }));
        console.log("Setting cookies in browser...");
        yield page.setCookie(...puppeteerCookies);
        console.log("Cookies loaded and set successfully.");
    });
}
// endpoint that will scrape the profile using linkedin profile url
app.post("/scrape", (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c;
    const { profileUrl } = req.body;
    if (!profileUrl) {
        return res.status(400).json({ error: "Profile URL is required" });
    }
    let browser;
    try {
        console.log("Launching Puppeteer...");
        browser = yield puppeteer_extra_1.default.launch({
            headless: true,
            executablePath: puppeteer_extra_1.default.executablePath(),
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        });
        const page = yield browser.newPage();
        console.log("Loading cookies...");
        yield loadCookies(page);
        console.log("Cookies loaded successfully.");
        console.log("Navigating to LinkedIn profile...");
        yield page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
        console.log("Navigation successful.");
        console.log("Waiting for profile name element...");
        yield page.waitForSelector("h1", { timeout: 60000 });
        console.log("Profile name element found.");
        const pageContent = yield page.content();
        const $ = cheerio.load(pageContent);
        console.log("Scraping data...");
        const name = $("h1").text().trim();
        const imageUrl = $("div.pv-top-card--photo img").attr("src");
        const location = $(".text-body-small.inline.t-black--light.break-words").first().text().trim();
        const extractDates = (range) => {
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
        }
        else if (/she|her|ms\.|mrs\./i.test(pronounText)) {
            genderDetected = 'Female';
        }
        const experience = $(".pvs-list__paged-list-item")
            .map((i, el) => {
            let text = $(el).text().trim().replace(/\s+/g, " ");
            return text ? text : null;
        })
            .get()
            .filter((item) => item !== null);
        const education = Array.isArray(experience[1]) ? experience[1] : [];
        const projectExperiences = [];
        try {
            const projSection = $('section').filter((i, el) => $(el).find('#projects').length > 0);
            projSection.find('> div ul > li').each((i, li) => {
                const $li = $(li);
                const projectName = $li.find('div.t-bold span[aria-hidden="true"]').first().text().trim();
                if (!projectName || /screenshot|\.png|\.jpg|\.jpeg|\.gif|\.svg/i.test(projectName))
                    return;
                const dateRange = $li.find('span.t-14.t-normal').first().text().trim();
                let startRaw = '', endRaw = '';
                if (dateRange) {
                    const dates = extractDates(dateRange);
                    startRaw = dates.start;
                    endRaw = dates.end;
                }
                const stillWorking = /present/i.test(dateRange);
                if (stillWorking)
                    endRaw = '';
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
            const uniqueProj = new Map();
            projectExperiences.forEach(p => {
                if (!uniqueProj.has(p.projectName))
                    uniqueProj.set(p.projectName, p);
            });
            while (projectExperiences.length)
                projectExperiences.pop();
            projectExperiences.push(...Array.from(uniqueProj.values()));
        }
        catch (e) {
            console.warn('Failed to parse projects section', e);
        }
        let skills = [];
        try {
            const skillsSection = $('section').filter((i, el) => $(el).find('#skills').length > 0);
            skills = skillsSection.find('div.hoverable-link-text span[aria-hidden="true"], div.t-bold span[aria-hidden="true"]').map((i, el) => $(el).text().trim()).get();
            skills = Array.from(new Set(skills.filter(s => s)));
        }
        catch (e) {
            console.warn('Failed to parse skills section', e);
        }
        const getFirstLast = (full) => {
            const parts = full.split(' ').filter(p => p);
            return {
                firstName: parts[0] || '',
                lastName: parts.slice(1).join(' ') || ''
            };
        };
        const { firstName, lastName } = getFirstLast(name);
        const workExperiences = [];
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
                if (!roleText)
                    return;
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
            const uniqueMap = new Map();
            workExperiences.forEach(w => {
                const key = `${w.jobTitle}|${w.companyName}`;
                if (!uniqueMap.has(key))
                    uniqueMap.set(key, w);
            });
            while (workExperiences.length)
                workExperiences.pop();
            workExperiences.push(...Array.from(uniqueMap.values()));
        }
        catch (e) {
            console.warn('Failed to parse experience section', e);
        }
        const educationExperiences = [];
        try {
            const eduSection = $('section').filter((i, el) => $(el).find('#education').length > 0);
            eduSection.find('> div ul > li').each((i, li) => {
                const $li = $(li);
                const collegeName = $li.find('div.hoverable-link-text span[aria-hidden="true"]').first().text().trim();
                if (!collegeName)
                    return;
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
        }
        catch (e) {
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
            degree: (((_a = educationExperiences[0]) === null || _a === void 0 ? void 0 : _a.courseName) || ((_b = educationExperiences[0]) === null || _b === void 0 ? void 0 : _b.educationType) || ((_c = educationExperiences[0]) === null || _c === void 0 ? void 0 : _c.field) || ''),
            workExperiences,
            projectExperiences,
            educationExperiences,
            scrapedAt: new Date().toISOString()
        };
        const dataFile = 'scrappedData.json';
        try {
            fs_1.default.writeFileSync(dataFile, JSON.stringify(profileData, null, 2));
            console.log(`Scraped data saved to ${dataFile}`);
        }
        catch (writeErr) {
            console.error('Failed to write scraped data to file:', writeErr);
        }
        console.log("Scraping completed. Sending response...");
        const responsePayload = Object.assign(Object.assign({}, profileData), { message: "Profile scraped and saved successfully", savedTo: dataFile });
        res.json(responsePayload);
    }
    catch (error) {
        console.error("Error scraping LinkedIn profile:", error);
        res.status(500).json({
            error: "Failed to scrape LinkedIn profile",
            details: error.message,
        });
    }
    finally {
        if (browser) {
            console.log("Closing Puppeteer...");
            yield browser.close();
        }
    }
}));
(() => __awaiter(void 0, void 0, void 0, function* () {
    if (!fs_1.default.existsSync("linked_cookies.json")) {
        console.log("Cookies file not found, running login script on startup...");
        yield (0, linkedinLogin_1.loginAndGetSessionCookie)();
    }
}))();
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

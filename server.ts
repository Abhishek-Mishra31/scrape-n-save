import express, { Request, Response } from "express";
import puppeteer from "puppeteer-extra";
import { Browser, Page, Protocol } from "puppeteer";
import cors, { CorsOptions } from "cors";
import * as cheerio from "cheerio";
import "dotenv/config";
import fs from "fs";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

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
const corsOptions: CorsOptions = {
  origin: true,
  credentials: true
};

app.use(cors(corsOptions));

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'LinkedIn Scraper API', status: 'running' });
});
puppeteer.use(StealthPlugin());

/**
 * Logs in to LinkedIn using the current browser page and saves cookies
 * @param page - The current Puppeteer page to use for login
 */
async function loginWithCurrentPage(page: Page): Promise<void> {
  console.log("Attempting to log into LinkedIn using current browser...");
  
  // Set user agent before login
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  );

  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "LinkedIn credentials are missing. Please set LINKEDIN_EMAIL and LINKEDIN_PASSWORD environment variables."
    );
  }

  console.log("Navigating to LinkedIn login page...");
  await page.goto("https://www.linkedin.com/login", {
    waitUntil: "networkidle2",
    timeout: 120000
  });

  console.log("Typing credentials...");
  await page.type("#username", email, { delay: 100 });
  await page.type("#password", password, { delay: 100 });

  console.log("Submitting login form...");
  await page.click("button[type=submit]");

  // Wait for the session cookie to be set
  let liAtCookie: Protocol.Network.Cookie | undefined;
  console.log("Waiting for 'li_at' session cookie...");
  
  for (let i = 0; i < 60; i++) {
    const cookies = await page.cookies();
    liAtCookie = cookies.find((cookie) => cookie.name === "li_at") as Protocol.Network.Cookie;
    if (liAtCookie) {
      console.log("✅ 'li_at' cookie found!");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!liAtCookie) {
    await page.screenshot({ path: 'login_error.png' });
    throw new Error("'li_at' cookie not found after 60 seconds. Login may have failed. Check login_error.png.");
  }

  const sessionCookies: Protocol.Network.Cookie[] = [liAtCookie];
  
  // Save cookies to file for future use
  fs.writeFileSync("linked_cookies.json", JSON.stringify(sessionCookies, null, 2));
  console.log("Cookies saved to linked_cookies.json");
}

/**
 * Loads cookies from environment, file, or performs login using current page
 * @param page - The Puppeteer page to set cookies on
 */
async function loadCookies(page: Page): Promise<void> {
  // 1. Try environment variable first
  const envCookie = process.env.LI_AT_COOKIE;
  if (envCookie) {
    console.log('Using li_at cookie from environment variable');
    await page.setCookie({
      name: 'li_at',
      value: envCookie,
      domain: '.linkedin.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None'
    });
    return;
  }

  // 2. Try loading from file
  if (fs.existsSync("linked_cookies.json")) {
    console.log("Loading existing cookies from file...");
    const cookiesJson = fs.readFileSync("linked_cookies.json", "utf-8");
    const cookies: Protocol.Network.Cookie[] = JSON.parse(cookiesJson);
    console.log(`Loaded ${cookies.length} cookies from file.`);
    
    const puppeteerCookies = cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || ".linkedin.com",
      path: cookie.path || "/",
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite as "Strict" | "Lax" | "None" | undefined,
    }));

    console.log("Setting cookies in browser...");
    await page.setCookie(...puppeteerCookies);
    console.log("Cookies loaded and set successfully.");
    return;
  }

  // 3. No cookies found - perform login with current page
  console.log("No cookies found, performing login with current browser...");
  try {
    await loginWithCurrentPage(page);
    console.log("Login successful, cookies saved. Ready to continue scraping.");
  } catch (loginError: any) {
    console.error("Login failed:", loginError.message);
    throw new Error(`Authentication failed: ${loginError.message}`);
  }
}

// endpoint that will scrape the profile using linkedin profile url
app.post(
  "/scrape",
  async (req: Request<{}, {}, ScrapeRequestBody>, res: Response) => {
    // Set a timeout for the entire scraping operation
    const timeout = setTimeout(() => {
      console.error('Scraping operation timed out after 5 minutes');
      if (!res.headersSent) {
        res.status(408).json({
          error: 'Request timeout', 
          details: 'Scraping took too long and was terminated'
        });
      }
    }, 300000); // 5 minutes
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
          "--disable-extensions",
          "--disable-gpu",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
        ],
      });

      const page = await browser.newPage();
      
      // Set longer timeouts
      page.setDefaultNavigationTimeout(120000);
      page.setDefaultTimeout(90000);

      console.log("Loading cookies...");
      await loadCookies(page);
      console.log("Cookies loaded successfully.");

      console.log("Navigating to LinkedIn profile...");
      await page.goto(profileUrl, { 
        waitUntil: "domcontentloaded",
        timeout: 120000 
      });
      console.log("Navigation successful.");

      console.log("Waiting for profile name element...");
      try {
        await page.waitForSelector("h1", { timeout: 30000 });
        console.log("Profile name element found.");
      } catch(e) {
        console.log("Profile name element not found quickly, continuing anyway...");
      }

      const pageContent = await page.content();
      const $ = cheerio.load(pageContent);

      console.log("Scraping data...");

      const name: string = $("h1").text().trim();
      const imageUrl: string | undefined = $("div.pv-top-card--photo img").attr(
        "src"
      );
      const location: string = $(
        ".text-body-small.inline.t-black--light.break-words"
      )
        .first()
        .text()
        .trim();

      const extractDates = (range: string) => {
        const matches = range.match(/[A-Za-z]{3}\s\d{4}/g) || [];
        const start = matches[0] || "";
        const end = /present/i.test(range) ? "" : matches[1] || "";
        return { start, end };
      };

      const countryDetected = location.includes(",")
        ? location.split(",").slice(-1)[0].trim()
        : "";
      const pronounText = $("span.text-body-small.v-align-middle")
        .first()
        .text()
        .trim()
        .toLowerCase();
      let genderDetected = "";
      if (/he|him|mr\./i.test(pronounText)) {
        genderDetected = "Male";
      } else if (/she|her|ms\.|mrs\./i.test(pronounText)) {
        genderDetected = "Female";
      }

      const experience = $(".pvs-list__paged-list-item")
        .map((i, el) => {
          let text = $(el).text().trim().replace(/\s+/g, " ");
          return text ? text : null;
        })
        .get()
        .filter((item): item is string => item !== null);

      const education: string[] = Array.isArray(experience[1])
        ? experience[1]
        : [];

      const projectExperiences: any[] = [];
      try {
        const projSection = $("section").filter(
          (i, el) => $(el).find("#projects").length > 0
        );
        projSection.find("> div ul > li").each((i, li) => {
          const $li = $(li);
          const projectName = $li
            .find('div.t-bold span[aria-hidden="true"]')
            .first()
            .text()
            .trim();
          if (
            !projectName ||
            /screenshot|\.png|\.jpg|\.jpeg|\.gif|\.svg/i.test(projectName)
          )
            return;

          const dateRange = $li
            .find("span.t-14.t-normal")
            .first()
            .text()
            .trim();
          let startRaw = "",
            endRaw = "";
          if (dateRange) {
            const dates = extractDates(dateRange);
            startRaw = dates.start;
            endRaw = dates.end;
          }
          const stillWorking = /present/i.test(dateRange);
          if (stillWorking) endRaw = "";

          const description = $li
            .find(".inline-show-more-text--is-collapsed")
            .text()
            .trim();

          projectExperiences.push({
            projectName,
            startDate: startRaw,
            endDate: endRaw,
            skills: [],
            stillWorking,
            description,
            gitUrl: "",
            hostUrl: "",
          });
        });

        const uniqueProj = new Map<string, any>();
        projectExperiences.forEach((p) => {
          if (!uniqueProj.has(p.projectName)) uniqueProj.set(p.projectName, p);
        });
        while (projectExperiences.length) projectExperiences.pop();
        projectExperiences.push(...Array.from(uniqueProj.values()));
      } catch (e) {
        console.warn("Failed to parse projects section", e);
      }

      let skills: string[] = [];
      try {
        const skillsSection = $("section").filter(
          (i, el) => $(el).find("#skills").length > 0
        );
        skills = skillsSection
          .find(
            'div.hoverable-link-text span[aria-hidden="true"], div.t-bold span[aria-hidden="true"]'
          )
          .map((i, el) => $(el).text().trim())
          .get();
        skills = Array.from(new Set(skills.filter((s) => s)));
      } catch (e) {
        console.warn("Failed to parse skills section", e);
      }

      const getFirstLast = (full: string) => {
        const parts = full.split(" ").filter((p) => p);
        return {
          firstName: parts[0] || "",
          lastName: parts.slice(1).join(" ") || "",
        };
      };

      const { firstName, lastName } = getFirstLast(name);

      const workExperiences: any[] = [];
      try {
        const expSection = $("section").filter(
          (i, el) => $(el).find("#experience").length > 0
        );
        expSection.find("> div ul > li").each((i, li) => {
          const $li = $(li);
          const roleText =
            $li
              .find('div.hoverable-link-text span[aria-hidden="true"]')
              .first()
              .text()
              .trim() ||
            $li
              .find('span.t-bold span[aria-hidden="true"]')
              .first()
              .text()
              .trim();

          const companyBlock = $li
            .find("span.t-14.t-normal")
            .first()
            .text()
            .trim();
          const [companyNameRaw, workTypeRaw] = companyBlock
            .split(" · ")
            .map((s) => s.trim());

          const dateRange = $li
            .find("span.t-14.t-normal.t-black--light")
            .first()
            .text()
            .trim();
          const locationText = $li
            .find("span.t-14.t-normal.t-black--light")
            .eq(1)
            .text()
            .trim();

          const description = $li
            .find(".inline-show-more-text--is-collapsed")
            .text()
            .trim();

          const stillWorking = /present/i.test(dateRange);

          if (!roleText) return;

          workExperiences.push({
            jobTitle: roleText,
            companyName: companyNameRaw || "",
            startDate: "",
            endDate: "",
            skills: [],
            stillWorking,
            description,
            location: locationText || location,
            workType: workTypeRaw || "",
          });
        });
        const uniqueMap = new Map<string, any>();
        workExperiences.forEach((w) => {
          const key = `${w.jobTitle}|${w.companyName}`;
          if (!uniqueMap.has(key)) uniqueMap.set(key, w);
        });
        while (workExperiences.length) workExperiences.pop();
        workExperiences.push(...Array.from(uniqueMap.values()));
      } catch (e) {
        console.warn("Failed to parse experience section", e);
      }

      const educationExperiences: any[] = [];
      try {
        const eduSection = $("section").filter(
          (i, el) => $(el).find("#education").length > 0
        );
        eduSection.find("> div ul > li").each((i, li) => {
          const $li = $(li);

          const collegeName = $li
            .find('div.hoverable-link-text span[aria-hidden="true"]')
            .first()
            .text()
            .trim();
          if (!collegeName) return;

          const degreeLine = $li
            .find("span.t-14.t-normal")
            .first()
            .text()
            .trim();
          const [degreeRaw, fieldRaw] = degreeLine
            .split(",")
            .map((s) => s.trim());

          const dateRange = $li
            .find("span.t-14.t-normal.t-black--light")
            .first()
            .text()
            .trim();
          const { start: eduStart, end: eduEnd } = extractDates(dateRange);
          const startRaw = eduStart;
          const endRaw = eduEnd;
          const stillStudying = /present/i.test(dateRange);

          educationExperiences.push({
            courseName: degreeRaw || "",
            field: fieldRaw || "",
            collegeName,
            startDate: startRaw || "",
            endDate: endRaw || "",
            skills: [],
            stillStudying,
            description: degreeLine,
            grade: "",
            location: location || "",
            educationType: degreeRaw || "",
          });
        });
      } catch (e) {
        console.warn("Failed to parse education section", e);
      }

      const profileData = {
        fullName: name,
        firstName,
        lastName,
        source: "LinkedIn",
        city: (location ? location.split(",")[0] : "").trim(),
        state: (location && location.includes(",")
          ? location.split(",")[1]
          : ""
        ).trim(),
        gender: genderDetected,
        country: countryDetected,
        linkedinUrl: profileUrl,
        workedPreviously: workExperiences.length > 0 ? "yes" : "no",
        degree:
          educationExperiences[0]?.courseName ||
          educationExperiences[0]?.educationType ||
          educationExperiences[0]?.field ||
          "",
        workExperiences,
        projectExperiences,
        educationExperiences,
        scrapedAt: new Date().toISOString(),
      };

      const dataFile = "scrappedData.json";
      try {
        fs.writeFileSync(dataFile, JSON.stringify(profileData, null, 2));
        console.log(`Scraped data saved to ${dataFile}`);
      } catch (writeErr) {
        console.error("Failed to write scraped data to file:", writeErr);
      }

      console.log("Scraping completed. Sending response...");
      const responsePayload = {
        ...profileData,
        message: "Profile scraped and saved successfully",
        savedTo: dataFile,
      };
        clearTimeout(timeout);
        if (!res.headersSent) {
          res.json(responsePayload);
        }

    } catch (error: any) {
        clearTimeout(timeout);
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
  }
);

// Remove automatic login on startup - handle it per request instead
console.log("Server starting - cookies will be loaded per request if needed");

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

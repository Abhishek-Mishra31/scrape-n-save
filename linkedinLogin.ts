import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import 'dotenv/config';
import { Browser, Page, Protocol } from 'puppeteer';

// Apply the stealth plugin to puppeteer
puppeteer.use(StealthPlugin());

/**
 * Launches a headless browser, logs into LinkedIn using credentials from .env,
 * retrieves the 'li_at' session cookie, saves it to a file, and returns it.
 * @returns {Promise<Protocol.Network.Cookie[] | null>} A promise that resolves to an array containing the session cookie, or null if login fails.
 */
export async function loginAndGetSessionCookie(): Promise<Protocol.Network.Cookie[] | null> {
    console.log("Attempting to log into LinkedIn to generate new cookies...");

    const browser: Browser = await puppeteer.launch({
        headless: true, // Use true for production, false for debugging
        defaultViewport: null,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            "--no-sandbox", 
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--no-first-run",
            "--no-default-browser-check"
        ],
    });

    const page: Page = await browser.newPage();

    // Set a common user agent to avoid bot detection
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );

    try {
        console.log("Navigating to LinkedIn login page...");
        await page.goto("https://www.linkedin.com/login", {
            waitUntil: "networkidle2",
        });

        console.log("Typing credentials...");
        // Use type assertion `as string` to assure TypeScript that these values will be provided
        await page.type("#username", process.env.LINKEDIN_EMAIL as string, { delay: 100 });
        await page.type("#password", process.env.LINKEDIN_PASSWORD as string, { delay: 100 });

        console.log("Submitting login form...");
        await page.click("button[type=submit]");

        // Wait for navigation and the session cookie to be set.
        // Poll for the cookie for up to 60 seconds.
        let liAtCookie: Protocol.Network.Cookie | undefined;
        console.log("Waiting for 'li_at' session cookie...");
        for (let i = 0; i < 60; i++) {
            const cookies = await page.cookies();
            liAtCookie = cookies.find((cookie) => cookie.name === "li_at") as Protocol.Network.Cookie;
            if (liAtCookie) {
                console.log("✅ 'li_at' cookie found!");
                break;
            }
            // Wait for 1 second before retrying
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (!liAtCookie) {
            // Take a screenshot for debugging if the cookie is not found
            await page.screenshot({ path: 'login_error.png' });
            throw new Error("'li_at' cookie not found after 60 seconds. Login may have failed. Check login_error.png.");
        }

        const sessionCookies: Protocol.Network.Cookie[] = [liAtCookie];

        // Save the essential cookie to a file for future sessions
        fs.writeFileSync("linked_cookies.json", JSON.stringify(sessionCookies, null, 2));
        console.log("Cookies saved to linked_cookies.json");

        return sessionCookies;
    } catch (err: any) {
        console.error("❌ Login failed:", err.message);
        return null;
    } finally {
        if (browser) {
            await browser.close();
            console.log("Browser closed.");
        }
    }
}
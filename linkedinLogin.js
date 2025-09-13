"use strict";
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
exports.loginAndGetSessionCookie = loginAndGetSessionCookie;
const puppeteer_extra_1 = __importDefault(require("puppeteer-extra"));
const puppeteer_extra_plugin_stealth_1 = __importDefault(require("puppeteer-extra-plugin-stealth"));
const fs_1 = __importDefault(require("fs"));
require("dotenv/config");
// Apply the stealth plugin to puppeteer
puppeteer_extra_1.default.use((0, puppeteer_extra_plugin_stealth_1.default)());
/**
 * Launches a headless browser, logs into LinkedIn using credentials from .env,
 * retrieves the 'li_at' session cookie, saves it to a file, and returns it.
 * @returns {Promise<Protocol.Network.Cookie[] | null>} A promise that resolves to an array containing the session cookie, or null if login fails.
 */
function loginAndGetSessionCookie() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("Attempting to log into LinkedIn to generate new cookies...");
        const browser = yield puppeteer_extra_1.default.launch({
            headless: true, // Use true for production, false for debugging
            defaultViewport: null,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
        const page = yield browser.newPage();
        // Set a common user agent to avoid bot detection
        yield page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36");
        try {
            console.log("Navigating to LinkedIn login page...");
            yield page.goto("https://www.linkedin.com/login", {
                waitUntil: "networkidle2",
            });
            console.log("Typing credentials...");
            // Use type assertion `as string` to assure TypeScript that these values will be provided
            yield page.type("#username", process.env.LINKEDIN_EMAIL, { delay: 100 });
            yield page.type("#password", process.env.LINKEDIN_PASSWORD, { delay: 100 });
            console.log("Submitting login form...");
            yield page.click("button[type=submit]");
            // Wait for navigation and the session cookie to be set.
            // Poll for the cookie for up to 60 seconds.
            let liAtCookie;
            console.log("Waiting for 'li_at' session cookie...");
            for (let i = 0; i < 60; i++) {
                const cookies = yield page.cookies();
                liAtCookie = cookies.find((cookie) => cookie.name === "li_at");
                if (liAtCookie) {
                    console.log("✅ 'li_at' cookie found!");
                    break;
                }
                // Wait for 1 second before retrying
                yield new Promise((resolve) => setTimeout(resolve, 1000));
            }
            if (!liAtCookie) {
                // Take a screenshot for debugging if the cookie is not found
                yield page.screenshot({ path: 'login_error.png' });
                throw new Error("'li_at' cookie not found after 60 seconds. Login may have failed. Check login_error.png.");
            }
            const sessionCookies = [liAtCookie];
            // Save the essential cookie to a file for future sessions
            fs_1.default.writeFileSync("linked_cookies.json", JSON.stringify(sessionCookies, null, 2));
            console.log("Cookies saved to linked_cookies.json");
            return sessionCookies;
        }
        catch (err) {
            console.error("❌ Login failed:", err.message);
            return null;
        }
        finally {
            if (browser) {
                yield browser.close();
                console.log("Browser closed.");
            }
        }
    });
}

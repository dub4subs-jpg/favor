/**
 * Browser Automation — Puppeteer-based headless Chrome for web tasks
 * Handles navigation, form filling, screenshots, and purchases
 * Enhanced with Readability (clean content extraction) and Crawlee (production scraping)
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');

const SCREENSHOTS_DIR = path.join(__dirname, 'data', 'browser_screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

function sanitizeLabel(label) {
  return String(label || 'page').replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 50);
}

function validateUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0') return false;
    if (host === '169.254.169.254' || host.endsWith('.internal')) return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return false;
    return true;
  } catch { return false; }
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class Browser {
  constructor() {
    this.browser = null;
    this.page = null;
    this.lastScreenshot = null;
  }

  async _ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return;
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1440,900'
      ],
      defaultViewport: { width: 1440, height: 900 }
    });
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(BROWSER_UA);
    // Block unnecessary resources for speed
    await this.page.setRequestInterception(true);
    this.page.on('request', req => {
      const type = req.resourceType();
      if (['font', 'media'].includes(type)) req.abort();
      else req.continue();
    });
  }

  async _ensurePage() {
    await this._ensureBrowser();
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage();
      await this.page.setUserAgent(BROWSER_UA);
    }
    return this.page;
  }

  /**
   * Navigate to a URL
   */
  async navigate(url, waitFor = 'networkidle2') {
    if (!validateUrl(url)) return { ok: false, error: 'Invalid or blocked URL. Only http/https to public hosts allowed.' };
    const page = await this._ensurePage();
    try {
      await page.goto(url, { waitUntil: waitFor, timeout: 30000 });
      const title = await page.title();
      return { ok: true, title, url: page.url() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Take a screenshot and return the file path + base64 buffer
   */
  async screenshot(label = 'page') {
    label = sanitizeLabel(label);
    const page = await this._ensurePage();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${label}_${ts}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    const buffer = fs.readFileSync(filepath);
    this.lastScreenshot = { path: filepath, buffer };
    return { path: filepath, buffer, filename };
  }

  /**
   * Get the page text content (simplified)
   */
  async getText(selector = 'body') {
    const page = await this._ensurePage();
    try {
      const text = await page.$eval(selector, el => el.innerText);
      return text.substring(0, 4000); // cap for WhatsApp
    } catch (e) {
      return 'Could not extract text: ' + e.message;
    }
  }

  /**
   * Click an element
   */
  async click(selector) {
    const page = await this._ensurePage();
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Type text into an input field
   */
  async type(selector, text, options = {}) {
    const page = await this._ensurePage();
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      if (options.clear) {
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
      }
      await page.type(selector, text, { delay: options.delay || 50 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Select a dropdown option
   */
  async select(selector, value) {
    const page = await this._ensurePage();
    try {
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.select(selector, value);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Fill a form using a map of selector->value pairs
   */
  async fillForm(fields) {
    const results = [];
    for (const [selector, value] of Object.entries(fields)) {
      const r = await this.type(selector, value, { clear: true });
      results.push({ selector, ok: r.ok, error: r.error });
    }
    return results;
  }

  /**
   * Wait for a selector to appear
   */
  async waitFor(selector, timeout = 10000) {
    const page = await this._ensurePage();
    try {
      await page.waitForSelector(selector, { timeout });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Evaluate arbitrary JS in the page context
   */
  async evaluate(code) {
    const page = await this._ensurePage();
    try {
      const result = await page.evaluate(code);
      return { ok: true, result: typeof result === 'object' ? JSON.stringify(result) : String(result) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Get all visible input fields on the page (for the AI to understand what to fill)
   */
  async getFormFields() {
    const page = await this._ensurePage();
    try {
      const fields = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
        return inputs
          .filter(el => el.offsetParent !== null) // visible only
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            name: el.name || '',
            id: el.id || '',
            placeholder: el.placeholder || '',
            label: el.labels?.[0]?.innerText?.trim() || '',
            value: el.value || '',
            options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => ({ value: o.value, text: o.text })) : undefined
          }));
      });
      return fields;
    } catch (e) {
      return [];
    }
  }

  /**
   * Get all clickable elements (buttons, links) for navigation
   */
  async getClickables() {
    const page = await this._ensurePage();
    try {
      const items = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"]'));
        return els
          .filter(el => el.offsetParent !== null)
          .slice(0, 50) // cap at 50
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.value || el.title || '').trim().substring(0, 80),
            href: el.href || '',
            id: el.id || '',
            class: el.className?.toString()?.substring(0, 60) || ''
          }));
      });
      return items;
    } catch (e) {
      return [];
    }
  }

  /**
   * Press a keyboard key
   */
  async pressKey(key) {
    const page = await this._ensurePage();
    await page.keyboard.press(key);
    return { ok: true };
  }

  /**
   * Scroll the page
   */
  async scroll(direction = 'down', amount = 500) {
    const page = await this._ensurePage();
    await page.evaluate((dir, amt) => {
      window.scrollBy(0, dir === 'down' ? amt : -amt);
    }, direction, amount);
    return { ok: true };
  }

  /**
   * Read a page and return clean content using Readability.
   * Much better than getText() for feeding to AI — strips nav, ads, footers.
   */
  async readPage(url) {
    try {
      if (url) {
        if (!validateUrl(url)) return { ok: false, error: 'Invalid or blocked URL.' };
        const nav = await this.navigate(url);
        if (!nav.ok) return { ok: false, error: nav.error };
      }
      const page = await this._ensurePage();
      const html = await page.content();
      const currentUrl = page.url();

      const { document } = parseHTML(html);
      const reader = new Readability(document, { charThreshold: 100 });
      const article = reader.parse();

      if (!article) {
        const fallback = await this.getText('body');
        return { ok: true, title: await page.title(), content: fallback, url: currentUrl, fallback: true };
      }

      const cleanText = article.textContent
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .substring(0, 8000);

      return {
        ok: true,
        title: article.title || '',
        content: cleanText,
        byline: article.byline || '',
        excerpt: article.excerpt || '',
        length: article.length || 0,
        url: currentUrl
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Crawl multiple pages from a starting URL using Crawlee.
   * Returns an array of { url, title, content } for each page crawled.
   * Options: { maxPages, match (glob pattern), maxDepth }
   */
  async crawl(startUrl, options = {}) {
    if (!validateUrl(startUrl)) return { ok: false, error: 'Invalid or blocked URL.' };
    const maxPages = options.maxPages || 5;
    const maxDepth = options.maxDepth || 2;
    const match = options.match || null;
    const results = [];

    try {
      const { PuppeteerCrawler } = await import('crawlee');

      const crawler = new PuppeteerCrawler({
        maxRequestsPerCrawl: maxPages,
        maxCrawlDepth: maxDepth,
        headless: true,
        launchContext: {
          launchOptions: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
          }
        },
        async requestHandler({ request, page, enqueueLinks }) {
          const title = await page.title();
          const html = await page.content();

          const { document } = parseHTML(html);
          const reader = new Readability(document, { charThreshold: 100 });
          const article = reader.parse();

          const content = article
            ? article.textContent.replace(/\n{3,}/g, '\n\n').trim().substring(0, 4000)
            : await page.$eval('body', el => el.innerText).catch(() => '').then(t => t.substring(0, 4000));

          results.push({
            url: request.loadedUrl || request.url,
            title,
            content,
            depth: request.userData?.depth || 0
          });

          if (results.length < maxPages) {
            await enqueueLinks({
              strategy: 'same-domain',
              globs: match ? [match] : undefined
            });
          }
        },
        failedRequestHandler({ request }) {
          console.warn(`[CRAWL] Failed: ${request.url}`);
        }
      });

      await crawler.run([startUrl]);
      return { ok: true, pages: results, count: results.length };
    } catch (e) {
      return { ok: false, error: e.message, pages: results };
    }
  }

  /**
   * Close the browser
   */
  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
  }

  /**
   * Get current page info
   */
  async getPageInfo() {
    if (!this.page || this.page.isClosed()) return { open: false };
    return {
      open: true,
      url: this.page.url(),
      title: await this.page.title().catch(() => 'unknown')
    };
  }
}

module.exports = Browser;

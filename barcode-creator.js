#!/usr/bin/env node
/**
 * Standalone Barcode Creator — runs the full GS1 barcode flow via Puppeteer
 * Usage:
 *   node barcode-creator.js "Product Description"                    # Each, activate
 *   node barcode-creator.js "Product 10PK" --packaging=case --qty=10
 *   node barcode-creator.js "Product" --dry-run --no-activate
 *
 * Can be called by Claude Code directly, or by Dell via subprocess.
 * Returns JSON to stdout with the result.
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, 'data', 'browser_screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const BARCODE_DIR = path.join(__dirname, 'data', 'barcodes');
if (!fs.existsSync(BARCODE_DIR)) fs.mkdirSync(BARCODE_DIR, { recursive: true });

// ─── Config & Vault ───
function getCredentials() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'data', 'favor.db'));
  const Vault = require('./vault');
  const vault = new Vault(db, config.vault.secret);
  const entry = vault.get('gs1_login');
  if (!entry) throw new Error('No gs1_login entry in vault. Save credentials first.');
  return entry.data; // { email, password }
}

// ─── Helpers ───
function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ${msg}`);
}

async function screenshot(page, label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `barcode_${label}_${ts}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  log(`Screenshot: ${filename}`);
  return filepath;
}

async function clickText(page, text, timeout = 10000) {
  // Try multiple strategies to click text
  const strategies = [
    // Strategy 1: XPath text match
    async () => {
      const [el] = await page.$x(`//button[contains(., '${text}')] | //a[contains(., '${text}')]`);
      if (el) { await el.click(); return true; }
      return false;
    },
    // Strategy 2: evaluate + click
    async () => {
      return await page.evaluate((t) => {
        const els = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
        const el = els.find(e => e.textContent.includes(t) && e.offsetParent !== null);
        if (el) { el.click(); return true; }
        return false;
      }, text);
    },
    // Strategy 3: CSS selector with text
    async () => {
      try {
        await page.waitForSelector(`text/${text}`, { timeout: 3000 });
        await page.click(`text/${text}`);
        return true;
      } catch { return false; }
    }
  ];

  for (const strategy of strategies) {
    try {
      const result = await strategy();
      if (result) {
        await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
        return true;
      }
    } catch {}
  }
  return false;
}

async function waitAndClick(page, selector, timeout = 10000) {
  await page.waitForSelector(selector, { timeout });
  await page.click(selector);
  await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
}

// ─── Main Flow ───
async function createBarcode(productDescription, options = {}) {
  const { dryRun = false, activate = true, packaging = 'each', caseQty = null, brandName = 'Higher Education' } = options;
  const creds = getCredentials();

  log(`Creating barcode for: "${productDescription}"`);
  log(`Dry run: ${dryRun}, Activate: ${activate}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 }
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const result = { ok: false, product: productDescription, steps: [] };

  try {
    // ─── STEP 0: Login ───
    log('Step 0: Logging in to GS1...');
    await page.goto('https://dh.gs1us.org', { waitUntil: 'networkidle2', timeout: 30000 });
    await screenshot(page, '0_login_page');

    // Email
    await page.waitForSelector('#signInName', { timeout: 15000 });
    await page.type('#signInName', creds.email, { delay: 30 });
    await page.click('#continue');
    log('Entered email, clicked Continue');

    // Password
    await page.waitForSelector('#password', { visible: true, timeout: 10000 });
    await new Promise(r => setTimeout(r, 1000)); // brief pause for animation
    await page.type('#password', creds.password, { delay: 30 });
    await page.click('#next');
    log('Entered password, clicked Log In');

    // Wait for login to complete
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await screenshot(page, '0_logged_in');
    result.steps.push({ step: 0, status: 'ok', detail: 'Logged in' });
    log('Login complete');

    // ─── STEP 1: Navigate to products & create ───
    log('Step 1: Creating product...');
    await page.goto('https://dh.gs1us.org/ui/product', { waitUntil: 'networkidle2', timeout: 30000 });
    await screenshot(page, '1_products_page');

    // Click "Add New Product"
    const addClicked = await clickText(page, 'Add New Product');
    if (!addClicked) throw new Error('Could not click "Add New Product"');
    await new Promise(r => setTimeout(r, 2000)); // wait for modal
    await screenshot(page, '1_add_product_modal');

    // Fill Product Description (first input with that placeholder)
    const descInputs = await page.$$('input[placeholder="Minimum required for Barcode"]');
    if (descInputs.length === 0) throw new Error('No "Minimum required for Barcode" inputs found');

    await descInputs[0].click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await descInputs[0].type(productDescription, { delay: 30 });
    log(`Filled Product Description: "${productDescription}"`);

    // Fill Brand Name (second input with same placeholder)
    if (descInputs.length >= 2) {
      await page.evaluate((brand) => {
        const inputs = document.querySelectorAll('input[placeholder="Minimum required for Barcode"]');
        if (inputs[1]) {
          inputs[1].value = brand;
          inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, brandName);
      log(`Filled Brand Name: "${brandName}"`);
    } else {
      log('WARNING: Only 1 input found, trying alternative brand name approach');
      await page.evaluate((brand) => {
        const labels = Array.from(document.querySelectorAll('label'));
        const brandLabel = labels.find(l => l.textContent.includes('Brand'));
        if (brandLabel) {
          const input = brandLabel.closest('.form-group')?.querySelector('input') ||
                       document.getElementById(brandLabel.htmlFor);
          if (input) {
            input.value = brand;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }, brandName);
    }

    // Set Packaging Level if Case
    if (packaging.toLowerCase() === 'case') {
      log('Setting Packaging Level to Case...');
      const pkgResult = await page.evaluate(() => {
        const selects = [...document.querySelectorAll('select')];
        for (const sel of selects) {
          const caseOpt = [...sel.options].find(o =>
            o.text.toLowerCase().includes('case')
          );
          if (caseOpt) {
            sel.value = caseOpt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { selected: caseOpt.text, value: caseOpt.value };
          }
        }
        return null;
      });
      log('Packaging Level result: ' + JSON.stringify(pkgResult));

      // If case, fill quantity field if it appears
      if (caseQty) {
        await new Promise(r => setTimeout(r, 1000));
        const qtyResult = await page.evaluate((qty) => {
          // Look for quantity/count input that may appear after selecting Case
          const inputs = [...document.querySelectorAll('input')];
          const qtyInput = inputs.find(i =>
            i.placeholder?.toLowerCase().includes('quantity') ||
            i.placeholder?.toLowerCase().includes('count') ||
            i.name?.toLowerCase().includes('quantity') ||
            i.name?.toLowerCase().includes('count') ||
            i.id?.toLowerCase().includes('quantity')
          );
          if (qtyInput) {
            qtyInput.value = String(qty);
            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
            return { found: true, placeholder: qtyInput.placeholder };
          }
          return { found: false };
        }, caseQty);
        log('Case quantity result: ' + JSON.stringify(qtyResult));
      }
    }

    await screenshot(page, '1_form_filled');
    result.steps.push({ step: 1, status: 'ok', detail: 'Form filled' });

    if (dryRun) {
      log('DRY RUN — stopping before Save');
      result.ok = true;
      result.dryRun = true;
      await browser.close();
      return result;
    }

    // Click "Save and Continue"
    const saveClicked = await clickText(page, 'Save and Continue');
    if (!saveClicked) throw new Error('Could not click "Save and Continue"');
    await new Promise(r => setTimeout(r, 2000));
    await screenshot(page, '1_saved');
    log('Clicked Save and Continue');

    // ─── STEP 2: GTIN Assignment ───
    log('Step 2: Assigning GTIN...');
    await screenshot(page, '2_gtin_method');

    // Click "Let Us Assign Your GTIN" — it's a CARD with blue link-text heading
    // The clickable element is likely an <a> tag or a div with cursor:pointer
    log('Step 2: Clicking "Let Us Assign Your GTIN" card...');

    // Dump the card's actual HTML for debugging
    const cardHTML = await page.evaluate(() => {
      // Look for elements containing exact "Let Us" text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim().includes('Let Us')) {
          textNodes.push({
            text: walker.currentNode.textContent.trim().substring(0, 80),
            parentTag: walker.currentNode.parentElement?.tagName,
            parentClass: walker.currentNode.parentElement?.className?.toString()?.substring(0, 80),
            grandparentTag: walker.currentNode.parentElement?.parentElement?.tagName,
            grandparentClass: walker.currentNode.parentElement?.parentElement?.className?.toString()?.substring(0, 80),
            parentHTML: walker.currentNode.parentElement?.outerHTML?.substring(0, 300)
          });
        }
      }
      return textNodes;
    });
    log('Text nodes with "Let Us": ' + JSON.stringify(cardHTML, null, 2));

    // Click strategy: use known Angular CSS class gs1-gtin-card, then fallbacks
    const assignResult = await page.evaluate(() => {
      // Strategy 1 (BEST): Click the card by its Angular class — discovered from DOM inspection
      const gtinCard = document.querySelector('.gs1-gtin-card');
      if (gtinCard) {
        gtinCard.click();
        gtinCard.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { strategy: 'gs1-gtin-card', tag: gtinCard.tagName };
      }

      // Strategy 2: Click the h5 heading with class "text-link" containing "Let Us"
      const h5 = [...document.querySelectorAll('h5.text-link')].find(h =>
        h.textContent.includes('Let Us') && h.textContent.includes('Assign')
      );
      if (h5) {
        h5.click();
        // Also click the parent card div
        const card = h5.closest('.gs1-card, [class*="card"]');
        if (card) card.click();
        return { strategy: 'h5_text_link', parentClass: card?.className?.toString()?.substring(0, 60) };
      }

      // Strategy 3: Find any element containing "Let Us" and click it + parent
      const allEls = [...document.querySelectorAll('div, section, article, li')];
      for (const el of allEls) {
        const innerText = el.textContent?.trim() || '';
        if (innerText.includes('Let Us') && innerText.includes('Assign') && el.children.length <= 8) {
          el.click();
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return { strategy: 'container_div', tag: el.tagName, class: el.className?.toString()?.substring(0, 80) };
        }
      }

      return null;
    });
    log('Assign click result: ' + JSON.stringify(assignResult));
    await new Promise(r => setTimeout(r, 3000));
    await screenshot(page, '2_after_assign');

    // Check if the prefix table appeared (should show "GS1 Company Prefix" and "Select" links)
    const prefixTableVisible = await page.evaluate(() => {
      return document.body.innerText.includes('GS1 Company Prefix') &&
             document.body.innerText.includes('Available GTINs');
    });
    log('Prefix table visible: ' + prefixTableVisible);

    if (!prefixTableVisible) {
      // If no table appeared, the card might need a different interaction
      // Try clicking by bounding box position of the first card
      log('No prefix table — trying bounding box click...');
      const cardBox = await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')];
        for (const el of els) {
          if (el.textContent.includes('Let Us') && el.textContent.includes('next available') &&
              el.children.length <= 6) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 50 && rect.width < 400 && rect.height > 50) {
              return { x: rect.x + rect.width/2, y: rect.y + rect.height/2, w: rect.width, h: rect.height };
            }
          }
        }
        return null;
      });
      log('Card bounding box: ' + JSON.stringify(cardBox));
      if (cardBox) {
        await page.mouse.click(cardBox.x, cardBox.y);
        await new Promise(r => setTimeout(r, 3000));
        await screenshot(page, '2_after_bbox_click');
      }
    }

    result.steps.push({ step: 2, status: prefixTableVisible ? 'ok' : 'uncertain', detail: 'GTIN assignment card clicked' });

    // ─── STEP 3: Select Company Prefix ───
    log('Step 3: Selecting company prefix...');
    await screenshot(page, '3_prefix_page');

    // "Select" is a blue link-styled element in a table row next to "0850073942"
    // Prefer the prefix with more available GTINs (0850073942 has 1/100)
    const selectResult = await page.evaluate(() => {
      // First try: find table rows containing prefix numbers and "Select" links
      const rows = [...document.querySelectorAll('tr, [role="row"]')];
      for (const row of rows) {
        if (row.textContent.includes('0850073942')) {
          // Find the "Select" link/button in this row
          const selectEl = [...row.querySelectorAll('a, button, [role="button"], span')]
            .find(el => el.textContent.trim() === 'Select');
          if (selectEl) {
            selectEl.click();
            return { strategy: 'table_row', prefix: '0850073942' };
          }
        }
      }

      // Fallback: find first "Select" link on the page
      const allEls = [...document.querySelectorAll('a, button, span, div')];
      const selectEl = allEls.find(el =>
        el.textContent.trim() === 'Select' && el.offsetParent !== null &&
        el.children.length === 0
      );
      if (selectEl) {
        selectEl.click();
        return { strategy: 'first_select', tag: selectEl.tagName };
      }

      // Last resort: any clickable with "Select" text
      const anySelect = allEls.find(el =>
        el.textContent.trim() === 'Select' && el.offsetParent !== null
      );
      if (anySelect) {
        anySelect.click();
        anySelect.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { strategy: 'any_select', tag: anySelect.tagName };
      }

      return null;
    });
    log('Select prefix result: ' + JSON.stringify(selectResult));
    await new Promise(r => setTimeout(r, 3000));
    await screenshot(page, '3_prefix_selected');
    result.steps.push({ step: 3, status: selectResult ? 'ok' : 'skipped', detail: 'Prefix: ' + JSON.stringify(selectResult) });

    // ─── STEP 4: Save and Continue (after GTIN assigned) ───
    // After clicking Select, the GTIN is assigned and "Your GTIN Information" appears
    // Must click "Save and Continue" to proceed to the product detail page
    log('Step 4: Clicking Save and Continue after GTIN assignment...');

    // First check if there's a Yes/confirm dialog (sometimes appears)
    const confirmResult = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
      const yesBtn = buttons.find(b => b.textContent.trim() === 'Yes' && b.offsetParent !== null);
      if (yesBtn) { yesBtn.click(); return 'clicked_yes'; }
      return null;
    });
    if (confirmResult) {
      log('Confirmation dialog found and clicked: ' + confirmResult);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Now click "Save and Continue" to go to product detail page
    const saveAfterGTIN = await clickText(page, 'Save and Continue');
    log('Save and Continue after GTIN: ' + saveAfterGTIN);
    await new Promise(r => setTimeout(r, 3000));
    await screenshot(page, '4_after_save');

    // We should now be on the product detail page with PREMARKET status
    // Extract the assigned GTIN from the page
    const gtin = await page.evaluate(() => {
      const text = document.body.innerText;
      // Look for GTIN patterns — 13 or 14 digit numbers starting with 0
      const match = text.match(/\b(0\d{12,13})\b/);
      return match ? match[1] : null;
    });
    log(`GTIN assigned: ${gtin || 'unknown'}`);
    result.gtin = gtin;

    // Check current page status
    const pageStatus = await page.evaluate(() => {
      const text = document.body.innerText;
      if (text.includes('PREMARKET')) return 'PREMARKET';
      if (text.includes('IN USE')) return 'IN_USE';
      if (text.includes('DRAFT')) return 'DRAFT';
      return 'unknown';
    });
    log('Product status: ' + pageStatus);
    result.steps.push({ step: 4, status: 'ok', detail: `GTIN: ${gtin}, status: ${pageStatus}` });

    // ─── STEP 5: Set Status to In Use ───
    if (activate) {
      log('Step 5: Setting status to In Use...');
      await screenshot(page, '5_before_in_use');

      // The "Set Status to In Use" button is in the right sidebar
      const inUseResult = await page.evaluate(() => {
        // Try multiple selectors for the "Set Status to In Use" button
        const allEls = [...document.querySelectorAll('button, a, [role="button"], div, span')];
        const inUseBtn = allEls.find(el =>
          el.textContent.includes('Set Status to In Use') &&
          el.offsetParent !== null &&
          el.textContent.length < 50
        );
        if (inUseBtn) {
          inUseBtn.click();
          inUseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { found: true, tag: inUseBtn.tagName, class: inUseBtn.className?.toString()?.substring(0, 60) };
        }
        return { found: false };
      });
      log('Set Status to In Use result: ' + JSON.stringify(inUseResult));

      if (!inUseResult.found) {
        // Try bounding box click — button is in right sidebar
        log('Trying bbox click for Set Status to In Use...');
        const inUseBox = await page.evaluate(() => {
          const els = [...document.querySelectorAll('*')];
          for (const el of els) {
            if (el.textContent.includes('Set Status to In Use') && el.children.length <= 2) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 50 && rect.height > 20 && rect.x > 500) { // right sidebar
                return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
              }
            }
          }
          return null;
        });
        if (inUseBox) {
          await page.mouse.click(inUseBox.x, inUseBox.y);
          log('Clicked In Use by bbox');
        }
      }

      await new Promise(r => setTimeout(r, 3000));

      // Handle the "Status Change to In Use" confirmation dialog
      // It has "Cancel" and "Continue" buttons — click "Continue"
      await new Promise(r => setTimeout(r, 1000));
      const inUseConfirm = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
        // Look specifically for "Continue" (NOT "Yes, cancel changes")
        const continueBtn = buttons.find(b =>
          b.textContent.trim() === 'Continue' && b.offsetParent !== null
        );
        if (continueBtn) { continueBtn.click(); return 'clicked_continue'; }
        // Also try "Proceed" or "Confirm"
        const proceedBtn = buttons.find(b =>
          (b.textContent.trim() === 'Proceed' || b.textContent.trim() === 'Confirm') &&
          b.offsetParent !== null
        );
        if (proceedBtn) { proceedBtn.click(); return 'clicked_proceed'; }
        return null;
      });
      log('Status change confirmation: ' + inUseConfirm);
      await new Promise(r => setTimeout(r, 3000));

      await screenshot(page, '5_after_continue');

      // IMPORTANT: After status change, we need to Save and Continue to persist
      // before we can navigate to View Barcode
      log('Saving after status change...');
      const saveAfterStatus = await clickText(page, 'Save and Continue');
      if (!saveAfterStatus) {
        // Try "Save and Exit" as alternative
        await clickText(page, 'Save and Exit');
      }
      await new Promise(r => setTimeout(r, 3000));

      // Handle any "GS1 US Confirm" navigation dialog — ALWAYS click "No, stay on page"
      // NEVER click "Yes, cancel changes" as that undoes our work
      const navConfirm = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, a, [role="button"]')];
        const stayBtn = buttons.find(b =>
          b.textContent.includes('No, stay') && b.offsetParent !== null
        );
        if (stayBtn) { stayBtn.click(); return 'stayed_on_page'; }
        return null;
      });
      if (navConfirm) {
        log('Navigation confirm handled: ' + navConfirm);
        await new Promise(r => setTimeout(r, 2000));
        // Try saving again
        await clickText(page, 'Save and Continue');
        await new Promise(r => setTimeout(r, 3000));
      }

      await screenshot(page, '5_in_use');

      // Verify status changed
      const newStatus = await page.evaluate(() => {
        return document.body.innerText.includes('IN USE') ? 'IN_USE' :
               document.body.innerText.includes('PREMARKET') ? 'PREMARKET' : 'unknown';
      });
      log('Status after In Use: ' + newStatus);
      result.steps.push({ step: 5, status: newStatus === 'IN_USE' ? 'ok' : 'warning', detail: 'Status: ' + newStatus });
    }

    // ─── STEP 6: View and Download Barcode ───
    log('Step 6: Clicking View Barcode...');

    // Click "View Barcode" in the right sidebar
    const viewResult = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"], div, span')];
      const viewBtn = els.find(el =>
        el.textContent.includes('View Barcode') && el.offsetParent !== null && el.textContent.length < 40
      );
      if (viewBtn) {
        viewBtn.click();
        viewBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { found: true, tag: viewBtn.tagName };
      }
      return { found: false };
    });
    log('View Barcode result: ' + JSON.stringify(viewResult));

    if (!viewResult.found) {
      // Try bbox click — View Barcode is in right sidebar
      const viewBox = await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')];
        for (const el of els) {
          if (el.textContent.includes('View Barcode') && el.children.length <= 2) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 20) {
              return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            }
          }
        }
        return null;
      });
      if (viewBox) {
        await page.mouse.click(viewBox.x, viewBox.y);
        log('Clicked View Barcode by bbox');
      }
    }

    await new Promise(r => setTimeout(r, 3000));
    await screenshot(page, '6_barcode_page');

    // Change dropdown to "Both Retail Point-of-Sale and Distribution"
    log('Selecting barcode usage dropdown...');
    const dropdownResult = await page.evaluate(() => {
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const options = [...sel.options];
        // Look for the "Both" or "Distribution" option
        const bothOpt = options.find(o =>
          o.text.includes('Both') || o.text.includes('Distribution') ||
          o.text.includes('Retail Point-of-Sale and Distribution')
        );
        if (bothOpt) {
          sel.value = bothOpt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: bothOpt.text, value: bothOpt.value };
        }
      }
      return null;
    });
    log('Dropdown result: ' + JSON.stringify(dropdownResult));
    await new Promise(r => setTimeout(r, 2000));
    await screenshot(page, '6_barcode_dropdown_set');

    // Download the PNG
    const downloadPath = BARCODE_DIR;
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });

    // Click "Download PNG"
    const dlResult = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"], div, span')];
      const dlBtn = els.find(el =>
        el.textContent.includes('Download PNG') && el.offsetParent !== null && el.textContent.length < 30
      );
      if (dlBtn) {
        dlBtn.click();
        return { found: true, tag: dlBtn.tagName, href: dlBtn.href || '' };
      }
      // Also try "Download" without PNG
      const dlBtn2 = els.find(el =>
        el.textContent.trim() === 'Download' && el.offsetParent !== null
      );
      if (dlBtn2) {
        dlBtn2.click();
        return { found: true, tag: dlBtn2.tagName, strategy: 'download_only' };
      }
      return { found: false };
    });
    log('Download PNG result: ' + JSON.stringify(dlResult));

    if (dlResult.found) {
      await new Promise(r => setTimeout(r, 4000)); // wait for download
    }

    // Also capture barcode screenshot as fallback
    const barcodeScreenshot = await screenshot(page, '6_barcode_final');

    // Check for downloaded file
    const safeName = productDescription.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    const finalName = `${safeName}_barcode.png`;
    const finalPath = path.join(BARCODE_DIR, finalName);

    const files = fs.readdirSync(downloadPath)
      .filter(f => f.endsWith('.png') && !f.startsWith('barcode_'))
      .sort((a, b) => fs.statSync(path.join(downloadPath, b)).mtimeMs - fs.statSync(path.join(downloadPath, a)).mtimeMs);

    if (files.length > 0) {
      const downloadedFile = path.join(downloadPath, files[0]);
      fs.copyFileSync(downloadedFile, finalPath);
      log(`Barcode saved from download: ${finalPath}`);
    } else {
      // Use screenshot as fallback
      fs.copyFileSync(barcodeScreenshot, finalPath);
      log(`Barcode saved from screenshot: ${finalPath}`);
    }

    result.barcodePath = finalPath;
    result.steps.push({ step: 6, status: dlResult.found ? 'ok' : 'screenshot_fallback', detail: `Saved: ${finalPath}` });
    result.ok = true;

  } catch (err) {
    log(`ERROR: ${err.message}`);
    await screenshot(page, 'error').catch(() => {});
    result.error = err.message;
  } finally {
    await browser.close();
  }

  return result;
}

// ─── CLI ───
if (require.main === module) {
  const args = process.argv.slice(2);
  const productName = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const noActivate = args.includes('--no-activate');

  // Parse --packaging=case and --qty=10
  const pkgArg = args.find(a => a.startsWith('--packaging='));
  const packaging = pkgArg ? pkgArg.split('=')[1] : 'each';
  const qtyArg = args.find(a => a.startsWith('--qty='));
  const caseQty = qtyArg ? parseInt(qtyArg.split('=')[1]) : null;
  const brandArg = args.find(a => a.startsWith('--brand='));
  const brandName = brandArg ? brandArg.split('=')[1] : 'Higher Education';

  if (!productName) {
    console.error('Usage: node barcode-creator.js "Product Description" [options]');
    console.error('Options:');
    console.error('  --dry-run           Stop before saving (test mode)');
    console.error('  --no-activate       Skip "Set Status to In Use" step');
    console.error('  --packaging=case    Set packaging to Case (default: each)');
    console.error('  --qty=10            Case quantity (only with --packaging=case)');
    console.error('  --brand="Name"      Brand name (default: Higher Education)');
    console.error('');
    console.error('Examples:');
    console.error('  node barcode-creator.js "Vitamin D3 5000IU"');
    console.error('  node barcode-creator.js "Vitamin D3 10PK" --packaging=case --qty=10');
    process.exit(1);
  }

  createBarcode(productName, { dryRun, activate: !noActivate, packaging, caseQty, brandName })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch(err => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = { createBarcode };

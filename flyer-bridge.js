// ============================================================
// Flyer Bridge — connects the bot to the HE Flyer Bot
// ============================================================
// No AI API calls. Just Drive + Puppeteer + local rendering.
//
// Usage from bot tools:
//   generate_flyer  → builds flyer from product data
//   save_to_drive   → saves an image sent via WhatsApp to a Drive folder

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FLYER_BOT_DIR = '/root/he-tools/he-flyer-bot';
const OUTPUT_DIR = path.join(FLYER_BOT_DIR, 'output');
const TEMP_DIR = path.join(FLYER_BOT_DIR, 'cache/whatsapp');

// Ensure dirs exist
[OUTPUT_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Drive helpers (reuse OAuth from flyer bot config) ───

let driveClient = null;
let driveReady = false;

function initDrive() {
  if (driveReady) return driveClient;

  try {
    const { google } = require('googleapis');
    const oauthPath = path.join(FLYER_BOT_DIR, 'config/oauth-credentials.json');
    const tokenPath = path.join(FLYER_BOT_DIR, 'config/drive-token.json');

    if (!fs.existsSync(oauthPath) || !fs.existsSync(tokenPath)) {
      console.log('[FLYER-BRIDGE] Drive credentials not found, Drive features disabled');
      return null;
    }

    const creds = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
    const { client_id, client_secret, redirect_uris } = creds.installed;
    const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oauth2.setCredentials(tokens);

    // Auto-refresh
    oauth2.on('tokens', (newTokens) => {
      const merged = { ...tokens, ...newTokens };
      fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    });

    driveClient = google.drive({ version: 'v3', auth: oauth2 });
    driveReady = true;
    console.log('[FLYER-BRIDGE] Drive connected');
    return driveClient;
  } catch (err) {
    console.log('[FLYER-BRIDGE] Drive init failed:', err.message);
    return null;
  }
}

// Load media config for root folder ID
function getRootFolderId() {
  try {
    const mediaConfig = JSON.parse(fs.readFileSync(path.join(FLYER_BOT_DIR, 'config/media.json'), 'utf8'));
    return mediaConfig.google_drive?.root_folder_id || null;
  } catch { return null; }
}

/**
 * Find a subfolder by name within a parent folder.
 */
async function findSubfolder(parentId, name) {
  const drive = initDrive();
  if (!drive) return null;

  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  return res.data.files?.[0]?.id || null;
}

/**
 * Find a folder by path relative to root.
 */
async function findFolderByPath(folderPath) {
  const rootId = getRootFolderId();
  if (!rootId) return null;

  const parts = folderPath.split('/').filter(Boolean);
  let parentId = rootId;

  for (const part of parts) {
    const id = await findSubfolder(parentId, part);
    if (!id) return null;
    parentId = id;
  }

  return parentId;
}

/**
 * Create a subfolder if it doesn't exist.
 */
async function ensureSubfolder(parentId, name) {
  const existing = await findSubfolder(parentId, name);
  if (existing) return existing;

  const drive = initDrive();
  if (!drive) return null;

  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  return res.data.id;
}

// ─── Save image to Drive ───

/**
 * Save an image buffer to a specific Drive folder.
 * folderPath is relative to root, e.g. "Products/Northern Lights"
 */
async function saveImageToDrive(buffer, fileName, folderPath) {
  const drive = initDrive();
  if (!drive) return { ok: false, error: 'Drive not available' };

  try {
    const rootId = getRootFolderId();
    if (!rootId) return { ok: false, error: 'No root folder configured' };

    // Ensure folder path exists
    const parts = folderPath.split('/').filter(Boolean);
    let parentId = rootId;
    for (const part of parts) {
      parentId = await ensureSubfolder(parentId, part);
      if (!parentId) return { ok: false, error: `Could not create folder: ${part}` };
    }

    // Upload file
    const tempPath = path.join(TEMP_DIR, fileName);
    fs.writeFileSync(tempPath, buffer);

    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [parentId],
      },
      media: {
        mimeType: 'image/png',
        body: fs.createReadStream(tempPath),
      },
      fields: 'id, name, webViewLink',
    });

    // Clean up temp
    fs.unlinkSync(tempPath);

    return {
      ok: true,
      fileId: res.data.id,
      name: res.data.name,
      link: res.data.webViewLink,
      folder: folderPath,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Generate Flyer ───

/**
 * Generate a flyer using the HE Flyer Bot engine.
 * Returns { ok, outputPath, reviewScore, driveId, cloudinaryUrl }
 */
async function generateFlyer(productData) {
  try {
    // Write temp input JSON
    const inputPath = path.join(TEMP_DIR, `flyer-input-${Date.now()}.json`);

    // Set defaults
    const input = {
      brand: 'Higher Education',
      website: 'www.highereducation.shop',
      cta: productData.cta || 'Now In Stock',
      output_sizes: productData.output_sizes || ['1080x1350'],
      ...productData,
    };

    fs.writeFileSync(inputPath, JSON.stringify(input, null, 2));

    // Build CLI flags
    const flags = [
      `--input "${inputPath}"`,
      `--out "${OUTPUT_DIR}"`,
    ];

    if (input.flyer_type) flags.push(`--template ${input.flyer_type}`);
    if (input.output_sizes?.length === 1) flags.push(`--only-size ${input.output_sizes[0]}`);

    // Run the flyer bot
    const cmd = `cd "${FLYER_BOT_DIR}" && node dist/cli.js generate ${flags.join(' ')} 2>&1`;
    const output = execSync(cmd, { timeout: 120000, encoding: 'utf8' });

    // Parse output for file paths and scores
    const outputLines = output.split('\n');
    const outputFiles = outputLines
      .filter(l => l.includes('/output/') && l.endsWith('.png'))
      .map(l => l.replace(/^\s*\[.\]\s*/, '').trim());

    // Get the most recent PNG in output dir if parsing failed
    let flyerPath = outputFiles[0];
    if (!flyerPath) {
      const pngs = fs.readdirSync(OUTPUT_DIR)
        .filter(f => f.endsWith('.png'))
        .map(f => ({ name: f, time: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (pngs.length) flyerPath = path.join(OUTPUT_DIR, pngs[0].name);
    }

    if (!flyerPath || !fs.existsSync(flyerPath)) {
      return { ok: false, error: 'Flyer generated but output file not found', log: output };
    }

    // Extract score from output
    const scoreLine = outputLines.find(l => l.includes('Overall Score:'));
    const score = scoreLine ? scoreLine.match(/(\d+\.?\d*)/)?.[1] : null;

    // Extract Cloudinary URL
    const cloudLine = outputLines.find(l => l.includes('cloudinary.com'));
    const cloudinaryUrl = cloudLine ? cloudLine.match(/(https:\/\/res\.cloudinary\.com\S+)/)?.[1] : null;

    // Extract Drive ID
    const driveLine = outputLines.find(l => l.includes('Drive archive ID:'));
    const driveId = driveLine ? driveLine.match(/ID:\s*(\S+)/)?.[1] : null;

    // Clean up temp input
    fs.unlinkSync(inputPath);

    return {
      ok: true,
      outputPath: flyerPath,
      score: score ? parseFloat(score) : null,
      cloudinaryUrl,
      driveId,
      log: output,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  generateFlyer,
  saveImageToDrive,
  initDrive,
  findFolderByPath,
};

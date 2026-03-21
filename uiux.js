/**
 * UI/UX Pro Max — Design System Generator for Favor
 * Ported from https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
 *
 * BM25 search engine + reasoning engine that generates complete design system
 * recommendations from a query (e.g. "beauty spa", "SaaS dashboard").
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data', 'uiux');

// ─── CSV LOADER ───
function loadCSV(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  const raw = fs.readFileSync(filepath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ─── BM25 SEARCH ENGINE ───
class BM25 {
  constructor(k1 = 1.5, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    this.corpus = [];
    this.docLengths = [];
    this.avgdl = 0;
    this.idf = {};
    this.docFreqs = {};
    this.N = 0;
  }

  tokenize(text) {
    return String(text).toLowerCase().replace(/[^\w\s]/g, ' ')
      .split(/\s+/).filter(w => w.length > 2);
  }

  fit(documents) {
    this.corpus = documents.map(d => this.tokenize(d));
    this.N = this.corpus.length;
    if (this.N === 0) return;
    this.docLengths = this.corpus.map(d => d.length);
    this.avgdl = this.docLengths.reduce((a, b) => a + b, 0) / this.N;
    this.docFreqs = {};
    for (const doc of this.corpus) {
      const seen = new Set();
      for (const word of doc) {
        if (!seen.has(word)) {
          this.docFreqs[word] = (this.docFreqs[word] || 0) + 1;
          seen.add(word);
        }
      }
    }
    this.idf = {};
    for (const [word, freq] of Object.entries(this.docFreqs)) {
      this.idf[word] = Math.log((this.N - freq + 0.5) / (freq + 0.5) + 1);
    }
  }

  score(query) {
    const tokens = this.tokenize(query);
    const scores = [];
    for (let idx = 0; idx < this.corpus.length; idx++) {
      const doc = this.corpus[idx];
      const docLen = this.docLengths[idx];
      const tf = {};
      for (const w of doc) tf[w] = (tf[w] || 0) + 1;
      let score = 0;
      for (const token of tokens) {
        if (this.idf[token] !== undefined) {
          const termFreq = tf[token] || 0;
          const idf = this.idf[token];
          const num = termFreq * (this.k1 + 1);
          const den = termFreq + this.k1 * (1 - this.b + this.b * docLen / this.avgdl);
          score += idf * num / den;
        }
      }
      scores.push([idx, score]);
    }
    return scores.sort((a, b) => b[1] - a[1]);
  }
}

// ─── SEARCH CONFIG ───
const CSV_CONFIG = {
  style: {
    file: 'styles.csv',
    searchCols: ['Style Category', 'Keywords', 'Best For', 'Type', 'AI Prompt Keywords'],
    outputCols: ['Style Category', 'Type', 'Keywords', 'Primary Colors', 'Effects & Animation', 'Best For', 'Performance', 'Accessibility']
  },
  color: {
    file: 'colors.csv',
    searchCols: ['Product Type', 'Notes'],
    outputCols: ['Product Type', 'Primary', 'Secondary', 'Accent', 'Background', 'Foreground', 'Notes']
  },
  landing: {
    file: 'landing.csv',
    searchCols: ['Pattern Name', 'Keywords', 'Conversion Optimization', 'Section Order'],
    outputCols: ['Pattern Name', 'Keywords', 'Section Order', 'Primary CTA Placement', 'Color Strategy', 'Conversion Optimization']
  },
  product: {
    file: 'products.csv',
    searchCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Key Considerations'],
    outputCols: ['Product Type', 'Keywords', 'Primary Style Recommendation', 'Secondary Styles', 'Landing Page Pattern', 'Color Palette Focus']
  },
  typography: {
    file: 'typography.csv',
    searchCols: ['Font Pairing Name', 'Category', 'Mood/Style Keywords', 'Best For', 'Heading Font', 'Body Font'],
    outputCols: ['Font Pairing Name', 'Category', 'Heading Font', 'Body Font', 'Mood/Style Keywords', 'Best For', 'Google Fonts URL', 'CSS Import']
  }
};

// ─── CORE SEARCH ───
function searchCSV(domain, query, maxResults = 3) {
  const config = CSV_CONFIG[domain];
  if (!config) return [];
  const data = loadCSV(config.file);
  if (!data.length) return [];

  const documents = data.map(row =>
    config.searchCols.map(col => row[col] || '').join(' ')
  );

  const bm25 = new BM25();
  bm25.fit(documents);
  const ranked = bm25.score(query);

  const results = [];
  for (const [idx, score] of ranked.slice(0, maxResults)) {
    if (score > 0) {
      const row = data[idx];
      const out = {};
      for (const col of config.outputCols) { if (row[col]) out[col] = row[col]; }
      results.push(out);
    }
  }
  return results;
}

// ─── REASONING ENGINE ───
let _reasoningCache = null;

function loadReasoning() {
  if (_reasoningCache) return _reasoningCache;
  _reasoningCache = loadCSV('ui-reasoning.csv');
  return _reasoningCache;
}

function findReasoningRule(category) {
  const rules = loadReasoning();
  const catLower = category.toLowerCase();

  // Exact match
  for (const rule of rules) {
    if ((rule.UI_Category || '').toLowerCase() === catLower) return rule;
  }
  // Partial match
  for (const rule of rules) {
    const ui = (rule.UI_Category || '').toLowerCase();
    if (ui.includes(catLower) || catLower.includes(ui)) return rule;
  }
  // Keyword match
  for (const rule of rules) {
    const keywords = (rule.UI_Category || '').toLowerCase().replace(/[/\-]/g, ' ').split(/\s+/);
    if (keywords.some(kw => kw.length > 2 && catLower.includes(kw))) return rule;
  }
  return null;
}

function applyReasoning(category) {
  const rule = findReasoningRule(category);
  if (!rule) {
    return {
      pattern: 'Hero + Features + CTA',
      stylePriority: ['Minimalism', 'Flat Design'],
      colorMood: 'Professional',
      typographyMood: 'Clean',
      keyEffects: 'Subtle hover transitions',
      antiPatterns: '',
      decisionRules: {},
      severity: 'MEDIUM'
    };
  }

  let decisionRules = {};
  try { decisionRules = JSON.parse(rule.Decision_Rules || '{}'); } catch {}

  return {
    pattern: rule.Recommended_Pattern || '',
    stylePriority: (rule.Style_Priority || '').split('+').map(s => s.trim()).filter(Boolean),
    colorMood: rule.Color_Mood || '',
    typographyMood: rule.Typography_Mood || '',
    keyEffects: rule.Key_Effects || '',
    antiPatterns: rule.Anti_Patterns || '',
    decisionRules,
    severity: rule.Severity || 'MEDIUM'
  };
}

// ─── BEST MATCH SELECTION ───
function selectBestMatch(results, priorityKeywords) {
  if (!results.length) return {};
  if (!priorityKeywords || !priorityKeywords.length) return results[0];

  // Try exact style name match
  for (const priority of priorityKeywords) {
    const pLow = priority.toLowerCase().trim();
    for (const result of results) {
      const styleName = (result['Style Category'] || '').toLowerCase();
      if (pLow.includes(styleName) || styleName.includes(pLow)) return result;
    }
  }

  // Score by keyword match
  let best = results[0], bestScore = 0;
  for (const result of results) {
    const resultStr = JSON.stringify(result).toLowerCase();
    let score = 0;
    for (const kw of priorityKeywords) {
      const kwLow = kw.toLowerCase().trim();
      if ((result['Style Category'] || '').toLowerCase().includes(kwLow)) score += 10;
      else if ((result['Keywords'] || '').toLowerCase().includes(kwLow)) score += 3;
      else if (resultStr.includes(kwLow)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = result; }
  }
  return best;
}

// ─── DESIGN SYSTEM GENERATOR ───
function generateDesignSystem(query, projectName) {
  // Step 1: Search product to get category
  const productResults = searchCSV('product', query, 1);
  const category = productResults.length ? (productResults[0]['Product Type'] || 'General') : 'General';

  // Step 2: Get reasoning rules
  const reasoning = applyReasoning(category);
  const stylePriority = reasoning.stylePriority;

  // Step 3: Multi-domain search with style priority hints
  const styleQuery = stylePriority.length
    ? `${query} ${stylePriority.slice(0, 2).join(' ')}`
    : query;

  const styleResults = searchCSV('style', styleQuery, 3);
  const colorResults = searchCSV('color', query, 2);
  const typographyResults = searchCSV('typography', query, 2);
  const landingResults = searchCSV('landing', query, 2);

  // Step 4: Select best matches
  const bestStyle = selectBestMatch(styleResults, stylePriority);
  const bestColor = colorResults[0] || {};
  const bestTypography = typographyResults[0] || {};
  const bestLanding = landingResults[0] || {};

  // Step 5: Build recommendation
  const styleEffects = bestStyle['Effects & Animation'] || '';
  const combinedEffects = styleEffects || reasoning.keyEffects;

  return {
    projectName: projectName || query,
    category,
    pattern: {
      name: bestLanding['Pattern Name'] || reasoning.pattern || 'Hero + Features + CTA',
      sections: bestLanding['Section Order'] || 'Hero > Features > CTA',
      ctaPlacement: bestLanding['Primary CTA Placement'] || 'Above fold',
      colorStrategy: bestLanding['Color Strategy'] || '',
      conversion: bestLanding['Conversion Optimization'] || ''
    },
    style: {
      name: bestStyle['Style Category'] || 'Minimalism',
      type: bestStyle['Type'] || 'General',
      effects: styleEffects,
      keywords: bestStyle['Keywords'] || '',
      bestFor: bestStyle['Best For'] || '',
      performance: bestStyle['Performance'] || '',
      accessibility: bestStyle['Accessibility'] || ''
    },
    colors: {
      primary: bestColor['Primary'] || '#2563EB',
      secondary: bestColor['Secondary'] || '#3B82F6',
      accent: bestColor['Accent'] || '#F97316',
      background: bestColor['Background'] || '#F8FAFC',
      text: bestColor['Foreground'] || '#1E293B',
      notes: bestColor['Notes'] || ''
    },
    typography: {
      heading: bestTypography['Heading Font'] || 'Inter',
      body: bestTypography['Body Font'] || 'Inter',
      mood: bestTypography['Mood/Style Keywords'] || reasoning.typographyMood,
      bestFor: bestTypography['Best For'] || '',
      googleFontsUrl: bestTypography['Google Fonts URL'] || '',
      cssImport: bestTypography['CSS Import'] || ''
    },
    keyEffects: combinedEffects,
    antiPatterns: reasoning.antiPatterns,
    decisionRules: reasoning.decisionRules,
    severity: reasoning.severity
  };
}

// ─── OUTPUT FORMATTERS ───
function formatMarkdown(ds) {
  const lines = [];
  lines.push(`## Design System: ${ds.projectName}`);
  lines.push('');

  lines.push('### Pattern');
  lines.push(`- *Name:* ${ds.pattern.name}`);
  if (ds.pattern.conversion) lines.push(`- *Conversion:* ${ds.pattern.conversion}`);
  if (ds.pattern.ctaPlacement) lines.push(`- *CTA Placement:* ${ds.pattern.ctaPlacement}`);
  lines.push(`- *Sections:* ${ds.pattern.sections}`);
  lines.push('');

  lines.push('### Style');
  lines.push(`- *Name:* ${ds.style.name}`);
  if (ds.style.keywords) lines.push(`- *Keywords:* ${ds.style.keywords}`);
  if (ds.style.bestFor) lines.push(`- *Best For:* ${ds.style.bestFor}`);
  if (ds.style.performance) lines.push(`- *Performance:* ${ds.style.performance} | *Accessibility:* ${ds.style.accessibility}`);
  lines.push('');

  lines.push('### Colors');
  lines.push(`- Primary: ${ds.colors.primary}`);
  lines.push(`- Secondary: ${ds.colors.secondary}`);
  lines.push(`- Accent/CTA: ${ds.colors.accent}`);
  lines.push(`- Background: ${ds.colors.background}`);
  lines.push(`- Text: ${ds.colors.text}`);
  if (ds.colors.notes) lines.push(`- _${ds.colors.notes}_`);
  lines.push('');

  lines.push('### Typography');
  lines.push(`- *Heading:* ${ds.typography.heading}`);
  lines.push(`- *Body:* ${ds.typography.body}`);
  if (ds.typography.mood) lines.push(`- *Mood:* ${ds.typography.mood}`);
  if (ds.typography.bestFor) lines.push(`- *Best For:* ${ds.typography.bestFor}`);
  if (ds.typography.googleFontsUrl) lines.push(`- *Google Fonts:* ${ds.typography.googleFontsUrl}`);
  lines.push('');

  if (ds.keyEffects) {
    lines.push('### Key Effects');
    lines.push(ds.keyEffects);
    lines.push('');
  }

  if (ds.antiPatterns) {
    lines.push('### Avoid (Anti-patterns)');
    for (const ap of ds.antiPatterns.split('+')) {
      if (ap.trim()) lines.push(`- ${ap.trim()}`);
    }
    lines.push('');
  }

  lines.push('### Pre-Delivery Checklist');
  lines.push('- No emojis as icons (use SVG: Heroicons/Lucide)');
  lines.push('- cursor-pointer on all clickable elements');
  lines.push('- Hover states with smooth transitions (150-300ms)');
  lines.push('- Light mode: text contrast 4.5:1 minimum');
  lines.push('- Focus states visible for keyboard nav');
  lines.push('- prefers-reduced-motion respected');
  lines.push('- Responsive: 375px, 768px, 1024px, 1440px');

  return lines.join('\n');
}

function formatCompact(ds) {
  // Compact format for WhatsApp (no markdown tables, fits small screen)
  const lines = [];
  lines.push(`*DESIGN SYSTEM: ${ds.projectName.toUpperCase()}*`);
  lines.push(`Category: ${ds.category}`);
  lines.push('');
  lines.push(`*PATTERN:* ${ds.pattern.name}`);
  lines.push(`Sections: ${ds.pattern.sections}`);
  if (ds.pattern.ctaPlacement) lines.push(`CTA: ${ds.pattern.ctaPlacement}`);
  lines.push('');
  lines.push(`*STYLE:* ${ds.style.name}`);
  if (ds.style.keywords) lines.push(`Keywords: ${ds.style.keywords}`);
  lines.push('');
  lines.push('*COLORS:*');
  lines.push(`  Primary: ${ds.colors.primary}`);
  lines.push(`  Secondary: ${ds.colors.secondary}`);
  lines.push(`  Accent: ${ds.colors.accent}`);
  lines.push(`  Background: ${ds.colors.background}`);
  lines.push(`  Text: ${ds.colors.text}`);
  if (ds.colors.notes) lines.push(`  (${ds.colors.notes})`);
  lines.push('');
  lines.push(`*TYPOGRAPHY:* ${ds.typography.heading} / ${ds.typography.body}`);
  if (ds.typography.mood) lines.push(`Mood: ${ds.typography.mood}`);
  if (ds.typography.googleFontsUrl) lines.push(`Fonts: ${ds.typography.googleFontsUrl}`);
  lines.push('');
  if (ds.keyEffects) lines.push(`*EFFECTS:* ${ds.keyEffects}`);
  if (ds.antiPatterns) lines.push(`*AVOID:* ${ds.antiPatterns}`);

  return lines.join('\n');
}

// ─── SINGLE-DOMAIN SEARCH (for quick lookups) ───
function searchDomain(query, domain, maxResults = 3) {
  const results = searchCSV(domain, query, maxResults);
  if (!results.length) return `No ${domain} results for: ${query}`;
  return results.map((r, i) => {
    const entries = Object.entries(r).map(([k, v]) => `${k}: ${v}`);
    return `[${i + 1}] ${entries.join(' | ')}`;
  }).join('\n\n');
}

// ─── EXPORTS ───
module.exports = {
  generateDesignSystem,
  formatMarkdown,
  formatCompact,
  searchDomain
};

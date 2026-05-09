'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠  Warning: ANTHROPIC_API_KEY is not set — API calls will fail.');
}

const client = new Anthropic();

const SYSTEM_PROMPT = `You are an experienced Australian woodworker and friendly mentor. You help hobby woodworkers — many of them older Australians — plan their projects with practical, encouraging advice.

Always:
- Use Australian spelling (colour, behaviour, centre, aluminium, etc.)
- Use metric measurements only (millimetres, centimetres, metres)
- Recommend Australian timber species as the primary choice (e.g. Spotted Gum, Blackwood, Tasmanian Oak, Victorian Ash, Queensland Silver Ash, Radiata Pine, Hoop Pine, Brush Box, Jarrah, Silky Oak)
- Write in warm, plain, conversational Australian English — like a knowledgeable mate at the hardware store
- Explain any technical terms briefly in plain language when you first use them
- Be encouraging and practical
- Tailor step complexity to the stated experience level
- Tailor the steps to the tools available — never suggest steps that require tools the person doesn't have

Never:
- Say "lumber" — always say "timber"
- Recommend non-Australian timber species as the primary recommendation (you may briefly mention alternatives exist)
- Use unexplained jargon
- Mention AI, technology, or anything about how you work`;

const VALID_EXPERIENCE = ['Beginner', 'Intermediate', 'Experienced'];
const VALID_TOOLS = ['Basic hand tools', 'Power tools', 'Full workshop'];

app.post('/api/variants', async (req, res) => {
  const { project } = req.body;
  if (!project || typeof project !== 'string' || project.length > 600) {
    return res.status(400).json({ error: 'Invalid project description.' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      system: 'You are a woodworking design advisor for Australian hobby woodworkers. Output only valid JSON as specified — no extra text.',
      messages: [{
        role: 'user',
        content: `Generate exactly 3 distinct design variants for this woodworking project. Return ONLY a JSON array — no other text.

Project: ${project}

Rules:
- The 3 variants must represent meaningfully different approaches. Vary complexity, storage, joinery style, or aesthetic — not just surface details.
- Each "name" is 2–4 friendly words (e.g. "Simple and Sturdy", "With Drawer Storage", "Craftsman Style").
- Each "description" is 2–3 sentences in plain, warm Australian English. No unexplained woodworking jargon — if you use a term, explain it in plain words. Mention who each variant suits.

Return exactly this structure:
[
  {"name": "...", "description": "..."},
  {"name": "...", "description": "..."},
  {"name": "...", "description": "..."}
]`,
      }],
    });

    const raw = message.content[0]?.text?.trim() ?? '';
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');

    const variants = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(variants) || variants.length < 2) throw new Error('Invalid variants');

    const clean = variants.slice(0, 3).map(v => ({
      name:        String(v.name        ?? '').slice(0, 60),
      description: String(v.description ?? '').slice(0, 500),
    }));

    res.json({ variants: clean });
  } catch (err) {
    console.error('Variants error:', err.message);
    res.status(500).json({ error: 'Could not generate design options. Please try again.' });
  }
});

app.post('/api/generate', async (req, res) => {
  const { project, experience, tools, timber, variant } = req.body;

  if (!project || !experience || !tools || !timber) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (!VALID_EXPERIENCE.includes(experience)) {
    return res.status(400).json({ error: 'Invalid experience value.' });
  }
  if (!VALID_TOOLS.includes(tools)) {
    return res.status(400).json({ error: 'Invalid tools value.' });
  }
  if (typeof project !== 'string' || project.length > 600) {
    return res.status(400).json({ error: 'Project description is too long.' });
  }
  if (typeof timber !== 'string' || timber.length > 300) {
    return res.status(400).json({ error: 'Timber preference is too long.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const timberNote = timber === 'suggest'
    ? 'Please suggest the most suitable Australian timber species for this project and skill level.'
    : `Timber preference stated by the person: "${timber}". Use this if it is suitable; otherwise suggest a better Australian alternative and explain why.`;

  const variantNote = (variant && variant.name && variant.description)
    ? `- **Chosen design approach:** "${variant.name}" — ${variant.description}\n`
    : '';

  const userMessage = `Please create a detailed project plan for the following Australian woodworker:

- **Project:** ${project}
${variantNote}- **Experience level:** ${experience}
- **Available tools:** ${tools}
- **Timber:** ${timberNote}
${variantNote ? '\nIMPORTANT: The entire plan — the overview, materials list, build steps, and tips — must reflect the chosen design approach above. The features, storage options, joinery method, and complexity described in that approach should be clearly present throughout the plan. Do not produce a generic plan.\n' : ''}
Format your response using these exact section headings:

## Overview
A friendly 2–3 sentence summary of the project and the chosen design approach, and why it's a great choice for this person.

## Recommended Timber
List 1–2 Australian timber species. For each, give a brief, practical reason why it suits this project and this person's experience level. Mention where to find it (hardware store, timber yard, etc.).

## Materials and Cut List
A clear, practical list reflecting the chosen design. Use metric measurements. Include approximate quantities.

## Step-by-Step Build Plan
Numbered steps written in plain English. Tailor the complexity and techniques to the person's experience level and available tools. When you first use a term a beginner might not know, add a brief plain-English explanation in brackets.

## A Few Tips
2–3 practical tips specific to this project and design approach — things that will make a real difference.`;

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`);
      res.end();
    });

    await stream.finalMessage();
    res.write('data: {"done":true}\n\n');
    res.end();

  } catch (err) {
    console.error('Anthropic API error:', err.message);
    const msg = err.status === 401
      ? 'API key problem — please check your ANTHROPIC_API_KEY.'
      : 'Something went wrong putting your plan together. Please try again.';
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

// The client sends only the extracted Materials/Cut List section, not the full plan.
// This keeps the sketch call small and completely independent of the plan's token budget.
app.post('/api/sketch', async (req, res) => {
  const { project, cutList } = req.body;
  if (!project || typeof project !== 'string') {
    return res.status(400).json({ error: 'Missing project.' });
  }

  const cutListText = (typeof cutList === 'string' ? cutList : '').slice(0, 1600);
  let svg = null;

  // Try Claude first
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: 'You are a technical draughtsperson. Output only raw SVG markup — no code fences, no explanation, nothing outside the SVG tags.',
      messages: [{
        role: 'user',
        content: `Create a workshop sketch in SVG showing a FRONT VIEW and SIDE VIEW of this project.

Project: ${project}

Cut list (read carefully to extract dimensions and identify structural features):
${cutListText}

━━━ STEP 1 — ANALYSE ━━━
From the cut list, determine:
• Overall width W, height H, depth D in mm
• Structural features present: legs / drawers / shelves / open cavities / back panel / doors

━━━ STEP 2 — FRONT VIEW ━━━
Draw the assembled front face. Show internal structure — do NOT draw a blank rectangle:
• Outer bounding outline of the whole piece
• LEGS: if present, draw them as separate vertical rectangles below the main body at the corners
• DRAWERS: draw each drawer front as a rectangle inset ~3px inside its opening, plus a short horizontal centred line as the handle
• SHELVES: draw horizontal lines spanning the internal width at proportional positions
• OPEN CAVITY: leave as empty space within the outline (no fill, no line across it)
• DOORS: rectangle in opening with a small circle near one edge for a knob

━━━ STEP 3 — SIDE VIEW ━━━
Draw the right-side profile at the same height as the front view, 65px to its right:
• Outer profile rectangle (width = depth D, height = H)
• If the piece has legs, show leg depth at bottom corners
• Indicate back panel with a short vertical line at the rear inside edge

━━━ STEP 4 — LABELS ━━━
Add short callout labels for key features. For each:
• A short horizontal leader line from the part edge to the label
• Label text in font-family="monospace" font-size="10" fill="#333"
• Place labels to the right of the front view outline (or left if needed to avoid crowding)
• One word per label: "Top", "Drawer", "Shelf", "Leg", "Side", "Cavity", "Back", "Handle"

━━━ STEP 5 — DIMENSIONS ━━━
Three dimension lines using the actual mm values from the cut list:
1. Width W — horizontal dim line 32px below the bottom of the front view
2. Depth D — horizontal dim line at the same y, below the side view
3. Height H — vertical dim line in the 65px gap between front and side views

Each dimension line:
• Extension lines: stroke="#ccc" stroke-width="0.6", from object edge to dim line
• Arrow line with inward arrowheads both ends: stroke="#999" stroke-width="0.8" marker-start="url(#a)" marker-end="url(#a)"
• Value text centred above the arrow line: font-family="monospace" font-size="10" fill="#666"

━━━ STYLE ━━━
Workshop sketch on white paper — outlines only:
• ALL shapes: fill="none" — no colour fills at all
• Main structure lines: stroke="#333" stroke-width="1.8"
• Internal lines (shelves, drawer outlines, leg outlines): stroke="#555" stroke-width="1.1"
• Centre lines or secondary detail: stroke="#888" stroke-width="0.7" stroke-dasharray="4 2"

━━━ SVG CANVAS ━━━
viewBox="0 0 600 400" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg"

Margins: left 72px · top 28px · bottom 55px · right 22px · gap between views 65px
Scale front and side views proportionally from W, H, D to fill this space.
Add "FRONT VIEW" above the front view and "SIDE VIEW" above the side view in font-size="9" fill="#999" text-anchor="middle".

In <defs> include:
<marker id="a" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><polygon points="0 0,6 2.5,0 5" fill="#888"/></marker>

Output ONLY the raw SVG. Begin with <svg and end with </svg>. No code fences, no text before or after.`,
      }],
    });

    const raw = message.content[0]?.text?.trim() ?? '';
    console.log('[sketch] Claude response start:', raw.slice(0, 120));
    const match = raw.match(/<svg[\s\S]*<\/svg>/i);
    const candidate = match ? match[0] : raw;
    if (candidate.trimStart().startsWith('<svg') && candidate.includes('</svg>')) {
      svg = candidate;
      console.log('[sketch] Claude SVG accepted, length:', svg.length);
    } else {
      console.warn('[sketch] Claude output did not contain valid SVG, using fallback');
    }
  } catch (err) {
    console.warn('[sketch] Claude call failed:', err.message);
  }

  // Fallback: generate a clean programmatic box diagram — always succeeds
  if (!svg) {
    try {
      console.log('[sketch] Generating fallback SVG for:', project);
      svg = generateFallbackSvg(project, cutListText);
    } catch (err) {
      console.error('[sketch] Fallback SVG generation failed:', err.message);
      svg = generateFallbackSvg(project, ''); // bare minimum with defaults
    }
  }

  res.json({ svg });
});

// ── Fallback SVG helpers ──────────────────────────────────────────────────────

function parseDimensions(planText) {
  const cutMatch = planText.match(/##\s*Materials[\s\S]*?(?=\n##|$)/i);
  const text = cutMatch ? cutMatch[0] : planText;

  const pairs = [];
  const re = /(\d{2,4})\s*(?:mm)?\s*[x×]\s*(\d{2,4})\s*(?:mm)?(?:\s*[x×]\s*(\d{2,4})\s*(?:mm)?)?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const a = parseInt(m[1]), b = parseInt(m[2]);
    if (a >= 50 && b >= 50) pairs.push([a, b, m[3] ? parseInt(m[3]) : null]);
  }

  if (pairs.length > 0) {
    pairs.sort((a, b) => (b[0] * b[1]) - (a[0] * a[1]));
    const [W, H, rawD] = pairs[0];
    let depth = rawD ?? pairs.find(p => p[2])?.[2] ?? null;
    // Ignore depth if it looks like a board thickness rather than a structural dimension
    if (depth && depth < Math.min(W, H) * 0.15) depth = null;
    return { W, H, D: depth };
  }

  // Fallback: pull out standalone mm values ≥ 100
  const vals = [];
  const mmRe = /\b(\d{3,4})\b/g;
  while ((m = mmRe.exec(text)) !== null) {
    const v = parseInt(m[1]);
    if (v >= 100 && v <= 3000) vals.push(v);
  }
  vals.sort((a, b) => b - a);
  const uniq = [...new Set(vals)];
  return { W: uniq[0] || 900, H: uniq[1] || 450, D: uniq[2] || null };
}

function generateFallbackSvg(projectTitle, planText) {
  const { W, H, D } = parseDimensions(planText);

  // Always show a side view — use a sensible default depth if none was found
  const depth = D ?? Math.round(Math.min(W, H) * 0.45);

  const VW = 600, VH = 400;
  const LEFT = 72, BOT = 55, TOP = 28, RIGHT = 22;
  const GAP = 65; // gap between front and side views (houses the height dim line)

  const drawW = VW - LEFT - RIGHT - GAP;
  const drawH = VH - TOP - BOT;
  const totalModelW = W + depth;
  const scale = Math.min(drawW / totalModelW, drawH / H) * 0.85;

  const fw = Math.round(W * scale);
  const fh = Math.round(H * scale);
  const sd = Math.round(depth * scale);

  // Centre the block vertically
  const blockH = fh;
  const ox = LEFT;
  const oy = Math.round(TOP + (drawH - blockH) / 2);

  const fx = ox, fy = oy;
  const sx = fx + fw + GAP, sy = fy;
  const D_OFF = 32, TICK = 5;
  const wY = fy + fh + D_OFF; // y of width/depth dimension lines
  const hX = sx - Math.round(GAP / 2); // x of height dimension line (in the gap)

  const title = projectTitle.length > 52 ? projectTitle.slice(0, 52) + '…' : projectTitle;

  const o = [];
  const l = s => o.push(s);

  l(`<svg viewBox="0 0 ${VW} ${VH}" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg">`);
  l(`<defs><marker id="a" markerWidth="6" markerHeight="5" refX="5" refY="2.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><polygon points="0 0,6 2.5,0 5" fill="#888"/></marker></defs>`);

  l(`<text x="${VW/2}" y="16" text-anchor="middle" font-family="monospace" font-size="11" font-weight="bold" fill="#333">${xmlEsc(title)}</text>`);

  // Front view — outline only, no fill
  l(`<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="#333" stroke-width="1.8"/>`);
  l(`<text x="${fx + fw/2}" y="${fy - 6}" text-anchor="middle" font-family="monospace" font-size="9" fill="#999">FRONT VIEW</text>`);

  // Width dimension (below front view)
  l(`<line x1="${fx}" y1="${fy+fh+2}" x2="${fx}" y2="${wY+TICK}" stroke="#ccc" stroke-width="0.6"/>`);
  l(`<line x1="${fx+fw}" y1="${fy+fh+2}" x2="${fx+fw}" y2="${wY+TICK}" stroke="#ccc" stroke-width="0.6"/>`);
  l(`<line x1="${fx}" y1="${wY}" x2="${fx+fw}" y2="${wY}" stroke="#999" stroke-width="0.8" marker-start="url(#a)" marker-end="url(#a)"/>`);
  l(`<text x="${fx+fw/2}" y="${wY-6}" text-anchor="middle" font-family="monospace" font-size="10" fill="#666">${W}mm</text>`);

  // Height dimension (in the gap between views)
  l(`<line x1="${fx+fw+2}" y1="${fy}" x2="${hX-TICK}" y2="${fy}" stroke="#ccc" stroke-width="0.6"/>`);
  l(`<line x1="${fx+fw+2}" y1="${fy+fh}" x2="${hX-TICK}" y2="${fy+fh}" stroke="#ccc" stroke-width="0.6"/>`);
  l(`<line x1="${hX}" y1="${fy}" x2="${hX}" y2="${fy+fh}" stroke="#999" stroke-width="0.8" marker-start="url(#a)" marker-end="url(#a)"/>`);
  const hMid = fy + fh/2;
  l(`<text x="${hX}" y="${hMid}" text-anchor="middle" font-family="monospace" font-size="10" fill="#666" transform="rotate(-90,${hX},${hMid})">${H}mm</text>`);

  // Side view — outline only, no fill
  l(`<rect x="${sx}" y="${sy}" width="${sd}" height="${fh}" fill="none" stroke="#333" stroke-width="1.8"/>`);
  l(`<text x="${sx+sd/2}" y="${sy-6}" text-anchor="middle" font-family="monospace" font-size="9" fill="#999">SIDE VIEW</text>`);

  // Depth dimension (below side view, same y as width)
  l(`<line x1="${sx}" y1="${sy+fh+2}" x2="${sx}" y2="${wY+TICK}" stroke="#ccc" stroke-width="0.6"/>`);
  l(`<line x1="${sx+sd}" y1="${sy+fh+2}" x2="${sx+sd}" y2="${wY+TICK}" stroke="#ccc" stroke-width="0.6"/>`);
  l(`<line x1="${sx}" y1="${wY}" x2="${sx+sd}" y2="${wY}" stroke="#999" stroke-width="0.8" marker-start="url(#a)" marker-end="url(#a)"/>`);
  l(`<text x="${sx+sd/2}" y="${wY-6}" text-anchor="middle" font-family="monospace" font-size="10" fill="#666">${depth}mm</text>`);

  l(`</svg>`);
  return o.join('\n');
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

app.listen(PORT, () => {
  console.log(`woodworking.au Project Planner → http://localhost:${PORT}`);
});

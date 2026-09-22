'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('⚠  Warning: ANTHROPIC_API_KEY is not set — API calls will fail.');
}
if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠  Warning: GEMINI_API_KEY is not set — image generation will be disabled.');
}

const client = new Anthropic();
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

// Imagen 4 (standard/ultra/fast) was shut down by Google on 2026-08-17.
// Image generation uses generateContent on the Gemini 3.1 Flash Image models.
// Flash-Lite for variant thumbnails (speed); Flash for higher-quality project sketches.
const VARIANT_IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
const SKETCH_IMAGE_MODEL  = 'gemini-3.1-flash-image';

async function generateImage(prompt, model) {
  const response = await genAI.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });
  // Images come back as inlineData parts (mimeType + base64 data), alongside any text parts.
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find(p => p.inlineData?.data);
  if (!imagePart) return null;
  const { data, mimeType } = imagePart.inlineData;
  return `data:${mimeType || 'image/jpeg'};base64,${data}`;
}

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

    // Generate one lifestyle image per variant in parallel — a per-image failure
    // doesn't fail the whole request, but we log it so it's visible in Vercel logs
    // instead of silently showing up as a card with no image.
    const imageResults = await Promise.allSettled(
      clean.map(v => generateImage(
        `Isometric illustration of a ${project} in ${v.name} style, woodworking project, warm timber tones, clean workshop setting, no text, no measurements, no dimension lines, no labels, no numbers, soft natural lighting, white background`,
        VARIANT_IMAGE_MODEL
      ))
    );

    const variantsWithImages = clean.map((v, i) => {
      const result = imageResults[i];
      if (result.status === 'rejected') {
        console.error(`Variant image ${i} (${v.name}) failed:`, result.reason?.message ?? result.reason);
      } else if (!result.value) {
        console.error(`Variant image ${i} (${v.name}) returned no image bytes (likely filtered or empty response).`);
      }
      return { ...v, image: result.status === 'fulfilled' ? result.value : null };
    });

    const imageCount = variantsWithImages.filter(v => v.image).length;
    console.log(`/api/variants: generated ${imageCount}/${variantsWithImages.length} images.`);

    res.json({ variants: variantsWithImages });
  } catch (err) {
    console.error('Variants error:', err.message);
    res.status(500).json({ error: 'Could not generate design options. Please try again.' });
  }
});

// Callout labels must stay under 5 characters: bare millimetres (Australian drawing
// convention), or whole metres for anything of 10 m or more.
function dimensionLabel(mm) {
  return mm < 10000 ? String(mm) : `${Math.round(mm / 1000)}m`;
}

// Pull the finished piece's overall size (mm) out of the plan text. Returns null unless
// all three values are present, so the sketch never shows an invented dimension.
async function extractOverallDimensions(planText) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `From this woodworking plan, give the overall finished dimensions of the completed piece in millimetres. Return ONLY a JSON object like {"width": 900, "height": 450, "depth": 400} — no other text.

- width: the longest horizontal side as seen from the front
- height: vertical size, floor or base to top
- depth: front to back
- Use the overall dimensions if the plan states them; otherwise derive them from the cut list. Do not guess.
- Use 0 for any value that cannot be determined from the plan.

Plan:
${planText.slice(0, 6000)}`,
    }],
  });
  const raw = message.content[0]?.text ?? '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  const dims = ['width', 'height', 'depth'].map(k => Math.round(Number(parsed[k])));
  return dims.every(n => Number.isFinite(n) && n > 0 && n <= 20000)
    ? { width: dims[0], height: dims[1], depth: dims[2] }
    : null;
}

// Project sketch for the plan page — same look as the variant image, but generated
// with the higher-quality model and carrying real overall width / height / depth callouts.
app.post('/api/sketch', async (req, res) => {
  const { project, variant, planText } = req.body;
  if (!project || typeof project !== 'string' || project.length > 600 ||
      !variant || typeof variant.name !== 'string' || !variant.name || variant.name.length > 60 ||
      typeof planText !== 'string' || !planText || planText.length > 30000) {
    return res.status(400).json({ error: 'Invalid sketch request.' });
  }

  try {
    const dims = await extractOverallDimensions(planText);
    if (!dims) {
      console.warn(`Sketch (${variant.name}): overall dimensions not found in plan; skipping.`);
      return res.status(422).json({ error: 'Overall dimensions not available.' });
    }

    const image = await generateImage(
      `Isometric illustration of a ${project} in ${variant.name} style, woodworking project, warm timber tones, clean workshop setting, soft natural lighting, white background. Add exactly three short dimension callouts, with thin dimension lines, showing the overall width ("${dimensionLabel(dims.width)}"), height ("${dimensionLabel(dims.height)}") and depth ("${dimensionLabel(dims.depth)}") of the piece, with each label written exactly as given. No other text, no other numbers, no other labels or measurements`,
      SKETCH_IMAGE_MODEL
    );
    if (!image) {
      console.error(`Sketch (${variant.name}) returned no image bytes (likely filtered or empty response).`);
      return res.status(502).json({ error: 'No sketch generated.' });
    }
    res.json({ image });
  } catch (err) {
    console.error('Sketch error:', err.message);
    res.status(500).json({ error: 'Could not generate sketch.' });
  }
});

app.post('/api/generate', async (req, res) => {
  const { project, experience, tools, timber, variant, variantImage } = req.body;

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

  // Build multimodal content when the selected variant image is provided
  let messageContent = userMessage;
  if (variantImage && typeof variantImage === 'string') {
    const imgMatch = variantImage.match(/^data:(image\/\w+);base64,(.+)$/);
    if (imgMatch) {
      messageContent = [
        {
          type: 'image',
          source: { type: 'base64', media_type: imgMatch[1], data: imgMatch[2] },
        },
        {
          type: 'text',
          text: `The image above shows the selected design variant: "${variant?.name ?? ''}". Use it as a visual reference when writing the build plan — the structure, proportions, and features visible in the image should be reflected in the instructions.\n\n${userMessage}`,
        },
      ];
    }
  }

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: messageContent }],
    });

    let fullPlanText = '';
    stream.on('text', (text) => {
      fullPlanText += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on('error', (err) => {
      console.error('Stream error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`);
      res.end();
    });

    await stream.finalMessage();

    // ── Extract cut list as structured JSON via a second quick API call ──
    let cutListData = null;
    try {
      const extraction = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Extract the cut list from this woodworking plan as JSON. Return ONLY a valid JSON array — no other text, no markdown, no code fences.

Each object must have exactly these fields:
- "partName": string (descriptive name of the piece)
- "quantity": integer (number of identical pieces)
- "length": integer (millimetres; 0 if not stated)
- "width": integer (millimetres; 0 if not stated)
- "thickness": integer (millimetres; 0 if not stated)
- "category": string (short group name for the part's role in the piece, 1–3 words, e.g. "Frame", "Top", "Shelves", "Drawers"; use the plan's own heading if it has one; use "Main parts" if there is no natural grouping)

Include only solid timber/sheet timber pieces. Omit hardware (screws, hinges), consumables, and finishing materials.

Plan:
${fullPlanText.slice(0, 6000)}`,
        }],
      });
      const raw = extraction.content[0]?.text?.trim() ?? '';
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        cutListData = JSON.parse(match[0]);
        console.log(`[cutlist] Extracted ${cutListData.length} parts OK`);
      } else {
        console.warn('[cutlist] No JSON array found in extraction response. Raw:', raw.slice(0, 200));
      }
    } catch (e) {
      console.warn('[cutlist] Extraction failed:', e.status ?? '', e.message);
    }

    res.write(`data: ${JSON.stringify({ done: true, ...(cutListData ? { cutListData } : {}) })}\n\n`);
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



// ── Exploded view (Claude-generated SVG) ──
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

// The SVG is shown through an <img>, which never runs script, but strip anything
// active or external anyway so the markup is safe wherever it ends up.
function sanitiseSvg(raw) {
  const match = raw.match(/<svg[\s\S]*<\/svg>/i);
  if (!match) return null;
  let svg = match[0]
    .replace(/<(script|foreignObject|image|iframe|style|animate\w*|set)\b[\s\S]*?(<\/\1>|\/>)/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '')
    .replace(/javascript:/gi, '');
  if (!/viewBox\s*=/i.test(svg)) return null;
  if (!/xmlns\s*=/i.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg.length <= 80000 ? svg : null;
}

app.post('/api/exploded-view', async (req, res) => {
  const { project, groups, planText = '' } = req.body;
  if (!project || typeof project !== 'string' || project.length > 600 ||
      !Array.isArray(groups) || !groups.length || groups.length > 12 ||
      typeof planText !== 'string') {
    return res.status(400).json({ error: 'Invalid exploded view request.' });
  }

  // Re-validate and flatten the client's numbered, colour-coded groups.
  let partCount = 0;
  const lines = [];
  for (const g of groups) {
    if (!g || !HEX_COLOUR.test(g.colour) || !Array.isArray(g.parts)) {
      return res.status(400).json({ error: 'Invalid exploded view request.' });
    }
    lines.push(`\nGroup "${String(g.name || 'Parts').slice(0, 40)}" — fill ${g.colour}`);
    for (const p of g.parts) {
      partCount++;
      const dims = Array.isArray(p.dims) ? p.dims.map(n => Math.round(Number(n)) || 0).slice(0, 3) : [0, 0, 0];
      lines.push(`  ${parseInt(p.n, 10) || partCount}. ${String(p.name ?? '').slice(0, 60)} — ${dims.join(' × ')} mm (length × width × thickness), qty ${parseInt(p.qty, 10) || 1}`);
    }
  }
  if (partCount === 0 || partCount > 40) {
    return res.status(400).json({ error: 'Invalid exploded view request.' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: 'You are a technical illustrator who draws clear, accurate exploded assembly diagrams as SVG. Output only the SVG markup — no explanation, no code fences.',
      messages: [{
        role: 'user',
        content: `Draw an exploded-view assembly diagram of this woodworking project as a single SVG.

Project: ${project}

Numbered parts, grouped and colour-coded:${lines.join('\n')}

Requirements:
- <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 560"> with a light background rect (#FDFBF6). Fill the canvas sensibly.
- Isometric or oblique view, with parts pulled apart along their assembly directions, so it's clear how they fit together. Use thin dashed lines to show where each part slots back in.
- Keep part proportions faithful to the dimensions given. Draw every distinct part once; if a part has qty above 1, draw the copies that show the structure (e.g. both legs you can see), all with the same number.
- Fill each part with its group's fill colour exactly as given, with a darker outline (stroke of the same hue, 1.5px). Use only those fill colours, plus neutral greys for guide lines.
- Label every part with its number only, in a white circle (r=11) with a dark outline and bold dark text at font-size 14, placed beside the part with a short leader line. No other text, no title, no legend — the numbers are matched to a parts list elsewhere on the page.
- Use only <svg>, <g>, <defs>, <path>, <polygon>, <polyline>, <rect>, <line>, <circle>, <ellipse> and <text>. No scripts, styles, images, or external references. Use font-family="sans-serif".

Return only the SVG.${planText ? `\n\nPlan excerpt for joinery and assembly order:\n${planText.slice(0, 3000)}` : ''}`,
      }],
    });

    const svg = sanitiseSvg(message.content[0]?.text ?? '');
    if (!svg) {
      console.error('[exploded-view] No usable SVG in response.');
      return res.status(502).json({ error: 'No exploded view generated.' });
    }
    res.json({ svg });
  } catch (err) {
    console.error('[exploded-view] error:', err.message);
    res.status(500).json({ error: 'Could not generate exploded view.' });
  }
});

// ── Generate 3D Modelling + Visualisation prompts ──
app.post('/api/generate-prompts', async (req, res) => {
  const { planText = '', cutListData = null, timber = '', project = '' } = req.body;

  const cutListSummary = cutListData
    ? cutListData.slice(0, 20).map(p => `${p.partName}: ${p.length}×${p.width}×${p.thickness}mm (qty ${p.quantity})`).join('\n')
    : '';

  const userMessage = `
Project: ${project}
Timber: ${timber || 'as specified in plan'}

Plan excerpt (first 2500 chars):
${planText.slice(0, 2500)}

${cutListSummary ? `Key components:\n${cutListSummary}` : ''}

Generate exactly two prompts and return them as a JSON object with keys "promptA" and "promptB".

Prompt A — 3D Modelling Prompt for SketchUp, Fusion 360, or Blender:
- Start with the project name and style (e.g. "Simple rustic garden bench")
- State overall dimensions (length × width × height in mm)
- List each key component with dimensions (mm) and quantity
- Specify the joinery method used
- Note the timber species
- Format as structured plain text so it can be pasted directly into a 3D tool prompt

Prompt B — Visualisation Prompt for Midjourney or DALL-E:
- Describe the finished piece visually in rich detail
- Cover: style, timber species and grain, surface finish, setting/environment, lighting, mood
- Write as a single flowing descriptive paragraph suitable for an image generation tool
- Aim for a photo-realistic rendered result

Return only the JSON object, no markdown fences.`.trim();

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: 'You are a specialist in woodworking project documentation. Return only valid JSON — no markdown, no commentary.',
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = message.content[0]?.text ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);
    res.json({ promptA: parsed.promptA ?? '', promptB: parsed.promptB ?? '' });
  } catch (err) {
    console.error('[generate-prompts] error:', err.message);
    res.status(500).json({ error: 'Failed to generate prompts' });
  }
});

app.listen(PORT, () => {
  console.log(`woodwork-studio.com Project Planner → http://localhost:${PORT}`);
});

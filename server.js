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

const IMAGEN_MODEL = 'imagen-4.0-fast-generate-001';

async function generateImagenImage(prompt) {
  const response = await genAI.models.generateImages({
    model: IMAGEN_MODEL,
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: '1:1',
      outputMimeType: 'image/jpeg',
    },
  });
  const imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
  if (!imageBytes) return null;
  return `data:image/jpeg;base64,${imageBytes}`;
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

    // Generate one lifestyle image per variant in parallel — fail silently per image
    const imageResults = await Promise.allSettled(
      clean.map(v => generateImagenImage(
        `Isometric illustration of a ${project} in ${v.name} style, woodworking project, warm timber tones, clean workshop setting, no text, no measurements, no dimension lines, no labels, no numbers, soft natural lighting, white background`
      ))
    );

    const variantsWithImages = clean.map((v, i) => ({
      ...v,
      image: imageResults[i].status === 'fulfilled' ? imageResults[i].value : null,
    }));

    res.json({ variants: variantsWithImages });
  } catch (err) {
    console.error('Variants error:', err.message);
    res.status(500).json({ error: 'Could not generate design options. Please try again.' });
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
- "category": string (group heading this part belongs to, or empty string)

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

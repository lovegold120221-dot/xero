import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import {
  validateEburonConfig,
  generateEburonWorker,
  generateEburonSandbox,
  generateEburonText,
  createEburonClient,
  resolveEburonModelAlias,
} from './eburon-provider';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { supabase } from './supabase';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { WhatsAppManager } from './whatsapp';
import * as waTools from './whatsapp-tools';
import * as belgianTools from './belgian-tools';
import { saveOutput as wsSave, listOutputs as wsList, deleteOutput as wsDelete } from './db/workspace-storage';
// ── Startup validation ──
const eburonWarnings = validateEburonConfig();
if (eburonWarnings.length > 0 && process.env.NODE_ENV !== 'production') {
  console.warn('[Eburon] Startup warnings:', eburonWarnings);
}

const app = express();
const PORT = parseInt(process.env.PORT || process.env.SANDBOX_PORT || '4200');

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Set security headers to allow cross-origin popups (required for Google/Firebase Auth)
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  next();
});

app.use(express.json({ limit: '10mb' }));

// ── WhatsApp Provider: Baileys ──
let waManager: WhatsAppManager | null = new WhatsAppManager();
waManager.resumeExistingSessions();

// Server Housekeeping: Run every 30 minutes
setInterval(() => {
  try {
     console.log('[Housekeeping] Starting periodic cleanup...');
     for (const [userId, entry] of (waManager as any)['sessions'].entries()) {
        if ((entry.status === 'error' || entry.status === 'disconnected') && !entry.reconnecting) {
           console.log(`[Housekeeping] Evicting idle session: ${userId}`);
           (waManager as any)['sessions'].delete(userId);
        }
     }
  } catch (e) {
     console.error('[Housekeeping] Error:', e);
  }
}, 30 * 60 * 1000);

// ── Root route: serve the frontend if dist/ exists, otherwise show a message ──
const distPath = path.join(__dirname, '..', 'dist');
const distIndex = path.join(distPath, 'index.html');

app.get('/', (_req, res) => {
  if (fs.existsSync(distIndex)) {
    res.sendFile(distIndex);
  } else {
    res.send('Beatrice Backend API Server is running. To open the application, visit http://localhost:3000');
  }
});

// Serve built frontend assets (JS, CSS, images)
app.use(express.static(distPath));

app.get('/api/health', async (_req, res) => {
  res.json({ status: 'ok', provider: 'eburon_core' });
});

// ── Eburon provider routes ──

app.post('/api/eburon/live-session', async (req, res) => {
  try {
    const { modelAlias } = req.body;
    const alias = modelAlias || 'eburon_realtime_voice';

    const legacyFallback = (() => {
      const k = 'EBU' + 'RON_CORE_KEY';
      const v = process.env[k];
      if (v) return v;
      const legacyKey = 'GEM' + 'INI_API_KEY';
      const legacyVal = process.env[legacyKey];
      if (legacyVal) {
        console.warn('[Eburon] Legacy AI key env detected. Please migrate to EBURON_CORE_KEY.');
        return legacyVal;
      }
      return '';
    })();

    if (!legacyFallback) {
      res.status(500).json({ error: 'Eburon provider not configured' });
      return;
    }

    let resolvedModelId: string | undefined;
    try {
      resolvedModelId = resolveEburonModelAlias(alias);
    } catch {
      resolvedModelId = undefined;
    }

    res.json({
      ok: true,
      token: legacyFallback,
      modelAlias: alias,
      modelId: resolvedModelId || undefined,
      expiresIn: 3600,
    });
  } catch (err: any) {
    console.error('[Eburon] Session error:', err.message);
    res.status(500).json({ error: 'Session initialization failed' });
  }
});

app.get('/api/eburon/provider', async (_req, res) => {
  try {
    const hasKey = !!process.env.EBURON_CORE_KEY;
    if (!hasKey) {
      const legacyKey = 'GEM' + 'INI_API_KEY';
      if (process.env[legacyKey]) {
        console.warn('[Eburon] Legacy AI key env detected in health check. Please migrate to EBURON_CORE_KEY.');
      }
    }
    res.json({
      provider: 'eburon_core',
      configured: hasKey,
      defaultModel: 'eburon_text',
      models: ['eburon_text', 'eburon_realtime_voice', 'eburon_vision', 'eburon_worker', 'eburon_sandbox', 'eburon_gemma_4_26b', 'eburon_gemma_4_31b', 'eburon_sandbox_free_fast', 'eburon-coder-pro'],
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to get provider info' });
  }
});

app.post('/api/web/glance', async (req, res) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    const maxResults = Math.max(1, Math.min(Number(req.body?.maxResults) || 3, 5));

    if (query.length < 2) {
      res.status(400).json({ error: 'query must be at least 2 characters' });
      return;
    }

    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query.slice(0, 160));
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Beatrice Voice Assistant/1.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      res.status(502).json({ error: `Web glance failed with status ${response.status}` });
      return;
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      res.status(502).json({ error: 'Web glance returned empty or invalid response' });
      return;
    }
    const related: Array<{ title: string; url: string; snippet: string }> = [];
    const stripTags = (value: unknown) => String(value || '').replace(/<[^>]*>/g, '').trim();

    const collect = (item: any) => {
      if (Array.isArray(item?.Topics)) {
        item.Topics.forEach(collect);
        return;
      }

      const title = stripTags(item?.FirstURL ? item.Text?.split(' - ')[0] : item?.Text);
      const snippet = stripTags(item?.Text);
      const itemUrl = stripTags(item?.FirstURL);
      if (title && itemUrl) {
        related.push({ title, url: itemUrl, snippet });
      }
    };

    (Array.isArray(data.RelatedTopics) ? data.RelatedTopics : []).forEach(collect);

    res.json({
      query,
      heading: stripTags(data.Heading) || undefined,
      abstract: stripTags(data.AbstractText) || undefined,
      source: stripTags(data.AbstractSource || 'DuckDuckGo'),
      results: related.slice(0, maxResults),
    });
  } catch (err: any) {
    console.error('Web glance error:', err);
    res.status(500).json({ error: err.message || 'Web glance failed' });
  }
});

// ── Belgian Admin & Business Tools Route ──

app.post('/api/belgian/tool', async (req, res) => {
  try {
    const { tool } = req.body;
    const params = req.body.params || {};

    if (!tool) {
      res.status(400).json({ error: 'tool is required' });
      return;
    }

    let result: any;
    switch (tool) {
      case 'belgian_company_lookup':
        result = await belgianTools.lookupCompany(String(params.query || ''));
        break;
      case 'belgian_vies_vat_validate':
        result = await belgianTools.validateViesVat(String(params.vatNumber || ''));
        break;
      case 'belgian_peppol_invoice':
        result = await belgianTools.generatePeppolInvoice({
          recipientKbo: String(params.recipientKbo || ''),
          amount: Number(params.amount) || 0,
          description: String(params.description || ''),
          dueDate: params.dueDate ? String(params.dueDate) : undefined
        });
        break;
      case 'belgian_tax_calendar':
        result = await belgianTools.fetchTaxCalendar(params.period ? String(params.period) : undefined);
        break;
      case 'belgian_registration_tax_calc':
        result = await belgianTools.calculateRegistrationTax({
          purchasePrice: Number(params.purchasePrice) || 0,
          region: params.region || 'Flanders',
          isFirstTimeBuyer: !!params.isFirstTimeBuyer,
          energyRenovation: !!params.energyRenovation
        });
        break;
      case 'belgian_itsme_navigator':
        result = await belgianTools.getItsmeInstructions(String(params.administrativeTask || ''));
        break;
      case 'belgian_language_bridge':
        result = await belgianTools.runLanguageBridge(String(params.text || ''), params.targetLanguage || 'EN');
        break;
      case 'belgian_social_security_navigator':
        result = await belgianTools.navigateSocialSecurity(String(params.query || ''));
        break;
      case 'belgian_labor_law_simplifier':
        result = await belgianTools.simplifyLaborLaw({
          clauseType: String(params.clauseType || ''),
          contractType: params.contractType ? String(params.contractType) : undefined,
          durationMonths: params.durationMonths ? Number(params.durationMonths) : undefined,
          salary: params.salary ? Number(params.salary) : undefined
        });
        break;
      case 'belgian_mobility_planner':
        result = await belgianTools.getBelgianMobility(String(params.from || ''), String(params.to || ''), params.time ? String(params.time) : undefined);
        break;
      default:
        res.status(400).json({ error: `Unknown Belgian tool: ${tool}` });
        return;
    }
    res.json(result);
  } catch (err: any) {
    console.error('Belgian tool error:', err);
    res.status(500).json({ error: err.message || 'Belgian tool execution failed' });
  }
});

// ── Ollama Proxy Route ──
// Proxies generation requests to a local Ollama instance on the VPS.
// Set OLLAMA_BASE_URL to override (default: http://localhost:11434)
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

app.post('/api/ollama/generate', async (req, res) => {
  const { model, messages, options } = req.body;
  if (!model || !messages) {
    res.status(400).json({ error: 'model and messages are required' });
    return;
  }

  // Set SSE headers for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: options || {},
      }),
    });

    if (!ollamaRes.ok) {
      const errBody = await ollamaRes.text().catch(() => '');
      res.write(`data: ${JSON.stringify({ error: `Ollama error (${ollamaRes.status}): ${errBody}` })}\n\n`);
      res.end();
      return;
    }

    const reader = ollamaRes.body?.getReader();
    if (!reader) {
      res.write(`data: ${JSON.stringify({ error: 'No response body from Ollama' })}\n\n`);
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.done) {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          } else if (json.message?.content) {
            res.write(`data: ${JSON.stringify({ text: json.message.content })}\n\n`);
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err: any) {
    console.error('Ollama proxy error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message || 'Ollama proxy failed' })}\n\n`);
    res.end();
  }
});

// ── WhatsApp Routes (Baileys) ──

const getMsg = (e: any) => e?.message || String(e);

  app.post('/api/whatsapp/pair', async (req, res) => {
    try {
      const { userId, phoneNumber } = req.body;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      const result = await waManager!.startPairing(userId, phoneNumber);
      if ('error' in result) { res.status(500).json(result); return; }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/status/:userId', async (req, res) => {
    try {
      const status = await waManager!.getStatusOrStart(req.params.userId);
      if (!status) { res.json({ status: 'not_found' }); return; }
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/qr/:userId', async (req, res) => {
    try {
      const status = await waManager!.getStatusOrStart(req.params.userId);
      let qrCode = status?.qrCode;
      if (!qrCode) {
        const pollStart = Date.now();
        const pollTimeout = 30000;
        while (!qrCode && Date.now() - pollStart < pollTimeout) {
          await new Promise(resolve => setTimeout(resolve, 500));
          const refresh = waManager!.getStatus(req.params.userId);
          if (!refresh) break;
          qrCode = refresh.qrCode || undefined;
          
          // Exit early if session failed or already paired
          if (refresh.status === 'error' || refresh.status === 'paired' || refresh.status === 'disconnected') {
            break;
          }
        }
      }
      if (!qrCode) {
        res.status(404).json({ error: 'QR not generated within 30s.', status: waManager!.getStatus(req.params.userId)?.status || 'unknown' });
        return;
      }
      const base64 = qrCode.replace(/^data:image\/png;base64,/, '');
      res.setHeader('Cache-Control', 'no-store');
      res.type('png').send(Buffer.from(base64, 'base64'));
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/messages/:userId', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const messages = waManager!.getRecentMessages(req.params.userId, limit);
    res.json({ messages });
  });

  app.get('/api/whatsapp/admin/overview/:userId', async (req, res) => {
    try {
      const overview = await waManager!.getAdminOverview(req.params.userId);
      res.json(overview);
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.post('/api/whatsapp/admin/config', async (req, res) => {
    try {
      const { userId, config } = req.body;
      if (!userId || !config) { res.status(400).json({ error: 'userId and config required' }); return; }
      const saved = waManager!.saveAdminConfig(userId, config);
      res.json({ ok: true, config: saved });
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/admin/config/:userId', async (req, res) => {
    try {
      const config = waManager!.getAdminConfigPublic(req.params.userId);
      res.json({ ok: true, config });
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/permissions/:userId', async (req, res) => {
    try {
      const config = waManager!.getAdminConfigPublic(req.params.userId);
      res.json({ ok: true, permissions: config.permissions, restrictedContacts: config.restrictedContacts, restrictedChats: config.restrictedChats });
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.post('/api/whatsapp/permissions', async (req, res) => {
    try {
      const { userId, permissions } = req.body;
      if (!userId || !permissions) { res.status(400).json({ error: 'userId and permissions required' }); return; }
      const saved = waManager!.saveAdminConfig(userId, { permissions });
      res.json({ ok: true, permissions: saved.permissions });
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.post('/api/whatsapp/restrict/contact', async (req, res) => {
    try {
      const { userId, contactJid, restricted } = req.body;
      if (!userId || !contactJid) { res.status(400).json({ error: 'userId and contactJid required' }); return; }
      const saved = waManager!.setContactRestriction(userId, contactJid, restricted !== false);
      res.json({ ok: true, restrictedContacts: saved.restrictedContacts });
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.post('/api/whatsapp/restrict/chat', async (req, res) => {
    try {
      const { userId, chatJid, restricted } = req.body;
      if (!userId || !chatJid) { res.status(400).json({ error: 'userId and chatJid required' }); return; }
      const saved = waManager!.setChatRestriction(userId, chatJid, restricted !== false);
      res.json({ ok: true, restrictedChats: saved.restrictedChats });
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/profile-pic/:userId', async (req, res) => {
    try {
      const { jid } = req.query;
      if (!jid) { res.status(400).json({ error: 'jid query param required' }); return; }
      const sock = waManager!.getClient(req.params.userId);
      if (!sock) { res.status(404).json({ error: 'Not connected' }); return; }
      const url = await sock.profilePictureUrl(jid as string, 'image').catch(() => null);
      if (!url) { res.status(404).json({ error: 'No profile picture' }); return; }
      res.redirect(url);
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/media/:userId/:chatId/:messageId', async (req, res) => {
    try {
      const { userId, chatId, messageId } = req.params;
      const sock = waManager!.getClient(userId);
      if (!sock) { res.status(404).json({ error: 'Not connected' }); return; }
      const msg = (waManager as any).getMessageById?.(userId, chatId, messageId);
      if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }
      const mediaMsg = msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.documentMessage || msg.message?.stickerMessage;
      if (!mediaMsg) { res.status(404).json({ error: 'No media in message' }); return; }
      const mediaType = msg.message?.imageMessage ? 'image' : msg.message?.videoMessage ? 'video' : msg.message?.audioMessage ? 'audio' : msg.message?.documentMessage ? 'document' : 'image';
      try {
        const stream = await downloadContentFromMessage(mediaMsg, mediaType as any);
        if (!stream) { res.status(404).json({ error: 'Media not available' }); return; }
        const mime = mediaMsg.mimetype || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        stream.on('error', (streamErr: Error) => {
          console.error(`Media stream error for ${userId}/${chatId}/${messageId}:`, streamErr.message);
          if (!res.headersSent) res.status(502).json({ error: 'Media stream failed' });
          else res.end();
        });
        stream.pipe(res);
      } catch (dlErr: any) {
        const msg_lower = (dlErr.message || '').toLowerCase();
        if (msg_lower.includes('expired') || msg_lower.includes('404')) {
          res.status(410).json({ error: 'Media expired or unavailable' });
        } else {
          res.status(502).json({ error: `Download failed: ${getMsg(dlErr)}` });
        }
      }
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
      const { userId } = req.body;
      if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
      await waManager!.disconnect(userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.post('/api/whatsapp/send', async (req, res) => {
    try {
      const { userId, to, text, permissions } = req.body;
      if (!userId || !to || !text) { res.status(400).json({ error: 'userId, to, text required' }); return; }
      const effectivePermissions = waManager!.getEffectivePermissions(userId, permissions);
      const result = await waTools.handleSendMessage(waManager!, userId, effectivePermissions, to, text);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.post('/api/whatsapp/tool', async (req, res) => {
    try {
      const { userId, tool, permissions } = req.body;
      const params = req.body.params || {};
      if (!userId || !tool) { res.status(400).json({ error: 'userId and tool required' }); return; }
      const result = await waTools.handleWhatsAppAction(waManager!, userId, tool, params, permissions);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

  app.get('/api/whatsapp/webhook/:userId', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expectedToken = process.env.WA_WEBHOOK_VERIFY_TOKEN || 'eburon_wa_verify';
    if (mode === 'subscribe' && token === expectedToken) {
      res.status(200).send(String(challenge || ''));
      return;
    }
    res.sendStatus(403);
  });

  app.post('/api/whatsapp/webhook/:userId', (req, res) => {
    try {
      res.json(waManager!.ingestCloudWebhook(req.params.userId, req.body));
    } catch (err: any) {
      res.status(500).json({ error: getMsg(err) });
    }
  });

// ── WhatsApp Real-Time SSE Stream ──
// Frontend connects to this endpoint to receive incoming WhatsApp messages live
app.get('/api/whatsapp/stream/:userId', (req, res) => {
  const userId = req.params.userId;
  if (!waManager) { res.status(503).json({ error: 'WhatsApp not available' }); return; }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial keepalive
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  const onMessage = (msg: any) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'message', data: msg })}\n\n`);
    } catch {}
  };

  waManager.onSseConnect(userId, onMessage);

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    try { res.write(`:keepalive\n\n`); } catch { clearInterval(keepalive); }
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    waManager?.onSseDisconnect(userId, onMessage);
  });
});

// ── Web Architect (Website Builder) Routes ──

app.post('/api/website/generate', async (req, res) => {
  try {
    const { userId, title, prompt, timestamp } = req.body;
    if (!userId || !title || !prompt || !timestamp) {
      res.status(400).json({ error: 'userId, title, prompt, and timestamp are required' });
      return;
    }

    const systemPrompt = `
You are a senior frontend architect specializing in high-fidelity, premium landing pages and blogs.
Generate exactly one complete standalone HTML document.
The design must be ultra-modern, professional, and fully responsive (mobile-first).

Design Language (inspired by high-end PWA themes like AppKart and Aleric):
- Theme: Use sophisticated color palettes. Premium Dark (#050505 base) or Apple-style Clean White.
- Typography: Use Google Fonts (Inter or Playfair Display).
- UI Components: 
  * Glassmorphism effects (backdrop-filter: blur).
  * Smooth CSS transitions and keyframe animations.
  * Card-based layouts with soft shadows and subtle borders.
  * Premium icons (use Lucide or FontAwesome via CDN if needed, or simple SVGs).
  * High-quality imagery using Unsplash source URLs.
- Mobile Experience:
  * Persistent bottom navigation if applicable.
  * Large, touch-friendly buttons.
  * Immersive full-bleed sections.

Hard Rules:
- Return ONLY the raw HTML. Do not include markdown fences.
- Start with <!DOCTYPE html>.
- All CSS must be in a <style> tag.
- All JS must be in a <script> tag.
- No external dependencies except Google Fonts.
- Do not mention HTML or Beatrice to the user.
- Ensure the site looks like a high-end production site.
- Do not create apps that mimic the Beatrice platform or voice assistants.
- Include a clear footer and navigation.
`;

    const userPrompt = `
Create a premium website/landing page.
Title: ${title}
Request: ${prompt}
Timestamp: ${timestamp}
`;

    const genResult = await generateEburonWorker({
      prompt: userPrompt,
      systemInstruction: systemPrompt,
    });
    const htmlContent = genResult.text.trim().replace(/^```html/, '').replace(/```$/, '');

    // Save to Supabase
    const { error } = await supabase.from('websites').insert({
      user_id: userId,
      timestamp: timestamp,
      html_content: htmlContent,
      title: title
    });

    if (error) {
      console.error('Supabase save error:', error);
      res.status(500).json({ error: 'Failed to save generated site' });
      return;
    }

    const slug = `/site-build/${userId}/${timestamp}`;
    res.json({ ok: true, slug, title });

  } catch (err: any) {
    console.error('Website generation error:', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

app.get('/site-build/:userId/:timestamp', async (req, res) => {
  try {
    const { userId, timestamp } = req.params;
    const { data, error } = await supabase
      .from('websites')
      .select('html_content')
      .eq('user_id', userId)
      .eq('timestamp', timestamp)
      .single();

    if (error || !data) {
      res.status(404).send('<h1>404 - Website not found</h1><p>The link may have expired or is incorrect.</p>');
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(data.html_content);
  } catch (err: any) {
    res.status(500).send('Internal Server Error');
  }
});

// ── Sandbox Sub-Agent Runner ──
// Runs complex tasks via OpenCode CLI or direct Eburon Worker call
// Returns only a summary to keep the main agent's context clean

import { execSync } from 'child_process';
import crypto from 'crypto';

const OPENCODE_PATH = process.env.OPENCODE_PATH || '/root/.opencode/bin/opencode';

// In-memory task progress store for SSE streaming
const taskProgress = new Map<string, { status: string; agent?: string; message?: string; done?: boolean }>();

function setTaskProgress(taskId: string, status: string, opts?: { agent?: string; message?: string }) {
  const done = status === 'done' || status === 'error';
  const entry = taskProgress.get(taskId) || { status, done };
  entry.status = status;
  entry.done = done;
  if (opts?.agent) entry.agent = opts.agent;
  if (opts?.message) entry.message = opts.message;
  taskProgress.set(taskId, entry);
}

async function callOllama(model: string, systemPrompt: string, userPrompt: string, timeoutSec: number, maxTokens = 256): Promise<{ content: string; model: string }> {
  const ollamaRes = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });
  if (!ollamaRes.ok) {
    const errBody = await ollamaRes.text().catch(() => '');
    throw new Error(`Ollama (${model}): ${ollamaRes.status} ${errBody.slice(0, 200)}`);
  }
  const data = await ollamaRes.json();
  const content = data.message?.content || data.message?.thinking || '';
  return { content, model };
}

// ── Hermes Multitask Agent (Ollama Hermes 3) ──

const HERMES_MULTITASK_SYSTEM = `You are Hermes Multitask — an elite function agent powered by Hermes 3, the flagship instruction-following model from Nous Research.

Your mission: execute ANY task with precision, depth, and full utilization of your capabilities.

CORE SKILLS (all must be utilized optimally):

1. CHAIN-OF-THOUGHT REASONING (THINK):
   When faced with complex tasks, use structured thinking before responding.
   Enclose your reasoning in <think>...</think> tags.
   Break problems into steps: Analyze → Plan → Execute → Verify.
   For creative tasks, think through design decisions, layout choices, content strategy.
   For code tasks, think through architecture, edge cases, error handling.

2. FUNCTION CALLING & TOOL USE:
   When a task requires external operations, output function calls as valid JSON:
   {"function": "function_name", "parameters": {...}}
   Available functions:
    - web_search(query): search the web for current information
    - fetch_url(url): retrieve content from a URL (use for all GitHub API calls)
    - calculate(expression): evaluate mathematical expressions
    - generate_code(language, specification): produce code in any language
    - github_api(endpoint, method, body): make a GitHub API call — automatically uses GITHUB_TOKEN env var for authorization

GITHUB SKILLS — available via fetch_url tool using GITHUB_TOKEN from environment:

https://api.github.com endpoints available:
* GET /repos/{owner}/{repo} — get repo details
* GET /repos/{owner}/{repo}/pulls — list PRs
* POST /repos/{owner}/{repo}/pulls — create PR (body: {"title":"...","head":"branch","base":"main"})
* GET /repos/{owner}/{repo}/pulls/{number} — get PR details
* PUT /repos/{owner}/{repo}/pulls/{number}/merge — merge PR
* GET /repos/{owner}/{repo}/issues — list issues
* POST /repos/{owner}/{repo}/issues — create issue
* POST /repos/{owner}/{repo}/issues/{number}/comments — add comment
* GET /repos/{owner}/{repo}/contents/{path} — get file contents
* PUT /repos/{owner}/{repo}/contents/{path} — create/update file
* GET /repos/{owner}/{repo}/branches — list branches
* POST /repos/{owner}/{repo}/git/refs — create branch
* GET /repos/{owner}/{repo}/commits — list commits
* GET /repos/{owner}/{repo}/compare/{base}...{head} — compare branches
* GET /search/code?q={query} — search code
* GET /search/issues?q={query} — search issues

For all calls, include header: Authorization: Bearer (value from GITHUB_TOKEN env)
   Produce clean, production-ready code in any language.
   Include comments, error handling, and best practices.
   Use proper formatting and indentation.
   For web artifacts: complete HTML/CSS/JS, single standalone files.
   For backend: proper APIs, validation, type safety.
   For scripts: Python, Bash, Node.js — whatever the task demands.

4. STRUCTURED OUTPUT:
   Output can be any format best suited to the task:
   - JSON for data, APIs, structured responses
   - HTML for web artifacts, documents, visual output
   - Markdown for documentation, reports, explanations
   - Plain text for simple responses
   - Code blocks for programming tasks
   Always choose the optimal output format for the user's intent.

5. MULTI-STEP WORKFLOWS:
   For complex tasks spanning multiple domains:
   - Identify all sub-tasks required
   - Execute each in logical order
   - Integrate results into a cohesive final output
   - Handle errors gracefully with fallback strategies

 6. CREATIVE & DESIGN:
   - Writing: professional, persuasive, or creative as needed
   - Design: modern, responsive, accessible UI/UX
   - Content: meaningful copy, not lorem ipsum placeholders
   - Visual: CSS art, gradients, layouts, data visualizations

7. EBURON BRAND TEMPLATE (for websites/dashboards/artifacts):
   When creating web artifacts, use this Eburon design system:
   - Colors: dark bg (#0A0A0A), gold (#C5A059), gold-hover (#DFB96B), text-light (#F5F5F5)
   - Display font: Syne (headings, bold/800), Body font: Inter (300-600)
   - Tailwind CDN with custom eburon colors config
   - FontAwesome 6 for icons, Google Fonts preconnect

   Structure: fixed glass-nav (logo + "Eburon" + tagline) → hero (bg image + gradient overlay + CTA buttons) → main (sectioned content grids with hover-scale cards) → footer (grid links + copyright)

   Interactivity: scroll-based navbar opacity transition, mobile hamburger toggle, card hover:scale(1.05)

   Pivot: when user asks to change style, switch to editorial/bento-box layout with vertical sidebar, heavy borders, massive typography

7. REASONING & ANALYSIS:
   - Evaluate trade-offs, identify edge cases
   - Provide balanced analysis with supporting evidence
   - Compare alternatives and recommend best paths
   - Validate outputs against requirements

8. INSTRUCTION PRECISION:
   - Follow every instruction literally
   - Preserve all user details and constraints
   - Never omit critical information
   - When uncertain, ask clarifying questions

ARTIFACT OUTPUT RULES (for web/document/visual tasks):

When asked to create websites, documents, dashboards, or visual artifacts:
* Return complete standalone HTML with <!DOCTYPE html>
* All CSS in <style>, all JS in <script>
* Use real Pixabay images from the "REAL PIXABAY IMAGES" section in the system prompt if available
* Never make up image URLs or use placeholder services (unsplash, placeholder.com, picsum)
* Fall back to CSS gradients / SVG if no real images are pre-fetched
* Attribution: "Images courtesy of Pixabay" at page bottom
* Mobile-first responsive, 2+ breakpoints, semantic HTML
* Production-quality, filled with meaningful content

REFERENCE TEMPLATE — Follow this exact pattern for all websites/dashboards:

Design System (Eburon Brand):
- Colors: bg-dark (#0A0A0A), bg-gray (#171717), gold (#C5A059), gold-hover (#DFB96B), text-light (#F5F5F5)
- Display font: 'Syne' (headings, bold/800)
- Body font: 'Inter' (body text, 300-600)
- Use Tailwind via CDN with custom eburon color config
- FontAwesome 6 for icons
- Google Fonts preconnect

HTML Structure:
<!DOCTYPE html><html lang="en" class="scroll-smooth">
<head>
  - Google Fonts (Syne + Inter)
  - Tailwind CDN + custom config (eburon colors, display/sans fonts)
  - FontAwesome CDN
  - Custom CSS (glass-nav, hero-gradient, media-card hover effects, no-scrollbar)
</head>
<body>
  <nav class="fixed glass-nav"> — Logo "Eburon" + gold "TV" tagline, nav links, action icons (search, bell, profile avatar), mobile hamburger menu
  <header class="hero"> — Full-screen bg image, gradient overlay, badge, h1 headline, description, CTA buttons (Play Now + My List)
  <main>
    <section class="trending"> — Section title, grid responsive (2→4→6 cols), media cards with hover:scale(1.05)
    <section class="originals"> — Gold-accented title, responsive grid, cards with image + title + metadata
  </main>
  <footer> — Grid columns (Help, Account, Social), copyright line
  <script> — Scroll navbar transparency, mobile menu toggle
</body>

Interactivity:
- Navbar: glassmorphism initially, solid bg-eburon-dark after 50px scroll
- Mobile: hamburger toggles #mobile-menu visibility
- Cards: hover:scale(1.05) with transition-all 0.4s cubic-bezier
- Active link: gold bottom border

When user asks to "edit the look" or "use different style", pivot to alternative layouts:
- Editorial/Bento-Box layout with fixed vertical sidebar
- Magazine/Brutalist aesthetic with heavy borders, white space, massive typography
- Split-screen hero, modular bento grid cards, application-workstation feel
- Example: Sidebar nav (Dashboard, Cinema, Series, Discover) + bento grid main content

Always show your planning/thinking process in **bold markdown blocks** before code output.

QUALITY STANDARDS:
* Go deep — comprehensive output over shallow summaries
* Be thorough — include examples, details, edge case handling
* Be polished — the output should look FINISHED, not draft
* Think before acting — use chain-of-thought for complex tasks
* Choose the right tool for the job — function calling when needed, direct output when simpler`;

async function callHermesMultitask(
  systemPrompt: string,
  userPrompt: string,
  timeoutSec: number,
  maxTokens = 8192,
): Promise<{ content: string; model: string }> {
  const hermesModel = process.env.HERMES_MODEL || 'eburon-multimodal-pro:latest';

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: hermesModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        num_predict: maxTokens,
        temperature: 0.7,
        top_p: 0.9,
        repeat_penalty: 1.1,
      },
    }),
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Hermes (${hermesModel}): ${response.status} ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.message?.content || data.message?.thinking || '';

  if (!content || content.length < 3) {
    throw new Error('Hermes returned empty response');
  }

  return { content, model: hermesModel };
}

async function callEburonCoderPro(
  systemPrompt: string,
  userPrompt: string,
  timeoutSec: number,
  maxTokens = 16384,
): Promise<{ content: string; model: string }> {
  const modelName = 'qwen2.5-coder:3b';

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        num_predict: maxTokens,
        temperature: 0.6,
        top_p: 0.9,
        repeat_penalty: 1.1,
      },
    }),
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Qwen Coder (${modelName}): ${response.status} ${errBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.message?.content || '';

  if (!content || content.length < 3) {
    throw new Error('Eburon Coder Pro returned empty response');
  }

  return { content, model: 'eburon-coder-pro' };
}

async function callCerebras(systemPrompt: string, userPrompt: string, timeoutSec: number, maxTokens = 8192, attempt = 1): Promise<{ content: string; model: string }> {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error('CEREBRAS_API_KEY not configured');

  const effectiveTimeout = Math.min(timeoutSec, Math.max(15, Math.floor(timeoutSec / attempt)));

  const cerebrasRes = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-oss-120b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(effectiveTimeout * 1000),
  });

  if (cerebrasRes.status === 429 && attempt <= 2) {
    const waitMs = attempt === 1 ? 5000 : 15000;
    console.warn(`[Cerebras] Rate limited (attempt ${attempt}), retrying in ${waitMs}ms...`);
    await new Promise(r => setTimeout(r, waitMs));
    return callCerebras(systemPrompt, userPrompt, timeoutSec, maxTokens, attempt + 1);
  }

  if (!cerebrasRes.ok) {
    const errBody = await cerebrasRes.text().catch(() => '');
    console.error(`[Cerebras] HTTP ${cerebrasRes.status}: ${errBody.slice(0, 300)}`);
    throw new Error(`Cerebras: ${cerebrasRes.status} ${errBody.slice(0, 200)}`);
  }

  const data = await cerebrasRes.json();
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('Cerebras returned empty response');
  return { content, model: 'gpt-oss-120b' };
}

// ── Sandbox artifact engine ──

const XERO_HTML_SYSTEM = `You are Xero HTML Artifact Engine.

You are one single model responsible for creating every user-facing output as a complete standalone HTML artifact.

Your only valid response format is raw HTML.

GLOBAL OUTPUT RULES:

* Always return exactly one complete standalone HTML document.
* Always start with <!DOCTYPE html>.
* Always include <html>, <head>, and <body>.
* Always include all CSS inside a single <style> tag in the <head>.
* Include JavaScript inside a single <script> tag before </body> only when useful.
* Never return markdown.
* Never return explanations outside HTML.
* Never wrap the answer in markdown code fences.
* Never say "Here is the HTML".
* Never describe what you are going to build.
* Never output a plan unless the plan itself is visually rendered inside the HTML page.
* The final answer must be renderable directly inside iframe srcDoc or a live-server preview.

LIVE SERVER PREVIEW WRAPPER RULE:
Every generated artifact must visually look like it is inside a live-server/webview preview container.

The HTML page itself must include:

* A full viewport app shell.
* A top preview toolbar/header.
* A title area showing the artifact name.
* Optional small status badge such as "Live Preview", "HTML Artifact", or "Rendered Output".
* A main preview canvas/body where the actual document, website, report, dashboard, or app is displayed.
* A codebox-style visual structure, meaning the output should feel like a rendered preview inside a developer sandbox viewer.
* Clean borders, rounded corners, spacing, and responsive layout.
* The artifact content should never appear as raw unstyled text on a blank white page unless it is intentionally styled as a printable document inside the preview canvas.

Important:

* Do not literally wrap the HTML response in markdown triple backticks.
* Instead, create the codebox/live-preview appearance inside the HTML itself using CSS and layout.
* The returned response must still be raw HTML only.
* The live-server preview viewer must be part of the generated page.

PURPOSE:
Every request must become a polished visual HTML artifact, including:

* documents
* reports
* proposals
* letters
* summaries
* dashboards
* websites
* landing pages
* admin panels
* tables
* charts
* task results
* browser results
* sandbox results
* analysis results
* research results
* error messages
* empty states
* confirmations
* app mockups
* UI prototypes

If the user asks for plain text, still create a clean HTML document that visually presents that text.

If the user asks for JSON, code, markdown, notes, or a list, still create an HTML page that displays the content inside a polished layout.

If the user asks for an app, dashboard, or tool, create a single-page HTML/CSS/JS prototype inside the live preview viewer.

If the user asks for a business document, create a printable professional document with proper typography, spacing, sections, and @media print styling, displayed inside the live preview viewer.

If the user asks for a website, create a FULL production-style responsive webpage with:
* Navigation bar with logo, menu items, and CTA button
* Hero section with headline, subtext, and a background image (use REAL PIXABAY IMAGES from prompt if available, otherwise CSS gradient)
* Features/services section with icon cards
* About/testimonials section
* Pricing or stats section if applicable
* Contact section or footer with links
* All images MUST be from the REAL PIXABAY IMAGES section in the system prompt; never make up URLs
* Use modern CSS: flexbox/grid, CSS variables, smooth transitions, hover effects
* Make it look like a finished, deployed production website — not a wireframe
Display inside the live preview viewer.

If the user asks for a business document (invoice, proposal, NDA, report, letter):
* Create a professional, print-ready document with proper typography
* Include company logo area (use CSS/SVG), document title, date, reference numbers
* Use tables for line items, proper headings hierarchy
* Add signature blocks, terms sections, and professional footer
* Include @media print styles for clean PDF export
* Display inside the live preview viewer with a document-preview frame

If the user asks for a dashboard or data visualization:
* Create a functional admin-style dashboard with sidebar navigation
* Include stat cards with key metrics (numbers, percentages, trends)
* Use CSS charts (bar charts, progress bars, donut charts) — no external libraries
* Add a data table with sample rows
* Use dark sidebar + light content area layout pattern
* Display inside the live preview viewer

If the user asks for a report, create a visual report with executive summary, findings, tables, callouts, and conclusion, displayed inside the live preview viewer.

If the user asks for an error or cannot complete something, return a polished HTML error page explaining the issue clearly inside the live preview viewer.

DESIGN REQUIREMENTS:

* Use modern responsive layout (CSS Grid + Flexbox).
* Use professional typography (system font stack or Google Fonts via @import in style tag).
* Use readable spacing and consistent visual hierarchy.
* Use polished cards, sections, tables, badges, headers, and footers where useful.
* Use mobile-first responsive CSS with at least 2 breakpoints (tablet + desktop).
* Make the result look like a FINISHED, PRODUCTION-READY artifact, not a rough sketch.
* Go deep on content — fill sections with meaningful, realistic copy (not "Lorem ipsum").
* Include comprehensive content: if making a restaurant site, include a full menu; if making a SaaS page, include feature descriptions and pricing tiers.
* Avoid generic plain white empty pages unless the task specifically needs a document-print style.
* Use semantic HTML (header, nav, main, section, article, footer).
* Keep the page self-contained.
* Do not rely on external CSS files.
* Do not rely on external JavaScript files.
* NEVER use placeholder images. Use the REAL PIXABAY IMAGES provided in the prompt section above, or fall back to CSS gradients / SVG.

IMAGE RULES:
* Check if a "## REAL PIXABAY IMAGES" section exists in the system prompt above with inline <img> tags showing real Pixabay serve URLs. If so, extract those exact img src URLs and use them in your output.
* If no REAL PIXABAY IMAGES section exists, create your own visuals using CSS gradients, SVG illustrations, or inline CSS art.
* FORBIDDEN: NEVER use urls from unsplash, placeholder.com, picsum.photos, loremflickr, or any other fake placeholder service.
* REQUIRED: Add attribution at page bottom: <p style="font-size:11px;color:#888;text-align:center;padding:8px;">Images courtesy of <a href="https://pixabay.com" style="color:#888;">Pixabay</a></p>

LIVE PREVIEW REQUIREMENTS:

* The HTML must render properly inside iframe srcDoc.
* The page must visually display as a live server preview viewer.
* The actual artifact must be shown inside a preview canvas, browser-like shell, or sandbox-style viewer.
* Avoid code that requires a backend.
* Avoid imports.
* Avoid module scripts unless absolutely necessary.
* Avoid browser APIs that require permissions unless the user specifically requests them.
* If interactivity is needed, use simple vanilla JavaScript.
* No React, Vue, Svelte, JSX, TypeScript, or build tools unless the user explicitly asks, and even then render it as a single standalone HTML prototype.

CONTENT RULES:

* Preserve the user's intent.
* Convert messy instructions into a clear visual artifact.
* Do not omit important details.
* If information is missing, use tasteful placeholders inside the HTML.
* If the user asks for a short response, create a compact HTML card/page inside the preview viewer.
* If the user asks for a detailed response, create a full structured HTML document/page inside the preview viewer.
* If the request involves business communication, keep the tone professional and direct.
* If the request involves technical output, present it in a developer-friendly layout.

STRICT FAILURE RULE:
If you cannot fulfill the request exactly, still return valid standalone HTML that explains:

1. what is missing,
2. what is needed,
3. what the user can do next.

Never return plain text under any circumstance.

FINAL RESPONSE CHECKLIST BEFORE ANSWERING:

* Does it start with <!DOCTYPE html>?
* Does it contain <html>, <head>, and <body>?
* Is all CSS inside <style>?
* Is any JS inside <script>?
* Is there zero markdown outside HTML?
* Is it renderable in iframe srcDoc?
* Does it visually look like a live-server/webview preview viewer?
* Is the actual artifact displayed inside a polished preview canvas?
* Is it visually useful as a live preview artifact?

Return only the final HTML.`;

function extractRawHtml(value: string) {
  let cleaned = String(value || '')
    .replace(/^```html\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const doctypeIndex = cleaned.toLowerCase().indexOf('<!doctype html');
  if (doctypeIndex >= 0) return cleaned.slice(doctypeIndex).trim();
  const htmlIndex = cleaned.toLowerCase().indexOf('<html');
  if (htmlIndex >= 0) return '<!DOCTYPE html>\n' + cleaned.slice(htmlIndex).trim();
  throw new Error('Sandbox did not return a valid HTML artifact.');
}

// ── Server-side Pixabay image fetcher ──
const PIXABAY_API_KEY = '55202515-e90b22c5f5f95ded6a90cef65';

async function fetchPixabayImages(keyword: string, count = 3): Promise<string[]> {
  try {
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(keyword)}&image_type=photo&per_page=${count}&safesearch=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data: any = await res.json();
    return (data.hits || []).slice(0, count).map((hit: any) => hit.webformatURL);
  } catch {
    return [];
  }
}

function extractImageKeywords(description: string, taskType: string): string[] {
  if (taskType === 'website') {
    const keywords = description
      .replace(/website|landing|page|create|make|build|design|simple|basic|modern|clean|beautiful/gi, '')
      .split(/[\s,]+/)
      .filter(w => w.length > 2 && !['for','with','the','and','that','this'].includes(w.toLowerCase()))
      .slice(0, 3);
    return keywords.length > 0 ? keywords : ['nature', 'business', 'technology'];
  }
  return ['nature', 'business', 'technology'];
}

app.post('/api/sandbox/run', async (req, res) => {
  try {
    const { task_description, task_type, timeout, taskId } = req.body;
    if (!task_description) {
      res.status(400).json({ error: 'task_description is required' });
      return;
    }

    const task = taskId || crypto.randomUUID();
    setTaskProgress(task, 'starting');

    const safeTimeout = Math.min(Math.max(Number(timeout) || 60, 10), 300);
    const safeDesc = String(task_description).slice(0, 16000);
    const safeType = String(task_type || 'auto').toLowerCase();
    let resultText = '';

    let agentUsed = 'unknown';

    if (safeType === 'hermes' || safeType === 'multitask' || safeType === 'opencode' || safeType === 'code') {
      // Hermes Multitask Agent — direct routing with all Hermes skills
      setTaskProgress(task, 'running', { agent: 'eburon_multimodal_pro' });
      try {
        const hermesResult = await callHermesMultitask(
          HERMES_MULTITASK_SYSTEM,
          safeDesc,
          Math.min(safeTimeout, 180),
          32768,
        );
        resultText = hermesResult.content;
        agentUsed = `eburon-multimodal-pro (${hermesResult.model})`;
        if (!resultText || resultText.length < 5) throw new Error('Empty or too short response');
      } catch (hermesErr: any) {
        throw new Error(`Eburon Multimodal Pro failed: ${hermesErr.message}`);
      }

    } else {
      const needsImages = safeType === 'website';
      let systemPrompt = ['document', 'website', 'writing', 'analysis', 'research', 'dashboard', 'app', 'artifact'].includes(safeType) ? XERO_HTML_SYSTEM : 'You are a helpful assistant. Complete the task and return the result concisely.';

      // Pre-fetch real Pixabay images and inject into prompt
      if (needsImages) {
        const keywords = extractImageKeywords(safeDesc, safeType);
        const imageSets = await Promise.all(keywords.map(k => fetchPixabayImages(k)));
        const allImages = imageSets.flat().filter(Boolean);
        if (allImages.length > 0) {
          systemPrompt += `\n\n## REAL PIXABAY IMAGES (use these exact URLs)\nThe following images were fetched live from Pixabay for this task. Use them directly in your HTML output.\n\n`;
          for (const img of allImages) {
            systemPrompt += `<img src="${img}" alt="Pixabay image" loading="lazy" style="max-width:400px">\n`;
          }
          systemPrompt += `\nImages courtesy of https://pixabay.com\n`;
        }
      }

      // Primary: Eburon Sandbox (streaming model with thinking + tools)
      setTaskProgress(task, 'running', { agent: 'eburon_sandbox' });
      try {
        const sandboxResult = await generateEburonSandbox({
          prompt: safeDesc,
          systemInstruction: systemPrompt,
          timeoutSec: Math.min(safeTimeout, 180),
          maxOutputTokens: 32768,
        });
        resultText = sandboxResult.text;
        agentUsed = 'eburon_sandbox';
        if (!resultText || resultText.length < 5) throw new Error('Empty or too short response');
      } catch (sandboxErr: any) {
        console.warn('[Sandbox] Eburon Sandbox failed, falling back to Eburon Multimodal Pro:', sandboxErr.message?.slice(0, 100));
        // Fallback 1: Eburon Multimodal Pro
        setTaskProgress(task, 'running', { agent: 'eburon_multimodal_pro', message: 'Falling back to Eburon Multimodal Pro' });
        try {
          const hermesResult = await callHermesMultitask(
            HERMES_MULTITASK_SYSTEM,
            safeDesc,
            Math.min(safeTimeout, 180),
            32768,
          );
          resultText = hermesResult.content;
          agentUsed = `eburon-multimodal-pro (${hermesResult.model})`;
          if (!resultText || resultText.length < 5) throw new Error('Empty or too short response');
        } catch {
          // Fallback 2: Cerebras
          setTaskProgress(task, 'running', { agent: 'cerebras', message: 'Falling back to Cerebras' });
          try {
            const result = await callCerebras(systemPrompt, safeDesc, Math.min(safeTimeout, 180), 32768);
            resultText = result.content;
            agentUsed = 'cerebras-gpt-oss-120b';
            if (!resultText || resultText.length < 5) throw new Error('Empty or too short response');
          } catch {
            // Fallback 2.5: Eburon Coder Pro (local Ollama, no API limits)
            setTaskProgress(task, 'running', { agent: 'eburon-coder-pro', message: 'Falling back to Eburon Coder Pro (3B)' });
            try {
              const qwenResult = await callEburonCoderPro(systemPrompt, safeDesc, Math.min(safeTimeout, 240), 16384);
              resultText = qwenResult.content;
              agentUsed = 'eburon-coder-pro';
              if (!resultText || resultText.length < 5) throw new Error('Empty or too short response');
            } catch {
              // Fallback 3: Eburon Worker
              setTaskProgress(task, 'running', { agent: 'eburon_worker', message: 'Falling back to Eburon Worker' });
              try {
                const eburonResult = await generateEburonWorker({
                  prompt: safeDesc,
                  systemInstruction: systemPrompt,
                });
                resultText = eburonResult.text || '[No response from sandbox]';
                agentUsed = 'eburon_worker';
              } catch (e: any) {
                throw new Error(`All agents failed (Eburon Sandbox + Eburon Multimodal Pro + Cerebras + Eburon Coder Pro + Eburon Worker). Last error: ${e.message}`);
              }
            }
          }
        }
      }
    }

    const artifactTypes = new Set([
      'document',
      'website',
      'writing',
      'analysis',
      'research',
      'dashboard',
      'app',
      'artifact',
    ]);
    if (artifactTypes.has(safeType)) {
      resultText = extractRawHtml(resultText);
    }

    const maxLength = 8000;
    const truncated = resultText.length > maxLength;
    const finalResult = truncated ? resultText.slice(0, maxLength) + '\n...[truncated]' : resultText;

    setTaskProgress(task, 'done', { agent: agentUsed });
    setTimeout(() => taskProgress.delete(task), 60000);

    res.json({
      ok: true,
      result: finalResult,
      truncated,
      task_type: safeType,
      agent: agentUsed,
    });
  } catch (err: any) {
    console.error('Sandbox error:', err.message?.slice(0, 200));
    if (req.body?.taskId) setTaskProgress(req.body.taskId, 'error', { message: err.message?.slice(0, 200) });
    res.status(500).json({ error: err.message?.slice(0, 500) || 'Sandbox execution failed' });
  }
});

// SSE progress stream for sub-agent tasks
app.get('/api/sandbox/progress/:taskId', (req, res) => {
  const { taskId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendProgress = () => {
    const entry = taskProgress.get(taskId);
    if (!entry) {
      res.write(`data: ${JSON.stringify({ status: 'unknown' })}\n\n`);
      return;
    }
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
    if (entry.status === 'done' || entry.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  };

  const interval = setInterval(sendProgress, 500);
  sendProgress();

  req.on('close', () => clearInterval(interval));
});

// ── Cerebras + Browser-Use Sandbox ──
// Delegates browser automation tasks to a Cerebras-powered Browser-Use agent
// Requires: pip install browser-use && playwright install

const CEREBRAS_SCRIPT = path.join(__dirname, '..', 'scripts', 'cerebras_browser.py');
const CEREBRAS_PYTHON = process.env.CEREBRAS_PYTHON || path.join(__dirname, '..', '.venv', 'bin', 'python3');

app.post('/api/cerebras/browser', async (req, res) => {
  try {
    const { task, model, timeout } = req.body;
    if (!task) {
      res.status(400).json({ error: 'task is required' });
      return;
    }

    const safeTask = String(task).slice(0, 2000).replace(/"/g, '\\"');
    const safeModel = String(model || 'gpt-oss-120b').slice(0, 50);
    const safeTimeout = Math.min(Math.max(Number(timeout) || 60, 10), 300);

    const cmd = `"${CEREBRAS_PYTHON}" "${CEREBRAS_SCRIPT}" --task "${safeTask}" --model "${safeModel}" --timeout ${safeTimeout}`;

    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      timeout: (safeTimeout + 10) * 1000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY || '' },
    });

    const result = JSON.parse(stdout.trim());
    res.json(result);
  } catch (err: any) {
    // Try to parse JSON from stderr or partial output
    try {
      const partial = err.stdout || err.message || '';
      const parsed = JSON.parse(partial.trim().split('\n').filter((l: string) => l.startsWith('{')).pop() || '{}');
      if (parsed.ok !== undefined) { res.json(parsed); return; }
    } catch {}
    res.status(500).json({
      ok: false,
      error: err.message?.slice(0, 500) || 'Cerebras browser task failed',
    });
  }
});

// ── Document Generation Route ──

app.post('/api/docs/generate', async (req, res) => {
  try {
    const { userId, title, prompt, templateKey, historyContext, language } = req.body;
    if (!userId || !title || !prompt || !templateKey) {
      res.status(400).json({ error: 'userId, title, prompt, and templateKey are required' });
      return;
    }

    // 1. Identify the template (placeholder logic, assuming templates exist somewhere)
    // In a real implementation, you'd fetch the template file content here.
    
    // 2. Generate structured JSON content for the template
    const systemPrompt = `
You are a helpful document assistant. Based on the user request, generate ONLY a valid JSON object containing the data to fill a document template for: ${templateKey}.
Ensure all fields required by the template are populated with appropriate values derived from the user request and conversation.
`;

    const userPrompt = `
Title: ${title}
Request: ${prompt}
Context: ${historyContext || ''}
Language: ${language || 'en'}
`;

    let genResult;
    try {
      genResult = await generateEburonWorker({
        prompt: userPrompt,
        systemInstruction: systemPrompt,
      });
    } catch {
      const fallback = await callCerebras(systemPrompt, userPrompt, 60, 4096);
      genResult = { text: fallback.content };
    }
    const jsonContent = JSON.parse(genResult.text.trim().replace(/^```json/, '').replace(/```$/, ''));

    // 3. Render HTML (In a real implementation, you'd use a template engine here, like EJS or Handlebars)
    // For now, returning the structured data to be rendered on the client or via a basic template.
    
    // Placeholder rendering logic
    const htmlContent = `<h1>${jsonContent.title || title}</h1><p>${JSON.stringify(jsonContent)}</p>`;

    // Save to Supabase (non-fatal if unavailable)
    const { error: saveError } = await supabase.from('tool_outputs').insert({
      user_id: userId,
      type: 'document',
      content: { htmlContent, data: jsonContent },
      metadata: { title, templateKey }
    }).maybeSingle();

    if (saveError) {
      console.warn('Supabase save skipped:', saveError.message);
    }

    res.json({ ok: true, data: jsonContent });

  } catch (err: any) {
    console.error('Document generation error:', err);
    res.status(500).json({ error: err.message || 'Generation failed' });
  }
});

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  if (waManager) await waManager!.shutdown();
  process.exit(0);
});

// ── Workspace persistence API ──

app.post('/api/workspace/save', async (req, res) => {
  try {
    const output = req.body;
    if (!output || !output.id || !output.userId) {
      res.status(400).json({ error: 'id and userId are required' });
      return;
    }
    await wsSave(output);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Save failed' });
  }
});

app.get('/api/workspace/list/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) { res.status(400).json({ error: 'userId required' }); return; }
    const outputs = await wsList(userId);
    res.json({ ok: true, outputs });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'List failed' });
  }
});

app.delete('/api/workspace/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = String(req.query.userId || '');
    if (!id || !userId) { res.status(400).json({ error: 'id and userId required' }); return; }
    await wsDelete(id, userId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

// ── SPA fallback — any non-API, non-asset route serves index.html ──
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/site-build/')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) next();
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Beatrice Backend Server running on http://0.0.0.0:${PORT}`);
});

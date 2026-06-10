import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import P from 'pino';
import QRCode from 'qrcode';
import { EventEmitter } from 'events';
import { supabase } from './supabase';

type WaStatus = 'init' | 'qr_ready' | 'paired' | 'disconnected' | 'error';
type WaProvider = 'linked_device' | 'cloud_api';

const WA_PERMISSION_KEYS = [
  'send_messages',
  'read_chats',
  'access_contacts',
  'manage_contacts',
  'access_groups',
  'send_group_messages',
  'read_group_chats',
  'view_message_history',
  'access_images',
  'access_videos',
  'access_audio',
  'access_documents',
  'access_stickers',
  'access_contact_cards',
  'access_location',
  'access_links',
  'access_polls',
] as const;

type WaPermission = typeof WA_PERMISSION_KEYS[number];

export interface WaRecentMessage {
  id: string;
  chatId: string;
  from: string;
  fromName?: string;
  pushName?: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  isMedia: boolean;
  mediaMimeType?: string;
  mediaCaption?: string;
}

export interface WaChatSummary {
  id: string;
  name: string;
  unreadCount: number;
  lastMessage: string;
  timestamp: number;
  isGroup: boolean;
}

export interface WaContactSummary {
  id: string;
  name: string;
  notify?: string;
  verifiedName?: string;
  number: string;
}

interface WaAdminConfig {
  provider: WaProvider;
  displayName: string;
  businessAccountId: string;
  phoneNumberId: string;
  appId: string;
  apiVersion: string;
  accessToken: string;
  appSecret: string;
  webhookVerifyToken: string;
  defaultCountryCode: string;
  permissions: Record<WaPermission, boolean>;
  restrictedContacts: string[];
  restrictedChats: string[];
  updatedAt: string;
}

export interface WaAdminConfigInput {
  provider?: WaProvider;
  displayName?: string;
  businessAccountId?: string;
  phoneNumberId?: string;
  appId?: string;
  apiVersion?: string;
  accessToken?: string;
  appSecret?: string;
  webhookVerifyToken?: string;
  defaultCountryCode?: string;
  permissions?: Partial<Record<WaPermission, boolean>>;
  restrictedContacts?: string[];
  restrictedChats?: string[];
}

export interface WaAdminConfigPublic {
  provider: WaProvider;
  displayName: string;
  businessAccountId: string;
  phoneNumberId: string;
  appId: string;
  apiVersion: string;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  hasWebhookVerifyToken: boolean;
  defaultCountryCode: string;
  permissions: Record<WaPermission, boolean>;
  restrictedContacts: string[];
  restrictedChats: string[];
  updatedAt: string | null;
}

interface WaSession {
  userId: string;
  status: WaStatus;
  qrCode: string | null;
  qrRaw: string | null;
  pairingCode?: string | null;
  phone: string | null;
  sock: any | null;
  authDir: string;
  dataFile: string;
  error: string | null;
  recentMessages: WaRecentMessage[];
  contacts: Record<string, WaContactSummary>;
  messageById: Map<string, any>;
  reconnecting: boolean;
  reconnectAttempt?: number;
  saveTimer: NodeJS.Timeout | null;
  reconnectTimer?: NodeJS.Timeout | null;
}
const MAX_MESSAGES = 50000;

const PERSIST_MESSAGES = 20000;
const logger = P({ level: process.env.WA_LOG_LEVEL || 'silent' });

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function defaultPermissions(): Record<WaPermission, boolean> {
  return WA_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = true;
    return acc;
  }, {} as Record<WaPermission, boolean>);
}

function normalizePermissions(input?: Partial<Record<WaPermission, boolean>>): Record<WaPermission, boolean> {
  const base = defaultPermissions();
  for (const key of WA_PERMISSION_KEYS) {
    if (typeof input?.[key] === 'boolean') base[key] = input[key] === true;
  }
  return base;
}

function cleanPhoneNumber(input: string, defaultCountryCode = '32'): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  // Belgian local mobile: 04xx xxx xxx (10 digits) -> 324xx xxx xxx
  if (digits.length === 10 && digits.startsWith('04')) {
    return '32' + digits.substring(1);
  }

  // Philippine local mobile: 09xx xxx xxxx (11 digits) -> 639xx xxx xxxx
  if (digits.length === 11 && digits.startsWith('09')) {
    return '63' + digits.substring(1);
  }

  // If already international (starts with country code or has +)
  if (raw.startsWith('+')) return digits;
  
  // If it's already a long number (11+ digits) and doesn't start with 0,
  // assume it already includes a country code and return it as is.
  if (digits.length >= 11 && !digits.startsWith('0')) {
    return digits;
  }

  const cleanCountry = defaultCountryCode.replace(/\D/g, '');
  if (!cleanCountry) return digits;
  
  // If it already starts with the default country code, return it
  if (digits.startsWith(cleanCountry)) return digits;
  
  // Otherwise, prepend the default country code
  return `${cleanCountry}${digits.replace(/^0+/, '')}`;
}

function messageText(message: any): string {
  const m = message?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

function mediaInfo(message: any): { isMedia: boolean; mimeType?: string; caption?: string; mediaType?: string; fileName?: string } {
  const m = message?.message;
  if (!m) return { isMedia: false };
  const img = m.imageMessage;
  if (img) return { isMedia: true, mimeType: img.mimetype || 'image/jpeg', caption: img.caption, mediaType: 'image' };
  const vid = m.videoMessage;
  if (vid) return { isMedia: true, mimeType: vid.mimetype || 'video/mp4', caption: vid.caption, mediaType: 'video' };
  const aud = m.audioMessage;
  if (aud) return { isMedia: true, mimeType: aud.mimetype || 'audio/ogg', mediaType: 'audio' };
  const doc = m.documentMessage;
  if (doc) return { isMedia: true, mimeType: doc.mimetype || 'application/octet-stream', caption: doc.caption, mediaType: 'document', fileName: doc.fileName };
  const sticker = m.stickerMessage;
  if (sticker) return { isMedia: true, mimeType: sticker.mimetype || 'image/webp', mediaType: 'sticker' };
  return { isMedia: false };
}

function timestampMs(value: any): number {
  if (!value) return Date.now();
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value?.toNumber === 'function') return value.toNumber() * 1000;
  return Date.now();
}

export function toWhatsAppJid(value: string, group = false): string {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.includes('@s.whatsapp.net') || input.includes('@g.us') || input.includes('@broadcast')) {
    return input;
  }
  const cleaned = input.replace(/\D/g, '');
  if (!cleaned) return input;
  return `${cleaned}@${group ? 'g.us' : 's.whatsapp.net'}`;
}

function jidNumber(jid: string): string {
  return jid.split('@')[0] || jid;
}

function readSessionData(dataFile: string): Pick<WaSession, 'recentMessages' | 'contacts'> {
  try {
    if (!fs.existsSync(dataFile)) return { recentMessages: [], contacts: {} };
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return {
      recentMessages: Array.isArray(parsed.recentMessages) ? parsed.recentMessages : [],
      contacts: parsed.contacts && typeof parsed.contacts === 'object' ? parsed.contacts : {},
    };
  } catch {
    return { recentMessages: [], contacts: {} };
  }
}

function writeSessionData(entry: WaSession) {
  const payload = {
    recentMessages: entry.recentMessages.slice(0, PERSIST_MESSAGES),
    contacts: entry.contacts,
  };
  fs.writeFileSync(entry.dataFile, JSON.stringify(payload, null, 2));
}

export class WhatsAppManager extends EventEmitter {
  private sessions = new Map<string, WaSession>();
  private authRoot = process.env.WA_AUTH_ROOT || path.join(process.cwd(), '.baileys_auth');
  private sseClients = new Map<string, Set<(msg: any) => void>>();

  // ── SSE (Server-Sent Events) for real-time message streaming ──
  onSseConnect(userId: string, callback: (msg: any) => void) {
    if (!this.sseClients.has(userId)) this.sseClients.set(userId, new Set());
    this.sseClients.get(userId)!.add(callback);
  }

  onSseDisconnect(userId: string, callback: (msg: any) => void) {
    this.sseClients.get(userId)?.delete(callback);
    if (this.sseClients.get(userId)?.size === 0) this.sseClients.delete(userId);
  }

  private emitNewMessage(userId: string, msg: any) {
    const clients = this.sseClients.get(userId);
    if (clients) {
      for (const cb of clients) {
        try { cb(msg); } catch {}
      }
    }
  }

  async resumeExistingSessions(): Promise<void> {
    if (!fs.existsSync(this.authRoot)) return;
    try {
      const dirs = fs.readdirSync(this.authRoot);
      for (const dir of dirs) {
        const fullPath = path.join(this.authRoot, dir);
        if (fs.statSync(fullPath).isDirectory()) {
          const credsFile = path.join(fullPath, 'creds.json');
          if (fs.existsSync(credsFile)) {
            console.log(`Resuming WhatsApp session: ${dir}`);
            this.startSession(dir).catch((err: any) => {
              console.error(`Failed to auto-resume session ${dir}:`, err.message);
            });
          }
        }
      }
    } catch (error) {
      console.error('Error resuming existing WhatsApp sessions:', error);
    }
  }

  async startPairing(userId: string, phoneNumber?: string): Promise<{ pairingCode: string; status: string }> {
    const existing = this.sessions.get(userId);
    if (existing && ['init', 'qr_ready', 'paired'].includes(existing.status)) {
      if (phoneNumber) {
        await this.disconnect(userId);
      } else {
        return { pairingCode: existing.pairingCode || safeUserId(userId), status: existing.status };
      }
    }

    await this.startSession(userId, phoneNumber);

    // If phone pairing, wait up to 12s for the actual pairing code to be generated by Baileys
    if (phoneNumber) {
      const pollStart = Date.now();
      const timeout = 12000;
      while (Date.now() - pollStart < timeout) {
        const current = this.sessions.get(userId);
        if (!current || current.status === 'error') break;
        if (current.pairingCode) {
          return { pairingCode: current.pairingCode, status: current.status };
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    const final = this.sessions.get(userId);
    return { 
      pairingCode: final?.pairingCode || safeUserId(userId), 
      status: final?.status || 'init' 
    };
  }

  private async reconnect(userId: string, attempt = 0) {
    const entry = this.sessions.get(userId);
    if (!entry) return; // User has disconnected/removed the session

    // If it's already logged out, do not reconnect
    if (entry.status === 'disconnected') return;

    entry.reconnecting = true;
    entry.reconnectAttempt = attempt;
    
    // Calculate backoff delay: 2s, 5s, 10s, 30s, up to 60s max
    const delays = [2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(attempt, delays.length - 1)];

    console.log(`[WhatsApp] Scheduling reconnection for ${userId} in ${delay}ms (attempt ${attempt + 1})`);

    this.clearReconnectTimer(entry);

    entry.reconnectTimer = setTimeout(async () => {
      // Check again if the session is still active and unchanged
      const currentEntry = this.sessions.get(userId);
      if (currentEntry !== entry) return;

      try {
        console.log(`[WhatsApp] Attempting to reconnect session for ${userId}...`);
        await this.startSession(userId);
      } catch (error: any) {
        console.error(`[WhatsApp] Reconnection attempt ${attempt + 1} failed for ${userId}:`, error.message);
        
        // Update status and error in the active session
        const activeEntry = this.sessions.get(userId);
        if (activeEntry === entry) {
          activeEntry.status = 'error';
          activeEntry.error = error.message || 'Reconnect failed';
          // Trigger the next retry
          this.reconnect(userId, attempt + 1);
        }
      }
    }, delay);
  }

  async startSession(userId: string, phoneNumber?: string): Promise<void> {
    const safeId = safeUserId(userId);
    const authDir = path.join(this.authRoot, safeId);
    const dataFile = path.join(authDir, 'session-data.json');
    ensureDir(authDir);

    let entry = this.sessions.get(userId);
    if (entry) {
      this.clearSaveTimer(entry);
      this.clearReconnectTimer(entry);
      try {
        entry.sock?.end?.(undefined);
      } catch {}
      
      entry.status = 'init';
      entry.sock = null;
      entry.error = null;
    } else {
      const savedData = readSessionData(dataFile);
      entry = {
        userId,
        status: 'init',
        qrCode: null,
        qrRaw: null,
        pairingCode: null,
        phone: null,
        sock: null,
        authDir,
        dataFile,
        error: null,
        recentMessages: savedData.recentMessages,
        contacts: savedData.contacts,
        messageById: new Map(),
        reconnecting: false,
        reconnectAttempt: 0,
        saveTimer: null,
        reconnectTimer: null,
      };
      this.sessions.set(userId, entry);
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      if (this.sessions.get(userId) !== entry) return;

      let version: [number, number, number] = [2, 3000, 1017531287];
      try {
        const fetched = await fetchLatestBaileysVersion();
        if (this.sessions.get(userId) !== entry) return;
        version = fetched.version;
      } catch (verErr: any) {
        console.warn(`[WhatsApp] Failed to fetch latest Baileys version, using fallback:`, verErr.message);
      }

      const sock = makeWASocket({
        version,
        logger,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
        markOnlineOnConnect: false,
        syncFullHistory: true,
        getMessage: async (key) => {
          const jid = key.remoteJid;
          const id = key.id;
          if (!jid || !id) return undefined;
          return entry!.messageById.get(`${jid}:${id}`)?.message;
        },
      });

      entry.sock = sock;

      if (phoneNumber && !state.creds.registered) {
        // More robust pairing code request with retries for "Connection Closed" errors
        const requestCode = async (retry = 0) => {
          if (this.sessions.get(userId) !== entry || entry.status === 'paired') return;
          try {
            const cleaned = phoneNumber.replace(/\D/g, '');
            console.log(`[Baileys] Requesting pairing code for ${cleaned} (attempt ${retry + 1})...`);
            const code = await sock.requestPairingCode(cleaned);
            if (this.sessions.get(userId) !== entry) return;
            entry.pairingCode = code;
            entry.status = 'qr_ready';
            console.log(`[Baileys] Generated pairing code successfully: ${code}`);
          } catch (err: any) {
            const isClosed = err.message?.includes('Closed') || err.output?.statusCode === 428;
            if (isClosed && retry < 5) {
              const delay = 1500 + (retry * 1000);
              console.warn(`[Baileys] Connection closed while requesting code, retrying in ${delay}ms...`);
              setTimeout(() => requestCode(retry + 1), delay);
            } else {
              console.error(`[Baileys] Failed to generate pairing code:`, err);
              if (this.sessions.get(userId) !== entry) return;
              entry.error = err.message || 'Failed to request pairing code';
              entry.status = 'error';
            }
          }
        };
        // Initial delay to allow socket to establish connection
        setTimeout(() => requestCode(), 2000);
      }

      entry.saveTimer = setInterval(() => {
        try {
          if (entry && this.sessions.get(userId) === entry) {
            writeSessionData(entry);
          }
        } catch (error) {
          console.warn(`Failed to write WhatsApp data for ${userId}:`, error);
        }
      }, 10_000);

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (this.sessions.get(userId) !== entry) return;

        if (qr) {
          entry.qrRaw = qr;
          entry.qrCode = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          entry.status = 'qr_ready';
          entry.error = null;
        }

        if (connection === 'open') {
          entry.status = 'paired';
          entry.qrCode = null;
          entry.qrRaw = null;
          entry.error = null;
          entry.phone = sock.user?.id ? jidNumber(sock.user.id) : 'connected';
          console.log(`WhatsApp paired for user ${userId}: ${entry.phone}`);
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          entry.status = loggedOut ? 'disconnected' : 'error';
          entry.error = loggedOut ? null : (lastDisconnect?.error?.message || 'WhatsApp connection closed');
          const currentAttempt = entry.reconnectAttempt || 0;
          entry.sock = null;
          this.clearSaveTimer(entry);

          if (!loggedOut) {
            this.reconnect(userId, currentAttempt + 1);
          }
        }
      });

      sock.ev.on('messages.upsert', ({ messages }: any) => {
        if (this.sessions.get(userId) !== entry) return;

        for (const msg of messages || []) {
          const chatId = msg.key?.remoteJid || '';
          if (!chatId || chatId === 'status@broadcast') continue;
          if (msg.key?.id) entry.messageById.set(`${chatId}:${msg.key.id}`, msg);

          const mi = mediaInfo(msg);
          const body = mi.isMedia ? (mi.caption || `[${mi.mediaType || 'media'}]`) : (messageText(msg) || '[media]');
          const record: WaRecentMessage = {
            id: msg.key?.id || `${chatId}:${Date.now()}`,
            chatId,
            from: msg.key?.participant || msg.key?.remoteJid || '',
            fromName: msg.key?.fromMe ? 'Me' : undefined,
            pushName: msg.pushName || undefined,
            body: body.slice(0, 1000),
            timestamp: timestampMs(msg.messageTimestamp),
            fromMe: !!msg.key?.fromMe,
            isGroup: chatId.endsWith('@g.us'),
            isMedia: mi.isMedia,
            mediaMimeType: mi.mimeType,
            mediaCaption: mi.caption,
          };
          entry.recentMessages.unshift(record);

          // Emit new message to SSE clients for real-time streaming
          this.emitNewMessage(userId, record);

          // Capture public profile name (pushName) from incoming messages
          const senderJid = msg.key?.participant || chatId;
          if (senderJid && senderJid.endsWith('@s.whatsapp.net') && msg.pushName) {
            const existing = entry.contacts[senderJid];
            const savedName = existing?.name && existing.name !== senderJid ? existing.name : '';
            const notifyName = msg.pushName || existing?.notify || '';
            entry.contacts[senderJid] = {
              id: senderJid,
              name: savedName || notifyName || senderJid,
              notify: notifyName || undefined,
              verifiedName: existing?.verifiedName || undefined,
              number: jidNumber(senderJid),
            };
          }
          // Also capture pushName for the chat itself (1-on-1 chats)
          if (chatId && chatId.endsWith('@s.whatsapp.net') && msg.pushName && senderJid !== chatId) {
            const existing = entry.contacts[chatId];
            const savedName = existing?.name && existing.name !== chatId ? existing.name : '';
            const notifyName = msg.pushName || existing?.notify || '';
            entry.contacts[chatId] = {
              id: chatId,
              name: savedName || notifyName || chatId,
              notify: notifyName || undefined,
              verifiedName: existing?.verifiedName || undefined,
              number: jidNumber(chatId),
            };
          }
        }
        entry.recentMessages = entry.recentMessages.slice(0, MAX_MESSAGES);
      });

      const updateContacts = (contacts: any[]) => {
        if (this.sessions.get(userId) !== entry) return;

        for (const contact of contacts || []) {
          const id = contact.id || contact.jid;
          if (!id || !String(id).endsWith('@s.whatsapp.net')) continue;
          
          const existing = entry.contacts[id];
          const savedName = contact.name || (existing?.name && existing.name !== id ? existing.name : '');
          const notifyName = contact.notify || contact.verifiedName || existing?.notify || '';

          entry.contacts[id] = {
            id,
            name: savedName || notifyName || id,
            notify: notifyName || undefined,
            verifiedName: contact.verifiedName || existing?.verifiedName || undefined,
            number: jidNumber(id),
          };
        }
      };

      sock.ev.on('messaging-history.set', ({ chats, contacts, messages }: any) => {
        updateContacts(contacts || []);
        for (const msg of messages || []) {
          const chatId = msg.key?.remoteJid || '';
          if (!chatId || chatId === 'status@broadcast') continue;
          if (msg.key?.id) entry.messageById.set(`${chatId}:${msg.key.id}`, msg);
          const mi = mediaInfo(msg);
          const body = mi.isMedia ? (mi.caption || `[${mi.mediaType || 'media'}]`) : (messageText(msg) || '[media]');
          const record: WaRecentMessage = {
            id: msg.key?.id || `${chatId}:${Date.now()}`,
            chatId,
            from: msg.key?.participant || msg.key?.remoteJid || '',
            fromName: msg.key?.fromMe ? 'Me' : undefined,
            pushName: msg.pushName || undefined,
            body: body.slice(0, 1000),
            timestamp: timestampMs(msg.messageTimestamp),
            fromMe: !!msg.key?.fromMe,
            isGroup: chatId.endsWith('@g.us'),
            isMedia: mi.isMedia,
            mediaMimeType: mi.mimeType,
            mediaCaption: mi.caption,
          };
          entry.recentMessages.push(record);
        }
        entry.recentMessages = entry.recentMessages.slice(0, MAX_MESSAGES);
      });
      sock.ev.on('contacts.upsert', updateContacts);
      sock.ev.on('contacts.update', updateContacts);

    } catch (err: any) {
      console.error(`[WhatsApp] Failed to initialize session for ${userId}:`, err.message);
      if (this.sessions.get(userId) === entry) {
        entry.status = 'error';
        entry.error = err.message || 'Failed to initialize WhatsApp session';
        
        const hasCreds = fs.existsSync(path.join(authDir, 'creds.json'));
        if (hasCreds) {
          this.reconnect(userId, 0);
        }
      }
    }
  }

  async getStatusOrStart(userId: string): Promise<{ status: string; qrCode?: string; phone?: string; error?: string; pairingCode?: string } | null> {
    const current = this.getStatus(userId);
    if (current) return current;

    const authDir = path.join(this.authRoot, safeUserId(userId));
    if (fs.existsSync(path.join(authDir, 'creds.json'))) {
      await this.startSession(userId);
      return this.getStatus(userId);
    }

    return null;
  }

  getStatus(userId: string): { status: string; qrCode?: string; phone?: string; error?: string; pairingCode?: string } | null {
    const entry = this.sessions.get(userId);
    if (!entry) return null;
    return {
      status: entry.status,
      qrCode: entry.qrCode || undefined,
      phone: entry.phone || undefined,
      error: entry.error || undefined,
      pairingCode: entry.pairingCode || undefined,
    };
  }

  getAdminConfigPublic(userId: string): WaAdminConfigPublic {
    const config = this.readAdminConfig(userId);
    return {
      provider: config.provider,
      displayName: config.displayName,
      businessAccountId: config.businessAccountId,
      phoneNumberId: config.phoneNumberId,
      appId: config.appId,
      apiVersion: config.apiVersion,
      hasAccessToken: !!config.accessToken,
      hasAppSecret: !!config.appSecret,
      hasWebhookVerifyToken: !!config.webhookVerifyToken,
      defaultCountryCode: config.defaultCountryCode,
      permissions: config.permissions,
      restrictedContacts: config.restrictedContacts || [],
      restrictedChats: config.restrictedChats || [],
      updatedAt: config.updatedAt || null,
    };
  }

  saveAdminConfig(userId: string, input: WaAdminConfigInput): WaAdminConfigPublic {
    const current = this.readAdminConfig(userId);
    const next: WaAdminConfig = {
      ...current,
      provider: input.provider || current.provider,
      displayName: input.displayName?.trim() ?? current.displayName,
      businessAccountId: input.businessAccountId?.trim() ?? current.businessAccountId,
      phoneNumberId: input.phoneNumberId?.trim() ?? current.phoneNumberId,
      appId: input.appId?.trim() ?? current.appId,
      apiVersion: input.apiVersion?.trim() || current.apiVersion || 'v23.0',
      defaultCountryCode: cleanPhoneNumber(input.defaultCountryCode || current.defaultCountryCode),
      permissions: input.permissions ? normalizePermissions(input.permissions) : current.permissions,
      restrictedContacts: Array.isArray(input.restrictedContacts) ? input.restrictedContacts : (current.restrictedContacts || []),
      restrictedChats: Array.isArray(input.restrictedChats) ? input.restrictedChats : (current.restrictedChats || []),
      updatedAt: new Date().toISOString(),
      accessToken: input.accessToken?.trim() ? input.accessToken.trim() : current.accessToken,
      appSecret: input.appSecret?.trim() ? input.appSecret.trim() : current.appSecret,
      webhookVerifyToken: input.webhookVerifyToken?.trim() ? input.webhookVerifyToken.trim() : current.webhookVerifyToken,
    };

    this.writeAdminConfig(userId, next);
    return this.getAdminConfigPublic(userId);
  }

  getEffectivePermissions(userId: string, requestPermissions?: Record<string, any>): Record<string, any> {
    const config = this.readAdminConfig(userId);
    const base = config.permissions || {};
    const request = requestPermissions || {};

    return {
      ...base,
      ...request,
      requireUserApproval: request.requireUserApproval,
      approvedByUser: request.approvedByUser,
      mode: request.mode,
    };
  }

  getPermission(userId: string, permissionKey: string): boolean {
    const config = this.readAdminConfig(userId);
    return config.permissions?.[permissionKey as WaPermission] ?? true;
  }

  isChatRestricted(userId: string, chatId: string): boolean {
    const config = this.readAdminConfig(userId);
    const restrictedChats = config.restrictedChats || [];
    const restrictedContacts = config.restrictedContacts || [];
    return restrictedChats.includes(chatId) || restrictedContacts.some(contactId => chatId.startsWith(contactId.split('@')[0]));
  }

  setContactRestriction(userId: string, contactJid: string, restricted: boolean): WaAdminConfigPublic {
    const config = this.readAdminConfig(userId);
    const restrictedContacts = config.restrictedContacts || [];
    const updated = restricted
      ? (restrictedContacts.includes(contactJid) ? restrictedContacts : [...restrictedContacts, contactJid])
      : restrictedContacts.filter(jid => jid !== contactJid);
    return this.saveAdminConfig(userId, { restrictedContacts: updated });
  }

  setChatRestriction(userId: string, chatJid: string, restricted: boolean): WaAdminConfigPublic {
    const config = this.readAdminConfig(userId);
    const restrictedChats = config.restrictedChats || [];
    const updated = restricted
      ? (restrictedChats.includes(chatJid) ? restrictedChats : [...restrictedChats, chatJid])
      : restrictedChats.filter(jid => jid !== chatJid);
    return this.saveAdminConfig(userId, { restrictedChats: updated });
  }

  async sendCloudTextMessage(userId: string, to: string, text: string): Promise<{ chatId: string; messageId?: string } | null> {
    const config = this.readAdminConfig(userId);
    if (config.provider !== 'cloud_api' || !config.accessToken || !config.phoneNumberId) return null;

    const resolvedJid = this.resolveContactJid(userId, to);
    const resolvedNumber = jidNumber(resolvedJid);
    const recipient = cleanPhoneNumber(resolvedNumber || to, config.defaultCountryCode);
    if (!recipient) throw new Error('Recipient phone number required');

    const version = config.apiVersion || 'v23.0';
    const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(config.phoneNumberId)}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || `WhatsApp Cloud API returned ${response.status}`);
    }

    return { chatId: `${recipient}@cloud.whatsapp`, messageId: data?.messages?.[0]?.id };
  }

  async sendWhatsAppMediaMessage(
    userId: string,
    to: string,
    mediaUrl: string,
    mediaType: 'image' | 'video' | 'document' | 'sticker' | 'audio',
    caption?: string,
    ptt?: boolean,
  ): Promise<{ chatId: string; messageId?: string } | null> {
    const sock = this.getClient(userId);
    if (!sock) return null;

    const chatId = this.resolveContactJid(userId, to);
    let content: any;
    if (mediaType === 'sticker') {
      const res = await fetch(mediaUrl).catch(() => null);
      if (!res) return null;
      const img = Buffer.from(await res.arrayBuffer());
      content = { sticker: img };
    } else if (mediaType === 'audio') {
      const res = await fetch(mediaUrl).catch(() => null);
      if (!res) return null;
      const aud = Buffer.from(await res.arrayBuffer());
      content = { audio: aud, ptt: !!ptt, mimetype: 'audio/ogg; codecs=opus' };
    } else {
      content = {
        [mediaType === 'image' ? 'image' : 'video']: { url: mediaUrl },
        caption,
      };
    }
    const sent = await sock.sendMessage(chatId, content);
    const body = mediaType === 'sticker' ? '[sticker]' : (caption || `[${mediaType}]`);
    const msgId = sent?.key?.id;
    this.trackSentMessage(userId, chatId, body, chatId.endsWith('@g.us'), msgId);
    return { chatId, messageId: msgId };
  }

  async getAdminOverview(userId: string) {
    const status = await this.getStatusOrStart(userId);
    const config = this.getAdminConfigPublic(userId);
    return {
      config,
      status: status || { status: 'not_found' },
      messages: await this.getMessageHistory(userId, 'recent', 9999), // Adjusted to use getMessageHistory
      chats: await this.getChats(userId, 9999),
      contactsCount: this.getContacts(userId, 500).length,
      authRootConfigured: !!this.authRoot,
    };
  }

  ingestCloudWebhook(userId: string, payload: any): { accepted: number } {
    const safeId = safeUserId(userId);
    const authDir = path.join(this.authRoot, safeId);
    const dataFile = path.join(authDir, 'session-data.json');
    ensureDir(authDir);

    let entry = this.sessions.get(userId);
    if (!entry) {
      const savedData = readSessionData(dataFile);
      entry = {
        userId,
        status: 'paired',
        qrCode: null,
        qrRaw: null,
        phone: null,
        sock: null,
        authDir,
        dataFile,
        error: null,
        recentMessages: savedData.recentMessages,
        contacts: savedData.contacts,
        messageById: new Map(),
        reconnecting: false,
        saveTimer: null,
      };
      this.sessions.set(userId, entry);
    }

    let accepted = 0;
    for (const root of payload?.entry || []) {
      for (const change of root?.changes || []) {
        for (const msg of change?.value?.messages || []) {
          const from = msg.from || '';
          const chatId = from ? `${from}@cloud.whatsapp` : `cloud:${Date.now()}`;
          const body = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '[cloud message]';
          entry.recentMessages.unshift({
            id: msg.id || `${chatId}:${Date.now()}`,
            chatId,
            from,
            body: String(body).slice(0, 1000),
            timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
            fromMe: false,
            isGroup: false,
            isMedia: !!msg.image || !!msg.video || !!msg.document || !!msg.audio,
          });
          accepted++;
        }
      }
    }

    entry.recentMessages = entry.recentMessages.slice(0, MAX_MESSAGES);
    writeSessionData(entry);
    return { accepted };
  }

  verifyWebhookToken(userId: string, token: unknown): boolean {
    const expected = this.readAdminConfig(userId).webhookVerifyToken;
    return !!expected && String(token || '') === expected;
  }

  getRecentMessages(userId: string, limit = 20): WaRecentMessage[] {
    const entry = this.sessions.get(userId);
    if (!entry) return [];
    return entry.recentMessages
      .filter(msg => !this.isChatRestricted(userId, msg.chatId))
      .slice(0, Math.min(limit, MAX_MESSAGES));
  }

  async getChats(userId: string, limit = 20): Promise<WaChatSummary[]> {
    const entry = this.sessions.get(userId);
    if (!entry) return [];

    const byId = new Map<string, WaChatSummary>();
    for (const msg of entry.recentMessages) {
      if (this.isChatRestricted(userId, msg.chatId)) continue;
      const current = byId.get(msg.chatId);
      if (!current || msg.timestamp >= current.timestamp) {
        const name = await this.resolveNameFromAnywhere(userId, msg.chatId);

        byId.set(msg.chatId, {
          id: msg.chatId,
          name,
          unreadCount: current?.unreadCount || 0,
          lastMessage: msg.body.slice(0, 160),
          timestamp: msg.timestamp,
          isGroup: msg.isGroup,
        });
      }
    }

    return [...byId.values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, Math.min(limit, MAX_MESSAGES));
  }

  private async resolveNameFromAnywhere(userId: string, jid: string): Promise<string> {
    const entry = this.sessions.get(userId);
    if (!entry) return jid;

    // 1. Session contacts
    const contact = entry.contacts[jid];
    if (contact?.name || contact?.notify || contact?.verifiedName) {
      return contact.name || contact.notify || contact.verifiedName || jid;
    }

    // 2. Supabase contacts table
    try {
      const cleanPhone = jid.split('@')[0];
      const { data } = await supabase
        .from('contacts')
        .select('display_name')
        .eq('owner_user_id', userId)
        .eq('phone_e164', '+' + cleanPhone)
        .limit(1);
      if (data?.[0]?.display_name) return data[0].display_name;
    } catch (e) {
      // Ignore DB errors in fallback
    }

    return jid;
  }

  trackSentMessage(userId: string, chatId: string, text: string, isGroup = false, messageId?: string) {
    const entry = this.sessions.get(userId);
    if (!entry) return;

    const record: WaRecentMessage = {
      id: messageId || `sent_${Date.now()}`,
      chatId,
      from: entry.sock?.user?.id || 'me',
      fromName: 'Me',
      body: text,
      timestamp: Date.now(),
      fromMe: true,
      isGroup,
      isMedia: false,
    };

    // Prepend and filter duplicates
    entry.recentMessages = [record, ...entry.recentMessages.filter(m => m.id !== record.id)].slice(0, MAX_MESSAGES);
    writeSessionData(entry);
  }

  getContacts(userId: string, limit = 100): WaContactSummary[] {
    const entry = this.sessions.get(userId);
    if (!entry?.contacts) return [];

    return Object.values(entry.contacts)
      .filter(contact => contact.id.endsWith('@s.whatsapp.net') && !this.isChatRestricted(userId, contact.id))
      .slice(0, Math.min(limit, 500));
  }

  resolveContactJid(userId: string, nameOrNumberOrJid: string): string {
    const input = String(nameOrNumberOrJid || '').trim();
    if (!input) return '';

    // If it's already a JID, return it
    if (input.endsWith('@s.whatsapp.net') || input.endsWith('@g.us') || input.endsWith('@broadcast')) {
      return input;
    }

    // If it contains only digits (with optional leading +), it's a number
    const isNumber = /^\+?\d+$/.test(input);
    if (isNumber) {
      const config = this.readAdminConfig(userId);
      return toWhatsAppJid(cleanPhoneNumber(input, config.defaultCountryCode));
    }

    // Try to find by name in session contacts
    const entry = this.sessions.get(userId);
    if (entry?.contacts) {
      const query = input.toLowerCase();
      // Exact matches first
      const exactMatch = Object.values(entry.contacts).find(c =>
        (c.name && c.name.toLowerCase() === query) ||
        (c.notify && c.notify.toLowerCase() === query) ||
        (c.verifiedName && c.verifiedName.toLowerCase() === query)
      );
      if (exactMatch) return exactMatch.id;

      // Partial matches
      const partialMatch = Object.values(entry.contacts).find(c =>
        (c.name && c.name.toLowerCase().includes(query)) ||
        (c.notify && c.notify.toLowerCase().includes(query)) ||
        (c.verifiedName && c.verifiedName.toLowerCase().includes(query))
      );
      if (partialMatch) return partialMatch.id;
    }

    return toWhatsAppJid(input);
  }

  async resolveContact(userId: string, contactRef: string): Promise<any> {
    const query = String(contactRef || '').trim();
    if (!query) return { status: 'not_found' };
    const queryLower = query.toLowerCase();

    // 1. Check local Baileys contacts
    const localContacts = this.getContacts(userId, 1000);
    const localExact = localContacts.filter(c =>
      (c.name && c.name.toLowerCase() === queryLower) ||
      (c.notify && c.notify.toLowerCase() === queryLower) ||
      (c.verifiedName && c.verifiedName.toLowerCase() === queryLower)
    );

    const localPartial = localContacts.filter(c =>
      !localExact.includes(c) && (
        (c.name && c.name.toLowerCase().includes(queryLower)) ||
        (c.notify && c.notify.toLowerCase().includes(queryLower)) ||
        (c.verifiedName && c.verifiedName.toLowerCase().includes(queryLower)) ||
        c.number.includes(query)
      )
    );

    // 2. Check Supabase contacts table
    let dbExact: any[] = [];
    let dbPartial: any[] = [];
    try {
      const { data } = await supabase
        .from('contacts')
        .select('*')
        .eq('owner_user_id', userId);

      if (data) {
        dbExact = data.filter(c =>
          (c.display_name && c.display_name.toLowerCase() === queryLower) ||
          (c.aliases && c.aliases.some((a: string) => a.toLowerCase() === queryLower))
        );
        dbPartial = data.filter(c =>
          !dbExact.includes(c) && (
            (c.display_name && c.display_name.toLowerCase().includes(queryLower)) ||
            (c.phone_e164 && c.phone_e164.includes(query))
          )
        );
      }
    } catch (e) {
      console.error('[WhatsApp] Supabase contact search failed:', e);
    }

    const seen = new Set<string>();
    const exactCandidates: any[] = [];
    const partialCandidates: any[] = [];

    const add = (list: any[], item: any, source: string) => {
      const phone = item.phone_e164 || '+' + (item.number || '');
      const clean = phone.replace(/\D/g, '');
      if (!seen.has(clean)) {
        list.push({
          id: item.id,
          display_name: item.display_name || item.name || item.notify || item.verifiedName || clean,
          phone_e164: phone,
          source
        });
        seen.add(clean);
      }
    };

    localExact.forEach(c => add(exactCandidates, c, 'whatsapp'));
    dbExact.forEach(c => add(exactCandidates, c, 'supabase'));
    localPartial.forEach(c => add(partialCandidates, c, 'whatsapp'));
    dbPartial.forEach(c => add(partialCandidates, c, 'supabase'));

    // RESOLUTION LOGIC
    // Only return 'resolved' if there is exactly one EXACT match
    if (exactCandidates.length === 1) {
      return { status: 'resolved', contact: exactCandidates[0] };
    }

    // If multiple exact matches, it's ambiguous
    if (exactCandidates.length > 1) {
      return {
        status: 'ambiguous',
        candidates: exactCandidates.slice(0, 5).map(c => ({ ...c, phone_last4: c.phone_e164.slice(-4) }))
      };
    }

    // If no exact matches but exactly one partial match, treat it as ambiguous/suggested
    // (Beatrice must confirm this one manually)
    if (partialCandidates.length > 0) {
      return {
        status: 'ambiguous',
        candidates: partialCandidates.slice(0, 5).map(c => ({ ...c, phone_last4: c.phone_e164.slice(-4) }))
      };
    }

    return { status: 'not_found' };
  }

  async sendWhatsAppContactCard(userId: string, to: string, contactRef: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');

    const chatId = this.resolveContactJid(userId, to);

    // Resolve the contact to share
    const res = await this.resolveContact(userId, contactRef);
    if (res.status !== 'resolved') {
      throw new Error(`Contact "${contactRef}" is ${res.status === 'not_found' ? 'not found' : 'ambiguous'}`);
    }

    const contact = res.contact;
    const displayName = contact.display_name;
    const phone = contact.phone_e164;
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\nTEL;type=CELL:${phone}\nEND:VCARD`;

    this.trackSentMessage(userId, chatId, `Shared contact: ${displayName}`);

    return await sock.sendMessage(chatId, {
      contacts: {
        displayName,
        contacts: [{ vcard }]
      }
    });
  }

  async sendWhatsAppTemplate(userId: string, to: string, templateName: string, languageCode = 'en_US', components: any[] = []): Promise<any> {
    const config = this.readAdminConfig(userId);
    if (config.provider !== 'cloud_api' || !config.accessToken || !config.phoneNumberId) {
      throw new Error('WhatsApp Cloud API required for templates');
    }

    const recipient = cleanPhoneNumber(to, config.defaultCountryCode);
    const version = config.apiVersion || 'v23.0';
    const url = `https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components
        }
      })
    });

    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || 'Template send failed');

    this.trackSentMessage(userId, to, `[Template: ${templateName}]`);

    return data;
  }


  async getGroups(userId: string): Promise<WaChatSummary[]> {
    const sock = this.getClient(userId);
    if (!sock) return [];
    const groups = await sock.groupFetchAllParticipating();
    return Object.entries(groups)
      .filter(([id]) => !this.isChatRestricted(userId, id))
      .map(([id, meta]: [string, any]) => ({
        id,
        name: meta.subject || id,
        unreadCount: 0,
        lastMessage: '',
        timestamp: timestampMs(meta.creation),
        isGroup: true,
      }));
  }

  async getMessageHistory(userId: string, chatId: string, limit = 20): Promise<WaRecentMessage[]> {
    const entry = this.sessions.get(userId);
    if (!entry) return [];
    const jid = toWhatsAppJid(chatId, chatId.endsWith('@g.us'));
    if (this.isChatRestricted(userId, jid)) return [];
    const messages = entry.recentMessages
      .filter(message => message.chatId === jid)
      .sort((a, b) => b.timestamp - a.timestamp) // Newest first
      .slice(0, Math.min(limit, MAX_MESSAGES));

    // Resolve names for these messages
    for (const msg of messages) {
      if (!msg.fromName) {
        msg.fromName = msg.fromMe ? 'Me' : await this.resolveNameFromAnywhere(userId, msg.from);
      }
    }

    return messages;
  }

  async disconnect(userId: string): Promise<void> {
    const entry = this.sessions.get(userId);
    if (!entry) return;
    try {
      if (entry.sock) {
        await entry.sock.logout().catch(async () => entry.sock?.end?.(undefined));
      }
    } catch (error) {
      console.error(`WhatsApp disconnect error for ${userId}:`, error);
    }

    this.clearSaveTimer(entry);
    this.clearReconnectTimer(entry);
    this.sessions.delete(userId);
    fs.rmSync(entry.authDir, { recursive: true, force: true });
  }

  async forceResync(userId: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.sessions.get(userId);
    if (!entry) return { ok: false, error: 'Session not found' };
    if (!entry.sock) return { ok: false, error: 'Not connected' };

    // Preserve existing messages — don't clear them. Just reconnect to get new ones.
    this.clearSaveTimer(entry);
    this.clearReconnectTimer(entry);

    try {
      await entry.sock.end(undefined).catch(() => {});
    } catch {}

    entry.sock = null;
    entry.status = 'init';

    setTimeout(async () => {
      try {
        await this.startSession(userId);
      } catch (err: any) {
        console.error(`[WhatsApp] Resync failed for ${userId}:`, err.message);
      }
    }, 1000);

    return { ok: true };
  }

  getCalls(_userId: string, _limit = 20): any[] {
    return [];
  }

  async getWhatsAppGroupMetadata(userId: string, groupId: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jid = toWhatsAppJid(groupId, true);
    const meta = await sock.groupMetadata(jid).catch(() => null);
    return meta || { error: 'Group not found' };
  }

  async getWhatsAppGroupInviteLink(userId: string, groupId: string): Promise<string | null> {
    const sock = this.getClient(userId);
    if (!sock) return null;
    const jid = toWhatsAppJid(groupId, true);
    return await sock.groupInviteCode(jid).catch(() => null) || null;
  }

  async checkWhatsAppUser(userId: string, number: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jid = toWhatsAppJid(number);
    const [result] = await sock.onWhatsApp(jid).catch(() => []);
    return { jid, exists: !!result, ...(result || {}) };
  }

  async getWhatsAppBusinessProfile(userId: string, jid?: string): Promise<any> {
    const config = this.readAdminConfig(userId);
    const resolvedJid = jid ? toWhatsAppJid(jid) : '';

    // Try Cloud API first (business's own profile)
    if (config.provider === 'cloud_api' && config.accessToken && config.phoneNumberId) {
      const myNumber = config.phoneNumberId.replace(/\D/g, '');
      if (!resolvedJid || resolvedJid.includes(myNumber)) {
        const bp = await this.getCloudBusinessProfile(userId);
        if (bp) return bp;
      }
    }
    // Fall back to Baileys socket
    const sock = this.getClient(userId);
    if (!sock) return null;
    return await sock.getBusinessProfile(resolvedJid || sock.user?.id || '').catch(() => null);
  }

  async getCloudBusinessProfile(userId: string): Promise<any> {
    const config = this.readAdminConfig(userId);
    if (config.provider !== 'cloud_api' || !config.accessToken || !config.phoneNumberId) return null;
    const version = config.apiVersion || 'v23.0';
    const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(config.phoneNumberId)}/whatsapp-business-profile?fields=messaging_product,about,address,description,email,profile_picture_url,websites,vertical`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    // Meta Cloud API returns { data: [ { business_profile: { ... } } ] }
    return data?.data?.[0]?.business_profile || data?.data?.[0] || null;
  }

  async updateCloudBusinessProfile(userId: string, profile: {
    about?: string;
    address?: string;
    description?: string;
    email?: string;
    websites?: string[];
    vertical?: string;
  }): Promise<any> {
    const config = this.readAdminConfig(userId);
    if (config.provider !== 'cloud_api' || !config.accessToken || !config.phoneNumberId) {
      throw new Error('WhatsApp Cloud API not configured');
    }
    const version = config.apiVersion || 'v23.0';
    const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(config.phoneNumberId)}/whatsapp-business-profile`;
    const body: any = { messaging_product: 'whatsapp' };
    if (profile.about !== undefined) body.about = profile.about;
    if (profile.address !== undefined) body.address = profile.address;
    if (profile.description !== undefined) body.description = profile.description;
    if (profile.email !== undefined) body.email = profile.email;
    if (profile.websites !== undefined) body.websites = profile.websites;
    if (profile.vertical !== undefined) body.vertical = profile.vertical;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || `Cloud API returned ${response.status}`);
    }
    return data;
  }

  async updateCloudBusinessAvatar(userId: string, imageUrl: string): Promise<any> {
    const config = this.readAdminConfig(userId);
    if (config.provider !== 'cloud_api' || !config.accessToken || !config.phoneNumberId || !config.appId) {
      throw new Error('WhatsApp Cloud API (with appId) not configured');
    }
    const version = config.apiVersion || 'v23.0';

    // Step 1: Download the image
    const imgRes = await fetch(imageUrl).catch(() => null);
    if (!imgRes) throw new Error('Failed to fetch image');
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
    const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

    // Step 2: Create upload session via Resumable Upload API
    const sessionUrl = `https://graph.facebook.com/${version}/${config.appId}/uploads?file_name=avatar.jpg&file_length=${imgBuffer.length}&file_type=${mimeType}&access_token=${config.accessToken}`;
    const sessionRes = await fetch(sessionUrl, { method: 'POST' });
    const sessionData: any = await sessionRes.json();
    if (!sessionRes.ok) throw new Error(sessionData?.error?.message || 'Failed to create upload session');
    const sessionId = sessionData.id;

    // Step 3: Upload binary data to get the handle
    const uploadUrl = `https://graph.facebook.com/${version}/${sessionId}`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${config.accessToken}`,
        file_offset: '0',
        'Content-Type': mimeType,
      },
      body: imgBuffer,
    });
    const uploadData: any = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(uploadData?.error?.message || 'Binary upload failed');
    const handle = uploadData.h;

    // Step 4: Apply handle to the business profile
    const profileUrl = `https://graph.facebook.com/${version}/${config.phoneNumberId}/whatsapp-business-profile`;
    const profileRes = await fetch(profileUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        profile_picture_handle: handle,
      }),
    });
    const profileData: any = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok) {
      throw new Error(profileData?.error?.message || 'Failed to set profile picture handle');
    }
    return profileData;
  }

  async getWhatsAppAvatar(userId: string, jid: string): Promise<string | null> {
    const sock = this.getClient(userId);
    if (!sock) return null;
    return await sock.profilePictureUrl(toWhatsAppJid(jid), 'image').catch(() => null);
  }

  async sendWhatsAppPoll(userId: string, to: string, name: string, options: string[]): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const chatId = this.resolveContactJid(userId, to);
    return await sock.sendMessage(chatId, {
      poll: { name, values: options.map(o => ({ pollOptionValue: Buffer.from(o).toString('base64') })) },
      options,
    });
  }

  async sendWhatsAppReaction(userId: string, to: string, messageId: string, emoji: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const chatId = this.resolveContactJid(userId, to);
    return await sock.sendMessage(chatId, { react: { key: { id: messageId, remoteJid: chatId }, text: emoji } });
  }

  async deleteWhatsAppMessage(userId: string, to: string, messageId: string, revoke = false): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const chatId = this.resolveContactJid(userId, to);
    return await sock.sendMessage(chatId, { delete: { id: messageId, remoteJid: chatId, fromMe: revoke } });
  }

  async markWhatsAppRead(userId: string, to: string, messageId?: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) return null;
    const chatId = this.resolveContactJid(userId, to);
    return await sock.readMessages([{ id: messageId || '', remoteJid: chatId }]).catch(() => null);
  }

  async pinWhatsAppChat(_userId: string, _to: string, _pin = true): Promise<any> {
    return { ok: true };
  }

  async setWhatsAppDisappearing(_userId: string, _to: string, _duration = 0): Promise<any> {
    return { ok: true };
  }

  async createWhatsAppGroup(userId: string, name: string, participants: string[]): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jids = participants.map(p => toWhatsAppJid(p));
    return await sock.groupCreate(name, jids);
  }

  async joinWhatsAppGroup(userId: string, code: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    return await sock.groupAcceptInvite(code);
  }

  async leaveWhatsAppGroup(userId: string, groupId: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jid = toWhatsAppJid(groupId, true);
    return await sock.groupLeave(jid).catch(() => null);
  }

  async updateWhatsAppGroupParticipants(userId: string, groupId: string, participants: string[], action: 'add' | 'remove' | 'promote' | 'demote'): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jid = toWhatsAppJid(groupId, true);
    const jids = participants.map(p => toWhatsAppJid(p));
    return await sock.groupParticipantsUpdate(jid, jids, action);
  }

  async setWhatsAppGroupName(userId: string, groupId: string, name: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jid = toWhatsAppJid(groupId, true);
    return await sock.groupUpdateSubject(jid, name);
  }

  async setWhatsAppGroupTopic(userId: string, groupId: string, topic: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jid = toWhatsAppJid(groupId, true);
    return await sock.groupUpdateDescription(jid, topic);
  }

  async archiveWhatsAppChat(_userId: string, _to: string, _archive = true): Promise<any> {
    return { ok: true };
  }

  async muteWhatsAppChat(_userId: string, _to: string, _duration: number | null = 86400): Promise<any> {
    return { ok: true };
  }

  async deleteWhatsAppChat(_userId: string, _to: string): Promise<any> {
    return { ok: true };
  }

  async clearWhatsAppChat(_userId: string, _to: string): Promise<any> {
    return { ok: true };
  }

  async markWhatsAppUnread(_userId: string, _to: string): Promise<any> {
    return { ok: true };
  }

  async blockWhatsAppContact(_userId: string, _to: string, _block = true): Promise<any> {
    return { ok: true };
  }

  async sendWhatsAppContact(userId: string, to: string, contactName: string, phoneNumber: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const chatId = this.resolveContactJid(userId, to);
    return await sock.sendMessage(chatId, {
      contacts: {
        displayName: contactName || phoneNumber,
        contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName || phoneNumber}\nTEL;type=CELL:${phoneNumber}\nEND:VCARD` }],
      },
    });
  }

  async sendWhatsAppLocation(userId: string, to: string, latitude: number, longitude: number, name?: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const chatId = this.resolveContactJid(userId, to);
    return await sock.sendMessage(chatId, { location: { degreesLatitude: latitude, degreesLongitude: longitude, name: name || '' } });
  }

  async starWhatsAppMessage(_userId: string, _to: string, _messageId: string, _star = true): Promise<any> {
    return { ok: true };
  }

  async updateWhatsAppGroupPhoto(userId: string, groupId: string, url: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) return null;
    const jid = toWhatsAppJid(groupId, true);
    const res = await fetch(url).catch(() => null);
    if (!res) throw new Error('Failed to fetch image');
    const img = Buffer.from(await res.arrayBuffer());
    return await sock.updateProfilePicture(jid, img);
  }

  async removeWhatsAppGroupPhoto(userId: string, groupId: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) return null;
    const jid = toWhatsAppJid(groupId, true);
    return await sock.removeProfilePicture(jid).catch(() => null);
  }

  async revokeWhatsAppGroupInvite(userId: string, groupId: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) throw new Error('Not connected');
    const jid = toWhatsAppJid(groupId, true);
    return await sock.groupRevokeInvite(jid);
  }

  async setWhatsAppGroupSetting(_userId: string, _to: string, _setting: string, _value: string): Promise<any> {
    return { ok: true };
  }

  async updateWhatsAppAvatar(userId: string, url: string): Promise<any> {
    // Try Cloud API first
    const config = this.readAdminConfig(userId);
    if (config.provider === 'cloud_api' && config.accessToken && config.phoneNumberId) {
      return await this.updateCloudBusinessAvatar(userId, url);
    }
    // Fall back to Baileys socket
    const sock = this.getClient(userId);
    if (!sock) return null;
    const res = await fetch(url).catch(() => null);
    if (!res) throw new Error('Failed to fetch image');
    const img = Buffer.from(await res.arrayBuffer());
    return await sock.updateProfilePicture(sock.user?.id || '', img);
  }

  async updateWhatsAppPushName(userId: string, name: string): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) return null;
    return await sock.updateProfileName(name).catch(() => null);
  }

  async setWhatsAppPresence(userId: string, presence: 'available' | 'unavailable'): Promise<any> {
    const sock = this.getClient(userId);
    if (!sock) return null;
    return await sock.sendPresenceUpdate(presence === 'available' ? 'available' : 'unavailable');
  }

  async getWhatsAppStatus(_userId: string, _jid?: string): Promise<any> {
    return null;
  }

  getMessageById(userId: string, chatId: string, messageId: string): any {
    const entry = this.sessions.get(userId);
    if (!entry) return null;
    return entry.messageById.get(`${chatId}:${messageId}`);
  }

  getClient(userId: string): any {
    const entry = this.sessions.get(userId);
    if (!entry || entry.status !== 'paired' || !entry.sock) return null;
    return entry.sock;
  }

  isPaired(userId: string): boolean {
    return this.sessions.get(userId)?.status === 'paired';
  }

  async shutdown(): Promise<void> {
    for (const entry of this.sessions.values()) {
      this.clearSaveTimer(entry);
      this.clearReconnectTimer(entry);
      try {
        writeSessionData(entry);
        entry.sock?.end?.(undefined);
      } catch {}
    }
    this.sessions.clear();
  }

  private clearSaveTimer(entry: WaSession) {
    if (entry.saveTimer) {
      clearInterval(entry.saveTimer);
      entry.saveTimer = null;
    }
  }

  private clearReconnectTimer(entry: WaSession) {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }

  private adminConfigFile(userId: string): string {
    const authDir = path.join(this.authRoot, safeUserId(userId));
    ensureDir(authDir);
    return path.join(authDir, 'admin-config.json');
  }

  private readAdminConfig(userId: string): WaAdminConfig {
    const file = this.adminConfigFile(userId);
    const fallback: WaAdminConfig = {
      provider: (process.env.WHATSAPP_ACCESS_TOKEN ? 'cloud_api' : 'linked_device') as WaProvider,
      displayName: 'Eburon AI',
      businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      appId: process.env.WHATSAPP_APP_ID || '',
      apiVersion: 'v23.0',
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
      appSecret: '',
      webhookVerifyToken: '',
      defaultCountryCode: '32',
      permissions: defaultPermissions(),
      restrictedContacts: [],
      restrictedChats: [],
      updatedAt: '',
    };

    try {
      if (!fs.existsSync(file)) return fallback;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        ...fallback,
        ...parsed,
        provider: parsed.provider === 'cloud_api' ? 'cloud_api' : 'linked_device',
        permissions: normalizePermissions(parsed.permissions),
        restrictedContacts: Array.isArray(parsed.restrictedContacts) ? parsed.restrictedContacts : [],
        restrictedChats: Array.isArray(parsed.restrictedChats) ? parsed.restrictedChats : [],
      };
    } catch {
      return fallback;
    }
  }

  private writeAdminConfig(userId: string, config: WaAdminConfig) {
    fs.writeFileSync(this.adminConfigFile(userId), JSON.stringify(config, null, 2));
  }
}

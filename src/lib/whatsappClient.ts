const BACKEND_URL_KEY = 'beatrice_backend_url';

export function getBackendUrl(): string {
  const envUrl = (typeof import.meta !== 'undefined' && ((import.meta as any).env?.VITE_BACKEND_URL || (import.meta as any).env?.VITE_SANDBOX_URL)) || '';
  
  // Prioritize environment variable for production/deployment consistency
  if (envUrl) return envUrl.replace(/\/+$/, '');

  try {
    const stored = localStorage.getItem(BACKEND_URL_KEY);
    if (stored) {
      const isStoredLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].some(h => stored.includes(h));
      const isCurrentLocalhost = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
      const isCurrentHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
      const isStoredHttp = stored.startsWith('http://');

      if (isCurrentHttps && isStoredHttp && !isStoredLocalhost) {
        // Skip stored HTTP URL to avoid Mixed Content errors in HTTPS environment
      } else if (!isStoredLocalhost || isCurrentLocalhost) {
        return stored.replace(/\/+$/, '');
      }
    }
  } catch {}

  if (typeof window !== 'undefined') {
    const isLocal = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname) || window.location.port === '3000' || window.location.hostname.startsWith('192.168.');
    return isLocal ? `http://${window.location.hostname}:4200` : 'https://whatsapp.eburon.ai';
  }

  return 'https://whatsapp.eburon.ai';
}

export function setBackendUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '');
  try {
    if (cleaned) localStorage.setItem(BACKEND_URL_KEY, cleaned);
    else localStorage.removeItem(BACKEND_URL_KEY);
  } catch {}
  return cleaned || getBackendUrl();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getBackendUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data as T;
}

export async function startWhatsAppPairing(userId: string, phoneNumber?: string): Promise<{ pairingCode: string; status?: string }> {
  return requestJson('/api/whatsapp/pair', {
    method: 'POST',
    body: JSON.stringify({ userId, phoneNumber }),
  });
}

export async function getWhatsAppStatus(userId: string): Promise<{
  status: string;
  qrCode?: string;
  phone?: string;
  error?: string;
  pairingCode?: string;
}> {
  const res = await fetch(`${getBackendUrl()}/api/whatsapp/status/${encodeURIComponent(userId)}`);
  if (!res.ok) return { status: 'error', error: `Server returned ${res.status}` };
  return res.json();
}

export async function disconnectWhatsApp(userId: string): Promise<void> {
  await requestJson('/api/whatsapp/disconnect', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export async function sendWhatsAppMessage(
  userId: string,
  to: string,
  text: string,
  permissions?: Record<string, boolean | string>,
): Promise<any> {
  return requestJson('/api/whatsapp/send', {
    method: 'POST',
    body: JSON.stringify({ userId, to, text, permissions }),
  });
}

export async function callWhatsAppTool(
  userId: string,
  tool: string,
  params: Record<string, any>,
  permissions?: Record<string, boolean | string>,
): Promise<any> {
  return requestJson('/api/whatsapp/tool', {
    method: 'POST',
    body: JSON.stringify({ userId, tool, params, permissions }),
  });
}

export async function getWhatsAppMessages(userId: string, limit = 20): Promise<{ messages: any[] }> {
  const res = await fetch(`${getBackendUrl()}/api/whatsapp/messages/${encodeURIComponent(userId)}?limit=${limit}`);
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function getWhatsAppAdminOverview(userId: string): Promise<any> {
  return requestJson(`/api/whatsapp/admin/overview/${encodeURIComponent(userId)}`);
}

export async function saveWhatsAppAdminConfig(userId: string, config: Record<string, any>): Promise<any> {
  return requestJson('/api/whatsapp/admin/config', {
    method: 'POST',
    body: JSON.stringify({ userId, config }),
  });
}

export async function sendWhatsAppTestMessage(userId: string, to: string, text: string): Promise<any> {
  return requestJson('/api/whatsapp/admin/test-message', {
    method: 'POST',
    body: JSON.stringify({ userId, to, text }),
  });
}

// ── Typed read helpers for the WhatsApp chat-list UI ──
// These mirror the backend WaChatSummary / WaRecentMessage shapes in server/whatsapp.ts.

export interface WaChatSummary {
  id: string;            // chat JID (e.g. 32470...@s.whatsapp.net or ...@g.us)
  name: string;          // contact saved name / group subject / fallback JID
  unreadCount: number;
  lastMessage: string;
  timestamp: number;     // ms epoch
  isGroup: boolean;
}

export interface WaMessageRecord {
  id: string;
  chatId: string;
  from: string;          // sender JID/participant
  body: string;
  timestamp: number;     // ms epoch
  fromMe: boolean;       // true = owner (current user) sent it
  isGroup: boolean;
  isMedia: boolean;
}

/**
 * Fetch the WhatsApp chat list (gated server-side by the `read_chats` permission and pairing).
 * Returns `{ ok:false, error }` when the permission is off or WhatsApp is not paired.
 */
export async function fetchWhatsAppChats(
  userId: string,
  permissions: Record<string, boolean | string>,
  limit = 30,
): Promise<{ ok: boolean; chats: WaChatSummary[]; error?: string }> {
  const res = await callWhatsAppTool(userId, 'readChats', { limit }, permissions);
  if (res?.ok) return { ok: true, chats: Array.isArray(res.chats) ? res.chats : [] };
  return { ok: false, chats: [], error: res?.error || 'Failed to load chats' };
}

/**
 * Fetch the message history for a single chat JID (gated server-side by `view_message_history`).
 */
export async function fetchWhatsAppHistory(
  userId: string,
  chatId: string,
  permissions: Record<string, boolean | string>,
  limit = 50,
): Promise<{ ok: boolean; messages: WaMessageRecord[]; error?: string }> {
  const res = await callWhatsAppTool(userId, 'getMessageHistory', { chatId, limit }, permissions);
  if (res?.ok) return { ok: true, messages: Array.isArray(res.messages) ? res.messages : [] };
  return { ok: false, messages: [], error: res?.error || 'Failed to load conversation' };
}

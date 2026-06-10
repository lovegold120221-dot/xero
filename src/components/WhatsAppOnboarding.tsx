import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  ArrowLeft, Check, CheckCheck, Laptop, Loader2, Phone, QrCode, ShieldCheck,
  Smartphone, X,
} from 'lucide-react';
import {
  callWhatsAppTool,
  getWhatsAppAdminOverview,
  getWhatsAppStatus,
  saveWhatsAppAdminConfig,
  startWhatsAppPairing,
} from '../lib/whatsappClient';

type PermissionKey =
  | 'send_messages' | 'read_chats' | 'access_contacts' | 'manage_contacts'
  | 'access_groups' | 'send_group_messages' | 'read_group_chats' | 'view_message_history'
  | 'access_images' | 'access_videos' | 'access_audio' | 'access_documents'
  | 'access_stickers' | 'access_contact_cards' | 'access_location' | 'access_links' | 'access_polls';

interface WhatsAppOnboardingProps {
  user: User;
  onComplete: () => void;
  onSkip: () => void;
}

const allPermissions: { key: PermissionKey; label: string }[] = [
  { key: 'send_messages', label: 'Send messages' },
  { key: 'read_chats', label: 'Read chats' },
  { key: 'access_contacts', label: 'Access contacts' },
  { key: 'manage_contacts', label: 'Manage contacts' },
  { key: 'access_groups', label: 'Access groups' },
  { key: 'send_group_messages', label: 'Send group messages' },
  { key: 'read_group_chats', label: 'Read group chats' },
  { key: 'view_message_history', label: 'View message history' },
  { key: 'access_images', label: 'Images' },
  { key: 'access_videos', label: 'Videos' },
  { key: 'access_audio', label: 'Audio & Voice notes' },
  { key: 'access_documents', label: 'Documents & files' },
  { key: 'access_stickers', label: 'Stickers & GIFs' },
  { key: 'access_contact_cards', label: 'Contact cards' },
  { key: 'access_location', label: 'Location messages' },
  { key: 'access_links', label: 'Links & previews' },
  { key: 'access_polls', label: 'Polls' },
];

const defaultPermissions = allPermissions.reduce((acc, p) => {
  acc[p.key] = true;
  return acc;
}, {} as Record<PermissionKey, boolean>);

export function WhatsAppOnboarding({ user, onComplete, onSkip }: WhatsAppOnboardingProps) {
  const [step, setStep] = useState<'pair' | 'permissions' | 'location'>('pair');
  const [pairMethod, setPairMethod] = useState<'qr' | 'phone'>('qr');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [waStatus, setWaStatus] = useState('not_found');
  const [waPhone, setWaPhone] = useState('');
  const [permissions, setPermissions] = useState<Record<PermissionKey, boolean>>(defaultPermissions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState(true);

  // Check current status on mount
  useEffect(() => {
    (async () => {
      try {
        let status = 'not_found';
        let phone = '';
        let qrCode = '';
        let config: any = {};
        try {
          const overview = await getWhatsAppAdminOverview(user.uid);
          status = overview?.status?.status || 'not_found';
          phone = overview?.status?.phone || '';
          qrCode = overview?.status?.qrCode || '';
          config = overview.config || {};
        } catch {
          const s = await getWhatsAppStatus(user.uid);
          status = s?.status || 'not_found';
          phone = s?.phone || '';
          qrCode = s?.qrCode || '';
        }
        setWaStatus(status);
        setWaPhone(phone);
        setQrCode(qrCode);

        if (status === 'paired' || status === 'connected') {
          const savedPerms = config.permissions;
          if (savedPerms && Object.keys(savedPerms).length > 0) {
            setPermissions({ ...defaultPermissions, ...savedPerms });
          }
          setStep('permissions');
        }
      } catch {}
      setChecking(false);
    })();
  }, [user.uid]);

  const handleStartPair = async () => {
    setPairing(true);
    setError('');
    setNotice('');
    setPairingCode('');
    setQrCode('');
    try {
      await startWhatsAppPairing(user.uid, pairMethod === 'phone' ? phoneNumber : undefined);
      setNotice(pairMethod === 'qr' ? 'QR code generated. Scan with WhatsApp.' : 'Pairing code requested.');
      const started = Date.now();
      const timer = setInterval(async () => {
        try {
          let status = 'not_found';
          // Try admin overview first, fall back to simple status
          try {
            const overview = await getWhatsAppAdminOverview(user.uid);
            status = overview?.status?.status || 'not_found';
            setWaPhone(overview?.status?.phone || '');
            setQrCode(overview?.status?.qrCode || '');
            setPairingCode(overview?.status?.pairingCode || '');
          } catch {
            // Fallback to simple status check
            const s = await getWhatsAppStatus(user.uid);
            status = s?.status || 'not_found';
            setWaPhone(s?.phone || '');
            setQrCode(s?.qrCode || '');
          }
          setWaStatus(status);
          if (Date.now() - started > 120_000 || status === 'paired') {
            clearInterval(timer);
            setPairing(false);
            if (status === 'paired') setStep('permissions');
          }
        } catch {}
      }, 1800);
    } catch (err: any) {
      setError(err.message || 'Pairing failed');
      setPairing(false);
    }
  };

  const handleSavePermissions = async () => {
    setSaving(true);
    setError('');
    try {
      const backendUrl = (await import('../lib/whatsappClient')).getBackendUrl();
      const res = await fetch(`${backendUrl}/api/whatsapp/admin/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid, config: { permissions } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      // Trigger full WhatsApp history sync in background
      callWhatsAppTool(user.uid, 'syncFullHistory', {}, permissions).catch(() => {});

      setStep('location');
    } catch (err: any) {
      setError(err.message || 'Failed to save permissions');
    } finally {
      setSaving(false);
    }
  };

  const handleLocation = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        () => onComplete(),
        () => onComplete(),
        { timeout: 5000 },
      );
    } else {
      onComplete();
    }
  };

  if (checking) {
    return (
      <div className="min-h-[100dvh] bg-[#111b21] text-[#e9edef] flex items-center justify-center p-4">
        <Loader2 className="w-8 h-8 animate-spin text-[#00a884]" />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-[#111b21] text-[#e9edef] flex flex-col overflow-x-hidden">
      {/* Header */}
      <div className="h-[52px] sm:h-[60px] bg-[#202c33] px-3 sm:px-4 flex items-center gap-2 sm:gap-3 flex-shrink-0">
        <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-[#00a884] flex items-center justify-center shrink-0">
          <Smartphone className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-black" />
        </div>
        <h1 className="text-base sm:text-lg font-semibold truncate">WhatsApp Setup</h1>
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-center gap-1 sm:gap-2 px-2 sm:px-4 py-3 sm:py-4 bg-[#0b141a] overflow-x-auto">
        {['pair', 'permissions', 'location'].map((s, i) => (
          <div key={s} className="flex items-center gap-1 sm:gap-2 shrink-0">
            <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-[10px] sm:text-xs font-bold ${
              step === s ? 'bg-[#00a884] text-black' :
              ['pair', 'permissions', 'location'].indexOf(step) > i ? 'bg-[#00a884]/30 text-[#00a884]' :
              'bg-[#202c33] text-[#8696a0]'
            }`}>
              {['pair', 'permissions', 'location'].indexOf(step) > i ? <Check className="w-3 h-3 sm:w-4 sm:h-4" /> : i + 1}
            </div>
            <span className={`text-[10px] sm:text-xs whitespace-nowrap ${step === s ? 'text-[#e9edef] font-medium' : 'text-[#8696a0]'}`}>
              {s === 'pair' ? 'Link' : s === 'permissions' ? 'Permissions' : 'Location'}
            </span>
            {i < 2 && <div className="w-4 sm:w-8 h-px bg-[#222d34] shrink-0" />}
          </div>
        ))}
      </div>

      {/* Error / Notice */}
      {(error || notice) && (
        <div className={`mx-4 mt-2 flex items-start gap-2 rounded-lg px-4 py-3 text-sm ${
          error ? 'bg-red-500/10 border border-red-500/30 text-red-300' :
          'bg-[#00a884]/10 border border-[#00a884]/30 text-[#00a884]'
        }`}>
          {error ? <X className="w-4 h-4 mt-0.5 shrink-0 cursor-pointer" onClick={() => setError('')} /> : <Check className="w-4 h-4 mt-0.5 shrink-0" />}
          <span>{error || notice}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* ── STEP 1: PAIR ── */}
        {step === 'pair' && (
          <div className="w-full px-4 sm:px-6 py-4 sm:py-6 max-w-lg mx-auto space-y-4 sm:space-y-6">
            <div className="text-center">
              <Smartphone className="w-12 h-12 sm:w-16 sm:h-16 text-[#00a884] mx-auto mb-3 sm:mb-4" />
              <h2 className="text-lg sm:text-xl font-semibold mb-1 sm:mb-2">Link Your WhatsApp</h2>
              <p className="text-xs sm:text-sm text-[#8696a0] px-2">Connect your WhatsApp to use it from this web app</p>
            </div>

            {/* Method toggle */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <button onClick={() => setPairMethod('qr')}
                className={`flex flex-col items-center gap-2 sm:gap-3 rounded-xl border p-4 sm:p-6 transition ${
                  pairMethod === 'qr' ? 'border-[#00a884] bg-[#00a884]/10' : 'border-[#222d34] bg-[#202c33] hover:bg-[#2a3942]'
                }`}>
                <QrCode className={`w-8 h-8 sm:w-10 sm:h-10 ${pairMethod === 'qr' ? 'text-[#00a884]' : 'text-[#8696a0]'}`} />
                <span className={`font-medium text-xs sm:text-sm ${pairMethod === 'qr' ? 'text-[#00a884]' : ''}`}>Scan QR Code</span>
                <span className="text-[10px] sm:text-xs text-[#8696a0] text-center hidden sm:block">Use your phone to scan</span>
              </button>
              <button onClick={() => setPairMethod('phone')}
                className={`flex flex-col items-center gap-2 sm:gap-3 rounded-xl border p-4 sm:p-6 transition ${
                  pairMethod === 'phone' ? 'border-[#00a884] bg-[#00a884]/10' : 'border-[#222d34] bg-[#202c33] hover:bg-[#2a3942]'
                }`}>
                <Phone className={`w-8 h-8 sm:w-10 sm:h-10 ${pairMethod === 'phone' ? 'text-[#00a884]' : 'text-[#8696a0]'}`} />
                <span className={`font-medium text-xs sm:text-sm ${pairMethod === 'phone' ? 'text-[#00a884]' : ''}`}>Link with Phone</span>
                <span className="text-[10px] sm:text-xs text-[#8696a0] text-center hidden sm:block">Enter your phone number</span>
              </button>
            </div>

            {/* Pair form */}
            {pairMethod === 'phone' && (
              <div className="space-y-3">
                <label className="text-xs sm:text-sm text-[#8696a0]">Phone number with country code</label>
                <input type="tel" placeholder="e.g. 32470123456"
                  value={phoneNumber} onChange={e => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                  className="w-full bg-[#202c33] border border-[#222d34] rounded-lg px-3 sm:px-4 py-2.5 sm:py-3 text-sm outline-none focus:border-[#00a884] text-[#e9edef] placeholder-[#8696a0]" />
              </div>
            )}

            {/* QR Code display */}
            {pairMethod === 'qr' && qrCode && (
              <div className="flex flex-col items-center gap-3 bg-[#202c33] rounded-xl p-4 sm:p-6">
                <img src={qrCode} alt="QR" className="w-40 h-40 sm:w-48 sm:h-48 rounded-lg bg-white p-2 max-w-full" />
                <p className="text-[10px] sm:text-xs text-[#8696a0] text-center">Open WhatsApp {'>'} Linked Devices {'>'} Link a Device</p>
              </div>
            )}

            {/* Pairing code display */}
            {pairingCode && (
              <div className="bg-[#202c33] rounded-xl p-4 sm:p-6 text-center overflow-x-auto">
                <p className="text-xs sm:text-sm text-[#8696a0] mb-2">Your pairing code:</p>
                <p className="text-xl sm:text-2xl font-mono font-bold tracking-widest text-[#00a884] break-all">{pairingCode}</p>
                <p className="text-[10px] sm:text-xs text-[#8696a0] mt-2">Enter this code in WhatsApp {'>'} Linked Devices</p>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-3">
              <button onClick={() => { setPairing(true); handleStartPair(); }}
                disabled={pairing || (pairMethod === 'phone' && phoneNumber.length < 5)}
                className="flex-1 bg-[#00a884] text-black font-semibold rounded-lg py-2.5 sm:py-3 hover:bg-[#06cf9c] disabled:opacity-50 text-xs sm:text-sm">
                {pairing ? (
                  <span className="flex items-center justify-center gap-2"><Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" /> Pairing...</span>
                ) : 'Link This Device'}
              </button>
            </div>

            {/* Already paired status */}
            {waStatus === 'paired' && (
              <div className="bg-[#00a884]/10 border border-[#00a884]/30 rounded-lg p-3 sm:p-4 text-xs sm:text-sm text-center">
                Already connected{waPhone ? ` (${waPhone})` : ''}. Tap Continue.
              </div>
            )}

            <button onClick={() => {
              if (waStatus === 'paired') setStep('permissions');
              else onSkip();
            }} className="w-full text-xs sm:text-sm text-[#8696a0] hover:text-[#e9edef] py-2">
              Skip for now
            </button>
          </div>
        )}

        {/* ── STEP 2: PERMISSIONS ── */}
        {step === 'permissions' && (
          <div className="w-full px-4 sm:px-6 py-4 sm:py-6 max-w-lg mx-auto space-y-4 sm:space-y-6">
            <div className="text-center">
              <ShieldCheck className="w-12 h-12 sm:w-16 sm:h-16 text-[#00a884] mx-auto mb-3 sm:mb-4" />
              <h2 className="text-lg sm:text-xl font-semibold mb-1 sm:mb-2">WhatsApp Permissions</h2>
              <p className="text-xs sm:text-sm text-[#8696a0]">Choose what Beatrice can do with your WhatsApp</p>
            </div>

            <div className="space-y-2">
              {allPermissions.map(p => (
                <button key={p.key} onClick={() => setPermissions(prev => ({ ...prev, [p.key]: !prev[p.key] }))}
                  className={`w-full flex items-center justify-between rounded-xl border px-3 sm:px-4 py-2.5 sm:py-3 transition text-left ${
                    permissions[p.key] ? 'border-[#00a884]/50 bg-[#00a884]/10' : 'border-[#222d34] bg-[#202c33] hover:bg-[#2a3942]'
                  }`}>
                  <span className="text-xs sm:text-sm">{p.label}</span>
                  <div className={`w-9 h-4.5 sm:w-10 sm:h-5 rounded-full p-0.5 transition shrink-0 ${permissions[p.key] ? 'bg-[#00a884]' : 'bg-[#374045]'}`}>
                    <div className={`w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-white transition ${permissions[p.key] ? 'translate-x-[18px] sm:translate-x-5' : ''}`} />
                  </div>
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button onClick={handleSavePermissions} disabled={saving}
                className="flex-1 bg-[#00a884] text-black font-semibold rounded-lg py-2.5 sm:py-3 hover:bg-[#06cf9c] disabled:opacity-50 text-xs sm:text-sm">
                {saving ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-3.5 h-3.5 sm:w-4 sm:h-4 animate-spin" /> Saving...</span> : 'Save Settings'}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: LOCATION ── */}
        {step === 'location' && (
          <div className="w-full px-4 sm:px-6 py-4 sm:py-6 max-w-lg mx-auto space-y-4 sm:space-y-6">
            <div className="text-center">
              <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-[#00a884]/20 flex items-center justify-center mx-auto mb-3 sm:mb-4">
                <svg className="w-6 h-6 sm:w-8 sm:h-8 text-[#00a884]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <h2 className="text-lg sm:text-xl font-semibold mb-1 sm:mb-2">Location Access</h2>
              <p className="text-xs sm:text-sm text-[#8696a0] mb-4 sm:mb-6">Beatrice uses your location to provide local information</p>
            </div>
            <button onClick={handleLocation}
              className="w-full bg-[#00a884] text-black font-semibold rounded-lg py-2.5 sm:py-3 hover:bg-[#06cf9c] text-xs sm:text-sm">
              Allow Location Access
            </button>
            <button onClick={onComplete}
              className="w-full text-xs sm:text-sm text-[#8696a0] hover:text-[#e9edef] py-2">
              Skip, I'll do it later
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

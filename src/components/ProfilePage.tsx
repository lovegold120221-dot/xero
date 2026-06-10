import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Power, Check, Settings, X, Save, Activity, Video, MessageSquare, Globe, User, Mail, FileText, AlertCircle, LogOut, Upload, Trash2, Folder, Download, ExternalLink, Image, Eye, Copy } from 'lucide-react';
import { auth } from '../firebase';
import { signOut } from 'firebase/auth';
import { supabase } from '../lib/supabase';
import {
  uploadAvatar,
  uploadKnowledgeFile,
  listKnowledgeFiles,
  deleteKnowledgeFile,
  updateKnowledgeDomains,
} from '../lib/supabaseStorage';
import { listOutputs, deleteOutput, type WorkspaceOutput } from '../lib/workspace';
import { LANGUAGES } from '../constants';

const VOICE_ALIASES = [
  { id: 'Aoede', name: 'Wonder Woman' },
  { id: 'Charon', name: 'Batman' },
  { id: 'Fenrir', name: 'Wolverine' },
  { id: 'Kore', name: 'Supergirl' },
  { id: 'Puck', name: 'Spider-Man' },
];

interface ProfilePageProps {
  onClose: () => void;
  personaName: string;
  setPersonaName: (v: string) => void;
  customPrompt: string;
  setCustomPrompt: (v: string) => void;
  userTitle: string;
  setUserTitle: (v: string) => void;
  contextSize: number;
  setContextSize: (v: number) => void;
  authLanguage: string;
  onSetLanguage: (v: string) => void;
  selectedVoice: string;
  setSelectedVoice: (v: string) => void;
  saveSettings: (callbacks?: { onSuccess?: () => void; onError?: (msg: string) => void }) => Promise<void>;
  isSaving: boolean;
  censorshipEnabled: boolean;
  setCensorshipEnabled: (v: boolean) => void;
}

const LS_KEY = 'beatrice_knowledge_domains';

function loadLocalDomains(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalDomains(domains: string[]) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(domains));
  } catch {}
}

export function ProfilePage({ 
  onClose,
  personaName,
  setPersonaName,
  customPrompt,
  setCustomPrompt,
  userTitle,
  setUserTitle,
  contextSize,
  setContextSize,
  authLanguage,
  onSetLanguage,
  selectedVoice,
  setSelectedVoice,
  saveSettings,
  censorshipEnabled,
  setCensorshipEnabled,
  isSaving
}: ProfilePageProps) {
  const user = auth.currentUser!;
  const isGoogleConnected = user.providerData.some(p => p.providerId === 'google.com');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const knowledgeInputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user.photoURL);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [knowledgeFiles, setKnowledgeFiles] = useState<Array<{
    id: string; name: string; type: string; size: number; uploadedAt: string; url: string;
  }>>([]);
  const [domains, setDomains] = useState<string[]>(loadLocalDomains);
  const [domainInput, setDomainInput] = useState('');
  const [uploadingFile, setUploadingFile] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [savingDomains, setSavingDomains] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [workspaceOutputs, setWorkspaceOutputs] = useState<WorkspaceOutput[]>([]);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<WorkspaceOutput | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  useEffect(() => {
    loadProfile();
    loadWorkspace();
  }, []);

  const loadWorkspace = async () => {
    setLoadingWorkspace(true);
    try {
      const outputs = await listOutputs(user.uid);
      setWorkspaceOutputs(outputs);
    } catch (e) {
      console.error('Failed to load workspace:', e);
    } finally {
      setLoadingWorkspace(false);
    }
  };

  const handleWorkspaceDelete = async (id: string) => {
    setDeletingWorkspaceId(id);
    try {
      await deleteOutput(id);
      setWorkspaceOutputs(prev => prev.filter(w => w.id !== id));
    } catch (e: any) {
      setError(e.message || 'Failed to delete');
    } finally {
      setDeletingWorkspaceId(null);
    }
  };

  const loadProfile = async () => {
    try {
      const { data: settings } = await supabase
        .from('user_settings')
        .select('avatar_url, knowledge_domains')
        .eq('user_id', user.uid)
        .single();
      if (settings) {
        if (settings.avatar_url) setAvatarUrl(settings.avatar_url);
        if (settings.knowledge_domains) {
          setDomains(settings.knowledge_domains);
          saveLocalDomains(settings.knowledge_domains);
        }
      }
      const files = await listKnowledgeFiles(user.uid);
      setKnowledgeFiles(files);
    } catch (e) {
      console.error('Failed to load profile:', e);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Only image files are allowed for avatar');
      return;
    }
    setUploadingAvatar(true);
    setError(null);
    try {
      const url = await uploadAvatar(user.uid, file);
      setAvatarUrl(url);
      setSuccess('Avatar updated');
      setTimeout(() => setSuccess(null), 2000);
    } catch (e: any) {
      setError(e.message || 'Failed to upload avatar');
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleKnowledgeUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingFile(true);
    setError(null);
    try {
      const result = await uploadKnowledgeFile(user.uid, file);
      setKnowledgeFiles(prev => [{
        id: result.id,
        name: result.name,
        type: result.type,
        size: result.size,
        uploadedAt: new Date().toISOString(),
        url: '',
      }, ...prev]);
      setSuccess('File uploaded to knowledge base');
      setTimeout(() => setSuccess(null), 2000);
    } catch (e: any) {
      setError(e.message || 'Failed to upload file');
    } finally {
      setUploadingFile(false);
      if (knowledgeInputRef.current) knowledgeInputRef.current.value = '';
    }
  };

  const handleDeleteFile = async (fileId: string) => {
    setDeletingFile(fileId);
    setError(null);
    try {
      await deleteKnowledgeFile(user.uid, fileId);
      setKnowledgeFiles(prev => prev.filter(f => f.id !== fileId));
    } catch (e: any) {
      setError(e.message || 'Failed to delete file');
    } finally {
      setDeletingFile(null);
    }
  };

  const addDomain = () => {
    const d = domainInput.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (!d) return;
    if (domains.includes(d)) { setDomainInput(''); return; }
    setDomains(prev => [...prev, d]);
    setDomainInput('');
  };

  const removeDomain = (d: string) => {
    setDomains(prev => prev.filter(x => x !== d));
  };

  const saveDomains = async () => {
    setSavingDomains(true);
    setError(null);
    try {
      await updateKnowledgeDomains(user.uid, domains);
      saveLocalDomains(domains);
      setSuccess('Domains saved');
      setTimeout(() => setSuccess(null), 2000);
    } catch (e: any) {
      saveLocalDomains(domains);
      setSuccess('Domains saved locally (Supabase sync pending — run migration in Supabase SQL Editor)');
      setTimeout(() => setSuccess(null), 4000);
    } finally {
      setSavingDomains(false);
    }
  };



  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)] flex flex-col h-[100dvh]">
      <header className="sticky top-0 w-full bg-[var(--bg-glass)] backdrop-blur-2xl border-b border-[var(--border)] px-4 py-3 flex items-center justify-between z-10 shrink-0">
        <div className="w-16" />
        <h1 className="text-base font-semibold tracking-wide text-[var(--text-primary)]">Profile</h1>
        <button
          onClick={onClose}
          className="w-16 text-right text-sm font-semibold text-[var(--accent)] hover:text-[var(--text-primary)] transition-colors"
          aria-label="Done"
        >
          Done
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 pb-20 w-full max-w-lg mx-auto space-y-8">
        
        {/* Success/Error toasts */}
        <AnimatePresence>
          {(error || success) && (
            <motion.div
              initial={{ opacity: 0, y: -10, height: 0 }}
              animate={{ opacity: 1, y: 0, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className={`px-4 py-3 rounded-2xl flex items-center gap-2 text-sm backdrop-blur-2xl ${
                error ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
              }`}>
                {error ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
                <span>{error || success}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Account Section */}
        <section>
          <h2 className="text-[13px] uppercase tracking-wide text-zinc-500 font-medium px-4 mb-2">Account</h2>
          <div className="bg-[#1C1C1E] rounded-[20px] overflow-hidden">
            <div className="p-4 flex items-center gap-4">
              <div className="relative group shrink-0">
                <div className="w-[72px] h-[72px] rounded-full bg-zinc-800 overflow-hidden border border-white/10">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-500">
                      <User className="w-8 h-8" />
                    </div>
                  )}
                </div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center transition-opacity"
                >
                  {uploadingAvatar ? (
                    <Loader2 className="w-5 h-5 animate-spin text-white" />
                  ) : (
                    <Upload className="w-5 h-5 text-white/80 drop-shadow-md" />
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarUpload}
                  className="hidden"
                  title="Upload Profile Photo"
                  aria-label="Upload Profile Photo"
                />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[17px] text-white font-medium truncate">{user.displayName || 'User'}</p>
                <p className="text-[15px] text-zinc-400 truncate mt-0.5">{user.email}</p>
                <div className="flex items-center gap-1.5 mt-2">
                  <div className={`w-2 h-2 rounded-full ${isGoogleConnected ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]' : 'bg-zinc-600'}`} />
                  <span className={`text-[11px] uppercase tracking-wider font-semibold ${isGoogleConnected ? 'text-emerald-500' : 'text-zinc-500'}`}>
                    {isGoogleConnected ? 'Google Connected' : 'Google Disconnected'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Knowledge Base Section */}
        <section>
          <div className="px-4 mb-2 flex items-baseline justify-between">
            <h2 className="text-[13px] uppercase tracking-wide text-zinc-500 font-medium">Knowledge Base</h2>
          </div>
          <div className="bg-[#1C1C1E] rounded-[20px] overflow-hidden">
            <div 
              onClick={() => !uploadingFile && knowledgeInputRef.current?.click()}
              className="p-4 border-b border-white/5 flex items-center justify-between cursor-pointer active:bg-white/5 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                  {uploadingFile ? <Loader2 className="w-4 h-4 text-[#d0a78b] animate-spin" /> : <Upload className="w-4 h-4 text-[#d0a78b]" />}
                </div>
                <div>
                  <p className="text-[15px] text-white">Upload File</p>
                  <p className="text-[13px] text-zinc-500">txt, pdf, doc, csv, md (Max 10MB)</p>
                </div>
              </div>
            </div>
            <input
              ref={knowledgeInputRef}
              type="file"
              accept=".txt,.csv,.pdf,.doc,.docx,.json,.md,text/plain,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleKnowledgeUpload}
              className="hidden"
              title="Upload Knowledge Base File"
              aria-label="Upload Knowledge Base File"
            />
            
            {knowledgeFiles.map((f, i) => (
              <div key={f.id} className={`p-4 flex items-center justify-between ${i !== knowledgeFiles.length - 1 ? 'border-b border-white/5' : ''}`}>
                <div className="flex items-center gap-3 min-w-0 flex-1 pr-4">
                  <FileText className="w-5 h-5 text-zinc-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[15px] text-white truncate">{f.name}</p>
                    <p className="text-[13px] text-zinc-500">{formatSize(f.size)}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteFile(f.id)}
                  disabled={deletingFile === f.id}
                  className="p-2 rounded-full active:bg-white/5 text-zinc-500 hover:text-red-400 transition-colors"
                >
                  {deletingFile === f.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
            ))}
            {knowledgeFiles.length === 0 && (
              <div className="p-4">
                <p className="text-[15px] text-zinc-500 text-center">No files uploaded yet.</p>
              </div>
            )}
          </div>
        </section>

        {/* Domains Section */}
        <section>
          <div className="px-4 mb-2 flex items-baseline justify-between">
            <h2 className="text-[13px] uppercase tracking-wide text-zinc-500 font-medium">URL Domains</h2>
          </div>
          <div className="bg-[#1C1C1E] rounded-[20px] overflow-hidden">
            <div className="p-4 border-b border-white/5 flex gap-2 items-center">
              <input
                type="text"
                value={domainInput}
                onChange={e => setDomainInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } }}
                placeholder="Add website URL (e.g. docs.stripe.com)"
                className="flex-1 bg-transparent text-[15px] text-white focus:outline-none placeholder-zinc-500"
              />
              <button
                onClick={addDomain}
                disabled={!domainInput.trim()}
                className="px-3 py-1 bg-white/10 rounded-full text-[13px] font-semibold text-white disabled:opacity-30 active:bg-white/20"
              >
                Add
              </button>
            </div>
            
            {domains.map((d, i) => (
              <div key={d} className={`p-4 flex items-center justify-between ${i !== domains.length - 1 ? 'border-b border-white/5' : ''}`}>
                <div className="flex items-center gap-3 truncate">
                  <Globe className="w-5 h-5 text-zinc-400 shrink-0" />
                  <p className="text-[15px] text-white truncate">{d}</p>
                </div>
                <button
                  onClick={() => removeDomain(d)}
                  aria-label={`Remove domain ${d}`}
                  title={`Remove domain ${d}`}
                  className="p-1 active:bg-white/5 text-zinc-500 hover:text-red-400 transition-colors rounded-full shrink-0 ml-2"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            {domains.length === 0 && (
              <div className="p-4">
                <p className="text-[15px] text-zinc-500 text-center">No domains added yet.</p>
              </div>
            )}
          </div>
          
          <button
            onClick={saveDomains}
            disabled={savingDomains}
            className="w-full mt-3 p-4 bg-white/[0.03] backdrop-blur-2xl border border-white/[0.06] rounded-[20px] text-center active:bg-white/[0.06] transition-all flex items-center justify-center gap-2"
          >
            {savingDomains ? <Loader2 className="w-5 h-5 animate-spin text-[#d0a78b]" /> : <Check className="w-5 h-5 text-[#d0a78b]" />}
            <span className="text-[15px] font-['SF_Pro_Text',system-ui,sans-serif] font-semibold text-[#d0a78b]">Save Domains to Cloud</span>
          </button>
        </section>

        {/* Workspace Section */}
        <section>
          <div className="px-4 mb-2 flex items-baseline justify-between">
            <h2 className="text-[13px] uppercase tracking-wide text-zinc-500 font-medium">Workspace</h2>
            <span className="text-[11px] text-zinc-600">auto-saved locally · synced to Drive</span>
          </div>
          <div className="bg-[#1C1C1E] rounded-[20px] overflow-hidden">
            {loadingWorkspace ? (
              <div className="p-8 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
              </div>
            ) : workspaceOutputs.length === 0 ? (
              <div className="p-6 text-center">
                <Folder className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                <p className="text-[15px] text-zinc-500">No outputs yet.</p>
                <p className="text-[13px] text-zinc-600 mt-1">Documents, images, and captures from Beatrice will appear here.</p>
              </div>
            ) : (
              workspaceOutputs.map((w, i) => (
                <div key={w.id} className={`p-4 flex items-center justify-between ${i !== workspaceOutputs.length - 1 ? 'border-b border-white/5' : ''}`}>
                  <div className="flex items-center gap-3 min-w-0 flex-1 pr-4">
                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center shrink-0">
                      {w.type === 'image' || w.type === 'screenshot' || w.type === 'capture' ? (
                        <Image className="w-4 h-4 text-zinc-400" />
                      ) : (
                        <FileText className="w-4 h-4 text-zinc-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-[15px] text-white truncate">{w.title}</p>
                      <p className="text-[11px] text-zinc-500 flex items-center gap-2 mt-0.5">
                        <span className="capitalize">{w.type}</span>
                        <span>&middot;</span>
                        <span>{w.fileSize < 1024 ? `${w.fileSize} B` : w.fileSize < 1048576 ? `${(w.fileSize / 1024).toFixed(1)} KB` : `${(w.fileSize / 1048576).toFixed(1)} MB`}</span>
                        <span>&middot;</span>
                        <span>{new Date(w.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                      </p>
                      {w.driveLink && (
                        <a
                          href={w.driveLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-[#d0a78b] hover:underline inline-flex items-center gap-1 mt-0.5"
                          onClick={e => e.stopPropagation()}
                        >
                          <ExternalLink className="w-3 h-3" />
                          Drive
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {w.textContent && (
                      <button
                        onClick={() => setPreviewItem(w)}
                        className="p-2 rounded-full active:bg-white/5 text-zinc-500 hover:text-[#d0a78b] transition-colors"
                        aria-label="Preview"
                        title="Preview"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleWorkspaceDelete(w.id)}
                      disabled={deletingWorkspaceId === w.id}
                      className="p-2 rounded-full active:bg-white/5 text-zinc-500 hover:text-red-400 transition-colors"
                      aria-label="Delete"
                      title="Delete"
                    >
                      {deletingWorkspaceId === w.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          {workspaceOutputs.length > 0 && (
            <p className="text-[11px] text-zinc-600 px-4 mt-2">
              {workspaceOutputs.filter(w => w.driveLink).length}/{workspaceOutputs.length} synced to Google Drive
            </p>
          )}
        </section>

        {/* Persona Settings */}
        <section>
          <h2 className="text-[13px] uppercase tracking-wide text-zinc-500 font-medium px-4 mb-2">Persona Configuration</h2>
          <div className="bg-[#1C1C1E] rounded-[20px] overflow-hidden divide-y divide-white/5">
            <div className="p-4 flex flex-col gap-1">
              <label className="text-[13px] text-zinc-500">Persona Name</label>
              <input
                type="text"
                value={personaName}
                onChange={(e) => setPersonaName(e.target.value)}
                placeholder="e.g. Beatrice"
                className="bg-transparent text-[15px] text-white focus:outline-none"
              />
            </div>
            <div className="p-4 flex flex-col gap-1">
              <label className="text-[13px] text-zinc-500">System Prompt Context</label>
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Enter character traits or specific rules..."
                className="bg-transparent text-[15px] text-white focus:outline-none h-24 resize-none leading-relaxed"
              />
            </div>
            <div className="p-4 flex flex-col gap-1">
              <label className="text-[13px] text-zinc-500">What Should Beatrice Call You?</label>
              <input
                type="text"
                value={userTitle}
                onChange={(e) => setUserTitle(e.target.value)}
                placeholder="e.g. Boss"
                className="bg-transparent text-[15px] text-white focus:outline-none"
              />
            </div>
            <div className="p-4 flex flex-col gap-1">
              <label htmlFor="context-size-slider" className="text-[13px] text-zinc-500">Conversation Context (Messages)</label>
              <div className="flex items-center gap-4 mt-2">
                <input
                  id="context-size-slider"
                  type="range"
                  min="0"
                  max="50"
                  step="1"
                  value={contextSize}
                  onChange={(e) => setContextSize(parseInt(e.target.value))}
                  className="w-full accent-amber-500 h-1.5 bg-white/5 rounded-lg appearance-none cursor-pointer"
                  aria-label="Conversation Context (Messages)"
                  title="Conversation Context (Messages)"
                />
                <span className="text-[13px] text-zinc-500 shrink-0 w-6 text-right">{contextSize}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Language & Voice */}
        <section>
          <h2 className="text-[13px] uppercase tracking-wide text-zinc-500 font-medium px-4 mb-2">Speech & Language</h2>
          <div className="bg-[#1C1C1E] rounded-[20px] overflow-hidden divide-y divide-white/5">
            <div className="p-4 flex items-center justify-between">
              <label htmlFor="language-select" className="text-[15px] text-white">Language</label>
              <select
                id="language-select"
                value={authLanguage}
                onChange={(e) => { onSetLanguage(e.target.value); try { localStorage.setItem('beatrice_language', e.target.value); } catch {} }}
                className="bg-transparent text-[15px] text-zinc-400 outline-none text-right cursor-pointer"
                aria-label="Select Language"
                title="Select Language"
              >
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code} className="bg-[#1C1C1E] text-white">{l.label}</option>
                ))}
              </select>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <span className="text-[15px] text-white mb-1">Agent Voice</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {VOICE_ALIASES.map(v => (
                  <button
                    key={v.id}
                    onClick={() => setSelectedVoice(v.id)}
                    className={`flex items-center justify-between px-4 py-3 rounded-xl transition-all ${selectedVoice === v.id ? 'bg-amber-500/10 text-amber-500 font-medium' : 'bg-white/5 text-zinc-400'}`}
                  >
                    <span>{v.name}</span>
                    {selectedVoice === v.id && <Check className="w-4 h-4" />}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <button
            onClick={() => saveSettings({
              onSuccess: () => {
                setSuccess('Settings saved');
                setTimeout(() => setSuccess(null), 2000);
              },
              onError: (msg: string) => {
                setError(msg);
                setTimeout(() => setError(null), 4000);
              }
            })}
            disabled={isSaving}
            className="w-full p-4 bg-[#d0a78b] rounded-[20px] text-center active:brightness-90 transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-[#d0a78b]/20"
          >
            {isSaving ? <Loader2 className="w-5 h-5 animate-spin text-black" /> : <Save className="w-5 h-5 text-black" />}
            <span className="text-[15px] font-['SF_Pro_Text',system-ui,sans-serif] font-bold text-black">Save Settings</span>
          </button>
        </section>

        {/* Content Filtering */}
        <section>
          <h2 className="text-[13px] uppercase tracking-wide text-zinc-500 font-medium px-4 mb-2">Content Filtering</h2>
          <div className="bg-[#1C1C1E] rounded-[20px] overflow-hidden">
            <div className="p-4 flex items-center justify-between">
              <div className="flex flex-col gap-0.5 pr-4">
                <span className="text-[15px] text-white font-medium">Censorship</span>
                <span className="text-[13px] text-zinc-400 leading-relaxed">
                  {censorshipEnabled
                    ? 'Filter profanity and sensitive content'
                    : 'Unfiltered — agent will not refuse or moralize'}
                </span>
              </div>
              <button
                onClick={() => setCensorshipEnabled(!censorshipEnabled)}
                aria-pressed={censorshipEnabled}
                aria-label="Toggle censorship"
                className={`w-12 h-6 rounded-full transition-all duration-300 flex items-center shrink-0 cursor-pointer ${
                  censorshipEnabled ? 'bg-[#d0a78b]' : 'bg-zinc-700'
                }`}
              >
                <span className={`block w-4 h-4 rounded-full bg-white transition-all duration-300 shadow-md ${
                  censorshipEnabled ? 'ml-[26px]' : 'ml-[4px]'
                }`} />
              </button>
            </div>
          </div>
        </section>

        {/* Logout Section */}
        <section>
          <button
            onClick={() => { signOut(auth); onClose(); }}
            className="w-full p-4 bg-white/[0.03] backdrop-blur-2xl border border-white/[0.06] rounded-[20px] text-center active:bg-white/[0.06] transition-all"
          >
            <span className="text-[15px] font-['SF_Pro_Text',system-ui,sans-serif] font-semibold text-red-400">Sign Out</span>
          </button>
        </section>

      </div>

      {previewItem && previewItem.textContent && (
        <div className="fixed inset-0 z-[200] bg-[var(--bg-base)] flex flex-col">
          <header className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--bg-glass)] shrink-0">
            <span className="text-[13px] font-semibold truncate">{previewItem.title}</span>
            <div className="flex-1" />
            <button
              onClick={() => {
                const blob = new Blob([previewItem.textContent!], { type: previewItem.mimeType });
                const url = URL.createObjectURL(blob);
                navigator.clipboard.writeText(url);
                setCopiedUrl(true);
                setTimeout(() => setCopiedUrl(false), 2000);
              }}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-xs font-bold hover:bg-[var(--bg-glass-hover)] transition-all"
              title="Copy blob URL"
            >
              {copiedUrl ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copiedUrl ? 'Copied!' : 'Copy URL'}
            </button>
            <button
              onClick={() => { setPreviewItem(null); setCopiedUrl(false); }}
              className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-glass-hover)] transition-all"
              aria-label="Close preview"
            >
              <X className="w-4 h-4" />
            </button>
          </header>
          <div className="flex-1 bg-white relative overflow-hidden">
            <iframe
              srcDoc={previewItem.mimeType === 'text/html' ? previewItem.textContent : `<pre style="font-family:monospace;white-space:pre-wrap;padding:20px;font-size:14px;color:#1f2937">${previewItem.textContent.replace(/</g, '&lt;')}</pre>`}
              className="w-full h-full border-0"
              sandbox="allow-scripts"
              title={previewItem.title}
            />
          </div>
        </div>
      )}
    </div>
  );
}

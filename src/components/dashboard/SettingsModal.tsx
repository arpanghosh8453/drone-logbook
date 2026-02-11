/**
 * Settings modal for API key configuration
 */

import { useState, useEffect } from 'react';
import * as api from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';
import { Select } from '@/components/ui/Select';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [apiKeyType, setApiKeyType] = useState<'none' | 'default' | 'personal'>('none');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [appDataDir, setAppDataDir] = useState('');
  const [appLogDir, setAppLogDir] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const {
    unitSystem,
    setUnitSystem,
    themeMode,
    setThemeMode,
    loadFlights,
    loadOverview,
    clearSelection,
    donationAcknowledged,
    setDonationAcknowledged,
    smartTagsEnabled,
    setSmartTagsEnabled,
    loadSmartTagsEnabled,
    regenerateSmartTags,
    isRegenerating,
    regenerationProgress,
    supporterBadgeActive,
    setSupporterBadge,
    updateStatus,
    latestVersion,
  } = useFlightStore();

  const [showBadgeModal, setShowBadgeModal] = useState(false);
  const [badgeCode, setBadgeCode] = useState('');
  const [badgeMessage, setBadgeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const SUPPORTER_HASH = '5978f3e898c83b40c90017c88b8048f80a5acfd020bbd073af794e710603067d';

  const handleActivateBadge = async () => {
    setBadgeMessage(null);
    const trimmed = badgeCode.trim();
    if (!trimmed) {
      setBadgeMessage({ type: 'error', text: 'Please enter a supporter code.' });
      return;
    }
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(trimmed);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      if (hashHex === SUPPORTER_HASH) {
        setSupporterBadge(true);
        setBadgeMessage({ type: 'success', text: '🎉 Supporter badge activated! Thank you for your support!' });
        setBadgeCode('');
      } else {
        setBadgeMessage({ type: 'error', text: 'Error: Invalid code. Please check and try again.' });
      }
    } catch {
      setBadgeMessage({ type: 'error', text: 'Error: Could not verify code.' });
    }
  };

  const handleRemoveBadge = () => {
    setSupporterBadge(false);
    setBadgeMessage(null);
    setShowBadgeModal(false);
  };

  // True when any long-running destructive/IO operation is in progress
  const isBusy = isBackingUp || isRestoring || isDeleting || isRegenerating;

  // Check if API key exists on mount
  useEffect(() => {
    if (isOpen) {
      checkApiKey();
      getAppDataDir();
      getAppLogDir();
      loadSmartTagsEnabled();
      fetchAppVersion();
    }
  }, [isOpen]);

  // Auto-dismiss messages after 5 seconds
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!isOpen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const hadModalClass = document.body.classList.contains('modal-open');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      if (!hadModalClass) {
        document.body.classList.remove('modal-open');
      }
    };
  }, [isOpen]);

  const checkApiKey = async () => {
    try {
      const exists = await api.hasApiKey();
      setHasKey(exists);
      const keyType = await api.getApiKeyType();
      setApiKeyType(keyType as 'none' | 'default' | 'personal');
    } catch (err) {
      console.error('Failed to check API key:', err);
    }
  };

  const fetchAppVersion = async () => {
    try {
      // Try Tauri API first (desktop mode)
      const { getVersion } = await import('@tauri-apps/api/app');
      const version = await getVersion();
      setAppVersion(version);
    } catch {
      // Fallback to package.json version injected by Vite
      setAppVersion(__APP_VERSION__);
    }
  };

  const getAppDataDir = async () => {
    try {
      const dir = await api.getAppDataDir();
      setAppDataDir(dir);
    } catch (err) {
      console.error('Failed to get app data dir:', err);
    }
  };

  const getAppLogDir = async () => {
    try {
      const dir = await api.getAppLogDir();
      setAppLogDir(dir);
    } catch (err) {
      console.error('Failed to get app log dir:', err);
    }
  };

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setMessage({ type: 'error', text: 'Please enter an API key' });
      return;
    }

    setIsSaving(true);
    setMessage(null);

    try {
      await api.setApiKey(apiKey.trim());
      setMessage({ type: 'success', text: 'API key saved successfully!' });
      setHasKey(true);
      setApiKey(''); // Clear the input for security
      await checkApiKey(); // Refresh key type to update badge
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to save: ${err}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAll = async () => {
    setIsDeleting(true);
    setMessage(null);
    try {
      await api.deleteAllFlights();
      clearSelection();
      await loadFlights();
      await loadOverview();
      setMessage({ type: 'success', text: 'All logs deleted.' });
      setConfirmDeleteAll(false);
    } catch (err) {
      setMessage({ type: 'error', text: `Failed to delete: ${err}` });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBackup = async () => {
    setIsBackingUp(true);
    setMessage(null);
    try {
      await api.backupDatabase();
      setMessage({ type: 'success', text: 'Database backup exported successfully!' });
    } catch (err) {
      setMessage({ type: 'error', text: `Backup failed: ${err}` });
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleRestore = async () => {
    setIsRestoring(true);
    setMessage(null);
    try {
      if (api.isWebMode()) {
        // Web mode: pick file via browser dialog
        const files = await api.pickFiles('.backup', false);
        if (files.length === 0) {
          setIsRestoring(false);
          return;
        }
        const msg = await api.restoreDatabase(files[0]);
        setMessage({ type: 'success', text: msg || 'Backup restored successfully!' });
      } else {
        // Tauri mode: native dialog handled inside restoreDatabase
        const msg = await api.restoreDatabase();
        if (!msg) {
          setIsRestoring(false);
          return; // user cancelled
        }
        setMessage({ type: 'success', text: msg });
      }
      // Refresh data after restore
      clearSelection();
      await loadFlights();
      await loadOverview();
    } catch (err) {
      setMessage({ type: 'error', text: `Restore failed: ${err}` });
    } finally {
      setIsRestoring(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isBusy ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative bg-dji-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-3xl mx-4 overflow-hidden">
        {/* Blocking overlay while a long-running operation is in progress */}
        {isBusy && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[2px] rounded-xl">
            <svg className="w-10 h-10 text-dji-primary animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
            </svg>
            <p className="mt-3 text-sm text-gray-300">
              {isBackingUp && 'Exporting backup…'}
              {isRestoring && 'Restoring backup…'}
              {isDeleting && 'Deleting all logs…'}
              {isRegenerating && (
                <>
                  Regenerating smart tags…
                  {regenerationProgress && (
                    <span className="block text-xs text-gray-400 mt-1">
                      Processed {regenerationProgress.processed} of {regenerationProgress.total} flights
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">Settings</h2>
          <button
            onClick={onClose}
            disabled={isBusy}
            className="text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content — two columns */}
        <div className="p-4 flex gap-0 max-h-[70vh] overflow-y-auto">
          {/* Left Column: Preferences & API Key */}
          <div className="flex-1 space-y-4 pr-5">
            {/* Units */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 whitespace-nowrap w-[15%] shrink-0">
                Units
              </label>
              <Select
                value={unitSystem}
                onChange={(v) => setUnitSystem(v as 'metric' | 'imperial')}
                className="w-[85%]"
                options={[
                  { value: 'metric', label: 'Metric (m, km/h)' },
                  { value: 'imperial', label: 'Imperial (ft, mph)' },
                ]}
              />
            </div>

            {/* Theme */}
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-300 whitespace-nowrap w-[15%] shrink-0">
                Theme
              </label>
              <Select
                value={themeMode}
                onChange={(v) => setThemeMode(v as 'system' | 'dark' | 'light')}
                className="w-[85%]"
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                ]}
              />
            </div>

            {/* Smart Tags */}
            <div>
              <p className="text-sm font-medium text-gray-300 mb-2">Smart Tags</p>
              <button
                type="button"
                onClick={() => setSmartTagsEnabled(!smartTagsEnabled)}
                className="flex items-center justify-between gap-3 w-full text-[0.85rem] text-gray-300"
                aria-pressed={smartTagsEnabled}
              >
                <span>Intelligent flight tags</span>
                <span
                  className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${
                    smartTagsEnabled
                      ? 'bg-dji-primary/90 border-dji-primary'
                      : 'bg-dji-surface border-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      smartTagsEnabled ? 'translate-x-4' : 'translate-x-1'
                    }`}
                  />
                </span>
              </button>
              <p className="text-xs text-gray-500 mt-1">
                Automatically generate descriptive tags when importing flights.
              </p>

              <button
                type="button"
                onClick={async () => {
                  const msg = await regenerateSmartTags();
                  setMessage({ type: 'success', text: msg });
                }}
                disabled={isBusy}
                className="mt-3 w-full py-2 px-3 rounded-lg border border-teal-600 text-teal-400 hover:bg-teal-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Regenerate smart tags
                </span>
              </button>
            </div>

            {/* API Key Section */}
            <div className="pt-4 border-t border-gray-700">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                DJI API Key
              </label>
              <p className="text-xs text-gray-500 mb-3">
                For decrypting V13+ flight logs. Get your own key following{' '}
                <a
                  href="https://github.com/arpanghosh8453/dji-logbook#how-to-obtain-your-own-dji-developer-api-key"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-dji-primary hover:underline"
                >
                  this guide
                </a>
              </p>

              {/* Status indicator */}
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <span className="text-sm text-gray-400">
                  {hasKey ? 'API key configured' : 'No API key configured'}
                </span>
                {apiKeyType === 'none' && (
                  <span className="api-key-badge api-key-badge-none inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full">
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-.5 3v5h1V4h-1zm0 6v1h1v-1h-1z"/></svg>
                    Invalid
                  </span>
                )}
                {apiKeyType === 'default' && (
                  <span className="api-key-badge api-key-badge-default inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full">
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7"/></svg>
                    Default
                  </span>
                )}
                {apiKeyType === 'personal' && (
                  <button
                    onClick={async () => {
                      try {
                        await api.removeApiKey();
                        await checkApiKey();
                        setMessage({ type: 'success', text: 'Custom API key removed. Using default key.' });
                      } catch (err) {
                        setMessage({ type: 'error', text: `Failed to remove key: ${err}` });
                      }
                    }}
                    className="api-key-badge api-key-badge-personal group inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full cursor-pointer transition-all duration-150 hover:api-key-badge-remove"
                    title="Click to remove custom key and use default"
                  >
                    <svg className="w-3 h-3 group-hover:hidden" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.354 4.646a.5.5 0 010 .708l-4 4a.5.5 0 01-.708 0l-2-2a.5.5 0 11.708-.708L7 9.293l3.646-3.647a.5.5 0 01.708 0z"/></svg>
                    <svg className="w-3 h-3 hidden group-hover:block" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm2.854 4.146a.5.5 0 010 .708L8.707 8l2.147 2.146a.5.5 0 01-.708.708L8 8.707l-2.146 2.147a.5.5 0 01-.708-.708L7.293 8 5.146 5.854a.5.5 0 11.708-.708L8 7.293l2.146-2.147a.5.5 0 01.708 0z"/></svg>
                    <span className="group-hover:hidden">Personal</span>
                    <span className="hidden group-hover:inline">Remove</span>
                  </button>
                )}
              </div>

              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasKey ? '••••••••••••••••' : 'Enter your DJI API key'}
                className="input w-full"
              />

              <button
                onClick={handleSave}
                disabled={isSaving || !apiKey.trim()}
                className="btn-primary w-full mt-3"
              >
                {isSaving ? 'Saving...' : hasKey ? 'Update API Key' : 'Save API Key'}
              </button>

              {/* Message (auto-dismisses after 5s) */}
              {message && (
                <p
                  className={`mt-2 text-sm text-center ${
                    message.type === 'success' ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {message.text}
                </p>
              )}
            </div>
          </div>

          {/* Vertical Divider */}
          <div className="w-px bg-gray-700 shrink-0" />

          {/* Right Column: Donation, Support, Info & Data */}
          <div className="flex-1 space-y-4 pl-5">
            {/* Donation Status */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                Donation status
              </p>
              <button
                type="button"
                onClick={() => {
                  if (!supporterBadgeActive) {
                    setDonationAcknowledged(!donationAcknowledged);
                  }
                }}
                className={`mt-2 flex items-center justify-between gap-3 w-full text-[0.85rem] text-gray-300 ${supporterBadgeActive ? 'opacity-60 cursor-not-allowed' : ''}`}
                aria-pressed={donationAcknowledged}
                disabled={supporterBadgeActive}
              >
                <span>Already donated. Remove banner permanently</span>
                <span
                  className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${
                    donationAcknowledged
                      ? 'bg-dji-primary/90 border-dji-primary'
                      : 'bg-dji-surface border-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                      donationAcknowledged ? 'translate-x-4' : 'translate-x-1'
                    }`}
                  />
                </span>
              </button>
              {supporterBadgeActive && (
                <p className="text-xs text-amber-400/80 mt-1">Locked — supporter badge is active.</p>
              )}

              {/* Supporter Badge Button */}
              <p className="mt-3 text-xs text-gray-500 leading-relaxed">
                Show your love by supporting this project — your donation keeps development running and new features coming.
              </p>
              <button
                type="button"
                onClick={() => { setShowBadgeModal(true); setBadgeMessage(null); setBadgeCode(''); }}
                className={`mt-3 w-full py-2 px-3 rounded-lg border text-sm transition-colors ${
                  supporterBadgeActive
                    ? 'border-amber-500/50 text-amber-400 hover:bg-amber-500/10'
                    : 'border-violet-500/50 text-violet-400 hover:bg-violet-500/10'
                }`}
              >
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                  </svg>
                  {supporterBadgeActive ? 'Manage Supporter Badge' : 'Get Supporter Badge'}
                </span>
              </button>
            </div>

            {/* Info Section */}
            <div className="pt-4 border-t border-gray-700">
              <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                <strong className="text-gray-400">App Version:</strong>{' '}
                <span className="text-gray-400">{appVersion || '...'}</span>
                {updateStatus === 'checking' && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 border border-gray-600/50">
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round"/></svg>
                    Checking…
                  </span>
                )}
                {updateStatus === 'latest' && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.354 4.646a.5.5 0 010 .708l-4 4a.5.5 0 01-.708 0l-2-2a.5.5 0 11.708-.708L7 9.293l3.646-3.647a.5.5 0 01.708 0z"/></svg>
                    Latest
                  </span>
                )}
                {updateStatus === 'outdated' && latestVersion && (
                  <a
                    href="https://github.com/arpanghosh8453/dji-logbook/releases/latest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer no-underline"
                    title="Click to open release page"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zM7.5 4v5h1V4h-1zm0 6v1h1v-1h-1z"/></svg>
                    Update to v{latestVersion}
                  </a>
                )}
                {updateStatus === 'failed' && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-.5 3v5h1V4h-1zm0 6v1h1v-1h-1z"/></svg>
                    Check failed
                  </span>
                )}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                <strong className="text-gray-400">Data Location:</strong>
                <br />
                <code className="text-xs text-gray-400 bg-dji-dark px-1 py-0.5 rounded break-all">
                  {appDataDir || 'Loading...'}
                </code>
              </p>
              <p className="text-xs text-gray-500 mt-2">
                <strong className="text-gray-400">Log Location:</strong>
                <br />
                <code className="text-xs text-gray-400 bg-dji-dark px-1 py-0.5 rounded break-all">
                  {appLogDir || 'Loading...'}
                </code>
              </p>
              <p className="text-xs text-gray-500 mt-2">
                Your API key is stored locally in <code className="text-gray-400">config.json</code> and never sent to any external servers except DJI's official API.
              </p>
            </div>

            {/* Backup & Restore */}
            <div className="pt-4 border-t border-gray-700">
              <div className="flex gap-3">
                <button
                  onClick={handleBackup}
                  disabled={isBusy}
                  className="flex-1 py-2 px-3 rounded-lg border border-sky-600 text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {isBackingUp ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                      </svg>
                      Exporting…
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
                      </svg>
                      Backup Database
                    </span>
                  )}
                </button>
                <button
                  onClick={handleRestore}
                  disabled={isBusy}
                  className="flex-1 py-2 px-3 rounded-lg border border-amber-600 text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {isRestoring ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                      </svg>
                      Restoring…
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 6l-4-4m0 0L8 6m4-4v13" />
                      </svg>
                      Import Backup
                    </span>
                  )}
                </button>
              </div>

              {confirmDeleteAll ? (
                <div className="mt-4 rounded-lg border border-red-600/60 bg-red-500/10 p-3">
                  <p className="text-xs text-red-200">
                    This action cannot be undone and will remove all flight logs.
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={handleDeleteAll}
                      className="text-xs text-red-300 hover:text-red-200"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmDeleteAll(false)}
                      className="text-xs text-gray-400 hover:text-gray-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDeleteAll(true)}
                  disabled={isBusy}
                  className="mt-4 w-full py-2 px-3 rounded-lg border border-red-600 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Delete all logs
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
      </div>

      {/* Supporter Badge Activation Modal */}
      {showBadgeModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowBadgeModal(false)}
          />
          <div className="relative bg-dji-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                Supporter Badge
              </h3>
              <button
                onClick={() => setShowBadgeModal(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4 space-y-4">
              {supporterBadgeActive ? (
                <>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <svg className="w-5 h-5 text-amber-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                    <p className="text-sm text-amber-300">Your supporter badge is active. Thank you for supporting this project!</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRemoveBadge}
                    className="w-full py-2 px-3 rounded-lg border border-red-600 text-red-500 hover:bg-red-500/10 transition-colors text-sm"
                  >
                    Remove Supporter Badge
                  </button>
                </>
              ) : (
                <>
                  <div className="space-y-2 text-sm text-gray-300">
                    <p className="flex gap-2">
                      <span className="text-dji-primary font-semibold shrink-0">1.</span>
                      <span>
                        Visit{' '}
                        <a
                          href="https://ko-fi.com/s/e06c1d4359"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-dji-primary hover:underline font-medium"
                        >
                          this page
                        </a>
                        {' '}to get your supporter code.
                      </span>
                    </p>
                    <p className="flex gap-2">
                      <span className="text-dji-primary font-semibold shrink-0">2.</span>
                      <span>Enter the code below to activate your Supporter Badge.</span>
                    </p>
                  </div>
                  <div>
                    <input
                      type="text"
                      value={badgeCode}
                      onChange={(e) => setBadgeCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleActivateBadge(); }}
                      placeholder="Enter your supporter code"
                      className="input w-full"
                    />
                    <button
                      type="button"
                      onClick={handleActivateBadge}
                      disabled={!badgeCode.trim()}
                      className="btn-primary w-full mt-3"
                    >
                      Activate Supporter Badge
                    </button>
                  </div>
                </>
              )}

              {badgeMessage && (
                <p className={`text-sm text-center ${badgeMessage.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
                  {badgeMessage.text}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

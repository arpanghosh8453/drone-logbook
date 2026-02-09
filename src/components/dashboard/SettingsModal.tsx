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
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [appDataDir, setAppDataDir] = useState('');
  const [appLogDir, setAppLogDir] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // True when any long-running destructive/IO operation is in progress
  const isBusy = isBackingUp || isRestoring || isDeleting;
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
  } = useFlightStore();

  // Check if API key exists on mount
  useEffect(() => {
    if (isOpen) {
      checkApiKey();
      getAppDataDir();
      getAppLogDir();
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
    } catch (err) {
      console.error('Failed to check API key:', err);
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
      <div className="relative bg-dji-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-md mx-4 overflow-hidden">
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

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Units */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Units
            </label>
            <Select
              value={unitSystem}
              onChange={(v) => setUnitSystem(v as 'metric' | 'imperial')}
              options={[
                { value: 'metric', label: 'Metric (m, km/h)' },
                { value: 'imperial', label: 'Imperial (ft, mph)' },
              ]}
            />
          </div>

          {/* Theme */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Theme
            </label>
            <Select
              value={themeMode}
              onChange={(v) => setThemeMode(v as 'system' | 'dark' | 'light')}
              options={[
                { value: 'system', label: 'System' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
            />
          </div>

          {/* API Key Section */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              DJI API Key
            </label>
            <p className="text-xs text-gray-500 mb-3">
              Required for decrypting V13+ flight logs. Get your key from{' '}
              <a
                href="https://developer.dji.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-dji-primary hover:underline"
              >
                developer.dji.com
              </a>
            </p>
            <p className="text-xs text-gray-500 mb-3">
              The standalone app ships with a developer-provided key, but please use your own
              API key to avoid rate limit issues. See the
              {' '}
              <a
                href="https://developer.dji.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-dji-primary hover:underline"
              >
                DJI developer portal
              </a>
              {' '}for guidance.
            </p>

            {/* Status indicator */}
            <div className="flex items-center gap-2 mb-3">
              <div
                className={`w-2 h-2 rounded-full ${
                  hasKey ? 'bg-green-500' : 'bg-yellow-500'
                }`}
              />
              <span className="text-sm text-gray-400">
                {hasKey ? 'API key configured' : 'No API key configured'}
              </span>
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

            <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-gray-400">
              Donation status
            </p>
            <button
              type="button"
              onClick={() => setDonationAcknowledged(!donationAcknowledged)}
              className="mt-2 flex items-center justify-between gap-3 w-full text-[0.85rem] text-gray-300"
              aria-pressed={donationAcknowledged}
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
          </div>

          {/* Info Section */}
          <div className="pt-4 border-t border-gray-700">
            <p className="text-xs text-gray-500">
              <strong className="text-gray-400">Data Location:</strong>
              <br />
              <code className="text-xs text-gray-400 bg-dji-dark px-1 py-0.5 rounded">
                {appDataDir || 'Loading...'}
              </code>
            </p>
            <p className="text-xs text-gray-500 mt-2">
              <strong className="text-gray-400">Log Location:</strong>
              <br />
              <code className="text-xs text-gray-400 bg-dji-dark px-1 py-0.5 rounded">
                {appLogDir || 'Loading...'}
              </code>
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Your API key is stored locally in <code className="text-gray-400">config.json</code> and never sent to any external servers except DJI's official API.
            </p>

            {/* Backup & Restore */}
            <div className="mt-4 flex gap-3">
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

        {/* Footer */}
      </div>
    </div>
  );
}

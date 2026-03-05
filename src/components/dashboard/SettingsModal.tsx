/**
 * Settings modal for API key configuration
 */

import { useState, useEffect, useRef, useTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { sha256 as jsSha256 } from 'js-sha256';
import * as api from '@/lib/api';
import { isWebMode, getKeepUploadSettings, setKeepUploadSettings, KeepUploadSettings } from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';
import { Select } from '@/components/ui/Select';
import { getBlacklist, clearBlacklist } from './FlightImporter';
import { SMART_TAG_TYPES, getEnabledSmartTagTypes, setEnabledSmartTagTypes, SmartTagTypeId } from '@/lib/api';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [apiKeyType, setApiKeyType] = useState<'none' | 'default' | 'personal'>('none');
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [appLogDir, setAppLogDir] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmClearBlacklist, setConfirmClearBlacklist] = useState(false);
  const [blacklistCount, setBlacklistCount] = useState(0);
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmRemoveAutoTags, setConfirmRemoveAutoTags] = useState(false);
  const [enabledTagTypes, setEnabledTagTypes] = useState<SmartTagTypeId[]>(() => getEnabledSmartTagTypes());
  const [isTagTypeDropdownOpen, setIsTagTypeDropdownOpen] = useState(false);
  const [tagTypeSearch, setTagTypeSearch] = useState('');
  const tagTypeDropdownRef = useRef<HTMLDivElement>(null);
  const [keepUploadSettings, setKeepUploadSettingsState] = useState<KeepUploadSettings | null>(null);

  const {
    unitSystem,
    setUnitSystem,
    locale,
    setLocale,
    dateLocale,
    setDateLocale,
    appLanguage,
    setAppLanguage,
    themeMode,
    setThemeMode,
    timeFormat,
    setTimeFormat,
    loadFlights,
    loadOverview,
    clearSelection,
    donationAcknowledged,
    setDonationAcknowledged,
    smartTagsEnabled,
    setSmartTagsEnabled,
    loadSmartTagsEnabled,
    regenerateSmartTags,
    removeAllAutoTags,
    isRegenerating,
    isRemovingAutoTags,
    regenerationProgress,
    supporterBadgeActive,
    setSupporterBadge,
    updateStatus,
    latestVersion,
    loadApiKeyType,
    hideSerialNumbers,
    setHideSerialNumbers,
  } = useFlightStore();

  // Local state so the dropdown responds instantly; store update is deferred via startTransition
  const [localTimeFormat, setLocalTimeFormat] = useState<'12h' | '24h'>(timeFormat);
  const [isTimeFormatPending, startTimeFormatTransition] = useTransition();

  const [showBadgeModal, setShowBadgeModal] = useState(false);
  const [badgeCode, setBadgeCode] = useState('');
  const [badgeMessage, setBadgeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const SUPPORTER_HASH = '5978f3e898c83b40c90017c88b8048f80a5acfd020bbd073af794e710603067d';

  const handleActivateBadge = async () => {
    setBadgeMessage(null);
    const trimmed = badgeCode.trim();
    if (!trimmed) {
      setBadgeMessage({ type: 'error', text: t('settings.enterCodeValidation') });
      return;
    }
    try {
      let hashHex: string;
      // Use Web Crypto API in secure contexts, fallback to js-sha256 for HTTP
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const encoder = new TextEncoder();
        const data = encoder.encode(trimmed);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        hashHex = jsSha256(trimmed);
      }
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
  const isBusy = isBackingUp || isRestoring || isDeleting || isRegenerating || isRemovingAutoTags;

  // Check if API key exists on mount
  useEffect(() => {
    if (isOpen) {
      checkApiKey();
      getAppLogDir();
      loadSmartTagsEnabled();
      fetchAppVersion();
      setBlacklistCount(getBlacklist().size);
      // Load enabled tag types from backend
      api.loadEnabledSmartTagTypes().then(setEnabledTagTypes);
      // Load keep upload settings (Tauri desktop only)
      if (!isWebMode()) {
        getKeepUploadSettings().then(setKeepUploadSettingsState);
      }
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

  // Close on Escape key (unless busy)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isBusy) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isBusy, onClose]);

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
      setMessage({ type: 'error', text: t('settings.enterApiKey') });
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
      await loadApiKeyType(); // Update global store for FlightImporter cooldown bypass
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
      const success = await api.backupDatabase();
      if (success) {
        setMessage({ type: 'success', text: 'Database backup exported successfully!' });
      }
      // If not success, user cancelled - no message needed
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isBusy ? undefined : onClose}
      />

      {/* Modal - use grid to handle overflow properly */}
      <div className="relative bg-drone-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-[845px] max-h-[calc(100vh-2rem)] grid grid-rows-[auto_1fr]">
        {/* Blocking overlay while a long-running operation is in progress */}
        {isBusy && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/90 dark:bg-black/60 backdrop-blur-[2px] rounded-xl">
            <svg className="w-10 h-10 text-drone-primary animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
              <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
            </svg>
            <p className="mt-3 text-sm font-semibold text-gray-800 dark:font-normal dark:text-gray-300">
              {isBackingUp && t('settings.exportingBackup')}
              {isRestoring && t('settings.restoringBackup')}
              {isDeleting && t('settings.deletingAllLogs')}
              {isRemovingAutoTags && t('settings.removingAutoTags')}
              {isRegenerating && (
                <>
                  {t('settings.regeneratingSmartTags')}
                  {regenerationProgress && (
                    <span className="block text-xs font-normal text-gray-600 dark:text-gray-400 mt-1">
                      {t('settings.processedFlights', { x: regenerationProgress.processed, y: regenerationProgress.total })}
                    </span>
                  )}
                </>
              )}
            </p>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">{t('settings.title')}</h2>
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

        {/* Content — two columns - scrollable area */}
        <div className="p-4 overflow-y-auto min-h-0 settings-scroll">
          <div className="flex flex-col md:flex-row gap-6 md:gap-0">
            {/* Left Column: Preferences & API Key */}
            <div className="flex-1 space-y-4 md:pr-5">
              {/* Units + Theme + Time Format — stack on mobile */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.units')}
                  </label>
                  <Select
                    value={unitSystem}
                    onChange={(v) => setUnitSystem(v as 'metric' | 'imperial')}
                    options={[
                      { value: 'metric', label: t('settings.metric') },
                      { value: 'imperial', label: t('settings.imperial') },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.theme')}
                  </label>
                  <Select
                    value={themeMode}
                    onChange={(v) => setThemeMode(v as 'system' | 'dark' | 'light')}
                    options={[
                      { value: 'system', label: t('settings.system') },
                      { value: 'dark', label: t('settings.dark') },
                      { value: 'light', label: t('settings.light') },
                    ]}
                  />
                </div>
                <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium text-gray-400 flex items-center gap-1.5">
                    {t('settings.timeFormat', 'Time Format')}
                    {isTimeFormatPending && (
                      <svg className="w-3 h-3 animate-spin text-drone-primary" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                        <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
                      </svg>
                    )}
                  </label>
                  <Select
                    value={localTimeFormat}
                    onChange={(v) => {
                      const fmt = v as '12h' | '24h';
                      setLocalTimeFormat(fmt);
                      // Yield the paint thread first, then commit to store
                      setTimeout(() => {
                        startTimeFormatTransition(() => setTimeFormat(fmt));
                      }, 0);
                    }}
                    options={[
                      { value: '12h', label: '12-hour' },
                      { value: '24h', label: '24-hour' },
                    ]}
                  />
                </div>
              </div>

              {/* Language + Number & Date Format — stack on mobile */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {/* App Language */}
                <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.language')}
                  </label>
                  <Select
                    value={appLanguage}
                    onChange={(v) => setAppLanguage(v)}
                    listMaxHeight="max-h-[230px]"
                    options={[
                      { value: 'en', label: 'English' },
                      { value: 'de', label: 'Deutsch' },
                      { value: 'fr', label: 'Français' },
                      { value: 'es', label: 'Español' },
                      { value: 'it', label: 'Italiano' },
                      { value: 'nl', label: 'Nederlands' },
                      { value: 'pl', label: 'Polski' },
                      { value: 'pt', label: 'Português BR' },
                      { value: 'ja', label: '日本語' },
                      { value: 'zh', label: '中文' },
                      { value: 'ko', label: '한국어' },
                    ]}
                  />
                </div>
                {/* Number Format */}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.numbers')}
                  </label>
                  <Select
                    value={locale}
                    onChange={(v) => setLocale(v)}
                    options={[
                      { value: 'en-GB', label: '1,234.56' },
                      { value: 'de-DE', label: '1.234,56' },
                      { value: 'fr-FR', label: '1 234,56' },
                    ]}
                  />
                </div>
                {/* Date Format */}
                <div className="flex flex-col gap-1 col-span-2 sm:col-span-1">
                  <label className="text-xs font-medium text-gray-400">
                    {t('settings.dates')}
                  </label>
                  <Select
                    value={dateLocale}
                    onChange={(v) => setDateLocale(v)}
                    options={[
                      { value: 'en-GB', label: 'DD/MM/YYYY' },
                      { value: 'en-US', label: 'MM/DD/YYYY' },
                      { value: 'de-DE', label: 'DD.MM.YYYY' },
                      { value: 'nl-NL', label: 'DD-MM-YYYY' },
                      { value: 'ja-JP', label: 'YYYY/MM/DD' },
                      { value: 'zh-CN', label: 'YYYY/M/D' },
                      { value: 'ko-KR', label: 'YYYY. M. D.' },
                    ]}
                  />
                </div>
              </div>

              {/* Hide Serial Numbers */}
              <div>
                <button
                  type="button"
                  onClick={() => setHideSerialNumbers(!hideSerialNumbers)}
                  className="flex items-center justify-between gap-3 w-full text-[0.85rem] text-gray-300"
                  aria-pressed={hideSerialNumbers}
                >
                  <span>{t('settings.hideSerials')}</span>
                  <span
                    className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${hideSerialNumbers
                      ? 'bg-drone-primary/90 border-drone-primary'
                      : 'bg-drone-surface border-gray-600 toggle-track-off'
                      }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${hideSerialNumbers ? 'translate-x-4' : 'translate-x-1'
                        }`}
                    />
                  </span>
                </button>
                <p className="text-xs text-gray-500 mt-1">
                  {t('settings.hideSerialDesc')}
                </p>
              </div>

              {/* Smart Tags */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-300">{t('settings.smartTags')}</p>
                    <p className="text-xs text-gray-500">{t('settings.smartTagsDesc')}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSmartTagsEnabled(!smartTagsEnabled)}
                    className="flex-shrink-0"
                    aria-pressed={smartTagsEnabled}
                  >
                    <span
                      className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${smartTagsEnabled
                        ? 'bg-drone-primary/90 border-drone-primary'
                        : 'bg-drone-surface border-gray-600 toggle-track-off'
                        }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${smartTagsEnabled ? 'translate-x-4' : 'translate-x-1'
                          }`}
                      />
                    </span>
                  </button>
                </div>

                {/* Smart Tag Types Selector */}
                {smartTagsEnabled && (
                  <div>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setIsTagTypeDropdownOpen((v) => !v)}
                        className="w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2 rounded-lg border border-gray-600 bg-drone-surface hover:border-gray-500 transition-colors"
                      >
                        <span className={`truncate ${enabledTagTypes.length < SMART_TAG_TYPES.length ? 'text-gray-100' : 'text-gray-400'}`}>
                          {enabledTagTypes.length === SMART_TAG_TYPES.length
                            ? t('settings.allTagTypes')
                            : enabledTagTypes.length === 0
                              ? t('settings.noneSelected')
                              : t('settings.tagTypesSelected', { count: enabledTagTypes.length, total: SMART_TAG_TYPES.length })}
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9" /></svg>
                      </button>
                      {isTagTypeDropdownOpen && (
                        <>
                          <div
                            className="fixed inset-0 z-40"
                            onClick={() => { setIsTagTypeDropdownOpen(false); setTagTypeSearch(''); }}
                          />
                          <div
                            ref={tagTypeDropdownRef}
                            className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                          >
                            {/* Search input */}
                            <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                              <input
                                type="text"
                                value={tagTypeSearch}
                                onChange={(e) => setTagTypeSearch(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setIsTagTypeDropdownOpen(false);
                                    setTagTypeSearch('');
                                  }
                                }}
                                placeholder={t('settings.searchTagTypes')}
                                autoFocus
                                className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                              />
                            </div>
                            <div className="overflow-y-scroll flex-1">
                              {(() => {
                                const filtered = SMART_TAG_TYPES.filter((t) =>
                                  t.label.toLowerCase().includes(tagTypeSearch.toLowerCase()) ||
                                  t.description.toLowerCase().includes(tagTypeSearch.toLowerCase())
                                );
                                if (filtered.length === 0) {
                                  return <p className="text-xs text-gray-500 px-3 py-2">{t('settings.noMatchingTagTypes')}</p>;
                                }
                                // Sort: selected first, then unselected
                                const sorted = [...filtered].sort((a, b) => {
                                  const aSelected = enabledTagTypes.includes(a.id);
                                  const bSelected = enabledTagTypes.includes(b.id);
                                  if (aSelected && !bSelected) return -1;
                                  if (!aSelected && bSelected) return 1;
                                  return 0;
                                });
                                return sorted.map((tagType) => {
                                  const isSelected = enabledTagTypes.includes(tagType.id);
                                  return (
                                    <button
                                      key={tagType.id}
                                      type="button"
                                      onClick={() => {
                                        const newTypes = isSelected
                                          ? enabledTagTypes.filter((t) => t !== tagType.id)
                                          : [...enabledTagTypes, tagType.id];
                                        setEnabledTagTypes(newTypes);
                                        setEnabledSmartTagTypes(newTypes);
                                      }}
                                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${isSelected
                                        ? 'bg-teal-500/20 text-gray-800 dark:text-teal-200'
                                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                                        }`}
                                    >
                                      <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-teal-500 bg-teal-500' : 'border-gray-400 dark:border-gray-600'
                                        }`}>
                                        {isSelected && (
                                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                        )}
                                      </span>
                                      <span className="truncate">{tagType.label}</span>
                                    </button>
                                  );
                                });
                              })()}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-stretch gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const msg = await regenerateSmartTags();
                      setMessage({ type: 'success', text: msg });
                    }}
                    disabled={isBusy}
                    className="flex-1 py-[7px] px-3 rounded-lg border border-teal-600 text-teal-400 hover:bg-teal-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                  >
                    <span className="flex items-center justify-center gap-1.5">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      {t('settings.regenerateBtn')}
                    </span>
                  </button>

                  {/* Remove Auto Tags */}
                  {confirmRemoveAutoTags ? (
                    <div className="flex-1 rounded-lg border border-orange-600/60 bg-orange-500/10 p-2.5">
                      <p className="text-xs text-orange-200">
                        {t('settings.removeAutoTagsConfirm')}
                      </p>
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          onClick={async () => {
                            try {
                              const msg = await removeAllAutoTags();
                              setMessage({ type: 'success', text: msg });
                            } catch (err) {
                              setMessage({ type: 'error', text: `Failed to remove auto tags: ${err}` });
                            }
                            setConfirmRemoveAutoTags(false);
                          }}
                          className="text-xs text-orange-300 hover:text-orange-200"
                        >
                          {t('flightList.yes')}
                        </button>
                        <button
                          onClick={() => setConfirmRemoveAutoTags(false)}
                          className="text-xs text-gray-400 hover:text-gray-200"
                        >
                          {t('flightList.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveAutoTags(true)}
                      disabled={isBusy}
                      className="flex-1 py-[7px] px-3 rounded-lg border border-orange-600 text-orange-400 hover:bg-orange-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs"
                    >
                      <span className="flex items-center justify-center gap-1.5">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        {t('settings.removeBtn')}
                      </span>
                    </button>
                  )}
                </div>
              </div>

              {/* API Key Section */}
              <div className="pt-4 border-t border-gray-700">
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {t('settings.djiApiKey')}
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  {t('settings.djiApiKeyDesc')}{' '}
                  <a
                    href="https://github.com/arpanghosh8453/open-dronelog#how-to-obtain-your-own-dji-developer-api-key"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-drone-primary hover:underline"
                  >
                    {t('settings.thisGuide')}
                  </a>
                </p>

                {/* Status indicator */}
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span className="text-sm text-gray-400">
                    {hasKey ? t('settings.apiKeyConfigured') : t('settings.noApiKey')}
                  </span>
                  {apiKeyType === 'none' && (
                    <span className="api-key-badge api-key-badge-none inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-.5 3v5h1V4h-1zm0 6v1h1v-1h-1z" /></svg>
                      {t('settings.invalid')}
                    </span>
                  )}
                  {apiKeyType === 'default' && (
                    <span className="api-key-badge api-key-badge-default inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" /></svg>
                      {t('settings.default')}
                    </span>
                  )}
                  {apiKeyType === 'personal' && (
                    <button
                      onClick={async () => {
                        try {
                          await api.removeApiKey();
                          await checkApiKey();
                          await loadApiKeyType(); // Update global store
                          setMessage({ type: 'success', text: 'Custom API key removed. Using default key.' });
                        } catch (err) {
                          setMessage({ type: 'error', text: `Failed to remove key: ${err}` });
                        }
                      }}
                      className="api-key-badge api-key-badge-personal group inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full cursor-pointer transition-all duration-150 hover:api-key-badge-remove"
                      title="Click to remove custom key and use default"
                    >
                      <svg className="w-3 h-3 group-hover:hidden" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.354 4.646a.5.5 0 010 .708l-4 4a.5.5 0 01-.708 0l-2-2a.5.5 0 11.708-.708L7 9.293l3.646-3.647a.5.5 0 01.708 0z" /></svg>
                      <svg className="w-3 h-3 hidden group-hover:block" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm2.854 4.146a.5.5 0 010 .708L8.707 8l2.147 2.146a.5.5 0 01-.708.708L8 8.707l-2.146 2.147a.5.5 0 01-.708-.708L7.293 8 5.146 5.854a.5.5 0 11.708-.708L8 7.293l2.146-2.147a.5.5 0 01.708 0z" /></svg>
                      <span className="group-hover:hidden">{t('settings.personal')}</span>
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
                  {isSaving ? t('settings.savingApiKey') : hasKey ? t('settings.updateApiKey') : t('settings.saveApiKey')}
                </button>

                {/* Message (auto-dismisses after 5s) */}
                {message && (
                  <p
                    className={`mt-2 text-sm text-center ${message.type === 'success' ? 'text-green-400' : 'text-red-400'
                      }`}
                  >
                    {message.text}
                  </p>
                )}
              </div>
            </div>

            {/* Vertical Divider */}
            <div className="hidden md:block w-px bg-gray-700 shrink-0" />
            {/* Horizontal Divider for mobile */}
            <div className="md:hidden h-px w-full bg-gray-700 shrink-0" />

            {/* Right Column: Donation, Support, Info & Data */}
            <div className="flex-1 space-y-4 md:pl-5">
              {/* Donation Status */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  {t('settings.donationStatus')}
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
                  <span>{t('settings.removeBanner')}</span>
                  <span
                    className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${donationAcknowledged
                      ? 'bg-drone-primary/90 border-drone-primary'
                      : 'bg-drone-surface border-gray-600 toggle-track-off'
                      }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${donationAcknowledged ? 'translate-x-4' : 'translate-x-1'
                        }`}
                    />
                  </span>
                </button>
                {supporterBadgeActive && (
                  <p className="text-xs text-amber-400/80 mt-1">{t('settings.badgeLocked')}</p>
                )}

                {/* Supporter Badge and Shop Buttons (Side-by-side) */}

                <p className="mt-3 text-xs text-gray-500 leading-relaxed">
                  {t('settings.supporterDescription', 'Show your love by supporting this project - your donation keeps development running and new features coming.')}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowBadgeModal(true); setBadgeMessage(null); setBadgeCode(''); }}
                    className={`flex-1 py-2 px-3 rounded-lg border text-sm transition-colors ${supporterBadgeActive
                      ? 'border-amber-500/50 text-amber-400 hover:bg-amber-500/10'
                      : 'border-violet-500/50 text-violet-400 hover:bg-violet-500/10'
                      }`}
                  >
                    <span className="flex items-center justify-center gap-1.5 whitespace-nowrap">
                      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                      {supporterBadgeActive ? t('settings.manageBadge', 'Manage badge') : t('settings.getBadge', 'Get badge')}
                    </span>
                  </button>

                  <a
                    href="https://ko-fi.com/arpandesign/shop"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-2 px-3 rounded-lg border border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10 transition-colors text-sm flex items-center justify-center gap-1.5 no-underline whitespace-nowrap"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"></path>
                      <line x1="3" y1="6" x2="21" y2="6"></line>
                      <path d="M16 10a4 4 0 0 1-8 0"></path>
                    </svg>
                    {t('settings.exploreMore', 'Explore more')}
                  </a>
                </div>
              </div>

              {/* Info Section */}
              <div className="pt-4 border-t border-gray-700">
                <p className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                  <strong className="text-gray-400">{t('settings.appVersion')}</strong>{' '}
                  <span className="text-gray-400">{appVersion || '...'}</span>
                  {updateStatus === 'checking' && (
                    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400 border border-gray-600/50">
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" /></svg>
                      {t('settings.checking')}
                    </span>
                  )}
                  {updateStatus === 'latest' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm3.354 4.646a.5.5 0 010 .708l-4 4a.5.5 0 01-.708 0l-2-2a.5.5 0 11.708-.708L7 9.293l3.646-3.647a.5.5 0 01.708 0z" /></svg>
                      {t('settings.latest')}
                    </span>
                  )}
                  {updateStatus === 'outdated' && latestVersion && (
                    <a
                      href="https://github.com/arpanghosh8453/open-dronelog/releases/latest"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer no-underline"
                      title="Click to open release page"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zM7.5 4v5h1V4h-1zm0 6v1h1v-1h-1z" /></svg>
                      {t('settings.updateToVersion', { version: latestVersion })}
                    </a>
                  )}
                  {updateStatus === 'failed' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
                      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zm-.5 3v5h1V4h-1zm0 6v1h1v-1h-1z" /></svg>
                      {t('settings.checkFailed')}
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  <strong className="text-gray-400">{t('settings.logLocation')}</strong>
                  <br />
                  <code className="text-xs text-gray-400 bg-drone-dark px-1 py-0.5 rounded break-all">
                    {appLogDir || t('settings.loading')}
                  </code>
                </p>

                {/* Keep Uploaded Files - Only show in Tauri desktop mode */}
                {!isWebMode() && keepUploadSettings && (
                  <div className="mt-4 pt-4 border-t border-gray-700">
                    <div className="flex items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={async () => {
                          const newEnabled = !keepUploadSettings.enabled;
                          const result = await setKeepUploadSettings(newEnabled, keepUploadSettings.folder_path);
                          if (result) setKeepUploadSettingsState(result);
                        }}
                        className="flex items-center gap-3 text-[0.85rem] text-gray-300"
                        aria-pressed={keepUploadSettings.enabled}
                      >
                        <span
                          className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${keepUploadSettings.enabled
                            ? 'bg-drone-primary/90 border-drone-primary'
                            : 'bg-drone-surface border-gray-600 toggle-track-off'
                            }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${keepUploadSettings.enabled ? 'translate-x-4' : 'translate-x-1'
                              }`}
                          />
                        </span>
                        <span>{t('settings.keepUploadedFiles')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const { open } = await import('@tauri-apps/plugin-dialog');
                            const selected = await open({
                              directory: true,
                              multiple: false,
                              title: 'Select folder for uploaded files',
                              defaultPath: keepUploadSettings.folder_path,
                            });
                            if (selected && typeof selected === 'string') {
                              const result = await setKeepUploadSettings(keepUploadSettings.enabled, selected);
                              if (result) setKeepUploadSettingsState(result);
                            }
                          } catch (e) {
                            console.error('Failed to select folder:', e);
                          }
                        }}
                        disabled={!keepUploadSettings.enabled}
                        className={`p-1.5 rounded transition-colors ${keepUploadSettings.enabled
                          ? 'text-gray-400 hover:text-white hover:bg-gray-700/50'
                          : 'text-gray-600 cursor-not-allowed'
                          }`}
                        title="Select folder"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        </svg>
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {t('settings.keepUploadedDesc')}
                    </p>
                    {keepUploadSettings.enabled && (
                      <p className="text-xs text-gray-500 mt-1">
                        <strong className="text-gray-400">{t('settings.folder')}</strong>
                        <br />
                        <code className="text-xs text-gray-400 bg-drone-dark px-1 py-0.5 rounded break-all">
                          {keepUploadSettings.folder_path}
                        </code>
                      </p>
                    )}
                  </div>
                )}
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
                        {t('settings.exporting')}
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" />
                        </svg>
                        {t('settings.backupDatabase')}
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
                        {t('settings.restoring')}
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M16 6l-4-4m0 0L8 6m4-4v13" />
                        </svg>
                        {t('settings.importBackup')}
                      </span>
                    )}
                  </button>
                </div>

                {confirmDeleteAll ? (
                  <div className="mt-4 rounded-lg border border-red-600/60 bg-red-500/10 p-3">
                    <p className="text-xs text-red-200">
                      {t('settings.deleteAllWarning')}
                    </p>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        onClick={handleDeleteAll}
                        className="text-xs text-red-300 hover:text-red-200"
                      >
                        {t('flightList.yes')}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteAll(false)}
                        className="text-xs text-gray-400 hover:text-gray-200"
                      >
                        {t('flightList.cancel')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteAll(true)}
                    disabled={isBusy}
                    className="mt-4 w-full py-2 px-3 rounded-lg border border-red-600 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('settings.deleteAllLogs')}
                  </button>
                )}

                {/* Clear Sync Blacklist */}
                {blacklistCount > 0 && (
                  <>
                    {confirmClearBlacklist ? (
                      <div className="mt-3 rounded-lg border border-amber-600/60 bg-amber-500/10 p-3">
                        <p className="text-xs text-amber-200">
                          {t('settings.clearBlacklistConfirm')}
                        </p>
                        <div className="mt-2 flex items-center gap-3">
                          <button
                            onClick={() => {
                              clearBlacklist();
                              setBlacklistCount(0);
                              setConfirmClearBlacklist(false);
                              setMessage({ type: 'success', text: 'Blacklist cleared.' });
                            }}
                            className="text-xs text-amber-300 hover:text-amber-200"
                          >
                            {t('flightList.yes')}
                          </button>
                          <button
                            onClick={() => setConfirmClearBlacklist(false)}
                            className="text-xs text-gray-400 hover:text-gray-200"
                          >
                            {t('flightList.cancel')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmClearBlacklist(true)}
                        disabled={isBusy}
                        className="mt-3 w-full py-2 px-3 rounded-lg border border-amber-600 text-amber-500 hover:bg-amber-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                      >
                        {blacklistCount === 1 ? t('settings.clearBlacklist', { count: blacklistCount }) : t('settings.clearBlacklistPlural', { count: blacklistCount })}
                      </button>
                    )}
                  </>
                )}
              </div>
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
          <div className="relative bg-drone-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
                {t('settings.supporterBadge')}
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
                    {t('settings.removeBadge')}
                  </button>
                </>
              ) : (
                <>
                  <div className="space-y-2 text-sm text-gray-300">
                    <p className="flex gap-2">
                      <span className="text-drone-primary font-semibold shrink-0">1.</span>
                      <span>
                        Visit{' '}
                        <a
                          href="https://ko-fi.com/s/e06c1d4359"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-drone-primary hover:underline font-medium"
                        >
                          this page
                        </a>
                        {' '}to get your supporter code.
                      </span>
                    </p>
                    <p className="flex gap-2">
                      <span className="text-drone-primary font-semibold shrink-0">2.</span>
                      <span>Enter the code below to activate your Supporter Badge.</span>
                    </p>
                  </div>
                  <div>
                    <input
                      type="text"
                      value={badgeCode}
                      onChange={(e) => setBadgeCode(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleActivateBadge(); }}
                      placeholder={t('settings.enterSupporterCode')}
                      className="input w-full"
                    />
                    <button
                      type="button"
                      onClick={handleActivateBadge}
                      disabled={!badgeCode.trim()}
                      className="btn-primary w-full mt-3"
                    >
                      {t('settings.activateBadge')}
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

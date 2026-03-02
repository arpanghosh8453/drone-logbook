/**
 * Main Dashboard layout component
 * Orchestrates the flight list sidebar, charts, and map
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFlightStore } from '@/stores/flightStore';
import { FlightList } from './FlightList';
import { FlightImporter, getSyncFolderPath, setSyncFolderPath } from './FlightImporter';
import { FlightStats } from './FlightStats';
import { SettingsModal } from './SettingsModal';
import { TelemetryCharts } from '@/components/charts/TelemetryCharts';
import { FlightMap } from '@/components/map/FlightMap';
import { FlightMessagesModal } from './FlightMessagesModal';
import { Overview } from './Overview';
import { isWebMode } from '@/lib/api';

export function Dashboard() {
  const {
    currentFlightData,
    overviewStats,
    isLoading,
    flights,
    isFlightsInitialized,
    unitSystem,
    themeMode,
    loadOverview,
    supporterBadgeActive,
    checkForUpdates,
    updateStatus,
    latestVersion,
    isImporting,
    isBatchProcessing,
  } = useFlightStore();
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);
  const [showMessagesModal, setShowMessagesModal] = useState(false);
  const [activeView, setActiveView] = useState<'flights' | 'overview'>('overview');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('sidebarWidth');
      if (stored) {
        const parsed = Number(stored);
        if (parsed >= 300 && parsed <= 420) return parsed;
      }
    }
    return 300;
  });
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  // Start with null, determine collapsed state after flights are loaded from DB
  const [isImporterCollapsed, setIsImporterCollapsed] = useState<boolean | null>(null);
  const [mainSplit, setMainSplit] = useState(50);
  // Track if telemetry panel is collapsed (slider pulled past minimum width)
  const [isTelemetryCollapsed, setIsTelemetryCollapsed] = useState(false);
  // Width of telemetry panel when collapsed (minimum visible width)
  const TELEMETRY_MIN_VISIBLE_WIDTH = 40;
  const TELEMETRY_MIN_NORMAL_WIDTH = 720;
  const resizingRef = useRef<null | 'sidebar' | 'main'>(null);

  // On initial load, collapse importer if there are flights, expand if empty
  // Wait until isFlightsInitialized is true (flights have been loaded from DB)
  useEffect(() => {
    if (isFlightsInitialized && isImporterCollapsed === null) {
      // Flights have been loaded from DB: collapse if flights exist, expand if empty
      setIsImporterCollapsed(flights.length > 0);
    }
  }, [isFlightsInitialized, flights.length, isImporterCollapsed]);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('sidebarWidth', String(sidebarWidth));
    }
  }, [sidebarWidth]);

  // Check for app updates on mount.
  // In web mode, also re-check on browser refresh (no dependency array change needed
  // since the component remounts on page reload). Using a timestamp ensures fresh check.
  useEffect(() => {
    // For web/Docker mode, we want to check on every page load (browser refresh),
    // not just on initial mount. The component remounts on refresh anyway.
    checkForUpdates();
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (resizingRef.current === 'sidebar') {
        const nextWidth = Math.min(Math.max(event.clientX, 300), 420);
        setSidebarWidth(nextWidth);
      }
      if (resizingRef.current === 'main') {
        const container = document.getElementById('main-panels');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const percentage = ((event.clientX - rect.left) / rect.width) * 100;
        const minLeftPercent = (TELEMETRY_MIN_VISIBLE_WIDTH / rect.width) * 100;
        const maxLeftPercent = 100 - (320 / rect.width) * 100;
        
        // Calculate the actual pixel width the telemetry panel would be
        const telemetryPixelWidth = (percentage / 100) * rect.width;
        
        // If dragging below normal minimum, collapse the telemetry panel
        if (telemetryPixelWidth < TELEMETRY_MIN_NORMAL_WIDTH) {
          setIsTelemetryCollapsed(true);
        } else {
          setIsTelemetryCollapsed(false);
        }
        
        setMainSplit(
          Math.min(Math.max(percentage, minLeftPercent), maxLeftPercent)
        );
      }
    };

    const handleMouseUp = () => {
      resizingRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    const applyTheme = (mode: 'system' | 'dark' | 'light') => {
      const prefersDark =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : true;
      const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
      document.body.classList.remove('theme-dark', 'theme-light');
      document.body.classList.add(resolved === 'dark' ? 'theme-dark' : 'theme-light');
    };

    applyTheme(themeMode);

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => themeMode === 'system' && applyTheme('system');
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    }
    return undefined;
  }, [themeMode]);

  useEffect(() => {
    if (activeView === 'overview') {
      loadOverview();
    }
  }, [activeView, loadOverview]);

  const appIcon = new URL('../../assets/icon.png', import.meta.url).href;

  return (
    <div className={`flex h-full ${showSettings ? 'modal-open' : ''}`}>
      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* Left Sidebar - Flight List */}
      {!isSidebarHidden && (
        <aside
          className="bg-drone-secondary border-r border-gray-700 flex flex-col relative overflow-visible z-40"
          style={{ width: sidebarWidth, minWidth: 300 }}
        >
        <div className="p-4 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <img
                src={appIcon}
                alt={t('app.title')}
                className="w-6 h-6 rounded-md"
                loading="lazy"
                decoding="async"
              />
              {t('app.title')}
            </h1>
            <p className="text-xs text-gray-400 mt-1">
              {t('app.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
          {/* Supporter Badge */}
          {supporterBadgeActive && (
            <div className="supporter-badge" title={t('dashboard.verifiedSupporter')}>
              <div className="flex items-center justify-center w-9 h-9 rounded-md">
                <svg className="w-8 h-8 supporter-star" viewBox="0 0 100 120" fill="none">
                  {/* Chevron body */}
                  <path d="M50 115L5 65L20 45L50 70L80 45L95 65Z" fill="url(#badge-grad)" />
                  {/* Wings */}
                  <path d="M15 55L50 85L85 55L75 40L50 60L25 40Z" fill="url(#badge-grad)" opacity="0.7" />
                  {/* Star */}
                  <path d="M50 2L56.5 18L74 18L60 28L65 45L50 35L35 45L40 28L26 18L43.5 18Z" fill="url(#star-grad)" />
                  <defs>
                    <linearGradient id="badge-grad" x1="50" y1="40" x2="50" y2="115" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stopColor="#f59e0b" />
                      <stop offset="100%" stopColor="#d97706" />
                    </linearGradient>
                    <linearGradient id="star-grad" x1="50" y1="2" x2="50" y2="45" gradientUnits="userSpaceOnUse">
                      <stop offset="0%" stopColor="#fbbf24" />
                      <stop offset="100%" stopColor="#f59e0b" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            </div>
          )}
          {/* Settings Button */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
            title={t('dashboard.settings')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          </div>
        </div>

        {/* View Toggle */}
        <div className="px-4 py-2 border-b border-gray-700">
          <div className="flex gap-2">
            <button
              onClick={() => {
                setActiveView('flights');
                // Clear highlighted flight when switching to flights view
                useFlightStore.getState().setOverviewHighlightedFlightId(null);
              }}
              className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${
                activeView === 'flights'
                  ? 'bg-drone-primary/20 border-drone-primary text-white'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {t('dashboard.flights')}
            </button>
            <button
              onClick={() => setActiveView('overview')}
              className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${
                activeView === 'overview'
                  ? 'bg-drone-primary/20 border-drone-primary text-white'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {t('dashboard.overview')}
            </button>
          </div>
        </div>

        {/* Flight Importer */}
        <div className="border-b border-gray-700 flex-shrink-0">
          <div className="flex items-center justify-between px-3 py-2">
            <button
              type="button"
              onClick={() => setIsImporterCollapsed((v) => !v)}
              className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors"
            >
              <span className={`font-medium ${(isImporting || isBatchProcessing) ? 'text-emerald-400' : ''}`}>
                {(isImporting || isBatchProcessing)
                  ? (isImporterCollapsed !== false ? t('dashboard.importingExpand') : t('dashboard.importing'))
                  : (isImporterCollapsed !== false ? t('dashboard.importExpand') : t('dashboard.import'))}
              </span>
            </button>
            <div className="flex items-center gap-1">
              {/* Sync Folder Config Button (desktop only) */}
              {!isWebMode() && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { open } = await import('@tauri-apps/plugin-dialog');
                      const selected = await open({
                        directory: true,
                        multiple: false,
                        title: t('dashboard.selectSyncFolder'),
                      });
                      if (selected && typeof selected === 'string') {
                        setSyncFolderPath(selected);
                        // Force re-render by triggering a state update
                        window.dispatchEvent(new CustomEvent('syncFolderChanged'));
                      }
                    } catch (e) {
                      console.error('Failed to select sync folder:', e);
                    }
                  }}
                  className={`p-1.5 rounded transition-colors ${
                    getSyncFolderPath()
                      ? 'text-emerald-500 hover:text-emerald-400 dark:text-emerald-400 dark:hover:text-emerald-300 hover:bg-emerald-500/10'
                      : 'text-red-400 hover:text-red-300 dark:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10'
                  }`}
                  title={getSyncFolderPath() ? `Sync folder: ${getSyncFolderPath()}` : t('dashboard.configureSyncFolder')}
                >
                  {getSyncFolderPath() ? (
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  )}
                </button>
              )}
              {/* Collapse/Expand Button */}
              <span
                onClick={() => setIsImporterCollapsed((v) => !v)}
                className={`w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center transition-transform duration-200 cursor-pointer hover:border-gray-500 ${
                  isImporterCollapsed !== false ? 'rotate-180' : ''
                }`}
                title={isImporterCollapsed !== false ? 'Expand' : 'Collapse'}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
              </span>
            </div>
          </div>
          <div
            className={`transition-all duration-200 ease-in-out ${
              isImporterCollapsed !== false ? 'max-h-0 overflow-hidden opacity-0' : 'max-h-[300px] overflow-visible opacity-100'
            }`}
          >
            <div className="px-3 pb-3">
              <FlightImporter />
            </div>
          </div>
        </div>

        {/* Flight List */}
        <div className="flex-1 min-h-0 flex flex-col">
          <FlightList 
            activeView={activeView}
            onSelectFlight={(flightId) => {
              // Clear the overview highlight when navigating to a flight
              useFlightStore.getState().setOverviewHighlightedFlightId(null);
              setActiveView('flights');
              useFlightStore.getState().selectFlight(flightId);
            }}
            onHighlightFlight={() => {
              // This callback is called when a flight is highlighted in overview mode
              // The store is already updated by FlightList, so no additional action needed here
            }}
          />
        </div>

        {/* Flight Count */}
        <div className="p-3 border-t border-gray-700 flex items-center justify-center gap-3">
          <span className="text-xs text-gray-400">
            {t('dashboard.flightsImported', { count: flights.length })}
          </span>
          <a
            href="https://github.com/arpanghosh8453/open-dronelog"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-white transition-colors"
            title={t('dashboard.starOnGithub')}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
          </a>
          {/* Update available badge */}
          {updateStatus === 'outdated' && latestVersion && (
            <a
              href="https://opendronelog.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 hover:bg-amber-500/25 transition-colors cursor-pointer no-underline"
              title={t('dashboard.clickToUpdate')}
            >
              <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 110 14A7 7 0 018 1zM7.5 4v5h1V4h-1zm0 6v1h1v-1h-1z"/></svg>
              {t('dashboard.updateTo', { version: latestVersion })}
            </a>
          )}
        </div>
        <button
          onClick={() => setIsSidebarHidden(true)}
          className="absolute -right-3 top-1 bg-drone-secondary border border-gray-700 rounded-full w-6 h-6 text-gray-300 hover:text-white z-50"
          title={t('dashboard.hideSidebar')}
        >
          ‹
        </button>
        <div
          onMouseDown={() => {
            resizingRef.current = 'sidebar';
          }}
          className="absolute top-0 right-0 h-full w-1 cursor-col-resize bg-transparent"
        />
        </aside>
      )}

      {isSidebarHidden && (
        <aside className="w-[1.8rem] bg-drone-secondary border-r border-gray-700 flex items-start justify-center relative">
          <button
            onClick={() => setIsSidebarHidden(false)}
            className="mt-4 bg-drone-secondary border border-gray-700 rounded-full w-6 h-6 text-gray-300 hover:text-white"
            title={t('dashboard.showSidebar')}
          >
            ›
          </button>
        </aside>
      )}

      {/* Main Content */}
      <main 
        className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
        onClick={() => {
          // Clear overview highlight when clicking outside the flight list
          if (activeView === 'overview') {
            useFlightStore.getState().setOverviewHighlightedFlightId(null);
          }
        }}
      >
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <div
                className="w-12 h-12 rounded-full spinner"
                style={{ border: '4px solid #38bdf8', borderTopColor: 'transparent' }}
              />
              <p className="text-sm" style={{ color: '#64748b' }}>{t('dashboard.loadingFlightData')}</p>
            </div>
          </div>
        ) : activeView === 'overview' ? (
          <div className="w-full h-full overflow-auto">
            {overviewStats ? (
              <Overview
                stats={overviewStats}
                flights={flights}
                unitSystem={unitSystem}
                onSelectFlight={(flightId) => {
                  setActiveView('flights');
                  useFlightStore.getState().selectFlight(flightId);
                }}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center h-full">
                <p className="text-gray-500">{t('dashboard.noOverviewData')}</p>
              </div>
            )}
          </div>
        ) : currentFlightData ? (
          <>
          <div className="w-full h-full overflow-auto">
            <div className="min-w-[1100px] h-full flex flex-col">
            {/* Stats Bar */}
            <FlightStats data={currentFlightData} />

            {/* Charts and Map Grid */}
            <div id="main-panels" className="flex-1 min-h-0 flex gap-4 p-4 overflow-hidden">
              {/* Telemetry Charts - when collapsed, content clips instead of squeezing */}
              <div
                className={`card flex flex-col min-h-0 relative ${isTelemetryCollapsed ? 'overflow-hidden' : 'overflow-hidden'}`}
                style={{ 
                  flexBasis: `${mainSplit}%`, 
                  minWidth: isTelemetryCollapsed ? TELEMETRY_MIN_VISIBLE_WIDTH : TELEMETRY_MIN_NORMAL_WIDTH,
                  flexShrink: 0,
                }}
              >
                {/* Inner container that maintains minimum width for content */}
                <div 
                  className="flex flex-col h-full"
                  style={{ 
                    minWidth: TELEMETRY_MIN_NORMAL_WIDTH,
                    width: isTelemetryCollapsed ? TELEMETRY_MIN_NORMAL_WIDTH : '100%',
                  }}
                >
                  <div className="p-3 border-b border-gray-700 flex items-center justify-between">
                    <h2 className="font-semibold text-white">
                      {t('dashboard.telemetryData')}
                    </h2>
                    {isTelemetryCollapsed && (
                      <span className="text-xs text-gray-500 ml-2">{t('dashboard.dragToExpand')}</span>
                    )}
                  </div>
                  <div className="flex-1 p-2 overflow-auto">
                    <TelemetryCharts
                      data={currentFlightData!.telemetry}
                      unitSystem={unitSystem}
                      startTime={currentFlightData!.flight.startTime}
                    />
                  </div>
                </div>
              </div>

              <div
                onMouseDown={() => {
                  resizingRef.current = 'main';
                }}
                className="w-1 cursor-col-resize bg-gray-700/60 rounded hover:bg-drone-primary/60 transition-colors"
                title={t('dashboard.dragToResize')}
              />

              {/* Flight Map */}
              <div className="card flex flex-col overflow-hidden min-h-0" style={{ flexBasis: `${100 - mainSplit}%` }}>
                <div className="px-3 py-2.5 border-b border-gray-700 flex items-center justify-between">
                  <h2 className="font-semibold text-white">{t('dashboard.flightPath')}</h2>
                  {currentFlightData?.messages && currentFlightData.messages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setShowMessagesModal(true)}
                      className="relative p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
                      title={t('dashboard.viewFlightMessages')}
                      aria-label={t('dashboard.viewFlightMessages')}
                    >
                      {/* Chat-bubble icon */}
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M8 10h.01M12 10h.01M16 10h.01M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"
                        />
                      </svg>
                      {/* Red badge with count */}
                      <span className="absolute -top-1 -right-1 min-w-[19px] h-[19px] px-0.5 flex items-center justify-center rounded-full bg-red-600 text-white text-[11px] font-bold leading-none border border-drone-dark">
                        {currentFlightData.messages.length > 99 ? '99+' : currentFlightData.messages.length}
                      </span>
                    </button>
                  )}
                </div>
                <div className="flex-1 min-h-0 relative">
                  <FlightMap
                    track={currentFlightData!.track}
                    homeLat={currentFlightData!.flight.homeLat}
                    homeLon={currentFlightData!.flight.homeLon}
                    durationSecs={currentFlightData!.flight.durationSecs}
                    telemetry={currentFlightData!.telemetry}
                    themeMode={themeMode}
                    messages={currentFlightData!.messages}
                  />
                </div>
              </div>
            </div>
            </div>
          </div>
          {/* Flight Messages Modal */}
          {showMessagesModal && currentFlightData?.messages && currentFlightData.messages.length > 0 && (
            <FlightMessagesModal
              isOpen={showMessagesModal}
              onClose={() => setShowMessagesModal(false)}
              messages={currentFlightData.messages}
              flightStartTime={currentFlightData.flight.startTime ?? null}
            />
          )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md">
              <div className="w-24 h-24 mx-auto mb-6 text-gray-600">
                <svg
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1}
                    d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-gray-300 mb-2">
                {t('dashboard.noFlightSelected')}
              </h2>
              <p className="text-gray-500">
                {t('dashboard.noFlightDescription')}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

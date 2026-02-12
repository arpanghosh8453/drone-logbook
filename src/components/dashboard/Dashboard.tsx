/**
 * Main Dashboard layout component
 * Orchestrates the flight list sidebar, charts, and map
 */

import { useEffect, useRef, useState } from 'react';
import { useFlightStore } from '@/stores/flightStore';
import { FlightList } from './FlightList';
import { FlightImporter } from './FlightImporter';
import { FlightStats } from './FlightStats';
import { SettingsModal } from './SettingsModal';
import { TelemetryCharts } from '@/components/charts/TelemetryCharts';
import { FlightMap } from '@/components/map/FlightMap';
import { Overview } from './Overview';

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
  } = useFlightStore();
  const [showSettings, setShowSettings] = useState(false);
  const [activeView, setActiveView] = useState<'flights' | 'overview'>('overview');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('sidebarWidth');
      if (stored) {
        const parsed = Number(stored);
        if (parsed >= 220 && parsed <= 420) return parsed;
      }
    }
    return 288;
  });
  const [isSidebarHidden, setIsSidebarHidden] = useState(false);
  // Start with null, determine collapsed state after flights are loaded from DB
  const [isImporterCollapsed, setIsImporterCollapsed] = useState<boolean | null>(null);
  const [mainSplit, setMainSplit] = useState(50);
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

  // Check for app updates once on mount
  useEffect(() => {
    checkForUpdates();
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (resizingRef.current === 'sidebar') {
        const nextWidth = Math.min(Math.max(event.clientX, 220), 420);
        setSidebarWidth(nextWidth);
      }
      if (resizingRef.current === 'main') {
        const container = document.getElementById('main-panels');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const percentage = ((event.clientX - rect.left) / rect.width) * 100;
        const minLeftPercent = (720 / rect.width) * 100;
        const maxLeftPercent = 100 - (320 / rect.width) * 100;
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
          className="bg-dji-secondary border-r border-gray-700 flex flex-col relative overflow-visible z-40"
          style={{ width: sidebarWidth }}
        >
        <div className="p-4 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <img
                src={appIcon}
                alt="DJI Logbook"
                className="w-6 h-6 rounded-md"
                loading="lazy"
                decoding="async"
              />
              DJI Logbook
            </h1>
            <p className="text-xs text-gray-400 mt-1">
              Flight Analysis Dashboard
            </p>
          </div>
          <div className="flex items-center gap-1.5">
          {/* Supporter Badge */}
          {supporterBadgeActive && (
            <div className="supporter-badge" title="Verified Supporter">
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
            title="Settings"
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
              onClick={() => setActiveView('flights')}
              className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${
                activeView === 'flights'
                  ? 'bg-dji-primary/20 border-dji-primary text-white'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              Flights
            </button>
            <button
              onClick={() => setActiveView('overview')}
              className={`flex-1 text-xs py-1.5 rounded-lg border transition-colors ${
                activeView === 'overview'
                  ? 'bg-dji-primary/20 border-dji-primary text-white'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              Overview
            </button>
          </div>
        </div>

        {/* Flight Importer */}
        <div className="border-b border-gray-700 flex-shrink-0">
          <button
            type="button"
            onClick={() => setIsImporterCollapsed((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            <span className="font-medium">{isImporterCollapsed !== false ? 'Import — click to expand' : 'Import'}</span>
            <span
              className={`w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center transition-transform duration-200 ${
                isImporterCollapsed !== false ? 'rotate-180' : ''
              }`}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
            </span>
          </button>
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
          <FlightList onSelectFlight={(flightId) => {
            setActiveView('flights');
            useFlightStore.getState().selectFlight(flightId);
          }} />
        </div>

        {/* Flight Count */}
        <div className="p-3 border-t border-gray-700 text-center">
          <span className="text-xs text-gray-400">
            {flights.length} flight{flights.length !== 1 ? 's' : ''} imported
          </span>
        </div>
        <button
          onClick={() => setIsSidebarHidden(true)}
          className="absolute -right-3 top-1 bg-dji-secondary border border-gray-700 rounded-full w-6 h-6 text-gray-300 hover:text-white z-50"
          title="Hide sidebar"
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
        <aside className="w-[1.8rem] bg-dji-secondary border-r border-gray-700 flex items-start justify-center relative">
          <button
            onClick={() => setIsSidebarHidden(false)}
            className="mt-4 bg-dji-secondary border border-gray-700 rounded-full w-6 h-6 text-gray-300 hover:text-white"
            title="Show sidebar"
          >
            ›
          </button>
        </aside>
      )}

      {/* Main Content */}
      <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <div
                className="w-12 h-12 rounded-full spinner"
                style={{ border: '4px solid #38bdf8', borderTopColor: 'transparent' }}
              />
              <p className="text-sm" style={{ color: '#64748b' }}>Loading flight data...</p>
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
                <p className="text-gray-500">No overview data yet.</p>
              </div>
            )}
          </div>
        ) : currentFlightData ? (
          <div className="w-full h-full overflow-auto">
            <div className="min-w-[1100px] h-full flex flex-col">
            {/* Stats Bar */}
            <FlightStats data={currentFlightData} />

            {/* Charts and Map Grid */}
            <div id="main-panels" className="flex-1 min-h-0 flex gap-4 p-4 overflow-hidden">
              {/* Telemetry Charts */}
              <div
                className="card overflow-hidden flex flex-col min-h-0"
                style={{ flexBasis: `${mainSplit}%`, minWidth: 720 }}
              >
                <div className="p-3 border-b border-gray-700">
                  <h2 className="font-semibold text-white">
                    Telemetry Data
                  </h2>
                </div>
                <div className="flex-1 p-2 overflow-auto">
                  <TelemetryCharts
                    data={currentFlightData!.telemetry}
                    unitSystem={unitSystem}
                    startTime={currentFlightData!.flight.startTime}
                  />
                </div>
              </div>

              <div
                onMouseDown={() => {
                  resizingRef.current = 'main';
                }}
                className="w-1 cursor-col-resize bg-gray-700/60 rounded"
              />

              {/* Flight Map */}
              <div className="card flex flex-col overflow-hidden min-h-0" style={{ flexBasis: `${100 - mainSplit}%` }}>
                <div className="p-3 border-b border-gray-700">
                  <h2 className="font-semibold text-white">Flight Path</h2>
                </div>
                <div className="flex-1 min-h-0 relative">
                  <FlightMap
                    track={currentFlightData!.track}
                    homeLat={currentFlightData!.flight.homeLat}
                    homeLon={currentFlightData!.flight.homeLon}
                    durationSecs={currentFlightData!.flight.durationSecs}
                    telemetry={currentFlightData!.telemetry}
                    themeMode={themeMode}
                  />
                </div>
              </div>
            </div>
            </div>
          </div>
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
                No Flight Selected
              </h2>
              <p className="text-gray-500">
                Import a DJI flight log or select an existing flight from the
                sidebar to view telemetry data and flight path.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { useFlightStore } from '@/stores/flightStore';
import { Dashboard } from '@/components/dashboard/Dashboard';

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  state = { hasError: false, error: undefined as Error | undefined };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('App crashed:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full bg-dji-dark text-gray-200 flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-3">
            <h2 className="text-lg font-semibold text-white">Something went wrong</h2>
            <p className="text-sm text-gray-400">
              The app hit an unexpected error. Please restart the app. If this keeps happening, let us know.
            </p>
            {this.state.error && (
              <pre className="text-xs text-gray-500 whitespace-pre-wrap break-words">
                {this.state.error.message}
              </pre>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function App() {
  const { loadFlights, error, clearError, donationAcknowledged, themeMode } = useFlightStore();
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false;
    return sessionStorage.getItem('donationBannerDismissed') === 'true';
  });

  // Load flights on mount
  useEffect(() => {
    loadFlights();
  }, [loadFlights]);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error('Window error:', event.error || event.message);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      console.error('Unhandled rejection:', event.reason);
    };
    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const showDonationBanner = useMemo(
    () => !donationAcknowledged && !bannerDismissed,
    [donationAcknowledged, bannerDismissed]
  );

  const resolvedTheme = useMemo(() => {
    if (themeMode === 'system') {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
      }
      return 'dark';
    }
    return themeMode;
  }, [themeMode]);

  const handleDismissBanner = () => {
    setBannerDismissed(true);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('donationBannerDismissed', 'true');
    }
  };

  return (
    <div className="w-full h-full bg-dji-dark">
      {showDonationBanner && (
        <div
          className={`w-full border-b border-dji-primary/40 text-gray-100 ${
            resolvedTheme === 'light'
              ? 'bg-gradient-to-r from-violet-200 via-fuchsia-200 to-orange-200 text-gray-900'
              : 'bg-gradient-to-r from-violet-900 via-purple-900 to-orange-900'
          }`}
        >
          <div className="relative mx-auto flex w-full items-center justify-center gap-4 px-4 py-[17px]">
            <div className="flex flex-nowrap items-center justify-center gap-2 text-[0.95rem] md:text-[1rem] text-center px-6">
              <span>
                This is a free, open-source project on
              </span>
              <a
                href="https://github.com/arpanghosh8453/dji-logbook"
                target="_blank"
                rel="noopener noreferrer"
                className={
                  resolvedTheme === 'light'
                    ? 'text-indigo-700 hover:underline font-semibold'
                    : 'text-dji-primary hover:underline font-semibold'
                }
              >
                GitHub
              </a> by Arpan Ghosh
              <span className={resolvedTheme === 'light' ? 'text-gray-500' : 'text-gray-400'}>
                •
              </span>
              <span>
                If you find this useful, please consider supporting the developer with a coffee on
              </span>
              <a
                href="https://ko-fi.com/arpandesign"
                target="_blank"
                rel="noopener noreferrer"
                className={
                  resolvedTheme === 'light'
                    ? 'text-indigo-700 hover:underline font-semibold'
                    : 'text-amber-300 hover:text-amber-200 hover:underline font-semibold'
                }
              >
                Ko-fi
              </a>
            </div>
            <button
              onClick={handleDismissBanner}
              className={`absolute right-3 md:right-4 rounded-md px-2.5 py-1.5 transition-colors ${
                resolvedTheme === 'light'
                  ? 'text-gray-600 hover:text-gray-900'
                  : 'text-gray-300 hover:text-white'
              }`}
              aria-label="Dismiss donation banner"
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {/* Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-red-500/90 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 max-w-md">
          <span className="text-sm">{error}</span>
          <button
            onClick={clearError}
            className="text-white/80 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Dashboard */}
      <AppErrorBoundary>
        <Dashboard />
      </AppErrorBoundary>
    </div>
  );
}

export default App;

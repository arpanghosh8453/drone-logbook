/**
 * Flight importer with drag-and-drop support
 * Handles file selection and invokes the Rust import command.
 * Supports both Tauri (native dialog) and web (HTML file input) modes.
 * 
 * Features:
 * - Batch imports defer flight list refresh until all files complete
 * - Personal API keys bypass cooldown entirely
 * - Progressive UI updates show import progress without expensive refreshes
 * - Sync folder support for automatic imports from a configured directory
 * - Blacklist support for deleted files (skipped during sync)
 */

import { useCallback, useState, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { isWebMode, pickFiles, computeFileHash, getFlights } from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';

// Storage keys for sync folder, blacklist, and autoscan
const SYNC_FOLDER_KEY = 'syncFolderPath';
const BLACKLIST_KEY = 'importBlacklist';
const AUTOSCAN_KEY = 'autoscanEnabled';

// Get autoscan enabled setting from localStorage
export function getAutoscanEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true; // Default to enabled
  const stored = localStorage.getItem(AUTOSCAN_KEY);
  return stored !== 'false'; // Default to true if not set
}

// Set autoscan enabled setting
export function setAutoscanEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AUTOSCAN_KEY, String(enabled));
}

// Get sync folder path from localStorage
export function getSyncFolderPath(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(SYNC_FOLDER_KEY);
}

// Set sync folder path in localStorage
export function setSyncFolderPath(path: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (path) {
    localStorage.setItem(SYNC_FOLDER_KEY, path);
  } else {
    localStorage.removeItem(SYNC_FOLDER_KEY);
  }
}

// Get blacklisted file hashes (used when deleting flights)
export function getBlacklist(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const stored = localStorage.getItem(BLACKLIST_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

// Add hash to blacklist (called when deleting a flight)
export function addToBlacklist(hash: string): void {
  if (typeof localStorage === 'undefined' || !hash) return;
  const blacklist = getBlacklist();
  blacklist.add(hash);
  localStorage.setItem(BLACKLIST_KEY, JSON.stringify([...blacklist]));
}

// Remove hash from blacklist (when manually importing)
export function removeFromBlacklist(hash: string): void {
  if (typeof localStorage === 'undefined' || !hash) return;
  const blacklist = getBlacklist();
  blacklist.delete(hash);
  localStorage.setItem(BLACKLIST_KEY, JSON.stringify([...blacklist]));
}

// Clear entire blacklist (e.g., when user wants to reset)
export function clearBlacklist(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(BLACKLIST_KEY);
}

// Check if a hash is blacklisted
export function isBlacklisted(hash: string | null | undefined): boolean {
  if (!hash) return false;
  return getBlacklist().has(hash);
}

export function FlightImporter() {
  const { importLog, isImporting, apiKeyType, loadApiKeyType, isBatchProcessing, setIsBatchProcessing } = useFlightStore();
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);
  const [syncFolderPath, setSyncFolderPathState] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  const [backgroundSyncResult, setBackgroundSyncResult] = useState<string | null>(null);
  const [autoscanEnabled, setAutoscanEnabledState] = useState(() => getAutoscanEnabled());
  const backgroundSyncTriggeredRef = useRef(false);
  const backgroundSyncAbortRef = useRef(false);

  // Load sync folder path on mount and listen for changes from Dashboard
  useEffect(() => {
    setSyncFolderPathState(getSyncFolderPath());
    
    const handleSyncFolderChanged = () => {
      setSyncFolderPathState(getSyncFolderPath());
    };
    window.addEventListener('syncFolderChanged', handleSyncFolderChanged);
    return () => window.removeEventListener('syncFolderChanged', handleSyncFolderChanged);
  }, []);

  // Load API key type on mount to determine cooldown behavior
  useEffect(() => {
    loadApiKeyType();
  }, [loadApiKeyType]);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const runCooldown = async (seconds: number) => {
    setCooldownRemaining(seconds);
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      await sleep(1000);
      setCooldownRemaining(remaining - 1);
    }
  };

  /** 
   * Process a batch of files efficiently
   * - Personal API keys: no cooldown, optimized batch import
   * - Default API key: cooldown between files, sequential import
   * - Flight list refreshes periodically so user sees progress
   * - isManualImport: if true, removes files from blacklist (allows re-importing deleted files)
   *                   if false (sync), checks blacklist BEFORE importing and skips blacklisted files
   */
  const processBatch = async (items: (string | File)[], isManualImport = true) => {
    if (items.length === 0) return;

    setBatchMessage(null);
    setIsBatchProcessing(true);
    setBatchTotal(items.length);
    setBatchIndex(0);

    // Fetch fresh API key type right before processing to ensure it's up to date
    await loadApiKeyType();
    const currentApiKeyType = useFlightStore.getState().apiKeyType;
    const hasPersonalKey = currentApiKeyType === 'personal';
    
    // Helper to refresh flight list in background (non-blocking)
    const refreshFlightListBackground = () => {
      const { loadFlights, loadAllTags } = useFlightStore.getState();
      // Don't await - let it run in background
      loadFlights().then(() => loadAllTags());
    };

    // Get blacklist for sync mode (check before import to avoid wasted work)
    const blacklist = !isManualImport ? getBlacklist() : new Set<string>();
    
    // Helper to check if file is blacklisted (for sync mode only)
    // Returns hash if blacklisted, null otherwise
    const checkBlacklist = async (item: string | File): Promise<string | null> => {
      if (isManualImport || blacklist.size === 0) return null;
      
      // Only works for file paths in Tauri mode
      if (typeof item !== 'string') return null;
      
      try {
        const hash = await computeFileHash(item);
        return blacklist.has(hash) ? hash : null;
      } catch {
        // If hash computation fails, proceed with import
        return null;
      }
    };
    
    if (hasPersonalKey) {
      // Optimized path: batch import without cooldown
      // Refresh flight list every 2 files to show progress
      let processed = 0;
      let skipped = 0;
      let duplicates = 0;
      let invalidFiles = 0;
      let blacklisted = 0;
      const REFRESH_INTERVAL = 2;

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        setBatchIndex(index + 1);
        const name =
          typeof item === 'string'
            ? getShortFileName(item)
            : item.name.length <= 50
            ? item.name
            : `${item.name.slice(0, 50)}…`;
        setCurrentFileName(name);

        // For sync mode: check blacklist BEFORE importing (much faster than import+delete)
        const blacklistedHash = await checkBlacklist(item);
        if (blacklistedHash) {
          blacklisted += 1;
          continue;
        }

        // Import without refreshing flight list (skipRefresh = true)
        const result = await importLog(item, true);
        if (!result.success) {
          if (result.message.toLowerCase().includes('already been imported')) {
            skipped += 1;
          } else if (result.message.toLowerCase().includes('duplicate flight')) {
            duplicates += 1;
          } else {
            // Parse errors, corrupt files, incompatible formats, timeouts, etc.
            invalidFiles += 1;
          }
        } else {
          processed += 1;
          // For manual import, remove from blacklist (allows re-importing)
          if (isManualImport && result.fileHash) {
            removeFromBlacklist(result.fileHash);
          }
          // Refresh flight list periodically so user sees progress
          if (processed % REFRESH_INTERVAL === 0) {
            refreshFlightListBackground();
          }
        }
      }

      // Final refresh at the end
      if (processed > 0) {
        setCurrentFileName('Refreshing flight list...');
        const { loadFlights, loadAllTags } = useFlightStore.getState();
        await loadFlights();
        loadAllTags();
      }

      setIsBatchProcessing(false);
      setCurrentFileName(null);
      setBatchTotal(0);
      setBatchIndex(0);

      // Build completion message
      const parts: string[] = [];
      if (processed > 0) parts.push(`${processed} file${processed === 1 ? '' : 's'} processed`);
      if (skipped > 0) parts.push(`${skipped} skipped (already imported)`);
      if (duplicates > 0) parts.push(`${duplicates} skipped (duplicate flight)`);
      if (blacklisted > 0) parts.push(`${blacklisted} skipped (blacklisted)`);
      if (invalidFiles > 0) parts.push(`${invalidFiles} skipped (incompatible file)`);
      setBatchMessage(`Import finished. ${parts.join(', ')}.`);
    } else {
      // Standard path with cooldown (default API key)
      // Refresh flight list after each successful import (during cooldown)
      let skipped = 0;
      let processed = 0;
      let blacklisted = 0;
      let invalidFiles = 0;
      let duplicates = 0;

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const isLast = index === items.length - 1;
        setBatchIndex(index + 1);
        const name =
          typeof item === 'string'
            ? getShortFileName(item)
            : item.name.length <= 50
            ? item.name
            : `${item.name.slice(0, 50)}…`;
        setCurrentFileName(name);
        
        // For sync mode: check blacklist BEFORE importing (much faster than import+delete)
        const blacklistedHash = await checkBlacklist(item);
        if (blacklistedHash) {
          blacklisted += 1;
          continue;
        }
        
        // Use skipRefresh=true to defer refresh until batch completes
        const result = await importLog(item, true);
        if (!result.success) {
          if (result.message.toLowerCase().includes('already been imported')) {
            skipped += 1;
          } else if (result.message.toLowerCase().includes('duplicate flight')) {
            duplicates += 1;
          } else {
            // Parse errors, corrupt files, incompatible formats, timeouts, etc.
            // Only show alert for manual imports, silently skip for sync
            invalidFiles += 1;
            if (isManualImport) {
              console.warn(`Failed to import: ${result.message}`);
            }
          }
        } else {
          processed += 1;
          // For manual import, remove from blacklist (allows re-importing)
          if (isManualImport && result.fileHash) {
            removeFromBlacklist(result.fileHash);
          }
          // Refresh flight list in background while cooldown runs
          // This way user sees new flights appear during the wait
          refreshFlightListBackground();
          
          // Only apply cooldown between successful imports (not on last)
          if (!isLast) {
            await runCooldown(5);
          }
        }
      }

      // Final refresh to ensure everything is up to date
      if (processed > 0) {
        setCurrentFileName('Refreshing flight list...');
        const { loadFlights, loadAllTags } = useFlightStore.getState();
        await loadFlights();
        loadAllTags();
      }

      setIsBatchProcessing(false);
      setCurrentFileName(null);
      setBatchTotal(0);
      setBatchIndex(0);
      
      // Build completion message
      const parts: string[] = [];
      if (processed > 0) parts.push(`${processed} file${processed === 1 ? '' : 's'} processed`);
      if (skipped > 0) parts.push(`${skipped} skipped (already imported)`);
      if (duplicates > 0) parts.push(`${duplicates} skipped (duplicate flight)`);
      if (blacklisted > 0) parts.push(`${blacklisted} skipped (blacklisted)`);
      if (invalidFiles > 0) parts.push(`${invalidFiles} skipped (incompatible file)`);
      setBatchMessage(`Import finished. ${parts.join(', ')}.`);
    }
  };

  // Handle file selection via dialog
  const handleBrowse = async () => {
    if (isWebMode()) {
      // Web mode: use HTML file input
      const files = await pickFiles('.txt,.dat,.log,.csv', true);
      await processBatch(files);
    } else {
      // Tauri mode: use native dialog
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: 'Drone Log Files',
            extensions: ['txt', 'dat', 'log', 'csv'],
          },
        ],
      });

      const files =
        typeof selected === 'string'
          ? [selected]
          : Array.isArray(selected)
          ? selected
          : [];

      await processBatch(files);
    }
  };

  // Handle drag and drop (web mode via react-dropzone)
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0 && isWebMode()) {
        await processBatch(acceptedFiles);
      }
    },
    [importLog, apiKeyType]
  );

  const { getRootProps, getInputProps, isDragActive: webDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/plain': ['.txt', '.dat', '.log'],
      'text/csv': ['.csv'],
    },
    multiple: true,
    noClick: true,
    disabled: !isWebMode(), // Disable react-dropzone in Tauri mode
  });

  // Handle drag and drop (Tauri mode via onDragDropEvent)
  const [tauriDragActive, setTauriDragActive] = useState(false);
  const processBatchRef = useRef(processBatch);
  processBatchRef.current = processBatch;

  // Cancel background sync when user initiates manual import/sync
  const cancelBackgroundSync = () => {
    if (isBackgroundSyncing) {
      backgroundSyncAbortRef.current = true;
      setIsBackgroundSyncing(false);
      setBackgroundSyncResult(null);
    }
  };

  useEffect(() => {
    if (isWebMode()) return;

    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === 'over') {
            setTauriDragActive(true);
          } else if (event.payload.type === 'drop') {
            setTauriDragActive(false);
            const paths = event.payload.paths;
            // Filter to supported extensions
            const supported = paths.filter((p: string) =>
              /\.(txt|dat|log|csv)$/i.test(p)
            );
            if (supported.length > 0) {
              // Cancel background sync - user action takes priority
              cancelBackgroundSync();
              processBatchRef.current(supported);
            }
          } else if (event.payload.type === 'leave') {
            setTauriDragActive(false);
          }
        });
      } catch (e) {
        console.warn('Tauri drag-drop listener not available:', e);
      }
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Background automatic sync on startup (lazy loaded, non-blocking)
  useEffect(() => {
    // Only run once, only in desktop mode, only if sync folder is configured, only if autoscan enabled
    if (backgroundSyncTriggeredRef.current || isWebMode() || !autoscanEnabled) return;
    
    const folderPath = getSyncFolderPath();
    if (!folderPath) return;
    
    // Mark as triggered to prevent re-running
    backgroundSyncTriggeredRef.current = true;
    // Reset abort flag for this run
    backgroundSyncAbortRef.current = false;
    
    // Lazy load: wait 3 seconds after mount to not block initial render
    const timeoutId = setTimeout(async () => {
      // Don't run if user is already doing something
      if (isImporting || isBatchProcessing || isSyncing) return;
      
      setIsBackgroundSyncing(true);
      setBackgroundSyncResult(null);
      
      try {
        // Check abort before each async operation
        if (backgroundSyncAbortRef.current) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        const { readDir } = await import('@tauri-apps/plugin-fs');
        const entries = await readDir(folderPath);
        
        // Check abort after directory read
        if (backgroundSyncAbortRef.current) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        // Filter for .txt files
        const txtFiles = entries
          .filter((entry) => entry.isFile && entry.name?.toLowerCase().endsWith('.txt'))
          .map((entry) => `${folderPath}/${entry.name}`);
        
        if (txtFiles.length === 0) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        // Get existing file hashes to check for new files
        const existingFlights = await getFlights();
        const existingHashes = new Set(existingFlights.map(f => f.fileHash).filter(Boolean));
        const blacklist = getBlacklist();
        
        // Find truly new files (not already imported, not blacklisted)
        const newFiles: string[] = [];
        for (const filePath of txtFiles) {
          // Check abort during hash computation loop
          if (backgroundSyncAbortRef.current) {
            setIsBackgroundSyncing(false);
            return;
          }
          try {
            const hash = await computeFileHash(filePath);
            if (!existingHashes.has(hash) && !blacklist.has(hash)) {
              newFiles.push(filePath);
            }
          } catch {
            // If hash fails, skip silently
          }
        }
        
        // Final abort check before importing
        if (backgroundSyncAbortRef.current) {
          setIsBackgroundSyncing(false);
          return;
        }
        
        setIsBackgroundSyncing(false);
        
        if (newFiles.length > 0) {
          // Show hint about new files found, then auto-import them
          setBackgroundSyncResult(`Found ${newFiles.length} new file${newFiles.length === 1 ? '' : 's'}. Importing...`);
          
          // Small delay to show the message, then start import
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Check abort before starting import
          if (backgroundSyncAbortRef.current) {
            setBackgroundSyncResult(null);
            return;
          }
          
          setBackgroundSyncResult(null);
          
          // Process the new files (non-blocking, will show normal import progress)
          await processBatchRef.current(newFiles, false);
        }
      } catch (e) {
        console.error('Background sync check failed:', e);
        setIsBackgroundSyncing(false);
      }
    }, 3000); // 3 second delay for lazy loading
    
    return () => clearTimeout(timeoutId);
  }, [autoscanEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDragActive = webDragActive || tauriDragActive;

  // Handle sync button click
  const handleSync = async () => {
    if (isWebMode()) {
      alert('Sync feature is only available in the desktop app.');
      return;
    }

    // Cancel background sync - user action takes priority
    cancelBackgroundSync();

    const folderPath = getSyncFolderPath();
    if (!folderPath) {
      setBatchMessage('NO_SYNC_FOLDER');
      return;
    }

    setIsSyncing(true);
    setBatchMessage(null);

    try {
      // Read directory contents using Tauri
      const { readDir } = await import('@tauri-apps/plugin-fs');
      const entries = await readDir(folderPath);
      
      // Filter for top-level .txt files only
      const txtFiles = entries
        .filter((entry) => {
          // Only files (not directories) with .txt extension
          return entry.isFile && entry.name?.toLowerCase().endsWith('.txt');
        })
        .map((entry) => `${folderPath}/${entry.name}`);

      if (txtFiles.length === 0) {
        setBatchMessage('No .txt files found in sync folder.');
        setIsSyncing(false);
        return;
      }

      // For sync, we pass isManualImport=false so blacklisted files are checked
      // The processBatch function will check each file's hash against the blacklist
      // after import and delete any that match (files user previously deleted)
      setIsSyncing(false);
      await processBatch(txtFiles, false); // isManualImport = false for sync
    } catch (e) {
      console.error('Sync failed:', e);
      setBatchMessage(`Sync failed: ${e}`);
      setIsSyncing(false);
    }
  };

  // Get short folder name for display
  const getSyncFolderDisplayName = () => {
    if (!syncFolderPath) return null;
    const parts = syncFolderPath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || syncFolderPath;
  };

  return (
    <div
      {...(isWebMode() ? getRootProps() : {})}
      className={`drop-zone p-4 text-center overflow-hidden ${isDragActive ? 'active' : ''}`}
    >
      {isWebMode() && <input {...getInputProps()} />}

      {isImporting || isBatchProcessing || isSyncing ? (
        <div className="flex flex-col items-center gap-2">
          <div className="w-6 h-6 border-2 border-drone-primary border-t-transparent rounded-full spinner" />
          <span className="text-sm text-gray-400 break-all text-center w-full px-2">
            {cooldownRemaining > 0
              ? `Cooling down... ${cooldownRemaining}s`
              : isSyncing
              ? 'Scanning sync folder...'
              : currentFileName
              ? `Importing ${currentFileName}...`
              : 'Importing...'}
          </span>
          {batchTotal > 0 && (
            <span className="text-xs text-drone-primary font-medium">
              {batchIndex} of {batchTotal} file{batchTotal !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="mb-2">
            <svg
              className="w-8 h-8 mx-auto text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>

          <p className="text-xs text-gray-400 mb-2">
            {isDragActive
              ? 'Drop the file here...'
              : 'Import a drone flight log'}
          </p>

          <div className="flex gap-2 justify-center">
            <button
              onClick={handleBrowse}
              className="btn-primary text-sm py-1.5 px-3 force-white flex-1 max-w-[100px]"
              disabled={isImporting || isBatchProcessing || isSyncing}
            >
              Browse
            </button>
            {!isWebMode() && (
              <button
                onClick={handleSync}
                className="btn-primary text-sm py-1.5 px-3 force-white flex-1 max-w-[100px]"
                disabled={isImporting || isBatchProcessing || isSyncing}
                title={syncFolderPath ? `Sync from: ${getSyncFolderDisplayName()}` : 'Configure sync folder first'}
              >
                <div className="flex items-center justify-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Sync
                </div>
              </button>
            )}
          </div>
          
          {/* Sync folder status */}
          {!isWebMode() && syncFolderPath && (
            <p className="mt-2 text-[10px] text-gray-500 truncate max-w-full" title={syncFolderPath}>
              Sync: {getSyncFolderDisplayName()}
            </p>
          )}
          
          {/* Autoscan toggle */}
          {!isWebMode() && syncFolderPath && (
            <label className="mt-2 flex items-center justify-center gap-1.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={autoscanEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setAutoscanEnabledState(enabled);
                  setAutoscanEnabled(enabled);
                }}
                className="w-3 h-3 rounded border-gray-500 bg-drone-dark text-drone-primary focus:ring-1 focus:ring-drone-primary focus:ring-offset-0 cursor-pointer"
              />
              <span className="text-[10px] text-gray-500 group-hover:text-gray-400 transition-colors">Autoscan on startup</span>
            </label>
          )}
          
          {/* Background sync indicator (passive, non-blocking) */}
          {isBackgroundSyncing && (
            <div className="mt-2 flex items-center justify-center gap-2 text-[10px] text-gray-500">
              <div className="w-3 h-3 border border-gray-500 border-t-transparent rounded-full animate-spin" />
              <span>Auto-sync checking for new files...</span>
            </div>
          )}
          
          {/* Background sync result hint */}
          {backgroundSyncResult && !isBackgroundSyncing && (
            <p className="mt-2 text-[10px] text-emerald-400">{backgroundSyncResult}</p>
          )}
          
          {batchMessage && (
            batchMessage === 'NO_SYNC_FOLDER' ? (
              <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                <div className="flex items-center gap-2 text-amber-400">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span className="text-xs font-medium">No sync folder configured</span>
                </div>
                <p className="mt-1 text-[10px] text-amber-300">
                  Click the folder icon in the header above to select a folder for automatic syncing.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-xs text-gray-400">{batchMessage}</p>
            )
          )}
        </>
      )}
    </div>
  );
}

function getShortFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.split('/').pop() || filePath;
  if (name.length <= 50) return name;
  return `${name.slice(0, 50)}…`;
}

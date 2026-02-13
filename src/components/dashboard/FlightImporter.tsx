/**
 * Flight importer with drag-and-drop support
 * Handles file selection and invokes the Rust import command.
 * Supports both Tauri (native dialog) and web (HTML file input) modes.
 * 
 * Optimizations:
 * - Batch imports defer flight list refresh until all files complete
 * - Personal API keys bypass cooldown entirely
 * - Progressive UI updates show import progress without expensive refreshes
 */

import { useCallback, useState, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { isWebMode, pickFiles } from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';

export function FlightImporter() {
  const { importLog, isImporting, apiKeyType, loadApiKeyType } = useFlightStore();
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);

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
   */
  const processBatch = async (items: (string | File)[]) => {
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
    
    if (hasPersonalKey) {
      // Optimized path: batch import without cooldown
      // Refresh flight list every 2 files to show progress
      let processed = 0;
      let skipped = 0;
      let failed = 0;
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

        // Import without refreshing flight list (skipRefresh = true)
        const result = await importLog(item, true);
        if (!result.success) {
          if (result.message.toLowerCase().includes('already been imported')) {
            skipped += 1;
          } else {
            failed += 1;
          }
        } else {
          processed += 1;
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
      if (failed > 0) parts.push(`${failed} failed`);
      setBatchMessage(`Import finished. ${parts.join(', ')}.`);
      
    } else {
      // Standard path with cooldown (default API key)
      // Refresh flight list after each successful import (during cooldown)
      let skipped = 0;
      let processed = 0;

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
        
        // Use skipRefresh=true to defer refresh until batch completes
        const result = await importLog(item, true);
        if (!result.success) {
          if (result.message.toLowerCase().includes('already been imported')) {
            skipped += 1;
          } else {
            alert(result.message);
          }
        } else {
          processed += 1;
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
      if (skipped > 0) {
        setBatchMessage(
          `Import finished. ${processed} file${processed === 1 ? '' : 's'} processed, ` +
            `${skipped} file${skipped === 1 ? '' : 's'} skipped (already imported).`
        );
      } else {
        setBatchMessage(
          `Import finished. ${processed} file${processed === 1 ? '' : 's'} processed.`
        );
      }
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
            name: 'DJI Log Files',
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

  const isDragActive = webDragActive || tauriDragActive;

  return (
    <div
      {...(isWebMode() ? getRootProps() : {})}
      className={`drop-zone p-4 text-center ${isDragActive ? 'active' : ''}`}
    >
      {isWebMode() && <input {...getInputProps()} />}

      {isImporting || isBatchProcessing ? (
        <div className="flex flex-col items-center gap-2">
          <div className="w-6 h-6 border-2 border-dji-primary border-t-transparent rounded-full spinner" />
          <span className="text-sm text-gray-400">
            {cooldownRemaining > 0
              ? `Cooling down... ${cooldownRemaining}s`
              : currentFileName
              ? `Importing ${currentFileName}...`
              : 'Importing...'}
          </span>
          {batchTotal > 0 && (
            <span className="text-xs text-dji-primary font-medium">
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
              : 'Import a DJI flight log'}
          </p>

          <button
            onClick={handleBrowse}
            className="btn-primary text-sm py-1.5 px-3 force-white"
            disabled={isImporting || isBatchProcessing}
          >
            Browse Files
          </button>
          {batchMessage && (
            <p className="mt-2 text-xs text-gray-400">{batchMessage}</p>
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

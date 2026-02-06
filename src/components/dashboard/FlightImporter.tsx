/**
 * Flight importer with drag-and-drop support
 * Handles file selection and invokes the Rust import command
 */

import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { open } from '@tauri-apps/plugin-dialog';
import { useFlightStore } from '@/stores/flightStore';

export function FlightImporter() {
  const { importLog, isImporting } = useFlightStore();
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const runCooldown = async (seconds: number) => {
    setCooldownRemaining(seconds);
    for (let remaining = seconds; remaining > 0; remaining -= 1) {
      await sleep(1000);
      setCooldownRemaining(remaining - 1);
    }
  };

  // Handle file selection via dialog
  const handleBrowse = async () => {
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

    if (files.length === 0) return;

    setBatchMessage(null);
    setIsBatchProcessing(true);
    let skipped = 0;
    let processed = 0;

    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index];
      const isLast = index === files.length - 1;
      setCurrentFileName(getShortFileName(filePath));
      const result = await importLog(filePath);
      if (!result.success) {
        if (result.message.toLowerCase().includes('already been imported')) {
          skipped += 1;
        } else {
          alert(result.message);
        }
      } else {
        processed += 1;
        if (!isLast) {
          await runCooldown(5);
        }
      }
    }

    setIsBatchProcessing(false);
    setCurrentFileName(null);
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
  };

  // Handle drag and drop
  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        // For Tauri, we need the file path which isn't directly available
        // from the File object. The user will need to use the file dialog.
        // This is a limitation of web-based drag and drop in Tauri.
        alert(
          'Please use the "Browse" button to select files. ' +
            'Drag and drop file paths are not accessible in Tauri apps.'
        );
      }
    },
    [importLog]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/plain': ['.txt', '.dat', '.log'],
      'text/csv': ['.csv'],
    },
    multiple: true,
    noClick: true, // Disable click to use our custom button
  });

  return (
    <div
      {...getRootProps()}
      className={`drop-zone p-4 text-center ${isDragActive ? 'active' : ''}`}
    >
      <input {...getInputProps()} />

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
            className="btn-primary text-sm py-1.5 px-3"
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

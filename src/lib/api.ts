/**
 * Backend API adapter
 *
 * Provides a unified interface that works with both:
 * - Tauri desktop: uses invoke() IPC
 * - Web/Docker:    uses fetch() REST calls
 *
 * The mode is selected by the VITE_BACKEND env var:
 * - "tauri" (default when built with Tauri)
 * - "web"  (set when building for Docker/web deployment)
 */

import type { Flight, FlightDataResponse, FlightTag, ImportResult, OverviewStats } from '@/types';

const isWeb = import.meta.env.VITE_BACKEND === 'web';

// Base URL for web mode API calls (relative in production, configurable in dev)
const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ============================================================================
// Tauri invoke wrapper (lazy-loaded to avoid import errors in web mode)
// ============================================================================

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getTauriInvoke() {
  if (!_invoke) {
    const { invoke } = await import('@tauri-apps/api/core');
    _invoke = invoke;
  }
  return _invoke;
}

// ============================================================================
// Web fetch helpers
// ============================================================================

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!response.ok) {
    const body = await response.text();
    let errorMsg: string;
    try {
      const parsed = JSON.parse(body);
      errorMsg = parsed.error || body;
    } catch {
      errorMsg = body;
    }
    throw new Error(errorMsg);
  }
  return response.json();
}

// ============================================================================
// API Functions
// ============================================================================

export async function getFlights(): Promise<Flight[]> {
  if (isWeb) {
    return fetchJson<Flight[]>('/flights');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_flights') as Promise<Flight[]>;
}

export async function getOverviewStats(): Promise<OverviewStats> {
  if (isWeb) {
    return fetchJson<OverviewStats>('/overview');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_overview_stats') as Promise<OverviewStats>;
}

export async function getFlightData(
  flightId: number,
  maxPoints?: number,
): Promise<FlightDataResponse> {
  if (isWeb) {
    const params = new URLSearchParams({ flight_id: String(flightId) });
    if (maxPoints != null) params.set('max_points', String(maxPoints));
    return fetchJson<FlightDataResponse>(`/flight_data?${params}`);
  }
  const invoke = await getTauriInvoke();
  return invoke('get_flight_data', {
    flightId,
    maxPoints: maxPoints ?? null,
  }) as Promise<FlightDataResponse>;
}

/**
 * Import a flight log.
 * - Tauri: passes a file path string
 * - Web: uploads the file via multipart/form-data
 */
export async function importLog(
  fileOrPath: string | File,
): Promise<ImportResult> {
  if (isWeb) {
    const formData = new FormData();
    if (typeof fileOrPath === 'string') {
      throw new Error('File path import is not supported in web mode. Please provide a File object.');
    }
    formData.append('file', fileOrPath, fileOrPath.name);
    const response = await fetch(`${API_BASE}/import`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }
    return response.json();
  }
  const invoke = await getTauriInvoke();
  return invoke('import_log', { filePath: fileOrPath as string }) as Promise<ImportResult>;
}

/**
 * Compute file hash without importing.
 * Tauri-only: used to check blacklist before importing.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  if (isWeb) {
    throw new Error('File hash computation is not supported in web mode.');
  }
  const invoke = await getTauriInvoke();
  return invoke('compute_file_hash', { filePath }) as Promise<string>;
}

export async function deleteFlight(flightId: number): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>(`/flights/delete?flight_id=${flightId}`, {
      method: 'DELETE',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('delete_flight', { flightId }) as Promise<boolean>;
}

export async function deleteAllFlights(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/flights/delete_all', { method: 'DELETE' });
  }
  const invoke = await getTauriInvoke();
  return invoke('delete_all_flights') as Promise<boolean>;
}

/**
 * Remove duplicate flights from the database.
 * Duplicates are identified by matching (drone_serial, battery_serial, start_time within 60s).
 * Keeps the flight with the most telemetry points.
 * @returns Number of duplicate flights removed
 */
export async function deduplicateFlights(): Promise<number> {
  if (isWeb) {
    return fetchJson<number>('/flights/deduplicate', { method: 'POST' });
  }
  const invoke = await getTauriInvoke();
  return invoke('deduplicate_flights') as Promise<number>;
}

export async function updateFlightName(
  flightId: number,
  displayName: string,
): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/flights/name', {
      method: 'PUT',
      body: JSON.stringify({ flight_id: flightId, display_name: displayName }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('update_flight_name', { flightId, displayName }) as Promise<boolean>;
}

export async function hasApiKey(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/has_api_key');
  }
  const invoke = await getTauriInvoke();
  return invoke('has_api_key') as Promise<boolean>;
}

export async function getApiKeyType(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/api_key_type');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_api_key_type') as Promise<string>;
}

export async function setApiKey(apiKey: string): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/set_api_key', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_api_key', { apiKey }) as Promise<boolean>;
}

export async function removeApiKey(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/remove_api_key', {
      method: 'DELETE',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_api_key') as Promise<boolean>;
}

export async function getAppDataDir(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/app_data_dir');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_app_data_dir') as Promise<string>;
}

export async function getAppLogDir(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/app_log_dir');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_app_log_dir') as Promise<string>;
}

// ============================================================================
// Tag Management
// ============================================================================

export async function addFlightTag(flightId: number, tag: string): Promise<FlightTag[]> {
  if (isWeb) {
    return fetchJson<FlightTag[]>('/flights/tags/add', {
      method: 'POST',
      body: JSON.stringify({ flight_id: flightId, tag }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('add_flight_tag', { flightId, tag }) as Promise<FlightTag[]>;
}

export async function removeFlightTag(flightId: number, tag: string): Promise<FlightTag[]> {
  if (isWeb) {
    return fetchJson<FlightTag[]>('/flights/tags/remove', {
      method: 'POST',
      body: JSON.stringify({ flight_id: flightId, tag }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('remove_flight_tag', { flightId, tag }) as Promise<FlightTag[]>;
}

export async function getAllTags(): Promise<string[]> {
  if (isWeb) {
    return fetchJson<string[]>('/tags');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_all_tags') as Promise<string[]>;
}

export async function getSmartTagsEnabled(): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/settings/smart_tags');
  }
  const invoke = await getTauriInvoke();
  return invoke('get_smart_tags_enabled') as Promise<boolean>;
}

export async function setSmartTagsEnabled(enabled: boolean): Promise<boolean> {
  if (isWeb) {
    return fetchJson<boolean>('/settings/smart_tags', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('set_smart_tags_enabled', { enabled }) as Promise<boolean>;
}

export async function regenerateSmartTags(): Promise<string> {
  if (isWeb) {
    return fetchJson<string>('/regenerate_smart_tags', {
      method: 'POST',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('regenerate_all_smart_tags') as Promise<string>;
}

export async function regenerateFlightSmartTags(flightId: number): Promise<string> {
  if (isWeb) {
    return fetchJson<string>(`/regenerate_flight_smart_tags/${flightId}`, {
      method: 'POST',
    });
  }
  const invoke = await getTauriInvoke();
  return invoke('regenerate_flight_smart_tags', { flightId }) as Promise<string>;
}

// ============================================================================
// File helpers for web mode (replacing Tauri dialog/fs plugins)
// ============================================================================

/** Trigger a browser file-open dialog and return selected Files */
export function pickFiles(accept?: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.onchange = () => {
      const files = Array.from(input.files || []);
      resolve(files);
    };
    // If user cancels, resolve with empty
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Trigger a browser download for the given content */
export function downloadFile(filename: string, content: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download for a Blob */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Check if running in web mode */
export function isWebMode(): boolean {
  return isWeb;
}

// ============================================================================
// Database backup & restore
// ============================================================================

/**
 * Export the database as a compressed backup file.
 * - Tauri: prompts user with a save dialog, backend writes the file directly.
 * - Web: downloads the backup file via the browser.
 */
export async function backupDatabase(): Promise<void> {
  if (isWeb) {
    // Web mode: download via fetch
    const response = await fetch(`${API_BASE}/backup`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }
    const blob = await response.blob();
    downloadBlob('Drone_logbook.db.backup', blob);
    return;
  }

  // Tauri mode: use native save dialog
  const { save } = await import('@tauri-apps/plugin-dialog');
  const destPath = await save({
    defaultPath: 'Drone_logbook.db.backup',
    filters: [{ name: 'Drone Logbook Backup', extensions: ['backup'] }],
  });
  if (!destPath) return; // user cancelled
  const invoke = await getTauriInvoke();
  await invoke('export_backup', { destPath });
}

/**
 * Import a backup file to restore flight data.
 * - Tauri: prompts user with an open dialog, backend reads the file directly.
 * - Web: uploads the file via multipart/form-data.
 * Returns a status message string.
 */
export async function restoreDatabase(file?: File): Promise<string> {
  if (isWeb) {
    if (!file) throw new Error('No file provided');
    const formData = new FormData();
    formData.append('file', file, file.name);
    const response = await fetch(`${API_BASE}/backup/restore`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }
    return response.json();
  }

  // Tauri mode: use native open dialog
  const { open } = await import('@tauri-apps/plugin-dialog');
  const srcPath = await open({
    multiple: false,
    filters: [{ name: 'Drone Logbook Backup', extensions: ['backup'] }],
  });
  if (!srcPath) return ''; // user cancelled
  const filePath = typeof srcPath === 'string' ? srcPath : (srcPath as { path: string }).path;
  const invoke = await getTauriInvoke();
  return invoke('import_backup', { srcPath: filePath }) as Promise<string>;
}

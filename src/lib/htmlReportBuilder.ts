/**
 * HTML Report Builder
 *
 * Generates a self-contained, printable HTML flight report.
 * Flights are grouped by day with subtotals and a grand total.
 * Layout uses grouped cards per flight for A4 print readability.
 */

import type { Flight, FlightDataResponse, TelemetryData } from '@/types';
import type { WeatherData } from '@/lib/weather';
import type { UnitSystem } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface HtmlReportFieldConfig {
  // General Info
  flightDateTime: boolean;
  flightName: boolean;
  duration: boolean;
  takeoffTime: boolean;
  landingTime: boolean;
  takeoffCoordinates: boolean;
  notes: boolean;

  // Equipment
  aircraftName: boolean;
  droneModel: boolean;
  droneSerial: boolean;
  batterySerial: boolean;

  // Flight Stats
  totalDistance: boolean;
  maxAltitude: boolean;
  maxSpeed: boolean;
  maxDistanceFromHome: boolean;

  // Battery
  takeoffBattery: boolean;
  landingBattery: boolean;
  batteryVoltage: boolean;
  batteryTemp: boolean;

  // Weather
  temperature: boolean;
  windSpeed: boolean;
  windGusts: boolean;
  humidity: boolean;
  cloudCover: boolean;
  precipitation: boolean;
  pressure: boolean;
  weatherCondition: boolean;

  // Media
  photoCount: boolean;
  videoCount: boolean;
}

export const DEFAULT_FIELD_CONFIG: HtmlReportFieldConfig = {
  flightDateTime: true,
  flightName: true,
  duration: true,
  takeoffTime: true,
  landingTime: true,
  takeoffCoordinates: true,
  notes: true,
  aircraftName: true,
  droneModel: true,
  droneSerial: true,
  batterySerial: true,
  totalDistance: true,
  maxAltitude: true,
  maxSpeed: true,
  maxDistanceFromHome: true,
  takeoffBattery: true,
  landingBattery: true,
  batteryVoltage: true,
  batteryTemp: true,
  temperature: true,
  windSpeed: true,
  windGusts: true,
  humidity: true,
  cloudCover: true,
  precipitation: true,
  pressure: true,
  weatherCondition: true,
  photoCount: true,
  videoCount: true,
};

export interface FieldGroup {
  name: string;
  fields: { key: keyof HtmlReportFieldConfig; label: string }[];
}

export const FIELD_GROUPS: FieldGroup[] = [
  {
    name: 'General Info',
    fields: [
      { key: 'flightDateTime', label: 'Flight Date/Time' },
      { key: 'flightName', label: 'Flight Name' },
      { key: 'duration', label: 'Duration' },
      { key: 'takeoffTime', label: 'Takeoff Time' },
      { key: 'landingTime', label: 'Landing Time' },
      { key: 'takeoffCoordinates', label: 'Takeoff Coordinates' },
      { key: 'notes', label: 'Notes' },
    ],
  },
  {
    name: 'Equipment',
    fields: [
      { key: 'aircraftName', label: 'Aircraft Name' },
      { key: 'droneModel', label: 'Drone Model' },
      { key: 'droneSerial', label: 'Drone Serial' },
      { key: 'batterySerial', label: 'Battery Serial' },
    ],
  },
  {
    name: 'Flight Stats',
    fields: [
      { key: 'totalDistance', label: 'Total Distance' },
      { key: 'maxAltitude', label: 'Max Altitude' },
      { key: 'maxSpeed', label: 'Max Speed' },
      { key: 'maxDistanceFromHome', label: 'Max Distance from Home' },
    ],
  },
  {
    name: 'Battery',
    fields: [
      { key: 'takeoffBattery', label: 'Takeoff Battery %' },
      { key: 'landingBattery', label: 'Landing Battery %' },
      { key: 'batteryVoltage', label: 'Battery Voltage' },
      { key: 'batteryTemp', label: 'Battery Temp' },
    ],
  },
  {
    name: 'Weather',
    fields: [
      { key: 'weatherCondition', label: 'Weather Condition' },
      { key: 'temperature', label: 'Temperature' },
      { key: 'windSpeed', label: 'Wind Speed' },
      { key: 'windGusts', label: 'Wind Gusts' },
      { key: 'humidity', label: 'Humidity' },
      { key: 'cloudCover', label: 'Cloud Cover' },
      { key: 'precipitation', label: 'Precipitation' },
      { key: 'pressure', label: 'Pressure' },
    ],
  },
  {
    name: 'Media',
    fields: [
      { key: 'photoCount', label: 'Photos' },
      { key: 'videoCount', label: 'Videos' },
    ],
  },
];

// ============================================================================
// Field config persistence
// ============================================================================

const STORAGE_KEY = 'htmlReportFieldConfig';

export function loadFieldConfig(): HtmlReportFieldConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_FIELD_CONFIG, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_FIELD_CONFIG };
}

export function saveFieldConfig(config: HtmlReportFieldConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

// ============================================================================
// Helpers
// ============================================================================

function esc(str: string | number | null | undefined): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined || seconds === 0) return '—';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

function fmtDistance(meters: number | null, unitSystem: UnitSystem): string {
  if (meters === null || meters === undefined || meters === 0) return '—';
  if (unitSystem === 'imperial') {
    const miles = meters / 1609.344;
    return `${miles.toFixed(2)} mi`;
  }
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${meters.toFixed(0)} m`;
}

function fmtSpeed(ms: number | null, unitSystem: UnitSystem): string {
  if (ms === null || ms === undefined || ms === 0) return '—';
  if (unitSystem === 'imperial') return `${(ms * 2.236936).toFixed(1)} mph`;
  return `${(ms * 3.6).toFixed(1)} km/h`;
}

function fmtAltitude(meters: number | null, unitSystem: UnitSystem): string {
  if (meters === null || meters === undefined || meters === 0) return '—';
  if (unitSystem === 'imperial') return `${(meters * 3.28084).toFixed(1)} ft`;
  return `${meters.toFixed(1)} m`;
}

/** Format to "DD MMM YYYY, hh:mm:ss AM/PM TZ" */
function fmtDateTimeFull(isoString: string | null): string {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
  } catch {
    return isoString;
  }
}

/** Format time only: "hh:mm:ss AM/PM TZ" */
function fmtTimeFull(isoString: string | null): string {
  if (!isoString) return '—';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
  } catch {
    return isoString;
  }
}

/** Format date for day header: "DD MMM YYYY" */
function fmtDateHeader(isoString: string | null): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return isoString;
  }
}

function fmtDateShort(isoString: string | null): string {
  if (!isoString) return '';
  return new Date(isoString).toISOString().split('T')[0];
}

/** Get current timestamp formatted as "DD MMM YYYY, hh:mm:ss AM/PM TZ" */
function fmtNow(): string {
  return new Date().toLocaleString('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

function calculateLandingTime(takeoffTime: string | null, durationSecs: number | null): string {
  if (!takeoffTime || !durationSecs) return '—';
  const landing = new Date(new Date(takeoffTime).getTime() + durationSecs * 1000);
  return landing.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

function calculateMaxDistanceFromHome(telemetry: TelemetryData): number | null {
  const lats = telemetry.latitude ?? [];
  const lngs = telemetry.longitude ?? [];
  let homeLat: number | null = null;
  let homeLng: number | null = null;
  for (let i = 0; i < lats.length; i++) {
    if (typeof lats[i] === 'number' && typeof lngs[i] === 'number') {
      homeLat = lats[i]!;
      homeLng = lngs[i]!;
      break;
    }
  }
  if (homeLat === null || homeLng === null) return null;
  let maxDistance = 0;
  const toRad = (v: number) => (v * Math.PI) / 180;
  for (let i = 0; i < lats.length; i++) {
    const lat = lats[i];
    const lng = lngs[i];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const dLat = toRad(lat - homeLat);
    const dLon = toRad(lng - homeLng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(homeLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = 6371000 * c;
    if (distance > maxDistance) maxDistance = distance;
  }
  return maxDistance;
}

function fmtWindSpeed(kmh: number, unitSystem: UnitSystem): string {
  if (unitSystem === 'imperial') return `${(kmh * 0.621371).toFixed(1)} mph`;
  return `${kmh.toFixed(1)} km/h`;
}

function fmtTemp(c: number, unitSystem: UnitSystem): string {
  if (unitSystem === 'imperial') return `${(c * 9 / 5 + 32).toFixed(1)} °F`;
  return `${c.toFixed(1)} °C`;
}

function fmtPrecip(mm: number, unitSystem: UnitSystem): string {
  if (unitSystem === 'imperial') return `${(mm * 0.03937).toFixed(2)} in`;
  return `${mm.toFixed(1)} mm`;
}

function fmtPressure(hPa: number, unitSystem: UnitSystem): string {
  if (unitSystem === 'imperial') return `${(hPa * 0.02953).toFixed(2)} inHg`;
  return `${hPa} hPa`;
}

// ============================================================================
// HTML builder
// ============================================================================

export interface FlightReportData {
  flight: Flight;
  data: FlightDataResponse;
  weather?: WeatherData | null;
  getDroneDisplayName?: (serial: string, fallback: string) => string;
  getBatteryDisplayName?: (serial: string) => string;
}

export interface ReportOptions {
  documentTitle: string;
  pilotName: string;
  fieldConfig: HtmlReportFieldConfig;
  unitSystem: UnitSystem;
}

/** Build a data item { label, value } for a flight, only for enabled fields */
function buildFlightItems(
  fd: FlightReportData,
  fc: HtmlReportFieldConfig,
  unitSystem: UnitSystem,
): { group: string; items: { label: string; value: string }[] }[] {
  const groups: { group: string; items: { label: string; value: string }[] }[] = [];

  // General Info
  const generalItems: { label: string; value: string }[] = [];
  if (fc.flightName) generalItems.push({ label: 'Flight Name', value: esc(fd.flight.displayName || fd.flight.fileName) });
  if (fc.flightDateTime) generalItems.push({ label: 'Date/Time', value: esc(fmtDateTimeFull(fd.flight.startTime)) });
  if (fc.takeoffTime) generalItems.push({ label: 'Takeoff', value: esc(fmtTimeFull(fd.flight.startTime)) });
  if (fc.landingTime) generalItems.push({ label: 'Landing', value: esc(calculateLandingTime(fd.flight.startTime, fd.flight.durationSecs)) });
  if (fc.duration) generalItems.push({ label: 'Duration', value: esc(fmtDuration(fd.flight.durationSecs)) });
  if (fc.takeoffCoordinates) {
    const lat = fd.flight.homeLat ?? fd.data.telemetry.latitude?.[0];
    const lon = fd.flight.homeLon ?? fd.data.telemetry.longitude?.[0];
    generalItems.push({ label: 'Takeoff Location', value: lat != null && lon != null ? `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}` : '—' });
  }
  if (fc.notes && fd.flight.notes) generalItems.push({ label: 'Notes', value: esc(fd.flight.notes) });
  if (generalItems.length > 0) groups.push({ group: 'General Info', items: generalItems });

  // Equipment
  const equipItems: { label: string; value: string }[] = [];
  if (fc.aircraftName) {
    const fallback = fd.flight.aircraftName || fd.flight.droneModel || '';
    const name = fd.flight.droneSerial && fd.getDroneDisplayName
      ? fd.getDroneDisplayName(fd.flight.droneSerial, fallback) : fallback;
    equipItems.push({ label: 'Aircraft', value: esc(name || '—') });
  }
  if (fc.droneModel) equipItems.push({ label: 'Drone Model', value: esc(fd.flight.droneModel || '—') });
  if (fc.droneSerial) equipItems.push({ label: 'Drone SN', value: esc(fd.flight.droneSerial || '—') });
  if (fc.batterySerial) {
    const serial = fd.flight.batterySerial || '—';
    const display = serial !== '—' && fd.getBatteryDisplayName ? fd.getBatteryDisplayName(serial) : serial;
    equipItems.push({ label: 'Battery SN', value: esc(display) });
  }
  if (equipItems.length > 0) groups.push({ group: 'Equipment', items: equipItems });

  // Performance (Flight Stats + Battery merged)
  const perfItems: { label: string; value: string }[] = [];
  if (fc.totalDistance) perfItems.push({ label: 'Distance', value: esc(fmtDistance(fd.flight.totalDistance, unitSystem)) });
  if (fc.maxAltitude) perfItems.push({ label: 'Max Alt.', value: esc(fmtAltitude(fd.flight.maxAltitude, unitSystem)) });
  if (fc.maxSpeed) perfItems.push({ label: 'Max Speed', value: esc(fmtSpeed(fd.flight.maxSpeed, unitSystem)) });
  if (fc.maxDistanceFromHome) {
    const d = calculateMaxDistanceFromHome(fd.data.telemetry);
    perfItems.push({ label: 'Max Dist. Home', value: esc(fmtDistance(d, unitSystem)) });
  }
  if (fc.takeoffBattery) {
    const b = fd.data.telemetry.battery;
    const first = b?.find((v) => v !== null);
    perfItems.push({ label: 'Takeoff Bat.', value: first != null && first !== 0 ? `${first}%` : '—' });
  }
  if (fc.landingBattery) {
    const b = fd.data.telemetry.battery;
    let last: number | null = null;
    if (b) for (let i = b.length - 1; i >= 0; i--) { if (b[i] !== null) { last = b[i]; break; } }
    perfItems.push({ label: 'Landing Bat.', value: last != null && last !== 0 ? `${last}%` : '—' });
  }
  if (fc.batteryVoltage) {
    const v = fd.data.telemetry.batteryVoltage;
    const first = v?.find((val) => val !== null);
    perfItems.push({ label: 'Voltage', value: first != null && first !== 0 ? `${(first / 1000).toFixed(2)} V` : '—' });
  }
  if (fc.batteryTemp) {
    const t = fd.data.telemetry.batteryTemp;
    const first = t?.find((val) => val !== null);
    if (first != null) {
      perfItems.push({ label: 'Bat. Temp', value: unitSystem === 'imperial' ? `${(first * 9 / 5 + 32).toFixed(1)} °F` : `${first.toFixed(1)} °C` });
    } else {
      perfItems.push({ label: 'Bat. Temp', value: '—' });
    }
  }
  if (perfItems.length > 0) groups.push({ group: 'Performance', items: perfItems });

  // Weather
  const wxItems: { label: string; value: string }[] = [];
  if (fc.weatherCondition) wxItems.push({ label: 'Condition', value: esc(fd.weather?.conditionLabel ?? '—') });
  if (fc.temperature) wxItems.push({ label: 'Temperature', value: fd.weather ? esc(fmtTemp(fd.weather.temperature, unitSystem)) : '—' });
  if (fc.windSpeed) wxItems.push({ label: 'Wind', value: fd.weather ? esc(fmtWindSpeed(fd.weather.windSpeed, unitSystem)) : '—' });
  if (fc.windGusts) wxItems.push({ label: 'Gusts', value: fd.weather ? esc(fmtWindSpeed(fd.weather.windGusts, unitSystem)) : '—' });
  if (fc.humidity) wxItems.push({ label: 'Humidity', value: fd.weather && fd.weather.humidity != null ? `${fd.weather.humidity}%` : '—' });
  if (fc.cloudCover) wxItems.push({ label: 'Clouds', value: fd.weather && fd.weather.cloudCover != null ? `${fd.weather.cloudCover}%` : '—' });
  if (fc.precipitation) wxItems.push({ label: 'Precipitation', value: fd.weather ? esc(fmtPrecip(fd.weather.precipitation, unitSystem)) : '—' });
  if (fc.pressure) wxItems.push({ label: 'Pressure', value: fd.weather ? esc(fmtPressure(fd.weather.pressure, unitSystem)) : '—' });
  if (wxItems.length > 0 && wxItems.some((i) => i.value !== '—')) groups.push({ group: 'Weather', items: wxItems });

  // Media
  const mediaItems: { label: string; value: string }[] = [];
  if (fc.photoCount) mediaItems.push({ label: 'Photos', value: fd.flight.photoCount != null && fd.flight.photoCount > 0 ? String(fd.flight.photoCount) : '—' });
  if (fc.videoCount) mediaItems.push({ label: 'Videos', value: fd.flight.videoCount != null && fd.flight.videoCount > 0 ? String(fd.flight.videoCount) : '—' });
  if (mediaItems.length > 0) groups.push({ group: 'Media', items: mediaItems });

  return groups;
}

// Calendar SVG icon (inline, no emoji)
const CALENDAR_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:6px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

export function buildHtmlReport(
  flightsData: FlightReportData[],
  options: ReportOptions,
): string {
  const {
    documentTitle,
    pilotName,
    fieldConfig: fc,
    unitSystem,
  } = options;

  // Group flights by day
  type DayGroup = { date: string; dateLabel: string; flights: FlightReportData[] };
  const dayMap = new Map<string, DayGroup>();
  for (const fd of flightsData) {
    const dateKey = fmtDateShort(fd.flight.startTime) || 'Unknown';
    const dateLabel = fmtDateHeader(fd.flight.startTime) || 'Unknown Date';
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, { date: dateKey, dateLabel, flights: [] });
    dayMap.get(dateKey)!.flights.push(fd);
  }
  const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const totalFlights = flightsData.length;
  const totalDuration = flightsData.reduce((sum, fd) => sum + (fd.flight.durationSecs || 0), 0);
  const totalDistanceM = flightsData.reduce((sum, fd) => sum + (fd.flight.totalDistance || 0), 0);
  const now = fmtNow();

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(documentTitle)}</title>
<style>
  :root {
    --primary: #0ea5e9;
    --primary-light: #e0f2fe;
    --bg: #ffffff;
    --text: #1e293b;
    --text-secondary: #64748b;
    --border: #e2e8f0;
    --header-bg: #f8fafc;
    --row-alt: #f1f5f9;
    --day-header-bg: #0f172a;
    --day-header-text: #ffffff;
    --subtotal-bg: #e0f2fe;
    --grand-total-bg: #0ea5e9;
    --grand-total-text: #ffffff;
    --card-bg: #ffffff;
    --card-border: #e2e8f0;
    --group-label-bg: #f1f5f9;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: 11px;
    color: var(--text);
    background: var(--bg);
    line-height: 1.5;
  }
  .report-container {
    max-width: 210mm; /* A4 width */
    margin: 0 auto;
    padding: 20px 24px;
  }

  /* Header */
  .report-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 3px solid var(--primary);
  }
  .report-header h1 {
    font-size: 20px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 2px;
  }
  .report-header .subtitle {
    font-size: 11px;
    color: var(--text-secondary);
    font-weight: 400;
    font-style: italic;
  }
  .report-header .meta {
    text-align: right;
    font-size: 10px;
    color: var(--text-secondary);
    line-height: 1.8;
  }
  .report-header .meta strong { color: var(--text); }

  /* Summary cards */
  .summary-row {
    display: flex;
    gap: 10px;
    margin-bottom: 16px;
  }
  .summary-card {
    flex: 1;
    background: var(--header-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    text-align: center;
  }
  .summary-card .value {
    font-size: 18px;
    font-weight: 700;
    color: var(--primary);
  }
  .summary-card .label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin-top: 2px;
  }

  /* Day header */
  .day-header {
    background: var(--day-header-bg);
    color: var(--day-header-text);
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 700;
    margin-top: 14px;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Flight card */
  .flight-card {
    border: 1px solid var(--card-border);
    border-radius: 5px;
    margin-bottom: 6px;
    overflow: hidden;
    background: var(--card-bg);
    page-break-inside: avoid;
  }
  .flight-card-header {
    background: var(--primary);
    color: white;
    padding: 3px 10px;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .flight-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.25);
    border-radius: 3px;
    width: 20px;
    height: 18px;
    font-size: 9px;
    font-weight: 700;
  }

  /* Grouped fields inside flight card — single compact row */
  .flight-groups {
    display: flex;
    flex-wrap: nowrap;
    gap: 0;
    overflow: hidden;
  }
  .field-group {
    flex: 1 1 0;
    min-width: 0;
    border-right: 1px solid var(--border);
  }
  .field-group:last-child { border-right: none; }
  .field-group-label {
    background: var(--group-label-bg);
    padding: 2px 8px;
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .field-group-items {
    display: flex;
    flex-wrap: wrap;
    padding: 2px 4px;
    gap: 0;
  }
  .field-item {
    padding: 1px 4px;
    min-width: 90px;
    flex: 1 1 auto;
  }
  .field-item .fl { font-size: 7px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; line-height: 1.3; }
  .field-item .fv { font-size: 9px; font-weight: 600; color: var(--text); line-height: 1.3; }

  /* Subtotal */
  .subtotal {
    background: var(--subtotal-bg);
    padding: 6px 14px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    margin-bottom: 4px;
    color: var(--text);
  }

  /* Grand total */
  .grand-total {
    background: var(--grand-total-bg);
    color: var(--grand-total-text);
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    margin-top: 12px;
  }

  /* Footer */
  .report-footer {
    margin-top: 20px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--text-secondary);
    font-size: 10px;
  }
  .report-footer a {
    color: var(--primary);
    text-decoration: none;
    font-weight: 600;
  }
  .report-footer a:hover { text-decoration: underline; }
  .report-footer .branding {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .report-footer .branding svg { width: 16px; height: 16px; }

  /* Print styles */
  @media print {
    body { font-size: 9px; }
    .report-container { padding: 0; max-width: 100%; }
    .summary-card .value { font-size: 15px; }
    .day-header { page-break-after: avoid; }
    .flight-card { page-break-inside: avoid; }
    @page { size: A4; margin: 10mm; }
  }
</style>
</head>
<body>
<div class="report-container">

  <!-- Header -->
  <div class="report-header">
    <div>
      <h1>${esc(documentTitle)}</h1>
      <div class="subtitle">Comprehensive drone flights summary</div>
    </div>
    <div class="meta">
      <div><strong>Pilot:</strong> ${esc(pilotName)}</div>
      <div><strong>Reported Flights:</strong> ${totalFlights}</div>
      <div><strong>Total Air Time:</strong> ${esc(fmtDuration(totalDuration))}</div>
      <div><strong>Total Distance:</strong> ${esc(fmtDistance(totalDistanceM, unitSystem))}</div>
      <div><strong>Generated:</strong> ${esc(now)}</div>
    </div>
  </div>

  <!-- Summary cards -->
  <div class="summary-row">
    <div class="summary-card">
      <div class="value">${totalFlights}</div>
      <div class="label">Total Flights</div>
    </div>
    <div class="summary-card">
      <div class="value">${esc(fmtDuration(totalDuration))}</div>
      <div class="label">Total Air Time</div>
    </div>
    <div class="summary-card">
      <div class="value">${esc(fmtDistance(totalDistanceM, unitSystem))}</div>
      <div class="label">Total Distance</div>
    </div>
    <div class="summary-card">
      <div class="value">${days.length}</div>
      <div class="label">Flight Days</div>
    </div>
  </div>

`;

  let globalFlightIndex = 0;

  for (const day of days) {
    // Day header
    html += `  <div class="day-header">${CALENDAR_SVG} ${esc(day.dateLabel)} — ${day.flights.length} flight${day.flights.length !== 1 ? 's' : ''}</div>\n`;

    for (const fd of day.flights) {
      globalFlightIndex++;
      const flightGroups = buildFlightItems(fd, fc, unitSystem);
      const headerLabel = fd.flight.displayName || fd.flight.fileName || `Flight ${globalFlightIndex}`;

      html += `  <div class="flight-card">
    <div class="flight-card-header">
      <span class="flight-num">${globalFlightIndex}</span>
      ${esc(headerLabel)}
    </div>
    <div class="flight-groups">\n`;

      for (const grp of flightGroups) {
        html += `      <div class="field-group">
        <div class="field-group-label">${esc(grp.group)}</div>
        <div class="field-group-items">\n`;
        for (const item of grp.items) {
          html += `          <div class="field-item"><div class="fl">${item.label}</div><div class="fv">${item.value}</div></div>\n`;
        }
        html += `        </div>
      </div>\n`;
      }

      html += `    </div>
  </div>\n`;
    }

    // Day subtotal
    const dayDuration = day.flights.reduce((s, fd) => s + (fd.flight.durationSecs || 0), 0);
    const dayDistance = day.flights.reduce((s, fd) => s + (fd.flight.totalDistance || 0), 0);
    html += `  <div class="subtotal">Subtotal: ${day.flights.length} flight${day.flights.length !== 1 ? 's' : ''} · ${esc(fmtDuration(dayDuration))} · ${esc(fmtDistance(dayDistance, unitSystem))}</div>\n`;
  }

  // Grand total
  html += `  <div class="grand-total">Grand Total: ${totalFlights} flights · ${esc(fmtDuration(totalDuration))} · ${esc(fmtDistance(totalDistanceM, unitSystem))}</div>\n`;

  // Footer
  html += `
  <div class="report-footer">
    <div>Generated on ${esc(now)}</div>
    <div class="branding">
      <svg viewBox="0 0 512 512" fill="currentColor" style="width:18px;height:18px">
        <path d="M256 0C114.6 0 0 114.6 0 256s114.6 256 256 256 256-114.6 256-256S397.4 0 256 0zm0 472c-119.1 0-216-96.9-216-216S136.9 40 256 40s216 96.9 216 216-96.9 216-216 216z"/>
        <circle cx="256" cy="256" r="40"/>
        <path d="M256 120c-12 0-22 8-24 20l-8 76c-1 8 2 16 8 22s14 9 22 9h4c8 0 16-3 22-9s9-14 8-22l-8-76c-2-12-12-20-24-20z" transform="rotate(0 256 256)"/>
        <path d="M256 120c-12 0-22 8-24 20l-8 76c-1 8 2 16 8 22s14 9 22 9h4c8 0 16-3 22-9s9-14 8-22l-8-76c-2-12-12-20-24-20z" transform="rotate(90 256 256)"/>
        <path d="M256 120c-12 0-22 8-24 20l-8 76c-1 8 2 16 8 22s14 9 22 9h4c8 0 16-3 22-9s9-14 8-22l-8-76c-2-12-12-20-24-20z" transform="rotate(180 256 256)"/>
        <path d="M256 120c-12 0-22 8-24 20l-8 76c-1 8 2 16 8 22s14 9 22 9h4c8 0 16-3 22-9s9-14 8-22l-8-76c-2-12-12-20-24-20z" transform="rotate(270 256 256)"/>
      </svg>
      Generated with <a href="https://opendronelog.com" target="_blank" rel="noopener noreferrer">Open Dronelog</a> (opendronelog.com)
    </div>
  </div>

</div>
</body>
</html>`;

  return html;
}

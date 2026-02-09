/**
 * Flight statistics bar component
 * Displays key metrics for the selected flight
 */

import type { FlightDataResponse } from '@/types';
import { isWebMode, downloadFile } from '@/lib/api';
import { useMemo, useState } from 'react';
import { WeatherModal } from './WeatherModal';
import weatherIcon from '@/assets/weather-icon.svg';
import {
  formatDuration,
  formatDistance,
  formatSpeed,
  formatAltitude,
  formatDateTime,
} from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';

interface FlightStatsProps {
  data: FlightDataResponse;
}

export function FlightStats({ data }: FlightStatsProps) {
  const { flight, telemetry } = data;
  const { unitSystem, getBatteryDisplayName } = useFlightStore();
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isWeatherOpen, setIsWeatherOpen] = useState(false);

  // Calculate min battery from telemetry
  const minBattery = telemetry.battery.reduce<number | null>((min, val) => {
    if (val === null) return min;
    if (min === null) return val;
    return val < min ? val : min;
  }, null);

  const exportOptions = useMemo(
    () => [
      { id: 'csv', label: 'CSV', extension: 'csv' },
      { id: 'json', label: 'JSON', extension: 'json' },
      { id: 'gpx', label: 'GPX', extension: 'gpx' },
      { id: 'kml', label: 'KML', extension: 'kml' },
    ],
    []
  );

  const buildCsv = () => {
    const trackAligned = data.track.length === telemetry.time.length;
    const latSeries = telemetry.latitude ?? [];
    const lngSeries = telemetry.longitude ?? [];
    const distanceToHome = computeDistanceToHomeSeries(telemetry);
    const headers = [
      'time_s',
      'lat',
      'lng',
      'alt_m',
      'distance_to_home_m',
      'height_m',
      'vps_height_m',
      'altitude_m',
      'speed_ms',
      'velocity_x_ms',
      'velocity_y_ms',
      'velocity_z_ms',
      'battery_percent',
      'battery_voltage_v',
      'battery_temp_c',
      'satellites',
      'rc_signal',
      'rc_uplink',
      'rc_downlink',
      'pitch_deg',
      'roll_deg',
      'yaw_deg',
    ];

    const escapeCsv = (value: string) => {
      if (value.includes('"')) value = value.replace(/"/g, '""');
      if (value.includes(',') || value.includes('\n') || value.includes('\r')) {
        return `"${value}"`;
      }
      return value;
    };

    const getValue = (arr: (number | null)[] | undefined, index: number) => {
      const val = arr?.[index];
      return val === null || val === undefined ? '' : String(val);
    };

    const rows = telemetry.time.map((time, index) => {
      const track = trackAligned ? data.track[index] : null;
      const lat = track ? track[1] : latSeries[index];
      const lng = track ? track[0] : lngSeries[index];
      const alt = track ? track[2] : '';
      const values = [
        String(time),
        lat === null || lat === undefined ? '' : String(lat),
        lng === null || lng === undefined ? '' : String(lng),
        alt === null || alt === undefined ? '' : String(alt),
        distanceToHome[index] === null || distanceToHome[index] === undefined
          ? ''
          : String(distanceToHome[index]),
        getValue(telemetry.height, index),
        getValue(telemetry.vpsHeight, index),
        getValue(telemetry.altitude, index),
        getValue(telemetry.speed, index),
        getValue(telemetry.velocityX, index),
        getValue(telemetry.velocityY, index),
        getValue(telemetry.velocityZ, index),
        getValue(telemetry.battery, index),
        getValue(telemetry.batteryVoltage, index),
        getValue(telemetry.batteryTemp, index),
        getValue(telemetry.satellites, index),
        getValue(telemetry.rcSignal, index),
        getValue(telemetry.rcUplink, index),
        getValue(telemetry.rcDownlink, index),
        getValue(telemetry.pitch, index),
        getValue(telemetry.roll, index),
        getValue(telemetry.yaw, index),
      ].map(escapeCsv);
      return values.join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  };

  const buildJson = () => {
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        flight,
        telemetry,
        track: data.track,
        derived: {
          distanceToHome: computeDistanceToHomeSeries(telemetry),
        },
      },
      null,
      2
    );
  };

  const buildGpx = () => {
    const name = flight.displayName || flight.fileName || 'DJI Flight';
    const points = data.track
      .map(([lng, lat, alt]) => {
        return `      <trkpt lat="${lat}" lon="${lng}"><ele>${alt}</ele></trkpt>`;
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="DJI Logbook" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${escapeXml(name)}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
  };

  const buildKml = () => {
    const name = flight.displayName || flight.fileName || 'DJI Flight';
    const coordinates = data.track
      .map(([lng, lat, alt]) => `${lng},${lat},${alt}`)
      .join(' ');
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <Placemark>
      <name>${escapeXml(name)}</name>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
  };

  const escapeXml = (value: string) => {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  const handleExport = async (format: string, extension: string) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const baseName = (flight.displayName || flight.fileName || 'flight')
        .replace(/[^a-z0-9-_]+/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);

      let content = '';
      switch (format) {
        case 'csv':
          content = buildCsv();
          break;
        case 'json':
          content = buildJson();
          break;
        case 'gpx':
          content = buildGpx();
          break;
        case 'kml':
          content = buildKml();
          break;
        default:
          return;
      }

      const filename = `${baseName || 'flight'}.${extension}`;

      if (isWebMode()) {
        downloadFile(filename, content);
      } else {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        const filePath = await save({
          defaultPath: filename,
          filters: [{ name: format.toUpperCase(), extensions: [extension] }],
        });
        if (!filePath) return;
        await writeTextFile(filePath, content);
      }
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="bg-dji-secondary border-b border-gray-700 px-4 py-3">
      {/* Flight Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-lg font-semibold text-white">
            {flight.displayName || flight.fileName}
          </h2>
          {flight.droneModel && !flight.droneModel.startsWith('Unknown') && (
            <p className="text-xs text-gray-500 mt-2">
              {flight.droneModel}
            </p>
          )}
          <div className="text-sm text-gray-400 flex flex-wrap items-center gap-2 mt-2">
            {formatDateTime(flight.startTime)}
            {flight.aircraftName && (
              <span className="px-2 py-0.5 rounded-full text-xs border border-dji-primary/40 text-dji-primary bg-dji-primary/10">
                Device: {flight.aircraftName}
              </span>
            )}
            {flight.droneSerial && (
              <span className="px-2 py-0.5 rounded-full text-xs border border-gray-600/60 text-gray-400 bg-dji-surface/60">
                SN: {flight.droneSerial}
              </span>
            )}
            {flight.batterySerial && (
              <span className="px-2 py-0.5 rounded-full text-xs border border-dji-accent/40 text-dji-accent bg-dji-accent/10">
                Battery: {getBatteryDisplayName(flight.batterySerial)}
              </span>
            )}
          </div>
        </div>

        <div className="text-right">
          <p className="text-xs text-gray-500">
            {flight.pointCount?.toLocaleString() || 0} data points
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_auto_auto] gap-2">
        <StatCard
          label="Duration"
          value={formatDuration(flight.durationSecs)}
          icon={<ClockIcon />}
        />
        <StatCard
          label="Distance"
          value={formatDistance(flight.totalDistance, unitSystem)}
          icon={<DistanceIcon />}
        />
        <StatCard
          label="Max Height"
          value={formatAltitude(flight.maxAltitude, unitSystem)}
          icon={<AltitudeIcon />}
        />
        <StatCard
          label="Max Speed"
          value={formatSpeed(flight.maxSpeed, unitSystem)}
          icon={<SpeedIcon />}
        />
        <StatCard
          label="Min Battery"
          value={minBattery !== null ? `${minBattery}%` : '--'}
          icon={<BatteryIcon percent={minBattery} />}
          alert={minBattery !== null && minBattery < 20}
        />
        {/* Weather button */}
        <button
          type="button"
          onClick={() => setIsWeatherOpen(true)}
          disabled={!flight.homeLat || !flight.homeLon || !flight.startTime}
          title="Flight weather"
          className="h-full min-h-[52px] w-[62px] flex items-center justify-center rounded-lg border-2 border-sky-500/70 text-sky-400 transition-all duration-200 hover:bg-sky-500 hover:text-white hover:shadow-md disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-sky-400"
        >
          <WeatherBtnIcon />
        </button>
        <div className="relative justify-self-end">
          <button
            type="button"
            onClick={() => setIsExportOpen((open) => !open)}
            className="w-[126px] h-full min-h-[52px] flex items-center justify-center gap-2 rounded-lg border-2 border-dji-accent/70 text-dji-accent text-sm font-semibold px-2 transition-all duration-200 hover:bg-dji-accent hover:text-white hover:shadow-md"
          >
            <ExportIcon />
            {isExporting ? 'Exporting...' : 'Export'}
            <ChevronIcon />
          </button>
          {isExportOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setIsExportOpen(false)}
              />
              <div className="themed-select-dropdown absolute right-0 top-full z-50 mt-2 w-40 rounded-xl border border-gray-700 p-1 shadow-xl">
                {exportOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setIsExportOpen(false);
                      handleExport(option.id, option.extension);
                    }}
                    className="themed-select-option w-full text-left px-3 py-2 text-xs rounded-lg transition-colors"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Weather Modal */}
      {flight.homeLat != null && flight.homeLon != null && flight.startTime && (
        <WeatherModal
          isOpen={isWeatherOpen}
          onClose={() => setIsWeatherOpen(false)}
          lat={flight.homeLat}
          lon={flight.homeLon}
          startTime={flight.startTime}
          unitSystem={unitSystem}
        />
      )}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  alert?: boolean;
}

function StatCard({ label, value, icon, alert }: StatCardProps) {
  return (
    <div className="bg-dji-surface/50 rounded-lg px-3 py-2 border border-gray-700/50 text-center">
      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center justify-center gap-2">
          <div className={`${alert ? 'text-red-400' : 'text-dji-primary'}`}>
            {icon}
          </div>
          <p
            className={`text-lg font-semibold ${
              alert ? 'text-red-400' : 'text-white'
            }`}
          >
            {value}
          </p>
        </div>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}

function ClockIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function DistanceIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
      />
    </svg>
  );
}

function AltitudeIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M7 11l5-5m0 0l5 5m-5-5v12"
      />
    </svg>
  );
}

function SpeedIcon() {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 10V3L4 14h7v7l9-11h-7z"
      />
    </svg>
  );
}

function BatteryIcon({ percent }: { percent: number | null }) {
  const fill = percent !== null ? Math.max(0, Math.min(100, percent)) : 50;
  const color =
    fill < 20 ? 'text-red-400' : fill < 50 ? 'text-yellow-400' : 'text-green-400';

  return (
    <svg className={`w-5 h-5 ${color}`} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 4h-3V2h-4v2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V6a2 2 0 00-2-2zM7 22V6h10v16H7z" />
      <rect
        x="8"
        y={22 - (fill / 100) * 15}
        width="8"
        height={(fill / 100) * 15}
        rx="1"
      />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 5v10m0 0l-4-4m4 4l4-4M4 19h16"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 9l-7 7-7-7"
      />
    </svg>
  );
}

function WeatherBtnIcon() {
  return <img src={weatherIcon} alt="Weather" className="w-[25px] h-[25px]" />;
}

function computeDistanceToHomeSeries(telemetry: FlightDataResponse['telemetry']) {
  const lats = telemetry.latitude ?? [];
  const lngs = telemetry.longitude ?? [];
  let homeLat: number | null = null;
  let homeLng: number | null = null;
  for (let i = 0; i < lats.length; i += 1) {
    const lat = lats[i];
    const lng = lngs[i];
    if (typeof lat === 'number' && typeof lng === 'number') {
      homeLat = lat;
      homeLng = lng;
      break;
    }
  }
  if (homeLat === null || homeLng === null) {
    return telemetry.time.map(() => null);
  }

  return telemetry.time.map((_, index) => {
    const lat = lats[index];
    const lng = lngs[index];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return haversineDistance(homeLat, homeLng, lat, lng);
  });
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}


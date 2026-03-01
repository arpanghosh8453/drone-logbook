/**
 * Shared export utilities for flight data
 * Used by FlightStats.tsx, FlightList.tsx, and any other components that export flight data
 */

import type { FlightDataResponse, TelemetryData } from '@/types';

declare const __APP_VERSION__: string;

/**
 * Escape a string value for CSV output
 */
export function escapeCsv(value: string): string {
  if (value.includes('"')) value = value.replace(/"/g, '""');
  if (value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value}"`;
  }
  return value;
}

/**
 * Escape a string for XML/GPX/KML output
 */
export function escapeXml(str: string | number | null | undefined): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Compute distance to home for each telemetry point
 */
export function computeDistanceToHomeSeries(telemetry: TelemetryData): (number | null)[] {
  const lats = telemetry.latitude ?? [];
  const lngs = telemetry.longitude ?? [];

  // Find first valid coordinate as home
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

  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371000; // Earth radius in meters

  return telemetry.time.map((_, index) => {
    const lat = lats[index];
    const lng = lngs[index];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const dLat = toRad(lat - homeLat);
    const dLon = toRad(lng - homeLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(homeLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return r * c;
  });
}

/**
 * Build CSV export string from flight data
 */
export function buildCsv(data: FlightDataResponse): string {
  const { telemetry, flight } = data;

  // Build metadata JSON for the first row's metadata column
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
  const metadata: Record<string, string | number | null | Array<{ tag: string; tag_type: string }>> = {
    format: 'Drone Logbook CSV Export',
    app_version: appVersion,
    exported_at: new Date().toISOString(),
    display_name: flight.displayName,
    drone_model: flight.droneModel,
    drone_serial: flight.droneSerial,
    aircraft_name: flight.aircraftName,
    battery_serial: flight.batterySerial,
    start_time: flight.startTime,
    duration_secs: flight.durationSecs,
    total_distance_m: flight.totalDistance,
    max_altitude_m: flight.maxAltitude,
    max_speed_ms: flight.maxSpeed,
    home_lat: flight.homeLat ?? null,
    home_lon: flight.homeLon ?? null,
    notes: flight.notes ?? null,
    tags: flight.tags?.map((t) => ({ tag: t.tag, tag_type: t.tagType })) ?? null,
  };
  // Remove null values for cleaner JSON
  const cleanMetadata = Object.fromEntries(Object.entries(metadata).filter(([_, v]) => v != null));
  const metadataJson = JSON.stringify(cleanMetadata);

  // Build messages JSON for the first row's messages column
  const messagesJson =
    data.messages && data.messages.length > 0
      ? JSON.stringify(
          data.messages.map((m) => ({
            timestamp_ms: m.timestampMs,
            type: m.messageType,
            message: m.message,
          }))
        )
      : '';

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
    'cell_voltages',
    'satellites',
    'rc_signal',
    'rc_uplink',
    'rc_downlink',
    'pitch_deg',
    'roll_deg',
    'yaw_deg',
    'rc_aileron',
    'rc_elevator',
    'rc_throttle',
    'rc_rudder',
    'is_photo',
    'is_video',
    'flight_mode',
    'messages',
    'metadata',
  ];

  // Handle manual entries with no telemetry - create single row with home coordinates
  if (!telemetry.time || telemetry.time.length === 0) {
    const homeLat = flight.homeLat ?? '';
    const homeLon = flight.homeLon ?? '';
    const singleRow = [
      '0', // time_s
      String(homeLat),
      String(homeLon),
      flight.maxAltitude != null ? String(flight.maxAltitude) : '',
      '0', // distance_to_home at takeoff
      '', '', // height, vps_height
      flight.maxAltitude != null ? String(flight.maxAltitude) : '',
      '', '', '', '', // speed, velocities
      '', '', '', '', // battery_percent, battery_voltage_v, battery_temp_c, cell_voltages
      '', // satellites
      '', '', '', // rc_signal, rc_uplink, rc_downlink
      '', '', '', // pitch, roll, yaw
      '', '', '', '', // rc controls
      '', '', '', // is_photo, is_video, flight_mode
      escapeCsv(messagesJson),
      escapeCsv(metadataJson),
    ].join(',');
    return [headers.join(','), singleRow].join('\n');
  }

  const trackAligned = data.track.length === telemetry.time.length;
  const latSeries = telemetry.latitude ?? [];
  const lngSeries = telemetry.longitude ?? [];
  const distanceToHome = computeDistanceToHomeSeries(telemetry);

  /**
   * Format a numeric value with appropriate precision for CSV export.
   * Lat/lng use full precision (DOUBLE in DB), other values use limited precision
   * since they're stored as FLOAT (7 significant digits).
   */
  const formatNum = (val: number | null | undefined, decimals: number): string => {
    if (val === null || val === undefined) return '';
    // Round to specified decimals to avoid FLOAT representation artifacts
    return Number(val.toFixed(decimals)).toString();
  };

  /** Coordinates need full precision (DOUBLE in DB) */
  const formatCoord = (val: number | null | undefined): string => {
    if (val === null || val === undefined) return '';
    return String(val); // Keep full precision for lat/lng
  };

  const getValue = (arr: (number | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : String(val);
  };

  /** Format telemetry value with appropriate precision based on field type */
  const getMetric = (arr: (number | null)[] | undefined, index: number, decimals = 2): string => {
    const val = arr?.[index];
    return formatNum(val, decimals);
  };

  const getBoolValue = (arr: (boolean | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : val ? '1' : '0';
  };

  const getStrValue = (arr: (string | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : val;
  };

  /** Format array of voltages with 3 decimal precision */
  const getArrayValue = (arr: (number[] | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    if (val === null || val === undefined) return '';
    // Round each voltage to 3 decimals to avoid FLOAT artifacts
    const formatted = val.map((v) => Number(v.toFixed(3)));
    return JSON.stringify(formatted);
  };

  const rows = telemetry.time.map((time, index) => {
    const track = trackAligned ? data.track[index] : null;
    const lat = track ? track[1] : latSeries[index];
    const lng = track ? track[0] : lngSeries[index];
    const alt = track ? track[2] : null;
    // telemetry.time is in seconds (converted from ms in backend)
    // Preserve sub-second resolution: 0.0, 0.1, 0.2... for 10Hz data
    const values = [
      time % 1 === 0 ? String(time) : time.toFixed(1),
      formatCoord(lat),                              // lat - full precision (DOUBLE)
      formatCoord(lng),                              // lng - full precision (DOUBLE)
      formatNum(alt, 2),                             // alt_m
      formatNum(distanceToHome[index], 2),           // distance_to_home_m
      getMetric(telemetry.height, index, 2),         // height_m
      getMetric(telemetry.vpsHeight, index, 2),      // vps_height_m
      getMetric(telemetry.altitude, index, 2),       // altitude_m
      getMetric(telemetry.speed, index, 2),          // speed_ms
      getMetric(telemetry.velocityX, index, 2),      // velocity_x_ms
      getMetric(telemetry.velocityY, index, 2),      // velocity_y_ms
      getMetric(telemetry.velocityZ, index, 2),      // velocity_z_ms
      getValue(telemetry.battery, index),            // battery_percent (integer)
      getMetric(telemetry.batteryVoltage, index, 3), // battery_voltage_v
      getMetric(telemetry.batteryTemp, index, 1),    // battery_temp_c
      getArrayValue(telemetry.cellVoltages, index),  // cell_voltages (JSON)
      getValue(telemetry.satellites, index),         // satellites (integer)
      getValue(telemetry.rcSignal, index),           // rc_signal (integer)
      getValue(telemetry.rcUplink, index),           // rc_uplink (integer)
      getValue(telemetry.rcDownlink, index),         // rc_downlink (integer)
      getMetric(telemetry.pitch, index, 2),          // pitch_deg
      getMetric(telemetry.roll, index, 2),           // roll_deg
      getMetric(telemetry.yaw, index, 2),            // yaw_deg
      getMetric(telemetry.rcAileron, index, 1),      // rc_aileron
      getMetric(telemetry.rcElevator, index, 1),     // rc_elevator
      getMetric(telemetry.rcThrottle, index, 1),     // rc_throttle
      getMetric(telemetry.rcRudder, index, 1),       // rc_rudder
      getBoolValue(telemetry.isPhoto, index),
      getBoolValue(telemetry.isVideo, index),
      getStrValue(telemetry.flightMode, index),
      // Messages and Metadata JSON only on first row (time 0)
      index === 0 ? messagesJson : '',
      index === 0 ? metadataJson : '',
    ].map(escapeCsv);
    return values.join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Build JSON export string from flight data
 */
export function buildJson(data: FlightDataResponse): string {
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
  const exportData = {
    _exportInfo: {
      format: 'Drone Logbook JSON Export',
      appVersion,
      exportedAt: new Date().toISOString(),
    },
    flight: data.flight,
    telemetry: data.telemetry,
    track: data.track,
    messages: data.messages,
    derived: {
      distanceToHome: computeDistanceToHomeSeries(data.telemetry),
    },
  };
  return JSON.stringify(exportData, null, 2);
}

/**
 * Build GPX export string from flight data
 */
export function buildGpx(data: FlightDataResponse): string {
  const { flight, telemetry, track } = data;
  const flightName = escapeXml(flight.displayName || flight.fileName || 'Flight');

  // Handle manual entries with no telemetry - create waypoint at home location
  if (!telemetry.time || telemetry.time.length === 0) {
    if (flight.homeLat != null && flight.homeLon != null) {
      const timeStr = flight.startTime ? `<time>${new Date(flight.startTime).toISOString()}</time>` : '';
      const eleStr = flight.maxAltitude != null ? `<ele>${flight.maxAltitude}</ele>` : '';
      return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Drone Logbook">
  <wpt lat="${flight.homeLat}" lon="${flight.homeLon}">
    <name>${flightName}</name>
    ${eleStr}
    ${timeStr}
  </wpt>
</gpx>`;
    }
    // No location data at all
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Drone Logbook">
  <metadata>
    <name>${flightName}</name>
  </metadata>
</gpx>`;
  }

  // Build trackpoints from track array
  const startTimeMs = flight.startTime ? new Date(flight.startTime).getTime() : null;

  const trackpoints = track
    .map((point, index) => {
      const [lng, lat, ele] = point;
      if (lat == null || lng == null) return '';
      const timeMs = telemetry.time[index];
      const timeStr =
        startTimeMs != null && timeMs != null
          ? `<time>${new Date(startTimeMs + timeMs * 1000).toISOString()}</time>`
          : '';
      const eleStr = ele != null ? `<ele>${ele}</ele>` : '';
      return `      <trkpt lat="${lat}" lon="${lng}">
        ${eleStr}
        ${timeStr}
      </trkpt>`;
    })
    .filter(Boolean)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Drone Logbook">
  <trk>
    <name>${flightName}</name>
    <trkseg>
${trackpoints}
    </trkseg>
  </trk>
</gpx>`;
}

/**
 * Build KML export string from flight data
 */
export function buildKml(data: FlightDataResponse): string {
  const { flight, telemetry } = data;
  const flightName = escapeXml(flight.displayName || flight.fileName || 'Flight');

  // Handle manual entries with no telemetry - create placemark at home location
  if (!telemetry.time || telemetry.time.length === 0) {
    if (flight.homeLat != null && flight.homeLon != null) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
    <Placemark>
      <name>${flightName}</name>
      <Point>
        <coordinates>${flight.homeLon},${flight.homeLat},${flight.maxAltitude ?? 0}</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>`;
    }
    // No location data at all
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
  </Document>
</kml>`;
  }

  // Build coordinates string using absolute altitude from telemetry
  // (track uses relative height for map visualization)
  const lats = telemetry.latitude ?? [];
  const lngs = telemetry.longitude ?? [];
  const alts = telemetry.altitude ?? [];
  const heights = telemetry.height ?? [];
  const vpsHeights = telemetry.vpsHeight ?? [];

  const coordinates = lats
    .map((lat, i) => {
      const lng = lngs[i];
      if (lat == null || lng == null) return '';
      // Skip 0,0 points
      if (Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001) return '';
      // Use absolute altitude with fallbacks
      const ele = alts[i] ?? heights[i] ?? vpsHeights[i] ?? 0;
      return `${lng},${lat},${ele}`;
    })
    .filter(Boolean)
    .join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${flightName}</name>
    <Style id="flightPath">
      <LineStyle>
        <color>ff0080ff</color>
        <width>3</width>
      </LineStyle>
    </Style>
    <Placemark>
      <name>${flightName}</name>
      <styleUrl>#flightPath</styleUrl>
      <LineString>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

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

  const getValue = (arr: (number | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : String(val);
  };

  const getBoolValue = (arr: (boolean | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : val ? '1' : '0';
  };

  const getStrValue = (arr: (string | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : val;
  };

  const getArrayValue = (arr: (number[] | null)[] | undefined, index: number) => {
    const val = arr?.[index];
    return val === null || val === undefined ? '' : JSON.stringify(val);
  };

  const rows = telemetry.time.map((time, index) => {
    const track = trackAligned ? data.track[index] : null;
    const lat = track ? track[1] : latSeries[index];
    const lng = track ? track[0] : lngSeries[index];
    const alt = track ? track[2] : '';
    // telemetry.time is already in seconds (converted from ms in backend)
    const values = [
      String(Math.round(time)),
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
      getArrayValue(telemetry.cellVoltages, index),
      getValue(telemetry.satellites, index),
      getValue(telemetry.rcSignal, index),
      getValue(telemetry.rcUplink, index),
      getValue(telemetry.rcDownlink, index),
      getValue(telemetry.pitch, index),
      getValue(telemetry.roll, index),
      getValue(telemetry.yaw, index),
      getValue(telemetry.rcAileron, index),
      getValue(telemetry.rcElevator, index),
      getValue(telemetry.rcThrottle, index),
      getValue(telemetry.rcRudder, index),
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
  const { flight, telemetry, track } = data;
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

  // Build coordinates string from track
  const coordinates = track
    .map((point) => {
      const [lng, lat, ele] = point;
      if (lat == null || lng == null) return '';
      return `${lng},${lat},${ele ?? 0}`;
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
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

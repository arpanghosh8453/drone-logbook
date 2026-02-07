/**
 * TypeScript interfaces matching Rust models
 * These are the data shapes exchanged via Tauri IPC
 */

/** Flight metadata for list display */
export interface Flight {
  id: number;
  fileName: string;
  displayName: string;
  droneModel: string | null;
  droneSerial: string | null;
  aircraftName: string | null;
  batterySerial: string | null;
  startTime: string | null;
  durationSecs: number | null;
  totalDistance: number | null;
  maxAltitude: number | null;
  maxSpeed: number | null;
  homeLat?: number | null;
  homeLon?: number | null;
  pointCount: number | null;
}

/** Telemetry data formatted for ECharts */
export interface TelemetryData {
  /** Time in seconds from flight start */
  time: number[];
  latitude?: (number | null)[];
  longitude?: (number | null)[];
  altitude?: (number | null)[];
  height: (number | null)[];
  vpsHeight: (number | null)[];
  speed: (number | null)[];
  velocityX?: (number | null)[];
  velocityY?: (number | null)[];
  velocityZ?: (number | null)[];
  battery: (number | null)[];
  batteryVoltage: (number | null)[];
  batteryTemp: (number | null)[];
  satellites: (number | null)[];
  rcSignal: (number | null)[];
  rcUplink?: (number | null)[];
  rcDownlink?: (number | null)[];
  pitch: (number | null)[];
  roll: (number | null)[];
  yaw: (number | null)[];
}

/** Complete flight data response from backend */
export interface FlightDataResponse {
  flight: Flight;
  telemetry: TelemetryData;
  /** GPS track: [lng, lat, height][] */
  track: [number, number, number][];
}

export interface BatteryUsage {
  batterySerial: string;
  flightCount: number;
  totalDurationSecs: number;
}

export interface DroneUsage {
  droneModel: string;
  droneSerial: string | null;
  aircraftName: string | null;
  flightCount: number;
}

export interface FlightDateCount {
  date: string;
  count: number;
}

export interface TopFlight {
  id: number;
  displayName: string;
  durationSecs: number;
  startTime: string | null;
}

export interface TopDistanceFlight {
  id: number;
  displayName: string;
  maxDistanceFromHomeM: number;
  startTime: string | null;
}

export interface BatteryHealthPoint {
  flightId: number;
  batterySerial: string;
  startTime: string | null;
  durationMins: number;
  deltaPercent: number;
  ratePerMin: number;
}

export interface OverviewStats {
  totalFlights: number;
  totalDistanceM: number;
  totalDurationSecs: number;
  totalPoints: number;
  maxAltitudeM: number;
  maxDistanceFromHomeM: number;
  batteriesUsed: BatteryUsage[];
  dronesUsed: DroneUsage[];
  flightsByDate: FlightDateCount[];
  topFlights: TopFlight[];
  topDistanceFlights: TopDistanceFlight[];
  batteryHealthPoints: BatteryHealthPoint[];
}

/** Result from import_log command */
export interface ImportResult {
  success: boolean;
  flightId: number | null;
  message: string;
  pointCount: number;
}

/** Flight statistics */
export interface FlightStats {
  durationSecs: number;
  totalDistanceM: number;
  maxAltitudeM: number;
  maxSpeedMs: number;
  avgSpeedMs: number;
  minBattery: number;
  homeLocation: [number, number] | null;
}

/** Chart series configuration */
export interface ChartSeries {
  name: string;
  data: (number | null)[];
  color: string;
  unit: string;
  visible: boolean;
}

/** Map viewport state */
export interface MapViewport {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

//! Data models for the Drone Logbook application.
//!
//! These structs are shared between Rust backend and TypeScript frontend
//! via Tauri's IPC system with serde serialization.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Flight metadata stored in the flights table
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightMetadata {
    pub id: i64,
    pub file_name: String,
    pub display_name: String,
    pub file_hash: Option<String>,
    pub drone_model: Option<String>,
    pub drone_serial: Option<String>,
    pub aircraft_name: Option<String>,
    pub battery_serial: Option<String>,
    pub start_time: Option<DateTime<Utc>>,
    pub end_time: Option<DateTime<Utc>>,
    pub duration_secs: Option<f64>,
    pub total_distance: Option<f64>,
    pub max_altitude: Option<f64>,
    pub max_speed: Option<f64>,
    pub home_lat: Option<f64>,
    pub home_lon: Option<f64>,
    pub point_count: i32,
}

/// Flight summary for list display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flight {
    pub id: i64,
    pub file_name: String,
    pub display_name: String,
    pub file_hash: Option<String>,
    pub drone_model: Option<String>,
    pub drone_serial: Option<String>,
    pub aircraft_name: Option<String>,
    pub battery_serial: Option<String>,
    pub start_time: Option<String>,
    pub duration_secs: Option<f64>,
    pub total_distance: Option<f64>,
    pub max_altitude: Option<f64>,
    pub max_speed: Option<f64>,
    pub home_lat: Option<f64>,
    pub home_lon: Option<f64>,
    pub point_count: Option<i32>,
    #[serde(default)]
    pub tags: Vec<FlightTag>,
    pub notes: Option<String>,
}

/// A tag attached to a flight, with a type indicator
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightTag {
    pub tag: String,
    pub tag_type: String,  // "auto" or "manual"
}

/// Raw telemetry point from parser (for bulk insert)
#[derive(Debug, Clone, Default)]
pub struct TelemetryPoint {
    pub timestamp_ms: i64,

    // Position
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude: Option<f64>,
    pub height: Option<f64>,
    pub vps_height: Option<f64>,
    pub altitude_abs: Option<f64>,

    // Velocity
    pub speed: Option<f64>,
    pub velocity_x: Option<f64>,
    pub velocity_y: Option<f64>,
    pub velocity_z: Option<f64>,

    // Orientation
    pub pitch: Option<f64>,
    pub roll: Option<f64>,
    pub yaw: Option<f64>,

    // Gimbal
    pub gimbal_pitch: Option<f64>,
    pub gimbal_roll: Option<f64>,
    pub gimbal_yaw: Option<f64>,

    // Power
    pub battery_percent: Option<i32>,
    pub battery_voltage: Option<f64>,
    pub battery_current: Option<f64>,
    pub battery_temp: Option<f64>,
    pub cell_voltages: Option<Vec<f64>>,

    // Status
    pub flight_mode: Option<String>,
    pub gps_signal: Option<i32>,
    pub satellites: Option<i32>,
    pub rc_signal: Option<i32>,
    pub rc_uplink: Option<i32>,
    pub rc_downlink: Option<i32>,

    // RC stick inputs (normalized to -100..+100 percentage)
    pub rc_aileron: Option<f64>,
    pub rc_elevator: Option<f64>,
    pub rc_throttle: Option<f64>,
    pub rc_rudder: Option<f64>,

    // Camera state
    pub is_photo: Option<bool>,
    pub is_video: Option<bool>,
}

/// Telemetry record for frontend consumption (optimized for ECharts)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryRecord {
    pub timestamp_ms: i64,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub altitude: Option<f64>,
    pub height: Option<f64>,
    pub vps_height: Option<f64>,
    pub speed: Option<f64>,
    pub velocity_x: Option<f64>,
    pub velocity_y: Option<f64>,
    pub velocity_z: Option<f64>,
    pub battery_percent: Option<i32>,
    pub battery_voltage: Option<f64>,
    pub battery_temp: Option<f64>,
    pub cell_voltages: Option<Vec<f64>>,
    pub pitch: Option<f64>,
    pub roll: Option<f64>,
    pub yaw: Option<f64>,
    pub satellites: Option<i32>,
    pub flight_mode: Option<String>,
    pub rc_signal: Option<i32>,
    pub rc_uplink: Option<i32>,
    pub rc_downlink: Option<i32>,
    pub rc_aileron: Option<f64>,
    pub rc_elevator: Option<f64>,
    pub rc_throttle: Option<f64>,
    pub rc_rudder: Option<f64>,
    pub is_photo: Option<bool>,
    pub is_video: Option<bool>,
}

/// Flight message (tip or warning from DJI app)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightMessage {
    pub timestamp_ms: i64,
    pub message_type: String, // "tip" or "warn"
    pub message: String,
}

/// Response format optimized for ECharts rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDataResponse {
    pub flight: Flight,
    pub telemetry: TelemetryData,
    pub track: Vec<[f64; 3]>, // [lng, lat, height] for map
    pub messages: Vec<FlightMessage>,
}

/// Overview statistics across all flights
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewStats {
    pub total_flights: i64,
    pub total_distance_m: f64,
    pub total_duration_secs: f64,
    pub total_points: i64,
    pub max_altitude_m: f64,
    pub max_distance_from_home_m: f64,
    pub batteries_used: Vec<BatteryUsage>,
    pub drones_used: Vec<DroneUsage>,
    pub flights_by_date: Vec<FlightDateCount>,
    pub top_flights: Vec<TopFlight>,
    pub top_distance_flights: Vec<TopDistanceFlight>,
    pub battery_health_points: Vec<BatteryHealthPoint>,
}

/// Battery usage summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryUsage {
    pub battery_serial: String,
    pub flight_count: i64,
    /// Total flight duration for this battery in seconds
    pub total_duration_secs: f64,
}

/// Drone usage summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DroneUsage {
    pub drone_model: String,
    pub drone_serial: Option<String>,
    pub aircraft_name: Option<String>,
    pub flight_count: i64,
}

/// Flight count per date for activity heatmap
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDateCount {
    pub date: String,
    pub count: i64,
}

/// Top flight summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopFlight {
    pub id: i64,
    pub display_name: String,
    pub duration_secs: f64,
    pub start_time: Option<String>,
}

/// Top flight by max distance from home
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopDistanceFlight {
    pub id: i64,
    pub display_name: String,
    pub max_distance_from_home_m: f64,
    pub start_time: Option<String>,
}

/// Battery health scatter/line point per flight
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryHealthPoint {
    pub flight_id: i64,
    pub battery_serial: String,
    pub start_time: Option<String>,
    pub duration_mins: f64,
    pub delta_percent: f64,
    pub rate_per_min: f64,
}

/// Telemetry data formatted for ECharts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryData {
    /// Time axis in seconds from flight start
    pub time: Vec<f64>,
    /// Latitude series
    pub latitude: Vec<Option<f64>>,
    /// Longitude series
    pub longitude: Vec<Option<f64>>,
    /// Altitude series (legacy fallback)
    pub altitude: Vec<Option<f64>>,
    /// Height series
    pub height: Vec<Option<f64>>,
    /// VPS height series
    pub vps_height: Vec<Option<f64>>,
    /// Speed series
    pub speed: Vec<Option<f64>>,
    /// Velocity X series (north)
    pub velocity_x: Vec<Option<f64>>,
    /// Velocity Y series (east)
    pub velocity_y: Vec<Option<f64>>,
    /// Velocity Z series (down)
    pub velocity_z: Vec<Option<f64>>,
    /// Battery percent series
    pub battery: Vec<Option<i32>>,
    /// Battery voltage series
    pub battery_voltage: Vec<Option<f64>>,
    /// Battery temperature series
    pub battery_temp: Vec<Option<f64>>,
    /// Individual cell voltages series (JSON arrays stored as Vec)
    pub cell_voltages: Vec<Option<Vec<f64>>>,
    /// Number of GPS satellites
    pub satellites: Vec<Option<i32>>,
    /// RC signal strength
    pub rc_signal: Vec<Option<i32>>,
    /// RC uplink signal strength
    pub rc_uplink: Vec<Option<i32>>,
    /// RC downlink signal strength
    pub rc_downlink: Vec<Option<i32>>,
    /// Pitch angle
    pub pitch: Vec<Option<f64>>,
    /// Roll angle
    pub roll: Vec<Option<f64>>,
    /// Yaw/Heading
    pub yaw: Vec<Option<f64>>,
    /// RC aileron stick input (normalized -100..+100)
    pub rc_aileron: Vec<Option<f64>>,
    /// RC elevator stick input (normalized -100..+100)
    pub rc_elevator: Vec<Option<f64>>,
    /// RC throttle stick input (normalized -100..+100)
    pub rc_throttle: Vec<Option<f64>>,
    /// RC rudder stick input (normalized -100..+100)
    pub rc_rudder: Vec<Option<f64>>,
    /// Photo capture indicator (true when taking photo)
    pub is_photo: Vec<Option<bool>>,
    /// Video recording indicator (true when recording)
    pub is_video: Vec<Option<bool>>,
    /// Flight mode (e.g., "GPS", "ATTI", "Sport")
    pub flight_mode: Vec<Option<String>>,
}

impl TelemetryData {
    /// Create TelemetryData from a vector of TelemetryRecords
    ///
    /// Uses a single pass over the records to build all column vectors
    /// simultaneously, avoiding 20 separate iterator traversals.
    pub fn from_records(records: &[TelemetryRecord]) -> Self {
        let n = records.len();
        let base_time = records.first().map(|r| r.timestamp_ms).unwrap_or(0);

        let mut time = Vec::with_capacity(n);
        let mut latitude = Vec::with_capacity(n);
        let mut longitude = Vec::with_capacity(n);
        let mut altitude = Vec::with_capacity(n);
        let mut height = Vec::with_capacity(n);
        let mut vps_height = Vec::with_capacity(n);
        let mut speed = Vec::with_capacity(n);
        let mut velocity_x = Vec::with_capacity(n);
        let mut velocity_y = Vec::with_capacity(n);
        let mut velocity_z = Vec::with_capacity(n);
        let mut battery = Vec::with_capacity(n);
        let mut battery_voltage = Vec::with_capacity(n);
        let mut battery_temp = Vec::with_capacity(n);
        let mut cell_voltages = Vec::with_capacity(n);
        let mut satellites = Vec::with_capacity(n);
        let mut rc_signal = Vec::with_capacity(n);
        let mut rc_uplink = Vec::with_capacity(n);
        let mut rc_downlink = Vec::with_capacity(n);
        let mut pitch = Vec::with_capacity(n);
        let mut roll = Vec::with_capacity(n);
        let mut yaw = Vec::with_capacity(n);
        let mut rc_aileron = Vec::with_capacity(n);
        let mut rc_elevator = Vec::with_capacity(n);
        let mut rc_throttle = Vec::with_capacity(n);
        let mut rc_rudder = Vec::with_capacity(n);
        let mut is_photo = Vec::with_capacity(n);
        let mut is_video = Vec::with_capacity(n);
        let mut flight_mode = Vec::with_capacity(n);

        for r in records {
            time.push((r.timestamp_ms - base_time) as f64 / 1000.0);
            latitude.push(r.latitude);
            longitude.push(r.longitude);
            altitude.push(r.altitude);
            height.push(r.height);
            vps_height.push(r.vps_height);
            speed.push(r.speed);
            velocity_x.push(r.velocity_x);
            velocity_y.push(r.velocity_y);
            velocity_z.push(r.velocity_z);
            battery.push(r.battery_percent);
            battery_voltage.push(r.battery_voltage);
            battery_temp.push(r.battery_temp);
            cell_voltages.push(r.cell_voltages.clone());
            satellites.push(r.satellites);
            rc_signal.push(r.rc_signal);
            rc_uplink.push(r.rc_uplink);
            rc_downlink.push(r.rc_downlink);
            pitch.push(r.pitch);
            roll.push(r.roll);
            yaw.push(r.yaw);
            rc_aileron.push(r.rc_aileron);
            rc_elevator.push(r.rc_elevator);
            rc_throttle.push(r.rc_throttle);
            rc_rudder.push(r.rc_rudder);
            is_photo.push(r.is_photo);
            is_video.push(r.is_video);
            flight_mode.push(r.flight_mode.clone());
        }

        Self {
            time,
            latitude,
            longitude,
            altitude,
            height,
            vps_height,
            speed,
            velocity_x,
            velocity_y,
            velocity_z,
            battery,
            battery_voltage,
            battery_temp,
            cell_voltages,
            satellites,
            rc_signal,
            rc_uplink,
            rc_downlink,
            pitch,
            roll,
            yaw,
            rc_aileron,
            rc_elevator,
            rc_throttle,
            rc_rudder,
            is_photo,
            is_video,
            flight_mode,
        }
    }

    /// Extract a GPS track from the telemetry data for map visualization.
    ///
    /// Filters out null/zero coordinates and downsamples to `max_points`
    /// using uniform stride. Returns `[lng, lat, height]` triples.
    pub fn extract_track(&self, max_points: usize) -> Vec<[f64; 3]> {
        // Collect valid GPS points
        let valid: Vec<[f64; 3]> = self.latitude.iter()
            .zip(self.longitude.iter())
            .zip(self.height.iter().zip(self.vps_height.iter().zip(self.altitude.iter())))
            .filter_map(|((lat, lng), (h, (vps, alt)))| {
                let lat_v = (*lat)?;
                let lng_v = (*lng)?;
                // Skip 0,0 points
                if lat_v.abs() < 0.000001 && lng_v.abs() < 0.000001 {
                    return None;
                }
                let height_v = h.or(*vps).or(*alt).unwrap_or(0.0);
                Some([lng_v, lat_v, height_v])
            })
            .collect();

        if valid.len() <= max_points {
            return valid;
        }

        // Downsample with uniform stride
        let stride = valid.len() / max_points;
        valid.into_iter()
            .step_by(stride.max(1))
            .collect()
    }
}

/// Import result returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub success: bool,
    pub flight_id: Option<i64>,
    pub message: String,
    pub point_count: usize,
    pub file_hash: Option<String>,
}

/// Statistics for a flight
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightStats {
    pub duration_secs: f64,
    pub total_distance_m: f64,
    pub max_altitude_m: f64,
    pub max_speed_ms: f64,
    pub avg_speed_ms: f64,
    pub min_battery: i32,
    pub home_location: Option<[f64; 2]>,
    pub max_distance_from_home_m: f64,
    pub start_battery_percent: Option<i32>,
    pub end_battery_percent: Option<i32>,
    pub start_battery_temp: Option<f64>,
}

//! Data models for the DJI Log Viewer application.
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

    // Status
    pub flight_mode: Option<String>,
    pub gps_signal: Option<i32>,
    pub satellites: Option<i32>,
    pub rc_signal: Option<i32>,
    pub rc_uplink: Option<i32>,
    pub rc_downlink: Option<i32>,
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
    pub pitch: Option<f64>,
    pub roll: Option<f64>,
    pub yaw: Option<f64>,
    pub satellites: Option<i32>,
    pub flight_mode: Option<String>,
    pub rc_signal: Option<i32>,
    pub rc_uplink: Option<i32>,
    pub rc_downlink: Option<i32>,
}

/// Response format optimized for ECharts rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightDataResponse {
    pub flight: Flight,
    pub telemetry: TelemetryData,
    pub track: Vec<[f64; 3]>, // [lng, lat, height] for map
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
}

impl TelemetryData {
    /// Create TelemetryData from a vector of TelemetryRecords
    pub fn from_records(records: &[TelemetryRecord]) -> Self {
        let base_time = records.first().map(|r| r.timestamp_ms).unwrap_or(0);

        Self {
            time: records
                .iter()
                .map(|r| (r.timestamp_ms - base_time) as f64 / 1000.0)
                .collect(),
            latitude: records.iter().map(|r| r.latitude).collect(),
            longitude: records.iter().map(|r| r.longitude).collect(),
            altitude: records.iter().map(|r| r.altitude).collect(),
            height: records.iter().map(|r| r.height).collect(),
            vps_height: records.iter().map(|r| r.vps_height).collect(),
            speed: records.iter().map(|r| r.speed).collect(),
            velocity_x: records.iter().map(|r| r.velocity_x).collect(),
            velocity_y: records.iter().map(|r| r.velocity_y).collect(),
            velocity_z: records.iter().map(|r| r.velocity_z).collect(),
            battery: records.iter().map(|r| r.battery_percent).collect(),
            battery_voltage: records.iter().map(|r| r.battery_voltage).collect(),
            battery_temp: records.iter().map(|r| r.battery_temp).collect(),
            satellites: records.iter().map(|r| r.satellites).collect(),
            rc_signal: records.iter().map(|r| r.rc_signal).collect(),
            rc_uplink: records.iter().map(|r| r.rc_uplink).collect(),
            rc_downlink: records.iter().map(|r| r.rc_downlink).collect(),
            pitch: records.iter().map(|r| r.pitch).collect(),
            roll: records.iter().map(|r| r.roll).collect(),
            yaw: records.iter().map(|r| r.yaw).collect(),
        }
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
}

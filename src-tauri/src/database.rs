//! Database module for DuckDB connection and schema management.
//!
//! This module handles:
//! - DuckDB connection initialization in the app data directory
//! - Schema creation for flights and telemetry tables
//! - Optimized bulk inserts using Appender
//! - Downsampled query retrieval for large datasets

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use duckdb::{params, Connection, Result as DuckResult};
use thiserror::Error;

use crate::models::{BatteryHealthPoint, BatteryUsage, DroneUsage, Flight, FlightDateCount, FlightMetadata, OverviewStats, TelemetryPoint, TelemetryRecord, TopDistanceFlight, TopFlight};

#[derive(Error, Debug)]
pub enum DatabaseError {
    #[error("DuckDB error: {0}")]
    DuckDb(#[from] duckdb::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Flight not found: {0}")]
    FlightNotFound(i64),
}

/// Thread-safe database manager
pub struct Database {
    conn: Mutex<Connection>,
    pub data_dir: PathBuf,
}

impl Database {
    /// Initialize the database in the app data directory.
    ///
    /// Creates the following directory structure:
    /// ```text
    /// {app_data_dir}/
    /// ├── flights.db       # DuckDB database file
    /// └── keychains/       # Cached decryption keys
    /// ```
    pub fn new(app_data_dir: PathBuf) -> Result<Self, DatabaseError> {
        // Ensure directory structure exists
        fs::create_dir_all(&app_data_dir)?;
        fs::create_dir_all(app_data_dir.join("keychains"))?;

        let db_path = app_data_dir.join("flights.db");

        log::info!("Initializing DuckDB at: {:?}", db_path);

        // Open or create the database (with WAL recovery)
        let conn = Self::open_with_recovery(&db_path)?;

        // Configure DuckDB for optimal performance
        Self::configure_connection(&conn)?;

        let db = Self {
            conn: Mutex::new(conn),
            data_dir: app_data_dir,
        };

        // Initialize schema
        db.init_schema()?;

        Ok(db)
    }

    fn open_with_recovery(db_path: &PathBuf) -> Result<Connection, DatabaseError> {
        match Connection::open(db_path) {
            Ok(conn) => Ok(conn),
            Err(err) => {
                log::warn!("DuckDB open failed: {}. Attempting WAL recovery...", err);

                let wal_path = db_path.with_extension("db.wal");
                if wal_path.exists() {
                    if let Err(wal_err) = fs::remove_file(&wal_path) {
                        log::warn!("Failed to remove WAL file {:?}: {}", wal_path, wal_err);
                    } else {
                        log::info!("Removed WAL file {:?}", wal_path);
                    }
                }

                match Connection::open(db_path) {
                    Ok(conn) => Ok(conn),
                    Err(second_err) => {
                        log::warn!("WAL recovery failed: {}. Backing up DB and recreating...", second_err);

                        let backup_path = Self::backup_db(db_path)?;
                        log::warn!("Database backed up to {:?}", backup_path);

                        Connection::open(db_path).map_err(DatabaseError::from)
                    }
                }
            }
        }
    }

    fn backup_db(db_path: &PathBuf) -> Result<PathBuf, DatabaseError> {
        if !db_path.exists() {
            return Ok(db_path.clone());
        }

        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let backup_path = db_path.with_extension(format!("db.bak.{}", timestamp));
        fs::rename(db_path, &backup_path)?;

        let wal_path = db_path.with_extension("db.wal");
        if wal_path.exists() {
            let wal_backup = wal_path.with_extension(format!("db.wal.bak.{}", timestamp));
            let _ = fs::rename(&wal_path, wal_backup);
        }

        Ok(backup_path)
    }

    /// Configure DuckDB connection for optimal analytical performance
    fn configure_connection(conn: &Connection) -> DuckResult<()> {
        // Memory settings for better performance with large datasets
        conn.execute_batch(
            r#"
            SET memory_limit = '2GB';
            SET threads = 4;
            SET enable_progress_bar = false;
            "#,
        )?;
        Ok(())
    }

    /// Initialize the database schema with optimized tables
    fn init_schema(&self) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            r#"
            -- ============================================================
            -- FLIGHTS TABLE: Stores metadata for each imported flight log
            -- ============================================================
            CREATE TABLE IF NOT EXISTS flights (
                id              BIGINT PRIMARY KEY,
                file_name       VARCHAR NOT NULL,
                display_name    VARCHAR NOT NULL,
                file_hash       VARCHAR UNIQUE,          -- SHA256 to prevent duplicates
                drone_model     VARCHAR,
                drone_serial    VARCHAR,
                aircraft_name   VARCHAR,
                battery_serial  VARCHAR,
                start_time      TIMESTAMP WITH TIME ZONE,
                end_time        TIMESTAMP WITH TIME ZONE,
                duration_secs   DOUBLE,
                total_distance  DOUBLE,                  -- Total distance in meters
                max_altitude    DOUBLE,                  -- Max altitude in meters
                max_speed       DOUBLE,                  -- Max speed in m/s
                home_lat        DOUBLE,
                home_lon        DOUBLE,
                point_count     INTEGER,                 -- Number of telemetry points
                imported_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                notes           VARCHAR
            );

            -- Index for sorting by flight date
            CREATE INDEX IF NOT EXISTS idx_flights_start_time 
                ON flights(start_time DESC);

            -- Schema migrations for existing databases
            ALTER TABLE flights ADD COLUMN IF NOT EXISTS display_name VARCHAR;
            ALTER TABLE flights ADD COLUMN IF NOT EXISTS aircraft_name VARCHAR;
            ALTER TABLE flights ADD COLUMN IF NOT EXISTS battery_serial VARCHAR;

            -- ============================================================
            -- TELEMETRY TABLE: Time-series data for each flight
            -- Optimized for range queries on timestamp
            -- ============================================================
            CREATE TABLE IF NOT EXISTS telemetry (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,         -- Milliseconds since flight start
                
                -- Position
                latitude        DOUBLE,
                longitude       DOUBLE,
                altitude        DOUBLE,                  -- Relative altitude in meters
                height          DOUBLE,                  -- Height above takeoff in meters
                vps_height      DOUBLE,                  -- VPS height in meters
                altitude_abs    DOUBLE,                  -- Absolute altitude (MSL)
                
                -- Velocity
                speed           DOUBLE,                  -- Ground speed in m/s
                velocity_x      DOUBLE,                  -- North velocity
                velocity_y      DOUBLE,                  -- East velocity  
                velocity_z      DOUBLE,                  -- Down velocity
                
                -- Orientation (Euler angles in degrees)
                pitch           DOUBLE,
                roll            DOUBLE,
                yaw             DOUBLE,
                
                -- Gimbal
                gimbal_pitch    DOUBLE,
                gimbal_roll     DOUBLE,
                gimbal_yaw      DOUBLE,
                
                -- Power
                battery_percent INTEGER,
                battery_voltage DOUBLE,
                battery_current DOUBLE,
                battery_temp    DOUBLE,
                
                -- Flight status
                flight_mode     VARCHAR,
                gps_signal      INTEGER,
                satellites      INTEGER,
                
                -- RC
                rc_signal       INTEGER,
                rc_uplink       INTEGER,
                rc_downlink     INTEGER,
                
                -- Composite primary key for efficient range queries
                PRIMARY KEY (flight_id, timestamp_ms)
            );

            -- Index for time-range queries within a flight
            CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time 
                ON telemetry(flight_id, timestamp_ms);

            -- Schema migrations for existing databases
            ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS height DOUBLE;
            ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS vps_height DOUBLE;
            ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS rc_uplink INTEGER;
            ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS rc_downlink INTEGER;

            -- ============================================================
            -- KEYCHAIN TABLE: Store cached decryption keys for V13+ logs
            -- ============================================================
            CREATE TABLE IF NOT EXISTS keychains (
                serial_number   VARCHAR PRIMARY KEY,
                encryption_key  VARCHAR NOT NULL,
                fetched_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            "#,
        )?;

        Self::ensure_telemetry_column_order(&conn)?;

        log::info!("Database schema initialized successfully");
        Ok(())
    }

    fn ensure_telemetry_column_order(conn: &Connection) -> Result<(), DatabaseError> {
        let expected = vec![
            "flight_id",
            "timestamp_ms",
            "latitude",
            "longitude",
            "altitude",
            "height",
            "vps_height",
            "altitude_abs",
            "speed",
            "velocity_x",
            "velocity_y",
            "velocity_z",
            "pitch",
            "roll",
            "yaw",
            "gimbal_pitch",
            "gimbal_roll",
            "gimbal_yaw",
            "battery_percent",
            "battery_voltage",
            "battery_current",
            "battery_temp",
            "flight_mode",
            "gps_signal",
            "satellites",
            "rc_signal",
            "rc_uplink",
            "rc_downlink",
        ];

        let mut stmt = conn.prepare("PRAGMA table_info('telemetry')")?;
        let actual: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;

        if actual.iter().map(String::as_str).eq(expected.iter().copied()) {
            return Ok(());
        }

        log::warn!("Telemetry column order mismatch detected. Rebuilding table.");

        let existing: std::collections::HashSet<&str> =
            actual.iter().map(|s| s.as_str()).collect();

        let select_list = expected
            .iter()
            .map(|col| {
                if existing.contains(col) {
                    col.to_string()
                } else {
                    format!("NULL AS {}", col)
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        conn.execute_batch(&format!(
            r#"
            BEGIN TRANSACTION;
            CREATE TABLE telemetry_new AS SELECT {} FROM telemetry;
            DROP TABLE telemetry;
            ALTER TABLE telemetry_new RENAME TO telemetry;
            CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time
                ON telemetry(flight_id, timestamp_ms);
            COMMIT;
            "#,
            select_list
        ))?;

        Ok(())
    }

    /// Generate a new unique flight ID using timestamp + random
    pub fn generate_flight_id(&self) -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        // Use lower bits for uniqueness
        timestamp % 1_000_000_000_000
    }

    /// Insert flight metadata and return the flight ID
    pub fn insert_flight(&self, flight: &FlightMetadata) -> Result<i64, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            r#"
            INSERT INTO flights (
                id, file_name, display_name, file_hash, drone_model, drone_serial,
                aircraft_name, battery_serial,
                start_time, end_time, duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                flight.id,
                flight.file_name,
                flight.display_name,
                flight.file_hash,
                flight.drone_model,
                flight.drone_serial,
                flight.aircraft_name,
                flight.battery_serial,
                flight.start_time.map(|t| t.to_rfc3339()),
                flight.end_time.map(|t| t.to_rfc3339()),
                flight.duration_secs,
                flight.total_distance,
                flight.max_altitude,
                flight.max_speed,
                flight.home_lat,
                flight.home_lon,
                flight.point_count,
            ],
        )?;

        log::info!("Inserted flight with ID: {}", flight.id);
        Ok(flight.id)
    }

    /// Bulk insert telemetry data using DuckDB's Appender for maximum performance
    ///
    /// This is significantly faster than individual INSERT statements for large datasets.
    pub fn bulk_insert_telemetry(
        &self,
        flight_id: i64,
        points: &[TelemetryPoint],
    ) -> Result<usize, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        // Use DuckDB Appender for high-performance bulk inserts
        let mut appender = conn.appender("telemetry")?;

        let mut inserted = 0usize;
        let mut skipped = 0usize;
        let mut seen_timestamps: HashSet<i64> = HashSet::with_capacity(points.len());

        for point in points {
            if !seen_timestamps.insert(point.timestamp_ms) {
                skipped += 1;
                continue;
            }
            match appender.append_row(params![
                flight_id,
                point.timestamp_ms,
                point.latitude,
                point.longitude,
                point.altitude,
                point.height,
                point.vps_height,
                point.altitude_abs,
                point.speed,
                point.velocity_x,
                point.velocity_y,
                point.velocity_z,
                point.pitch,
                point.roll,
                point.yaw,
                point.gimbal_pitch,
                point.gimbal_roll,
                point.gimbal_yaw,
                point.battery_percent,
                point.battery_voltage,
                point.battery_current,
                point.battery_temp,
                point.flight_mode.as_deref(),
                point.gps_signal,
                point.satellites,
                point.rc_signal,
                point.rc_uplink,
                point.rc_downlink,
            ]) {
                Ok(()) => inserted += 1,
                Err(err) => {
                    let message = err.to_string().to_lowercase();
                    if message.contains("primary key")
                        || message.contains("unique key")
                        || message.contains("duplicate key")
                    {
                        skipped += 1;
                        continue;
                    }
                    return Err(DatabaseError::from(err));
                }
            }
        }

        appender.flush()?;

        log::info!(
            "Bulk inserted {} telemetry points for flight {} ({} skipped)",
            inserted,
            flight_id,
            skipped
        );
        Ok(inserted)
    }

    /// Get all flights metadata (for the flight list sidebar)
    pub fn get_all_flights(&self) -> Result<Vec<Flight>, DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        let mut stmt = conn.prepare(
            r#"
            SELECT 
                id, file_name, COALESCE(display_name, file_name) AS display_name,
                drone_model, drone_serial, aircraft_name, battery_serial,
                CAST(start_time AS VARCHAR) AS start_time,
                duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count
            FROM flights
            ORDER BY start_time DESC
            "#,
        )?;

        let flights = stmt
            .query_map([], |row| {
                Ok(Flight {
                    id: row.get(0)?,
                    file_name: row.get(1)?,
                    display_name: row.get(2)?,
                    drone_model: row.get(3)?,
                    drone_serial: row.get(4)?,
                    aircraft_name: row.get(5)?,
                    battery_serial: row.get(6)?,
                    start_time: row.get(7)?,
                    duration_secs: row.get(8)?,
                    total_distance: row.get(9)?,
                    max_altitude: row.get(10)?,
                    max_speed: row.get(11)?,
                    home_lat: row.get(12)?,
                    home_lon: row.get(13)?,
                    point_count: row.get(14)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        log::debug!("get_all_flights: {} rows in {:.1}ms", flights.len(), start.elapsed().as_secs_f64() * 1000.0);
        Ok(flights)
    }

    /// Get a single flight by ID (avoids loading all flights)
    pub fn get_flight_by_id(&self, flight_id: i64) -> Result<Flight, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.query_row(
            r#"
            SELECT 
                id, file_name, COALESCE(display_name, file_name) AS display_name,
                drone_model, drone_serial, aircraft_name, battery_serial,
                CAST(start_time AS VARCHAR) AS start_time,
                duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count
            FROM flights
            WHERE id = ?
            "#,
            params![flight_id],
            |row| {
                Ok(Flight {
                    id: row.get(0)?,
                    file_name: row.get(1)?,
                    display_name: row.get(2)?,
                    drone_model: row.get(3)?,
                    drone_serial: row.get(4)?,
                    aircraft_name: row.get(5)?,
                    battery_serial: row.get(6)?,
                    start_time: row.get(7)?,
                    duration_secs: row.get(8)?,
                    total_distance: row.get(9)?,
                    max_altitude: row.get(10)?,
                    max_speed: row.get(11)?,
                    home_lat: row.get(12)?,
                    home_lon: row.get(13)?,
                    point_count: row.get(14)?,
                })
            },
        )
        .map_err(|e| match e {
            duckdb::Error::QueryReturnedNoRows => DatabaseError::FlightNotFound(flight_id),
            other => DatabaseError::DuckDb(other),
        })
    }

    /// Get flight telemetry with automatic downsampling for large datasets.
    ///
    /// Strategy:
    /// - If points < 5000: return raw data
    /// - If points >= 5000: group by 1-second intervals, averaging values
    /// - This keeps the frontend responsive while preserving data trends
    ///
    /// `known_point_count` avoids an extra COUNT query when the flight metadata
    /// already provides the point count.
    pub fn get_flight_telemetry(
        &self,
        flight_id: i64,
        max_points: Option<usize>,
        known_point_count: Option<i64>,
    ) -> Result<Vec<TelemetryRecord>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let max_points = max_points.unwrap_or(5000);

        // Use known count or fall back to a COUNT query
        let point_count = match known_point_count {
            Some(c) if c > 0 => c,
            _ => {
                let c: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM telemetry WHERE flight_id = ?",
                    params![flight_id],
                    |row| row.get(0),
                )?;
                if c == 0 {
                    return Err(DatabaseError::FlightNotFound(flight_id));
                }
                c
            }
        };

        let records = if point_count as usize <= max_points {
            // Return raw data - no downsampling needed
            log::debug!(
                "Returning {} raw telemetry points for flight {}",
                point_count,
                flight_id
            );
            self.query_raw_telemetry(&conn, flight_id)?
        } else {
            // Downsample using 1-second interval averaging
            log::debug!(
                "Downsampling {} points to ~{} for flight {}",
                point_count,
                max_points,
                flight_id
            );
            self.query_downsampled_telemetry(&conn, flight_id, max_points)?
        };

        Ok(records)
    }

    /// Query raw telemetry without any downsampling
    fn query_raw_telemetry(
        &self,
        conn: &Connection,
        flight_id: i64,
    ) -> Result<Vec<TelemetryRecord>, DatabaseError> {
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                timestamp_ms,
                latitude,
                longitude, 
                altitude,
                height,
                vps_height,
                speed,
                velocity_x,
                velocity_y,
                velocity_z,
                battery_percent,
                battery_voltage,
                battery_temp,
                pitch,
                roll,
                yaw,
                satellites,
                flight_mode,
                rc_signal,
                rc_uplink,
                rc_downlink
            FROM telemetry
            WHERE flight_id = ?
            ORDER BY timestamp_ms ASC
            "#,
        )?;

        let records = stmt
            .query_map(params![flight_id], |row| {
                Ok(TelemetryRecord {
                    timestamp_ms: row.get(0)?,
                    latitude: row.get(1)?,
                    longitude: row.get(2)?,
                    altitude: row.get(3)?,
                    height: row.get(4)?,
                    vps_height: row.get(5)?,
                    speed: row.get(6)?,
                    velocity_x: row.get(7)?,
                    velocity_y: row.get(8)?,
                    velocity_z: row.get(9)?,
                    battery_percent: row.get(10)?,
                    battery_voltage: row.get(11)?,
                    battery_temp: row.get(12)?,
                    pitch: row.get(13)?,
                    roll: row.get(14)?,
                    yaw: row.get(15)?,
                    satellites: row.get(16)?,
                    flight_mode: row.get(17)?,
                    rc_signal: row.get(18)?,
                    rc_uplink: row.get(19)?,
                    rc_downlink: row.get(20)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Query telemetry with downsampling using DuckDB's analytical capabilities
    ///
    /// Groups data into time buckets and averages values for smooth visualization
    fn query_downsampled_telemetry(
        &self,
        conn: &Connection,
        flight_id: i64,
        target_points: usize,
    ) -> Result<Vec<TelemetryRecord>, DatabaseError> {
        // Calculate the bucket size in milliseconds based on flight duration and target points
        let (min_ts, max_ts): (i64, i64) = conn.query_row(
            "SELECT MIN(timestamp_ms), MAX(timestamp_ms) FROM telemetry WHERE flight_id = ?",
            params![flight_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let duration_ms = max_ts - min_ts;
        let bucket_size_ms = (duration_ms / target_points as i64).max(1000); // At least 1 second

        let mut stmt = conn.prepare(
            r#"
            WITH bucketed AS (
                SELECT 
                    (timestamp_ms / ?) * ? AS bucket_ts,
                    AVG(latitude) AS latitude,
                    AVG(longitude) AS longitude,
                    AVG(altitude) AS altitude,
                    AVG(height) AS height,
                    AVG(vps_height) AS vps_height,
                    AVG(speed) AS speed,
                    AVG(velocity_x) AS velocity_x,
                    AVG(velocity_y) AS velocity_y,
                    AVG(velocity_z) AS velocity_z,
                    AVG(battery_percent)::INTEGER AS battery_percent,
                    AVG(battery_voltage) AS battery_voltage,
                    AVG(battery_temp) AS battery_temp,
                    AVG(pitch) AS pitch,
                    AVG(roll) AS roll,
                    AVG(yaw) AS yaw,
                    ROUND(AVG(satellites))::INTEGER AS satellites,
                    FIRST(flight_mode ORDER BY timestamp_ms) AS flight_mode,
                    AVG(rc_signal)::INTEGER AS rc_signal,
                    AVG(rc_uplink)::INTEGER AS rc_uplink,
                    AVG(rc_downlink)::INTEGER AS rc_downlink
                FROM telemetry
                WHERE flight_id = ?
                GROUP BY bucket_ts
                ORDER BY bucket_ts ASC
            )
            SELECT * FROM bucketed
            "#,
        )?;

        let records = stmt
            .query_map(params![bucket_size_ms, bucket_size_ms, flight_id], |row| {
                Ok(TelemetryRecord {
                    timestamp_ms: row.get(0)?,
                    latitude: row.get(1)?,
                    longitude: row.get(2)?,
                    altitude: row.get(3)?,
                    height: row.get(4)?,
                    vps_height: row.get(5)?,
                    speed: row.get(6)?,
                    velocity_x: row.get(7)?,
                    velocity_y: row.get(8)?,
                    velocity_z: row.get(9)?,
                    battery_percent: row.get(10)?,
                    battery_voltage: row.get(11)?,
                    battery_temp: row.get(12)?,
                    pitch: row.get(13)?,
                    roll: row.get(14)?,
                    yaw: row.get(15)?,
                    satellites: row.get(16)?,
                    flight_mode: row.get(17)?,
                    rc_signal: row.get(18)?,
                    rc_uplink: row.get(19)?,
                    rc_downlink: row.get(20)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Delete a flight and all associated telemetry data
    pub fn delete_flight(&self, flight_id: i64) -> Result<(), DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "DELETE FROM telemetry WHERE flight_id = ?",
            params![flight_id],
        )?;
        conn.execute("DELETE FROM flights WHERE id = ?", params![flight_id])?;

        log::info!("Deleted flight {} in {:.1}ms", flight_id, start.elapsed().as_secs_f64() * 1000.0);
        Ok(())
    }

    /// Delete all flights and associated telemetry
    pub fn delete_all_flights(&self) -> Result<(), DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        conn.execute("DELETE FROM telemetry", params![])?;
        conn.execute("DELETE FROM flights", params![])?;

        log::info!("Deleted all flights and telemetry in {:.1}ms", start.elapsed().as_secs_f64() * 1000.0);
        Ok(())
    }

    /// Get overview stats across all flights
    pub fn get_overview_stats(&self) -> Result<OverviewStats, DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        // Basic aggregate stats
        let (total_flights, total_distance, total_duration, total_points, max_altitude): (i64, f64, f64, i64, f64) =
            conn.query_row(
                r#"
                SELECT
                    COUNT(*)::BIGINT,
                    COALESCE(SUM(total_distance), 0)::DOUBLE,
                    COALESCE(SUM(duration_secs), 0)::DOUBLE,
                    COALESCE(SUM(point_count), 0)::BIGINT,
                    COALESCE(MAX(max_altitude), 0)::DOUBLE
                FROM flights
                "#,
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )?;

        // Battery usage with total duration
        let mut stmt = conn.prepare(
            r#"
            SELECT battery_serial, COUNT(*)::BIGINT AS flight_count, COALESCE(SUM(duration_secs), 0)::DOUBLE AS total_duration
            FROM flights
            WHERE battery_serial IS NOT NULL AND battery_serial <> ''
            GROUP BY battery_serial
            ORDER BY flight_count DESC
            "#,
        )?;

        let batteries_used = stmt
            .query_map([], |row| {
                Ok(BatteryUsage {
                    battery_serial: row.get(0)?,
                    flight_count: row.get(1)?,
                    total_duration_secs: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Drone usage stats
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                COALESCE(drone_model, 'Unknown') AS drone_model, 
                drone_serial,
                aircraft_name,
                COUNT(*)::BIGINT AS flight_count
            FROM flights
            GROUP BY drone_model, drone_serial, aircraft_name
            ORDER BY flight_count DESC
            "#,
        )?;

        let drones_used = stmt
            .query_map([], |row| {
                Ok(DroneUsage {
                    drone_model: row.get(0)?,
                    drone_serial: row.get(1)?,
                    aircraft_name: row.get(2)?,
                    flight_count: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Flights by date for activity heatmap (last 365 days)
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                CAST(DATE_TRUNC('day', start_time) AS DATE)::VARCHAR AS flight_date,
                COUNT(*)::BIGINT AS count
            FROM flights
            WHERE start_time IS NOT NULL 
              AND start_time >= CURRENT_DATE - INTERVAL '365 days'
            GROUP BY DATE_TRUNC('day', start_time)
            ORDER BY flight_date ASC
            "#,
        )?;

        let flights_by_date = stmt
            .query_map([], |row| {
                Ok(FlightDateCount {
                    date: row.get(0)?,
                    count: row.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Top 3 longest flights
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                id,
                COALESCE(display_name, file_name) AS display_name,
                COALESCE(duration_secs, 0)::DOUBLE AS duration_secs,
                CAST(start_time AS VARCHAR) AS start_time
            FROM flights
            WHERE duration_secs IS NOT NULL
            ORDER BY duration_secs DESC
            LIMIT 3
            "#,
        )?;

        let top_flights = stmt
            .query_map([], |row| {
                Ok(TopFlight {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    duration_secs: row.get(2)?,
                    start_time: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Max distance from home per flight (for top furthest calculation)
        let mut stmt = conn.prepare(
            r#"
            SELECT
                f.id,
                COALESCE(f.display_name, f.file_name) AS display_name,
                COALESCE(MAX(
                    CASE WHEN f.home_lat IS NOT NULL AND f.home_lon IS NOT NULL
                         AND t.latitude IS NOT NULL AND t.longitude IS NOT NULL
                         AND NOT (ABS(t.latitude) < 0.000001 AND ABS(t.longitude) < 0.000001)
                    THEN
                        6371000 * 2 * ASIN(SQRT(
                            POWER(SIN(RADIANS(t.latitude - f.home_lat) / 2), 2) +
                            COS(RADIANS(f.home_lat)) * COS(RADIANS(t.latitude)) *
                            POWER(SIN(RADIANS(t.longitude - f.home_lon) / 2), 2)
                        ))
                    ELSE 0 END
                ), 0)::DOUBLE AS max_distance_from_home_m,
                CAST(f.start_time AS VARCHAR) AS start_time
            FROM flights f
            LEFT JOIN telemetry t ON f.id = t.flight_id
            WHERE NOT (ABS(f.home_lat) < 0.000001 AND ABS(f.home_lon) < 0.000001)
               OR f.home_lat IS NULL
            GROUP BY f.id, f.display_name, f.file_name, f.start_time
            ORDER BY max_distance_from_home_m DESC
            "#,
        )?;

        let top_distance_flights = stmt
            .query_map([], |row| {
                Ok(TopDistanceFlight {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    max_distance_from_home_m: row.get(2)?,
                    start_time: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Battery health points (delta % / minute) per flight
        let mut stmt = conn.prepare(
            r#"
            SELECT
                f.id,
                f.battery_serial,
                CAST(f.start_time AS VARCHAR) AS start_time,
                COALESCE(f.duration_secs, 0)::DOUBLE AS duration_secs,
                (MAX(t.battery_percent) - MIN(t.battery_percent))::DOUBLE AS delta_percent
            FROM flights f
            JOIN telemetry t ON f.id = t.flight_id
            WHERE f.battery_serial IS NOT NULL AND f.battery_serial <> ''
              AND t.battery_percent IS NOT NULL
            GROUP BY f.id, f.battery_serial, f.start_time, f.duration_secs
            ORDER BY f.start_time ASC
            "#,
        )?;

        let battery_health_points = stmt
            .query_map([], |row| {
                let duration_secs: f64 = row.get(3)?;
                let duration_mins = if duration_secs > 0.0 { duration_secs / 60.0 } else { 0.0 };
                let delta_percent: f64 = row.get(4)?;
                let rate_per_min = if duration_mins > 0.0 { delta_percent / duration_mins } else { 0.0 };

                Ok(BatteryHealthPoint {
                    flight_id: row.get(0)?,
                    battery_serial: row.get(1)?,
                    start_time: row.get(2)?,
                    duration_mins,
                    delta_percent,
                    rate_per_min,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Derive global max distance from the per-flight results (no extra query needed)
        let max_distance_from_home = top_distance_flights
            .first()
            .map(|f| f.max_distance_from_home_m)
            .unwrap_or(0.0);

        log::debug!(
            "get_overview_stats: {} flights, {} batteries, {} drones in {:.1}ms",
            total_flights, batteries_used.len(), drones_used.len(),
            start.elapsed().as_secs_f64() * 1000.0
        );

        Ok(OverviewStats {
            total_flights,
            total_distance_m: total_distance,
            total_duration_secs: total_duration,
            total_points,
            max_altitude_m: max_altitude,
            max_distance_from_home_m: max_distance_from_home,
            batteries_used,
            drones_used,
            flights_by_date,
            top_flights,
            top_distance_flights,
            battery_health_points,
        })
    }

    /// Update the display name for a flight
    pub fn update_flight_name(&self, flight_id: i64, display_name: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE flights SET display_name = ? WHERE id = ?",
            params![display_name, flight_id],
        )?;

        log::debug!("Updated flight {} display name to '{}'", flight_id, display_name);
        Ok(())
    }

    /// Check if a file has already been imported (by hash)
    pub fn is_file_imported(&self, file_hash: &str) -> Result<bool, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM flights WHERE file_hash = ?",
            params![file_hash],
            |row| row.get(0),
        )?;

        Ok(count > 0)
    }

    /// Export the entire database to a compressed backup file.
    ///
    /// Uses DuckDB's Parquet COPY for each table, then packs them into a single
    /// gzip-compressed tar archive.  The resulting `.db.backup` file is portable
    /// and can be restored with `import_backup`.
    pub fn export_backup(&self, dest_path: &std::path::Path) -> Result<(), DatabaseError> {
        let start = std::time::Instant::now();
        log::info!("Starting database backup to {:?}", dest_path);

        // Create a temp directory for the Parquet exports
        let temp_dir = std::env::temp_dir().join(format!("dji-logbook-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;

        let conn = self.conn.lock().unwrap();

        // Export each table to Parquet (fast, compressed, columnar)
        let flights_path = temp_dir.join("flights.parquet");
        let telemetry_path = temp_dir.join("telemetry.parquet");
        let keychains_path = temp_dir.join("keychains.parquet");

        conn.execute_batch(&format!(
            "COPY flights    TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            flights_path.to_string_lossy()
        ))?;
        conn.execute_batch(&format!(
            "COPY telemetry  TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            telemetry_path.to_string_lossy()
        ))?;
        conn.execute_batch(&format!(
            "COPY keychains  TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            keychains_path.to_string_lossy()
        ))?;

        drop(conn); // release the lock while we tar

        // Pack the Parquet files into a gzip-compressed tar archive
        let dest_file = fs::File::create(dest_path)?;
        let gz = flate2::write::GzEncoder::new(dest_file, flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);

        for name in &["flights.parquet", "telemetry.parquet", "keychains.parquet"] {
            let file_path = temp_dir.join(name);
            if file_path.exists() {
                tar.append_path_with_name(&file_path, name)
                    .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            }
        }

        tar.into_inner()
            .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
            .finish()
            .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;

        // Clean up temp dir
        let _ = fs::remove_dir_all(&temp_dir);

        log::info!(
            "Database backup completed in {:.1}s → {:?}",
            start.elapsed().as_secs_f64(),
            dest_path
        );
        Ok(())
    }

    /// Import a backup file, restoring all flight data.
    ///
    /// Existing records are kept.  If a flight with the same ID already exists
    /// it is overwritten (its telemetry is replaced as well).
    pub fn import_backup(&self, src_path: &std::path::Path) -> Result<String, DatabaseError> {
        let start = std::time::Instant::now();
        log::info!("Starting database restore from {:?}", src_path);

        // Extract the tar.gz archive to a temp directory
        let temp_dir = std::env::temp_dir().join(format!("dji-logbook-restore-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir)?;

        let file = fs::File::open(src_path)?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        archive.unpack(&temp_dir)
            .map_err(|e| DatabaseError::Io(std::io::Error::new(std::io::ErrorKind::Other, format!("Failed to extract backup archive: {}", e))))?;

        let flights_path = temp_dir.join("flights.parquet");
        let telemetry_path = temp_dir.join("telemetry.parquet");
        let keychains_path = temp_dir.join("keychains.parquet");

        if !flights_path.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(DatabaseError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Invalid backup file: missing flights.parquet",
            )));
        }

        let conn = self.conn.lock().unwrap();

        // --- Restore flights ---
        // The flights table has multiple UNIQUE/PRIMARY KEY constraints (id + file_hash),
        // so INSERT OR REPLACE is not supported.  Delete matching rows first, then insert.
        conn.execute_batch(&format!(
            r#"
            DELETE FROM flights
            WHERE id IN (SELECT id FROM read_parquet('{}'))
               OR file_hash IN (SELECT file_hash FROM read_parquet('{}') WHERE file_hash IS NOT NULL);
            INSERT INTO flights
            SELECT * FROM read_parquet('{}');
            "#,
            flights_path.to_string_lossy(),
            flights_path.to_string_lossy(),
            flights_path.to_string_lossy()
        ))?;

        let flights_restored: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM read_parquet('{}')", flights_path.to_string_lossy()),
            [],
            |row| row.get(0),
        )?;

        // --- Restore telemetry ---
        if telemetry_path.exists() {
            // Get the set of flight IDs being restored so we can remove their
            // existing telemetry first (to handle overwrites cleanly).
            conn.execute_batch(&format!(
                r#"
                DELETE FROM telemetry
                WHERE flight_id IN (
                    SELECT DISTINCT flight_id FROM read_parquet('{}')
                );
                INSERT INTO telemetry
                SELECT * FROM read_parquet('{}');
                "#,
                telemetry_path.to_string_lossy(),
                telemetry_path.to_string_lossy()
            ))?;
        }

        // --- Restore keychains ---
        if keychains_path.exists() {
            conn.execute_batch(&format!(
                r#"
                INSERT OR REPLACE INTO keychains
                SELECT * FROM read_parquet('{}');
                "#,
                keychains_path.to_string_lossy()
            ))?;
        }

        drop(conn);

        // Clean up temp dir
        let _ = fs::remove_dir_all(&temp_dir);

        let elapsed = start.elapsed().as_secs_f64();
        let msg = format!(
            "Restored {} flights in {:.1}s",
            flights_restored, elapsed
        );
        log::info!("{}", msg);
        Ok(msg)
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_database_initialization() {
        let temp_dir = tempdir().unwrap();
        let db = Database::new(temp_dir.path().to_path_buf()).unwrap();

        // Verify directories were created
        assert!(temp_dir.path().join("keychains").exists());
        assert!(temp_dir.path().join("flights.db").exists());

        // Verify we can get flights (empty)
        let flights = db.get_all_flights().unwrap();
        assert!(flights.is_empty());
    }
}

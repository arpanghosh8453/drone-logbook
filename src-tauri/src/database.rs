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

use duckdb::{params, Connection, OptionalExt, Result as DuckResult};
use thiserror::Error;

use crate::models::{BatteryHealthPoint, BatteryUsage, DroneUsage, Flight, FlightDateCount, FlightMessage, FlightMetadata, FlightTag, OverviewStats, TelemetryPoint, TelemetryRecord, TopDistanceFlight, TopFlight};

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

impl Drop for Database {
    fn drop(&mut self) {
        log::info!("Dropping Database instance. DuckDB will now gracefully close and flush remaining WAL data to disk...");
        let drop_start = std::time::Instant::now();
        // The actual DuckDB connection drop happens automatically right after this, 
        // which triggers any implicit final checkpoints.
        log::info!("Database drop initiated (drop handler took {:.3}s)", drop_start.elapsed().as_secs_f64());
    }
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

        // Checkpoint WAL to main database file for faster subsequent startups
        if let Err(e) = conn.execute_batch("CHECKPOINT;") {
            log::warn!("WAL checkpoint failed (non-fatal): {}", e);
        }

        let db = Self {
            conn: Mutex::new(conn),
            data_dir: app_data_dir,
        };

        // Initialize schema
        db.init_schema()?;

        // Run one-time startup deduplication for existing data
        db.run_startup_deduplication();

        // Perform a checkpoint right after startup, as migrations (especially those touching thousands of rows)
        // create large WAL files. This ensures the 100+ MB WAL isn't held in memory until the user
        // closes the app window, which prevents process locking issues.
        log::info!("Starting post-startup WAL checkpoint to clear large migration logs...");
        let checkpoint_start = std::time::Instant::now();
        if let Err(e) = db.conn.lock().unwrap().execute_batch("CHECKPOINT; VACUUM;") {
            log::warn!("Post-startup WAL checkpoint & vacuum failed (non-fatal): {} (took {:.1}s)", e, checkpoint_start.elapsed().as_secs_f64());
        } else {
            log::info!("Post-startup WAL checkpoint & vacuum completed successfully in {:.1}s", checkpoint_start.elapsed().as_secs_f64());
        }

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

    /// Backup the database before WAL recovery or rebuilds
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

    /// Explicitly forces a WAL checkpoint. Useful for flushing the WAL before shutdown.
    #[cfg(feature = "tauri-app")]
    pub fn checkpoint(&self) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("CHECKPOINT;")?;
        Ok(())
    }

    /// Configure DuckDB connection for optimal analytical performance
    fn configure_connection(conn: &Connection) -> DuckResult<()> {
        // Memory settings for better performance with large datasets
        conn.execute_batch(
            r#"
            SET memory_limit = '2GB';
            SET threads = 4;
            SET enable_progress_bar = false;
            PRAGMA wal_autocheckpoint='25MB';
            "#,
        )?;
        Ok(())
    }

    /// Initialize the database schema with optimized tables
    fn init_schema(&self) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        // Create base tables (without migrations in the batch)
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
                photo_count     INTEGER,                 -- Number of photos taken
                video_count     INTEGER,                 -- Number of video recordings
                imported_at     TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                notes           VARCHAR
            );

            -- Index for sorting by flight date
            CREATE INDEX IF NOT EXISTS idx_flights_start_time 
                ON flights(start_time DESC);

            -- ============================================================
            -- TELEMETRY TABLE: Time-series data for each flight
            -- Optimized for range queries on timestamp
            -- Note: lat/lon use DOUBLE for precision, other metrics use FLOAT to save space
            -- ============================================================
            CREATE TABLE IF NOT EXISTS telemetry (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,         -- Milliseconds since flight start
                
                -- Position (DOUBLE for lat/lon precision, FLOAT for altitude)
                latitude        DOUBLE,
                longitude       DOUBLE,
                altitude        FLOAT,                   -- Relative altitude in meters
                height          FLOAT,                   -- Height above takeoff in meters
                vps_height      FLOAT,                   -- VPS height in meters
                altitude_abs    FLOAT,                   -- Absolute altitude (MSL)
                
                -- Velocity
                speed           FLOAT,                   -- Ground speed in m/s
                velocity_x      FLOAT,                   -- North velocity
                velocity_y      FLOAT,                   -- East velocity  
                velocity_z      FLOAT,                   -- Down velocity
                
                -- Orientation (Euler angles in degrees)
                pitch           FLOAT,
                roll            FLOAT,
                yaw             FLOAT,
                
                -- Gimbal
                gimbal_pitch    FLOAT,
                gimbal_roll     FLOAT,
                gimbal_yaw      FLOAT,
                
                -- Power
                battery_percent INTEGER,
                battery_voltage FLOAT,
                battery_current FLOAT,
                battery_temp    FLOAT,
                cell_voltages   VARCHAR,                 -- JSON array of individual cell voltages
                
                -- Flight status
                flight_mode     VARCHAR,
                gps_signal      INTEGER,
                satellites      INTEGER,
                
                -- RC
                rc_signal       INTEGER,
                rc_uplink       INTEGER,
                rc_downlink     INTEGER,

                -- RC stick inputs (normalized -100..+100)
                rc_aileron      FLOAT,
                rc_elevator     FLOAT,
                rc_throttle     FLOAT,
                rc_rudder       FLOAT,

                -- Camera state
                is_photo        BOOLEAN,
                is_video        BOOLEAN
            );

            -- Index for time-range queries within a flight
            CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time 
                ON telemetry(flight_id, timestamp_ms);

            -- ============================================================
            -- KEYCHAIN TABLE: Store cached decryption keys for V13+ logs
            -- ============================================================
            CREATE TABLE IF NOT EXISTS keychains (
                serial_number   VARCHAR PRIMARY KEY,
                encryption_key  VARCHAR NOT NULL,
                fetched_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            -- ============================================================
            -- FLIGHT_TAGS TABLE: Tags associated with each flight
            -- Separate table for backward compatibility with old backups
            -- ============================================================
            CREATE TABLE IF NOT EXISTS flight_tags (
                flight_id       BIGINT NOT NULL,
                tag             VARCHAR NOT NULL,
                tag_type        VARCHAR NOT NULL DEFAULT 'auto',
                PRIMARY KEY (flight_id, tag)
            );

            CREATE INDEX IF NOT EXISTS idx_flight_tags_flight 
                ON flight_tags(flight_id);
            CREATE INDEX IF NOT EXISTS idx_flight_tags_tag 
                ON flight_tags(tag);

            -- ============================================================
            -- SETTINGS TABLE: Key-value store for app settings/flags
            -- ============================================================
            CREATE TABLE IF NOT EXISTS settings (
                key             VARCHAR PRIMARY KEY,
                value           VARCHAR NOT NULL,
                updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );

            -- ============================================================
            -- EQUIPMENT_NAMES TABLE: Custom display names for batteries/aircraft
            -- ============================================================
            CREATE TABLE IF NOT EXISTS equipment_names (
                serial          VARCHAR NOT NULL,        -- battery or aircraft serial number
                equipment_type  VARCHAR NOT NULL,        -- 'battery' or 'aircraft'
                display_name    VARCHAR NOT NULL,
                updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (serial, equipment_type)
            );

            -- ============================================================
            -- FLIGHT_MESSAGES TABLE: App messages (tips/warnings) per flight
            -- ============================================================
            CREATE TABLE IF NOT EXISTS flight_messages (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,
                message_type    VARCHAR NOT NULL,        -- 'tip' or 'warn'
                message         VARCHAR NOT NULL,
                PRIMARY KEY (flight_id, timestamp_ms, message_type)
            );

            CREATE INDEX IF NOT EXISTS idx_flight_messages_flight 
                ON flight_messages(flight_id);
            "#,
        )?;

        // Run selective migrations only for missing columns
        Self::migrate_flights_table(&conn)?;
        Self::migrate_telemetry_table(&conn)?;
        Self::migrate_flight_tags_table(&conn)?;

        // Run type optimization migration (DOUBLE -> FLOAT for non-critical metrics)
        // Must run before column order check since it recreates the table
        Self::migrate_telemetry_types(&conn)?;

        Self::ensure_telemetry_column_order(&conn)?;

        log::info!("Database schema initialized successfully");
        Ok(())
    }

    /// Get existing column names for a table (single query)
    fn get_table_columns(conn: &Connection, table_name: &str) -> Result<HashSet<String>, DatabaseError> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info('{}')", table_name))?;
        let columns: HashSet<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        Ok(columns)
    }

    /// Migrate flights table - only add missing columns
    fn migrate_flights_table(conn: &Connection) -> Result<(), DatabaseError> {
        let columns = Self::get_table_columns(conn, "flights")?;
        
        let migrations: &[(&str, &str)] = &[
            ("display_name", "ALTER TABLE flights ADD COLUMN display_name VARCHAR"),
            ("aircraft_name", "ALTER TABLE flights ADD COLUMN aircraft_name VARCHAR"),
            ("battery_serial", "ALTER TABLE flights ADD COLUMN battery_serial VARCHAR"),
            ("photo_count", "ALTER TABLE flights ADD COLUMN photo_count INTEGER"),
            ("video_count", "ALTER TABLE flights ADD COLUMN video_count INTEGER"),
        ];

        let need_backfill = !columns.contains("photo_count");

        for (col_name, sql) in migrations {
            if !columns.contains(*col_name) {
                log::info!("Migrating flights table: adding {} column", col_name);
                conn.execute_batch(sql)?;
            }
        }

        // Backfill photo/video counts from telemetry for existing flights
        if need_backfill {
            log::info!("Backfilling photo_count and video_count from telemetry data...");
            let backfill_sql = r#"
                UPDATE flights SET
                    photo_count = COALESCE((
                        SELECT COUNT(*) FROM (
                            SELECT is_photo, LAG(is_photo) OVER (ORDER BY timestamp_ms) AS prev_photo
                            FROM telemetry WHERE flight_id = flights.id
                        ) sub WHERE is_photo = true AND (prev_photo IS NULL OR prev_photo = false)
                    ), 0),
                    video_count = COALESCE((
                        SELECT COUNT(*) FROM (
                            SELECT is_video, LAG(is_video) OVER (ORDER BY timestamp_ms) AS prev_video
                            FROM telemetry WHERE flight_id = flights.id
                        ) sub WHERE is_video = true AND (prev_video IS NULL OR prev_video = false)
                    ), 0)
                WHERE photo_count IS NULL OR video_count IS NULL
            "#;
            match conn.execute_batch(backfill_sql) {
                Ok(()) => log::info!("Backfilled photo/video counts successfully"),
                Err(e) => log::warn!("Failed to backfill photo/video counts: {}", e),
            }
        }

        Ok(())
    }

    /// Migrate telemetry table - only add missing columns
    fn migrate_telemetry_table(conn: &Connection) -> Result<(), DatabaseError> {
        let columns = Self::get_table_columns(conn, "telemetry")?;
        
        let migrations: &[(&str, &str)] = &[
            ("height", "ALTER TABLE telemetry ADD COLUMN height FLOAT"),
            ("vps_height", "ALTER TABLE telemetry ADD COLUMN vps_height FLOAT"),
            ("rc_uplink", "ALTER TABLE telemetry ADD COLUMN rc_uplink INTEGER"),
            ("rc_downlink", "ALTER TABLE telemetry ADD COLUMN rc_downlink INTEGER"),
            ("rc_aileron", "ALTER TABLE telemetry ADD COLUMN rc_aileron FLOAT"),
            ("rc_elevator", "ALTER TABLE telemetry ADD COLUMN rc_elevator FLOAT"),
            ("rc_throttle", "ALTER TABLE telemetry ADD COLUMN rc_throttle FLOAT"),
            ("rc_rudder", "ALTER TABLE telemetry ADD COLUMN rc_rudder FLOAT"),
            ("is_photo", "ALTER TABLE telemetry ADD COLUMN is_photo BOOLEAN"),
            ("is_video", "ALTER TABLE telemetry ADD COLUMN is_video BOOLEAN"),
            ("cell_voltages", "ALTER TABLE telemetry ADD COLUMN cell_voltages VARCHAR"),
        ];

        for (col_name, sql) in migrations {
            if !columns.contains(*col_name) {
                log::info!("Migrating telemetry table: adding {} column", col_name);
                conn.execute_batch(sql)?;
            }
        }
        Ok(())
    }

    /// Migrate flight_tags table - only add missing columns
    fn migrate_flight_tags_table(conn: &Connection) -> Result<(), DatabaseError> {
        let columns = Self::get_table_columns(conn, "flight_tags")?;
        
        if !columns.contains("tag_type") {
            log::info!("Migrating flight_tags table: adding tag_type column");
            conn.execute_batch(
                "ALTER TABLE flight_tags ADD COLUMN tag_type VARCHAR DEFAULT 'auto';",
            )?;
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_flight_tags_type ON flight_tags(tag_type);",
            )?;
        }
        
        // Update existing tags with NULL tag_type to 'auto' (migration backfill)
        // This handles rows created before the tag_type column existed
        conn.execute_batch(
            "UPDATE flight_tags SET tag_type = 'auto' WHERE tag_type IS NULL;",
        )?;
        
        Ok(())
    }

    /// Migrate telemetry table column types from DOUBLE to FLOAT for non-critical metrics.
    /// This reduces storage by ~50% for numeric columns while preserving full precision
    /// for latitude/longitude coordinates. Only runs once.
    fn migrate_telemetry_types(conn: &Connection) -> Result<(), DatabaseError> {
        const MIGRATION_KEY: &str = "telemetry_float_migrated";
        
        // Check if migration already completed using a marker in the settings table
        let already_migrated: bool = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?",
                params![MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .map(|v| v == "true")
            .unwrap_or(false);
        
        if already_migrated {
            log::debug!("Telemetry type migration already completed, skipping");
            return Ok(());
        }
        
        // Check if telemetry table exists and has data
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM telemetry", [], |row| row.get(0))
            .unwrap_or(0);
        
        if row_count == 0 {
            // Empty table or new install - just mark as done
            log::debug!("Telemetry table empty, marking float migration as complete");
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                params![MIGRATION_KEY, "true"],
            )?;
            return Ok(());
        }
        
        // Check if any DOUBLE columns exist (need migration)
        // Query column types from DuckDB's information schema
        let needs_migration: bool = conn
            .query_row(
                r#"
                SELECT COUNT(*) > 0 
                FROM information_schema.columns 
                WHERE table_name = 'telemetry' 
                  AND column_name = 'altitude' 
                  AND data_type = 'DOUBLE'
                "#,
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        
        if !needs_migration {
            log::debug!("Telemetry columns already using FLOAT types");
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                params![MIGRATION_KEY, "true"],
            )?;
            return Ok(());
        }
        
        log::info!(
            "Migrating telemetry table types: DOUBLE -> FLOAT for {} rows (this may take a moment)...",
            row_count
        );
        let start = std::time::Instant::now();
        
        // Recreate table with optimized types:
        // - DOUBLE preserved for latitude, longitude (need ~15 decimal precision for GPS)
        // - FLOAT for everything else (7 decimal precision is plenty for altitude, speed, etc.)
        conn.execute_batch(
            r#"
            BEGIN TRANSACTION;
            
            CREATE TABLE telemetry_optimized (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,
                latitude        DOUBLE,
                longitude       DOUBLE,
                altitude        FLOAT,
                height          FLOAT,
                vps_height      FLOAT,
                altitude_abs    FLOAT,
                speed           FLOAT,
                velocity_x      FLOAT,
                velocity_y      FLOAT,
                velocity_z      FLOAT,
                pitch           FLOAT,
                roll            FLOAT,
                yaw             FLOAT,
                gimbal_pitch    FLOAT,
                gimbal_roll     FLOAT,
                gimbal_yaw      FLOAT,
                battery_percent INTEGER,
                battery_voltage FLOAT,
                battery_current FLOAT,
                battery_temp    FLOAT,
                cell_voltages   VARCHAR,
                flight_mode     VARCHAR,
                gps_signal      INTEGER,
                satellites      INTEGER,
                rc_signal       INTEGER,
                rc_uplink       INTEGER,
                rc_downlink     INTEGER,
                rc_aileron      FLOAT,
                rc_elevator     FLOAT,
                rc_throttle     FLOAT,
                rc_rudder       FLOAT,
                is_photo        BOOLEAN,
                is_video        BOOLEAN,
                PRIMARY KEY (flight_id, timestamp_ms)
            );
            
            INSERT INTO telemetry_optimized 
            SELECT 
                flight_id,
                timestamp_ms,
                latitude,
                longitude,
                CAST(altitude AS FLOAT),
                CAST(height AS FLOAT),
                CAST(vps_height AS FLOAT),
                CAST(altitude_abs AS FLOAT),
                CAST(speed AS FLOAT),
                CAST(velocity_x AS FLOAT),
                CAST(velocity_y AS FLOAT),
                CAST(velocity_z AS FLOAT),
                CAST(pitch AS FLOAT),
                CAST(roll AS FLOAT),
                CAST(yaw AS FLOAT),
                CAST(gimbal_pitch AS FLOAT),
                CAST(gimbal_roll AS FLOAT),
                CAST(gimbal_yaw AS FLOAT),
                battery_percent,
                CAST(battery_voltage AS FLOAT),
                CAST(battery_current AS FLOAT),
                CAST(battery_temp AS FLOAT),
                cell_voltages,
                flight_mode,
                gps_signal,
                satellites,
                rc_signal,
                rc_uplink,
                rc_downlink,
                CAST(rc_aileron AS FLOAT),
                CAST(rc_elevator AS FLOAT),
                CAST(rc_throttle AS FLOAT),
                CAST(rc_rudder AS FLOAT),
                is_photo,
                is_video
            FROM telemetry;
            
            DROP TABLE telemetry;
            ALTER TABLE telemetry_optimized RENAME TO telemetry;
            
            CREATE INDEX IF NOT EXISTS idx_telemetry_flight_time 
                ON telemetry(flight_id, timestamp_ms);
            
            COMMIT;
            "#,
        )?;
        
        log::info!(
            "Telemetry type migration completed in {:.1}s for {} rows",
            start.elapsed().as_secs_f64(),
            row_count
        );
        
        // Run VACUUM to reclaim space (must be outside transaction)
        log::info!("Running VACUUM to reclaim disk space...");
        let vacuum_start = std::time::Instant::now();
        if let Err(e) = conn.execute_batch("VACUUM;") {
            log::warn!("VACUUM failed (non-fatal): {}", e);
        } else {
            log::info!("VACUUM completed in {:.1}s", vacuum_start.elapsed().as_secs_f64());
        }
        
        // Mark migration as complete
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![MIGRATION_KEY, "true"],
        )?;
        
        log::info!("Telemetry type migration marked as complete");
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
            "cell_voltages",
            "flight_mode",
            "gps_signal",
            "satellites",
            "rc_signal",
            "rc_uplink",
            "rc_downlink",
            "rc_aileron",
            "rc_elevator",
            "rc_throttle",
            "rc_rudder",
            "is_photo",
            "is_video",
        ];

        let mut stmt = conn.prepare("PRAGMA table_info('telemetry')")?;
        let actual: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;

        if actual.iter().map(String::as_str).eq(expected.iter().copied()) {
            return Ok(());
        }

        log::warn!("Telemetry column order mismatch detected. Rebuilding table with correct schema.");

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

        // Use explicit schema to preserve PRIMARY KEY and correct column types
        // (DOUBLE for lat/lon precision, FLOAT for everything else to save space)
        conn.execute_batch(&format!(
            r#"
            BEGIN TRANSACTION;
            
            CREATE TABLE telemetry_reordered (
                flight_id       BIGINT NOT NULL,
                timestamp_ms    BIGINT NOT NULL,
                latitude        DOUBLE,
                longitude       DOUBLE,
                altitude        FLOAT,
                height          FLOAT,
                vps_height      FLOAT,
                altitude_abs    FLOAT,
                speed           FLOAT,
                velocity_x      FLOAT,
                velocity_y      FLOAT,
                velocity_z      FLOAT,
                pitch           FLOAT,
                roll            FLOAT,
                yaw             FLOAT,
                gimbal_pitch    FLOAT,
                gimbal_roll     FLOAT,
                gimbal_yaw      FLOAT,
                battery_percent INTEGER,
                battery_voltage FLOAT,
                battery_current FLOAT,
                battery_temp    FLOAT,
                cell_voltages   VARCHAR,
                flight_mode     VARCHAR,
                gps_signal      INTEGER,
                satellites      INTEGER,
                rc_signal       INTEGER,
                rc_uplink       INTEGER,
                rc_downlink     INTEGER,
                rc_aileron      FLOAT,
                rc_elevator     FLOAT,
                rc_throttle     FLOAT,
                rc_rudder       FLOAT,
                is_photo        BOOLEAN,
                is_video        BOOLEAN
            );
            
            INSERT INTO telemetry_reordered SELECT {} FROM telemetry;
            DROP TABLE telemetry;
            ALTER TABLE telemetry_reordered RENAME TO telemetry;
            
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
                max_altitude, max_speed, home_lat, home_lon, point_count,
                photo_count, video_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                flight.photo_count,
                flight.video_count,
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

        for point in points {
            // Serialize cell_voltages to JSON string for storage
            let cell_voltages_json: Option<String> = point.cell_voltages.as_ref().map(|v| {
                serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
            });
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
                cell_voltages_json.as_deref(),
                point.flight_mode.as_deref(),
                point.gps_signal,
                point.satellites,
                point.rc_signal,
                point.rc_uplink,
                point.rc_downlink,
                point.rc_aileron,
                point.rc_elevator,
                point.rc_throttle,
                point.rc_rudder,
                point.is_photo,
                point.is_video,
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
                file_hash,
                drone_model, drone_serial, aircraft_name, battery_serial,
                CAST(start_time AS VARCHAR) AS start_time,
                duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count,
                photo_count, video_count, notes
            FROM flights
            ORDER BY start_time DESC
            "#,
        )?;

        let mut flights: Vec<Flight> = stmt
            .query_map([], |row| {
                Ok(Flight {
                    id: row.get(0)?,
                    file_name: row.get(1)?,
                    display_name: row.get(2)?,
                    file_hash: row.get(3)?,
                    drone_model: row.get(4)?,
                    drone_serial: row.get(5)?,
                    aircraft_name: row.get(6)?,
                    battery_serial: row.get(7)?,
                    start_time: row.get(8)?,
                    duration_secs: row.get(9)?,
                    total_distance: row.get(10)?,
                    max_altitude: row.get(11)?,
                    max_speed: row.get(12)?,
                    home_lat: row.get(13)?,
                    home_lon: row.get(14)?,
                    point_count: row.get(15)?,
                    photo_count: row.get(16)?,
                    video_count: row.get(17)?,
                    tags: Vec::new(),
                    notes: row.get(18)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Load all tags and attach to flights
        // Use a separate query to avoid breaking if flight_tags table doesn't exist yet
        let tag_map = self.get_all_flight_tags_with_conn(&conn);
        if let Ok(tags) = tag_map {
            for flight in &mut flights {
                if let Some(flight_tags) = tags.get(&flight.id) {
                    flight.tags = flight_tags.clone();
                }
            }
        }

        log::debug!("get_all_flights: {} rows in {:.1}ms", flights.len(), start.elapsed().as_secs_f64() * 1000.0);
        Ok(flights)
    }

    /// Helper: get all flight tags using an existing connection lock
    fn get_all_flight_tags_with_conn(&self, conn: &Connection) -> Result<std::collections::HashMap<i64, Vec<FlightTag>>, DatabaseError> {
        let mut stmt = conn.prepare(
            "SELECT flight_id, tag, tag_type FROM flight_tags ORDER BY flight_id, tag",
        )?;
        let mut map: std::collections::HashMap<i64, Vec<FlightTag>> = std::collections::HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (flight_id, tag, tag_type) = row?;
            map.entry(flight_id).or_default().push(FlightTag { tag, tag_type });
        }
        Ok(map)
    }

    /// Get a single flight by ID (avoids loading all flights)
    pub fn get_flight_by_id(&self, flight_id: i64) -> Result<Flight, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        let mut flight = conn.query_row(
            r#"
            SELECT 
                id, file_name, COALESCE(display_name, file_name) AS display_name,
                file_hash, drone_model, drone_serial, aircraft_name, battery_serial,
                CAST(start_time AS VARCHAR) AS start_time,
                duration_secs, total_distance,
                max_altitude, max_speed, home_lat, home_lon, point_count,
                photo_count, video_count, notes
            FROM flights
            WHERE id = ?
            "#,
            params![flight_id],
            |row| {
                Ok(Flight {
                    id: row.get(0)?,
                    file_name: row.get(1)?,
                    display_name: row.get(2)?,
                    file_hash: row.get(3)?,
                    drone_model: row.get(4)?,
                    drone_serial: row.get(5)?,
                    aircraft_name: row.get(6)?,
                    battery_serial: row.get(7)?,
                    start_time: row.get(8)?,
                    duration_secs: row.get(9)?,
                    total_distance: row.get(10)?,
                    max_altitude: row.get(11)?,
                    max_speed: row.get(12)?,
                    home_lat: row.get(13)?,
                    home_lon: row.get(14)?,
                    point_count: row.get(15)?,
                    photo_count: row.get(16)?,
                    video_count: row.get(17)?,
                    tags: Vec::new(),
                    notes: row.get(18)?,
                })
            },
        )
        .map_err(|e| match e {
            duckdb::Error::QueryReturnedNoRows => DatabaseError::FlightNotFound(flight_id),
            other => DatabaseError::DuckDb(other),
        })?;

        // Load tags for this flight
        if let Ok(mut stmt) = conn.prepare("SELECT tag, tag_type FROM flight_tags WHERE flight_id = ? ORDER BY tag") {
            if let Ok(tags) = stmt
                .query_map(params![flight_id], |row| {
                    Ok(FlightTag {
                        tag: row.get::<_, String>(0)?,
                        tag_type: row.get::<_, String>(1)?,
                    })
                })
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            {
                flight.tags = tags;
            }
        }

        Ok(flight)
    }

    /// Get flight telemetry with automatic downsampling for large datasets.
    ///
    /// Strategy:
    /// - If max_points is None: return all raw data (for export)
    /// - If points <= max_points: return raw data
    /// - If points > max_points: group by time-bucket intervals, averaging values
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

        // None = return all raw data (for export); Some(n) = downsample for display
        if max_points.is_none() {
            log::debug!("Returning all raw telemetry points for flight {} (export mode)", flight_id);
            return self.query_raw_telemetry(&conn, flight_id);
        }

        let max_points = max_points.unwrap();

        // Use known count or fall back to a COUNT query
        let point_count = match known_point_count {
            Some(c) if c > 0 => c,
            _ => {
                let c: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM telemetry WHERE flight_id = ?",
                    params![flight_id],
                    |row| row.get(0),
                )?;
                // Return empty vec for flights with no telemetry (e.g., manual entries)
                if c == 0 {
                    return Ok(Vec::new());
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
                cell_voltages,
                pitch,
                roll,
                yaw,
                satellites,
                flight_mode,
                rc_signal,
                rc_uplink,
                rc_downlink,
                rc_aileron,
                rc_elevator,
                rc_throttle,
                rc_rudder,
                is_photo,
                is_video
            FROM telemetry
            WHERE flight_id = ?
            ORDER BY timestamp_ms ASC
            "#,
        )?;

        let records = stmt
            .query_map(params![flight_id], |row| {
                // Parse cell_voltages from JSON string
                let cell_voltages_json: Option<String> = row.get(13)?;
                let cell_voltages = cell_voltages_json.and_then(|s| {
                    serde_json::from_str::<Vec<f64>>(&s).ok()
                });
                
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
                    cell_voltages,
                    pitch: row.get(14)?,
                    roll: row.get(15)?,
                    yaw: row.get(16)?,
                    satellites: row.get(17)?,
                    flight_mode: row.get(18)?,
                    rc_signal: row.get(19)?,
                    rc_uplink: row.get(20)?,
                    rc_downlink: row.get(21)?,
                    rc_aileron: row.get(22)?,
                    rc_elevator: row.get(23)?,
                    rc_throttle: row.get(24)?,
                    rc_rudder: row.get(25)?,
                    is_photo: row.get(26)?,
                    is_video: row.get(27)?,
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
                    FIRST(cell_voltages ORDER BY timestamp_ms) AS cell_voltages,
                    AVG(pitch) AS pitch,
                    AVG(roll) AS roll,
                    AVG(yaw) AS yaw,
                    ROUND(AVG(satellites))::INTEGER AS satellites,
                    FIRST(flight_mode ORDER BY timestamp_ms) AS flight_mode,
                    AVG(rc_signal)::INTEGER AS rc_signal,
                    AVG(rc_uplink)::INTEGER AS rc_uplink,
                    AVG(rc_downlink)::INTEGER AS rc_downlink,
                    AVG(rc_aileron) AS rc_aileron,
                    AVG(rc_elevator) AS rc_elevator,
                    AVG(rc_throttle) AS rc_throttle,
                    AVG(rc_rudder) AS rc_rudder,
                    BOOL_OR(is_photo) AS is_photo,
                    BOOL_OR(is_video) AS is_video
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
                // Parse cell_voltages from JSON string
                let cell_voltages_json: Option<String> = row.get(13)?;
                let cell_voltages = cell_voltages_json.and_then(|s| {
                    serde_json::from_str::<Vec<f64>>(&s).ok()
                });
                
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
                    cell_voltages,
                    pitch: row.get(14)?,
                    roll: row.get(15)?,
                    yaw: row.get(16)?,
                    satellites: row.get(17)?,
                    flight_mode: row.get(18)?,
                    rc_signal: row.get(19)?,
                    rc_uplink: row.get(20)?,
                    rc_downlink: row.get(21)?,
                    rc_aileron: row.get(22)?,
                    rc_elevator: row.get(23)?,
                    rc_throttle: row.get(24)?,
                    rc_rudder: row.get(25)?,
                    is_photo: row.get(26)?,
                    is_video: row.get(27)?,
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
        // Clean up tags (ignore errors if table doesn't exist in old DBs)
        let _ = conn.execute(
            "DELETE FROM flight_tags WHERE flight_id = ?",
            params![flight_id],
        );
        // Clean up messages (ignore errors if table doesn't exist in old DBs)
        let _ = conn.execute(
            "DELETE FROM flight_messages WHERE flight_id = ?",
            params![flight_id],
        );
        conn.execute("DELETE FROM flights WHERE id = ?", params![flight_id])?;

        log::info!("Deleted flight {} in {:.1}ms", flight_id, start.elapsed().as_secs_f64() * 1000.0);
        Ok(())
    }

    /// Delete all flights and associated telemetry
    pub fn delete_all_flights(&self) -> Result<(), DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        conn.execute("DELETE FROM telemetry", params![])?;
        let _ = conn.execute("DELETE FROM flight_tags", params![]);
        let _ = conn.execute("DELETE FROM flight_messages", params![]);
        conn.execute("DELETE FROM flights", params![])?;

        log::info!("Deleted all flights and telemetry in {:.1}ms", start.elapsed().as_secs_f64() * 1000.0);
        Ok(())
    }

    /// Get overview stats across all flights
    pub fn get_overview_stats(&self) -> Result<OverviewStats, DatabaseError> {
        let start = std::time::Instant::now();
        let conn = self.conn.lock().unwrap();

        // Basic aggregate stats
        let (total_flights, total_distance, total_duration, total_points, total_photos, total_videos, max_altitude): (i64, f64, f64, i64, i64, i64, f64) =
            conn.query_row(
                r#"
                SELECT
                    COUNT(*)::BIGINT,
                    COALESCE(SUM(total_distance), 0)::DOUBLE,
                    COALESCE(SUM(duration_secs), 0)::DOUBLE,
                    COALESCE(SUM(point_count), 0)::BIGINT,
                    COALESCE(SUM(photo_count), 0)::BIGINT,
                    COALESCE(SUM(video_count), 0)::BIGINT,
                    COALESCE(MAX(max_altitude), 0)::DOUBLE
                FROM flights
                "#,
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
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

        // Drone usage stats - group by serial when available, otherwise by model
        let mut stmt = conn.prepare(
            r#"
            SELECT 
                COALESCE(MAX(drone_model), 'Unknown') AS drone_model, 
                drone_serial,
                MAX(aircraft_name) AS aircraft_name,
                COUNT(*)::BIGINT AS flight_count
            FROM flights
            WHERE drone_serial IS NOT NULL AND drone_serial != ''
            GROUP BY drone_serial
            UNION ALL
            SELECT 
                COALESCE(drone_model, 'Unknown') AS drone_model, 
                NULL AS drone_serial,
                MAX(aircraft_name) AS aircraft_name,
                COUNT(*)::BIGINT AS flight_count
            FROM flights
            WHERE drone_serial IS NULL OR drone_serial = ''
            GROUP BY drone_model
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
            total_photos,
            total_videos,
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

    /// Update the notes for a flight
    pub fn update_flight_notes(&self, flight_id: i64, notes: Option<&str>) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "UPDATE flights SET notes = ? WHERE id = ?",
            params![notes, flight_id],
        )?;

        log::debug!("Updated flight {} notes", flight_id);
        Ok(())
    }

    // ================================================================
    // TAG MANAGEMENT
    // ================================================================

    /// Insert multiple tags for a flight (used during import, always type 'auto')
    pub fn insert_flight_tags(&self, flight_id: i64, tags: &[String]) -> Result<(), DatabaseError> {
        if tags.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for tag in tags {
            let trimmed = tag.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Use INSERT OR IGNORE to avoid duplicate key errors
            conn.execute(
                "INSERT OR IGNORE INTO flight_tags (flight_id, tag, tag_type) VALUES (?, ?, 'auto')",
                params![flight_id, trimmed],
            )?;
        }
        log::debug!("Inserted {} tags for flight {}", tags.len(), flight_id);
        Ok(())
    }

    /// Get all tags for a specific flight
    pub fn get_flight_tags(&self, flight_id: i64) -> Result<Vec<FlightTag>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT tag, tag_type FROM flight_tags WHERE flight_id = ? ORDER BY tag",
        )?;
        let tags = stmt
            .query_map(params![flight_id], |row| {
                Ok(FlightTag {
                    tag: row.get::<_, String>(0)?,
                    tag_type: row.get::<_, String>(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    /// Add a single tag to a flight (manual user-added tag)
    pub fn add_flight_tag(&self, flight_id: i64, tag: &str) -> Result<(), DatabaseError> {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO flight_tags (flight_id, tag, tag_type) VALUES (?, ?, 'manual')",
            params![flight_id, trimmed],
        )?;
        log::debug!("Added manual tag '{}' to flight {}", trimmed, flight_id);
        Ok(())
    }

    /// Remove a single tag from a flight
    pub fn remove_flight_tag(&self, flight_id: i64, tag: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM flight_tags WHERE flight_id = ? AND tag = ?",
            params![flight_id, tag.trim()],
        )?;
        log::debug!("Removed tag '{}' from flight {}", tag, flight_id);
        Ok(())
    }

    /// Get all unique tags across all flights
    pub fn get_all_unique_tags(&self) -> Result<Vec<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT DISTINCT tag FROM flight_tags ORDER BY tag",
        )?;
        let tags = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    /// Replace all auto tags for a flight with new ones (keeps manual tags)
    pub fn replace_auto_tags(&self, flight_id: i64, new_tags: &[String]) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        // Delete existing auto tags
        conn.execute(
            "DELETE FROM flight_tags WHERE flight_id = ? AND tag_type = 'auto'",
            params![flight_id],
        )?;
        // Insert new auto tags
        for tag in new_tags {
            let trimmed = tag.trim();
            if trimmed.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO flight_tags (flight_id, tag, tag_type) VALUES (?, ?, 'auto')",
                params![flight_id, trimmed],
            )?;
        }
        Ok(())
    }

    /// Remove all auto-generated tags from all flights (keeps manual tags)
    /// Returns the number of auto tags removed
    pub fn remove_all_auto_tags(&self) -> Result<usize, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let removed = conn.execute(
            "DELETE FROM flight_tags WHERE tag_type = 'auto'",
            [],
        )?;
        Ok(removed)
    }

    /// Get all flight IDs (for bulk operations like tag regeneration)
    pub fn get_all_flight_ids(&self) -> Result<Vec<i64>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM flights ORDER BY id")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    // ================================================================
    // MESSAGE MANAGEMENT
    // ================================================================

    /// Insert flight messages (tips and warnings) for a flight
    pub fn insert_flight_messages(&self, flight_id: i64, messages: &[FlightMessage]) -> Result<(), DatabaseError> {
        if messages.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for msg in messages {
            // Use INSERT OR IGNORE to avoid duplicate key errors
            conn.execute(
                "INSERT OR IGNORE INTO flight_messages (flight_id, timestamp_ms, message_type, message) VALUES (?, ?, ?, ?)",
                params![flight_id, msg.timestamp_ms, msg.message_type, msg.message],
            )?;
        }
        log::debug!("Inserted {} messages for flight {}", messages.len(), flight_id);
        Ok(())
    }

    /// Get all messages for a flight
    pub fn get_flight_messages(&self, flight_id: i64) -> Result<Vec<FlightMessage>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT timestamp_ms, message_type, message FROM flight_messages WHERE flight_id = ? ORDER BY timestamp_ms",
        )?;
        let messages = stmt
            .query_map(params![flight_id], |row| {
                Ok(FlightMessage {
                    timestamp_ms: row.get(0)?,
                    message_type: row.get(1)?,
                    message: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(messages)
    }

    /// Delete all messages for a flight
    #[allow(dead_code)]
    pub fn delete_flight_messages(&self, flight_id: i64) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM flight_messages WHERE flight_id = ?",
            params![flight_id],
        )?;
        Ok(())
    }

    // ========================================================================
    // EQUIPMENT NAMES
    // ========================================================================

    /// Set a custom display name for a battery or aircraft
    pub fn set_equipment_name(&self, serial: &str, equipment_type: &str, display_name: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let serial_upper = serial.trim().to_uppercase();
        
        if display_name.trim().is_empty() {
            // Empty name = delete the mapping
            conn.execute(
                "DELETE FROM equipment_names WHERE serial = ? AND equipment_type = ?",
                params![serial_upper, equipment_type],
            )?;
            log::info!("Removed {} name for serial {}", equipment_type, serial_upper);
        } else {
            conn.execute(
                "INSERT OR REPLACE INTO equipment_names (serial, equipment_type, display_name, updated_at) 
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
                params![serial_upper, equipment_type, display_name.trim()],
            )?;
            log::info!("Set {} name for serial {}: {}", equipment_type, serial_upper, display_name.trim());
        }
        Ok(())
    }

    /// Get all equipment names of a given type (battery or aircraft)
    pub fn get_equipment_names(&self, equipment_type: &str) -> Result<Vec<(String, String)>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT serial, display_name FROM equipment_names WHERE equipment_type = ? ORDER BY serial"
        )?;
        let names = stmt
            .query_map(params![equipment_type], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    }

    /// Get all equipment names (both batteries and aircraft) as a map
    pub fn get_all_equipment_names(&self) -> Result<(Vec<(String, String)>, Vec<(String, String)>), DatabaseError> {
        let battery_names = self.get_equipment_names("battery")?;
        let aircraft_names = self.get_equipment_names("aircraft")?;
        Ok((battery_names, aircraft_names))
    }

    /// Check if a file has already been imported (by hash)
    /// Returns the display_name of the matching flight if found, None otherwise
    pub fn is_file_imported(&self, file_hash: &str) -> Result<Option<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();

        let result: Option<String> = conn.query_row(
            "SELECT COALESCE(display_name, file_name) FROM flights WHERE file_hash = ? LIMIT 1",
            params![file_hash],
            |row| row.get(0),
        ).optional()?;

        Ok(result)
    }

    /// Get all file hashes from existing flights
    /// Used by sync to filter out already-imported files (web feature only)
    #[allow(dead_code)]
    pub fn get_all_file_hashes(&self) -> Result<Vec<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT file_hash FROM flights WHERE file_hash IS NOT NULL AND file_hash != ''"
        )?;
        let hashes = stmt.query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(hashes)
    }

    /// Check if a duplicate flight exists based on exact signature match (drone_serial + battery_serial + start_time).
    /// Returns the display_name of the matching flight if found, None otherwise.
    /// If any of the signature fields are None, returns None (can't reliably deduplicate).
    pub fn is_duplicate_flight(
        &self,
        drone_serial: Option<&str>,
        battery_serial: Option<&str>,
        start_time: Option<chrono::DateTime<chrono::Utc>>,
    ) -> Result<Option<String>, DatabaseError> {
        // We need at least drone_serial and start_time to check for duplicates
        let drone = match drone_serial {
            Some(d) if !d.is_empty() => d,
            _ => return Ok(None),
        };
        let time = match start_time {
            Some(t) => t,
            None => return Ok(None),
        };

        let conn = self.conn.lock().unwrap();

        // Build query based on whether battery_serial is available
        let result: Option<String> = match battery_serial {
            Some(b) if !b.is_empty() => {
                // Full check: drone + battery + start_time
                conn.query_row(
                    r#"
                    SELECT COALESCE(display_name, file_name) FROM flights 
                    WHERE drone_serial = ?
                      AND battery_serial = ?
                      AND start_time IS NOT NULL
                      AND start_time = ?::TIMESTAMPTZ
                    LIMIT 1
                    "#,
                    params![drone, b, time.to_rfc3339()],
                    |row| row.get(0),
                ).optional()?
            }
            _ => {
                // Partial check: drone + start_time only (battery unknown)
                // Also match flights that have NULL battery_serial
                conn.query_row(
                    r#"
                    SELECT COALESCE(display_name, file_name) FROM flights 
                    WHERE drone_serial = ?
                      AND (battery_serial IS NULL OR battery_serial = '')
                      AND start_time IS NOT NULL
                      AND start_time = ?::TIMESTAMPTZ
                    LIMIT 1
                    "#,
                    params![drone, time.to_rfc3339()],
                    |row| row.get(0),
                ).optional()?
            }
        };

        Ok(result)
    }

    /// Remove duplicate flights from the database based on exact signature match (drone_serial + battery_serial + start_time).
    /// Keeps the flight with the most telemetry points for each duplicate group.
    /// Returns the number of duplicates removed.
    pub fn deduplicate_flights(&self) -> Result<usize, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        let start = std::time::Instant::now();
        log::info!("Starting flight deduplication...");

        let mut total_removed = 0;

        // Method 1: Remove exact file_hash duplicates (keep the one with most telemetry points)
        let hash_duplicates = conn.execute(
            r#"
            WITH hash_duplicates AS (
                SELECT file_hash, COUNT(*) as cnt
                FROM flights
                WHERE file_hash IS NOT NULL AND file_hash != ''
                GROUP BY file_hash
                HAVING COUNT(*) > 1
            ),
            ranked_flights AS (
                SELECT f.id, f.file_hash, f.point_count,
                       ROW_NUMBER() OVER (PARTITION BY f.file_hash ORDER BY f.point_count DESC, f.id ASC) as rn
                FROM flights f
                WHERE f.file_hash IN (SELECT file_hash FROM hash_duplicates)
            )
            DELETE FROM flights WHERE id IN (
                SELECT id FROM ranked_flights WHERE rn > 1
            )
            "#,
            [],
        )?;
        total_removed += hash_duplicates;
        log::info!("Removed {} file_hash duplicates", hash_duplicates);

        // Method 2: Remove signature-based duplicates (same drone + battery + exact same start_time)
        // This catches re-imports of the same flight from different sources
        let signature_duplicates = conn.execute(
            r#"
            WITH flight_pairs AS (
                SELECT 
                    f1.id as id1,
                    f2.id as id2,
                    f1.point_count as points1,
                    f2.point_count as points2
                FROM flights f1
                JOIN flights f2 ON f1.drone_serial = f2.drone_serial
                    AND f1.battery_serial = f2.battery_serial
                    AND f1.id < f2.id
                    AND f1.start_time = f2.start_time
                WHERE f1.drone_serial IS NOT NULL AND f1.drone_serial != ''
                  AND f1.battery_serial IS NOT NULL AND f1.battery_serial != ''
                  AND f1.start_time IS NOT NULL
                  AND f2.start_time IS NOT NULL
            ),
            ids_to_delete AS (
                SELECT CASE 
                    WHEN points1 >= points2 THEN id2
                    ELSE id1
                END as id
                FROM flight_pairs
            )
            DELETE FROM flights WHERE id IN (SELECT DISTINCT id FROM ids_to_delete)
            "#,
            [],
        )?;
        total_removed += signature_duplicates;
        log::info!("Removed {} signature-based duplicates", signature_duplicates);

        // Clean up orphaned telemetry data
        let orphaned_telemetry = conn.execute(
            "DELETE FROM telemetry WHERE flight_id NOT IN (SELECT id FROM flights)",
            [],
        )?;
        log::info!("Cleaned up {} orphaned telemetry records", orphaned_telemetry);

        // Clean up orphaned tags
        let orphaned_tags = conn.execute(
            "DELETE FROM flight_tags WHERE flight_id NOT IN (SELECT id FROM flights)",
            [],
        )?;
        log::info!("Cleaned up {} orphaned tags", orphaned_tags);

        log::info!(
            "Deduplication complete in {:.1}s: {} total duplicate flights removed",
            start.elapsed().as_secs_f64(),
            total_removed
        );

        Ok(total_removed)
    }

    /// Get a setting value by key
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, DatabaseError> {
        let conn = self.conn.lock().unwrap();
        
        let result: Result<String, _> = conn.query_row(
            "SELECT value FROM settings WHERE key = ?",
            params![key],
            |row| row.get(0),
        );
        
        match result {
            Ok(value) => Ok(Some(value)),
            Err(duckdb::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DatabaseError::from(e)),
        }
    }

    /// Set a setting value (insert or update)
    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), DatabaseError> {
        let conn = self.conn.lock().unwrap();
        
        // DuckDB doesn't support CURRENT_TIMESTAMP in ON CONFLICT, so use INSERT OR REPLACE
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            params![key, value],
        )?;
        
        Ok(())
    }

    /// Run one-time startup deduplication for existing data.
    /// This only runs once - on first startup after the dedup feature is added.
    /// After running, it sets a flag so it won't run again.
    fn run_startup_deduplication(&self) {
        const SETTING_KEY: &str = "duplicate_checked";
        
        // Check if we've already run deduplication
        match self.get_setting(SETTING_KEY) {
            Ok(Some(value)) if value == "true" => {
                log::debug!("Startup deduplication already completed, skipping");
                return;
            }
            Ok(_) => {
                // Not set or not "true", run deduplication
            }
            Err(e) => {
                log::warn!("Failed to check dedup setting: {}, proceeding with deduplication", e);
            }
        }

        log::info!("Running one-time startup deduplication for existing flights...");
        
        match self.deduplicate_flights() {
            Ok(count) => {
                if count > 0 {
                    log::info!("Startup deduplication removed {} duplicate flights", count);
                } else {
                    log::info!("Startup deduplication complete, no duplicates found");
                }
            }
            Err(e) => {
                log::error!("Startup deduplication failed: {}", e);
                // Don't set the flag if dedup failed - try again next startup
                return;
            }
        }

        // Mark deduplication as complete
        if let Err(e) = self.set_setting(SETTING_KEY, "true") {
            log::error!("Failed to save dedup completion flag: {}", e);
        }
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
        let tags_path = temp_dir.join("flight_tags.parquet");
        let messages_path = temp_dir.join("flight_messages.parquet");
        let equipment_names_path = temp_dir.join("equipment_names.parquet");

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
        // Export tags table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY flight_tags TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            tags_path.to_string_lossy()
        ));
        // Export messages table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY flight_messages TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            messages_path.to_string_lossy()
        ));
        // Export equipment_names table (ignore error if empty or doesn't exist)
        let _ = conn.execute_batch(&format!(
            "COPY equipment_names TO '{}' (FORMAT PARQUET, COMPRESSION ZSTD);",
            equipment_names_path.to_string_lossy()
        ));

        drop(conn); // release the lock while we tar

        // Pack the Parquet files into a gzip-compressed tar archive
        let dest_file = fs::File::create(dest_path)?;
        let gz = flate2::write::GzEncoder::new(dest_file, flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);

        for name in &["flights.parquet", "telemetry.parquet", "keychains.parquet", "flight_tags.parquet", "flight_messages.parquet", "equipment_names.parquet"] {
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

        // --- Restore flight tags (backward compatible — may not exist in old backups) ---
        let tags_path = temp_dir.join("flight_tags.parquet");
        if tags_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                DELETE FROM flight_tags
                WHERE flight_id IN (
                    SELECT DISTINCT flight_id FROM read_parquet('{}')
                );
                INSERT INTO flight_tags
                SELECT * FROM read_parquet('{}');
                "#,
                tags_path.to_string_lossy(),
                tags_path.to_string_lossy()
            ));
        }

        // --- Restore flight messages (backward compatible — may not exist in old backups) ---
        let messages_path = temp_dir.join("flight_messages.parquet");
        if messages_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                DELETE FROM flight_messages
                WHERE flight_id IN (
                    SELECT DISTINCT flight_id FROM read_parquet('{}')
                );
                INSERT INTO flight_messages
                SELECT * FROM read_parquet('{}');
                "#,
                messages_path.to_string_lossy(),
                messages_path.to_string_lossy()
            ));
        }

        // --- Restore equipment names (backward compatible — may not exist in old backups) ---
        let equipment_names_path = temp_dir.join("equipment_names.parquet");
        if equipment_names_path.exists() {
            let _ = conn.execute_batch(&format!(
                r#"
                INSERT OR REPLACE INTO equipment_names
                SELECT * FROM read_parquet('{}');
                "#,
                equipment_names_path.to_string_lossy()
            ));
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

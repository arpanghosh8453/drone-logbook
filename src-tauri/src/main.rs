//! Open DroneLog - Backend
//!
//! A high-performance application for analyzing DJI drone flight logs.
//! Supports two build modes:
//! - `tauri-app` (default): Desktop app with Tauri v2
//! - `web`: REST API server with Axum for Docker/web deployment
//!
//! Licensed under the GNU Affero General Public License v3.0. See the LICENSE file for details.

#![cfg_attr(
    all(not(debug_assertions), feature = "tauri-app"),
    windows_subsystem = "windows"
)]

mod api;
mod database;
mod dronelogbook_parser;
mod litchi_parser;
mod models;
mod parser;

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
mod server;

// ============================================================================
// TAURI DESKTOP MODE
// ============================================================================

#[cfg(feature = "tauri-app")]
mod tauri_app {
    use std::path::PathBuf;
    use std::sync::Arc;

    use tauri::{AppHandle, Manager, State};
    use tauri_plugin_log::{Target, TargetKind};
    use log::LevelFilter;

    use crate::database::{Database, DatabaseError};
    use crate::models::{Flight, FlightDataResponse, FlightTag, ImportResult, OverviewStats, TelemetryData};
    use crate::parser::LogParser;
    use crate::api::DjiApi;

    /// Application state containing the database connection
    pub struct AppState {
        pub db: Arc<Database>,
    }

    /// Get the app data directory for storing the database and logs
    fn app_data_dir_path(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data directory: {}", e))
    }

    /// Migrate data from old app identifier (com.dji-logviewer) to new one (com.drone-logbook)
    /// This preserves user data when upgrading from older versions
    fn migrate_old_data(new_data_dir: &PathBuf) -> Result<(), String> {
        // Determine the old data directory path based on platform
        let old_data_dir = if cfg!(target_os = "macos") {
            dirs::data_dir().map(|d| d.join("com.dji-logviewer.app"))
        } else if cfg!(target_os = "windows") {
            dirs::data_local_dir().map(|d| d.join("com.dji-logviewer.app"))
        } else {
            // Linux: ~/.local/share/com.dji-logviewer.app
            dirs::data_dir().map(|d| d.join("com.dji-logviewer.app"))
        };

        let old_data_dir = match old_data_dir {
            Some(dir) => dir,
            None => {
                log::debug!("Could not determine old data directory path");
                return Ok(());
            }
        };

        // Check if old directory exists and new one doesn't have data yet
        if !old_data_dir.exists() {
            log::debug!("No old data directory found at {:?}", old_data_dir);
            return Ok(());
        }

        let old_db_path = old_data_dir.join("flights.db");
        let new_db_path = new_data_dir.join("flights.db");

        // Only migrate if old DB exists and new DB doesn't
        if !old_db_path.exists() {
            log::debug!("No old database found at {:?}", old_db_path);
            return Ok(());
        }

        if new_db_path.exists() {
            log::info!("New database already exists, skipping migration");
            return Ok(());
        }

        log::info!("Migrating data from {:?} to {:?}", old_data_dir, new_data_dir);

        // Create new data directory if it doesn't exist
        std::fs::create_dir_all(new_data_dir)
            .map_err(|e| format!("Failed to create new data directory: {}", e))?;

        // Copy all files from old directory to new directory
        for entry in std::fs::read_dir(&old_data_dir)
            .map_err(|e| format!("Failed to read old data directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let file_name = entry.file_name();
            let old_path = entry.path();
            let new_path = new_data_dir.join(&file_name);

            if old_path.is_dir() {
                // Recursively copy directories (e.g., keychains/)
                copy_dir_recursive(&old_path, &new_path)?;
            } else {
                // Copy files
                std::fs::copy(&old_path, &new_path)
                    .map_err(|e| format!("Failed to copy {:?}: {}", file_name, e))?;
            }
            log::debug!("Migrated: {:?}", file_name);
        }

        log::info!("Successfully migrated all data from old location");
        Ok(())
    }

    /// Recursively copy a directory
    fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("Failed to create directory {:?}: {}", dst, e))?;

        for entry in std::fs::read_dir(src)
            .map_err(|e| format!("Failed to read directory {:?}: {}", src, e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());

            if src_path.is_dir() {
                copy_dir_recursive(&src_path, &dst_path)?;
            } else {
                std::fs::copy(&src_path, &dst_path)
                    .map_err(|e| format!("Failed to copy {:?}: {}", src_path, e))?;
            }
        }
        Ok(())
    }

    /// Initialize the database in the app data directory
    fn init_database(app: &AppHandle) -> Result<Database, String> {
        let data_dir = app_data_dir_path(app)?;
        log::info!("Initializing database in: {:?}", data_dir);

        // Attempt to migrate data from old app identifier
        if let Err(e) = migrate_old_data(&data_dir) {
            log::warn!("Migration from old data directory failed: {}", e);
            // Continue anyway - this is not fatal
        }

        Database::new(data_dir).map_err(|e| format!("Failed to initialize database: {}", e))
    }

    #[tauri::command]
    pub async fn import_log(file_path: String, state: State<'_, AppState>) -> Result<ImportResult, String> {
        let import_start = std::time::Instant::now();
        log::info!("Importing log file: {}", file_path);

        let path = PathBuf::from(&file_path);

        if !path.exists() {
            log::warn!("File not found: {}", file_path);
            return Ok(ImportResult {
                success: false,
                flight_id: None,
                message: "File not found".to_string(),
                point_count: 0,
                file_hash: None,
            });
        }

        // Load config early for keep_uploaded_files setting
        let config_path = state.db.data_dir.join("config.json");
        let config: serde_json::Value = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        let keep_enabled = config.get("keep_uploaded_files").and_then(|v| v.as_bool()).unwrap_or(true);
        let default_folder = state.db.data_dir.join("uploaded");
        let upload_folder = config.get("uploaded_files_path")
            .and_then(|v| v.as_str())
            .map(|s| PathBuf::from(s))
            .unwrap_or(default_folder);

        // Helper to copy uploaded file if setting is enabled
        let try_copy_file = |file_hash: Option<&str>| {
            if keep_enabled {
                if let Err(e) = copy_uploaded_file(&path, &upload_folder, file_hash) {
                    log::warn!("Failed to copy uploaded file: {}", e);
                }
            }
        };

        let parser = LogParser::new(&state.db);

        let parse_result = match parser.parse_log(&path).await {
            Ok(result) => result,
            Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
                log::info!("Skipping already-imported file: {} — matches flight '{}' in database", file_path, matching_flight);
                // Compute file hash so copy_uploaded_file can properly deduplicate
                let file_hash = LogParser::calculate_file_hash(&path).ok();
                try_copy_file(file_hash.as_deref());
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: format!("This flight log has already been imported (matches: {})", matching_flight),
                    point_count: 0,
                    file_hash,
                });
            }
            Err(e) => {
                log::error!("Failed to parse log {}: {}", file_path, e);
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: format!("Failed to parse log: {}", e),
                    point_count: 0,
                    file_hash: None,
                });
            }
        };

        // Check for duplicate flight based on signature (drone_serial + battery_serial + start_time)
        if let Some(matching_flight) = state.db.is_duplicate_flight(
            parse_result.metadata.drone_serial.as_deref(),
            parse_result.metadata.battery_serial.as_deref(),
            parse_result.metadata.start_time,
        ).unwrap_or(None) {
            log::info!("Skipping duplicate flight (signature match): {} - matches flight '{}' in database", file_path, matching_flight);
            // Still copy the file even though flight is a duplicate
            try_copy_file(parse_result.metadata.file_hash.as_deref());
            return Ok(ImportResult {
                success: false,
                flight_id: None,
                message: format!("Duplicate flight: matches '{}' (same drone, battery, and start time)", matching_flight),
                point_count: 0,
                file_hash: parse_result.metadata.file_hash.clone(),
            });
        }

        log::debug!("Inserting flight metadata: id={}", parse_result.metadata.id);
        let flight_id = state
            .db
            .insert_flight(&parse_result.metadata)
            .map_err(|e| format!("Failed to insert flight: {}", e))?;

        let point_count = match state
            .db
            .bulk_insert_telemetry(flight_id, &parse_result.points)
        {
            Ok(count) => count,
            Err(e) => {
                log::error!("Failed to insert telemetry for flight {}: {}. Cleaning up.", flight_id, e);
                if let Err(cleanup_err) = state.db.delete_flight(flight_id) {
                    log::error!("Failed to clean up flight {}: {}", flight_id, cleanup_err);
                }
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: format!("Failed to insert telemetry data: {}", e),
                    point_count: 0,
                    file_hash: parse_result.metadata.file_hash.clone(),
                });
            }
        };

        // Insert smart tags if the feature is enabled
        let config_path = state.db.data_dir.join("config.json");
        let config: serde_json::Value = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        let tags_enabled = config.get("smart_tags_enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        
        if tags_enabled {
            // Filter tags based on enabled_tag_types if configured
            let tags = if let Some(types) = config.get("enabled_tag_types").and_then(|v| v.as_array()) {
                let enabled_types: Vec<String> = types.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                crate::parser::LogParser::filter_smart_tags(parse_result.tags.clone(), &enabled_types)
            } else {
                parse_result.tags.clone()
            };
            if let Err(e) = state.db.insert_flight_tags(flight_id, &tags) {
                log::warn!("Failed to insert tags for flight {}: {}", flight_id, e);
            }
        }

        // Insert manual tags from re-imported CSV exports (always inserted regardless of smart_tags_enabled)
        for manual_tag in &parse_result.manual_tags {
            if let Err(e) = state.db.add_flight_tag(flight_id, manual_tag) {
                log::warn!("Failed to insert manual tag '{}' for flight {}: {}", manual_tag, flight_id, e);
            }
        }

        // Insert notes from re-imported CSV exports
        if let Some(ref notes) = parse_result.notes {
            if let Err(e) = state.db.update_flight_notes(flight_id, Some(notes.as_str())) {
                log::warn!("Failed to insert notes for flight {}: {}", flight_id, e);
            }
        }

        // Insert app messages (tips and warnings) from DJI logs
        if !parse_result.messages.is_empty() {
            if let Err(e) = state.db.insert_flight_messages(flight_id, &parse_result.messages) {
                log::warn!("Failed to insert messages for flight {}: {}", flight_id, e);
            }
        }

        log::info!(
            "Successfully imported flight {} with {} points in {:.1}s",
            flight_id,
            point_count,
            import_start.elapsed().as_secs_f64()
        );

        // Copy uploaded file if setting is enabled
        try_copy_file(parse_result.metadata.file_hash.as_deref());

        Ok(ImportResult {
            success: true,
            flight_id: Some(flight_id),
            message: format!("Successfully imported {} telemetry points", point_count),
            point_count,
            file_hash: parse_result.metadata.file_hash.clone(),
        })
    }

    /// Create a manual flight entry without importing a log file
    /// Used for flights where no log file is available
    #[tauri::command]
    pub async fn create_manual_flight(
        flight_title: Option<String>,
        aircraft_name: String,
        drone_serial: String,
        battery_serial: String,
        start_time: String, // ISO 8601 format
        duration_secs: f64,
        total_distance: Option<f64>,
        max_altitude: Option<f64>,
        home_lat: f64,
        home_lon: f64,
        notes: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<ImportResult, String> {
        use chrono::DateTime;
        
        log::info!("Creating manual flight entry: {} @ {}", aircraft_name, start_time);

        // Parse the start time
        let parsed_start_time = DateTime::parse_from_rfc3339(&start_time)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .map_err(|e| format!("Invalid start time format: {}", e))?;

        // Calculate end time
        let end_time = parsed_start_time + chrono::Duration::seconds(duration_secs as i64);

        // Create flight metadata
        // Use flight_title if provided, otherwise fallback to aircraft_name
        let display_name = flight_title
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.clone())
            .unwrap_or_else(|| aircraft_name.clone());
        
        let flight_id = state.db.generate_flight_id();
        let metadata = crate::models::FlightMetadata {
            id: flight_id,
            file_name: format!("manual_entry_{}.log", flight_id),
            display_name,
            file_hash: None, // Manual entries have no file hash
            drone_model: Some(format!("Manual Entry ({})", aircraft_name)),
            drone_serial: Some(drone_serial.trim().to_uppercase()),
            aircraft_name: Some(aircraft_name),
            battery_serial: Some(battery_serial.trim().to_uppercase()),
            start_time: Some(parsed_start_time),
            end_time: Some(end_time),
            duration_secs: Some(duration_secs),
            total_distance,
            max_altitude,
            max_speed: None,
            home_lat: Some(home_lat),
            home_lon: Some(home_lon),
            point_count: 0, // No telemetry points for manual entries
            photo_count: 0,
            video_count: 0,
        };

        // Insert flight
        state
            .db
            .insert_flight(&metadata)
            .map_err(|e| format!("Failed to insert flight: {}", e))?;

        // Update notes if provided
        if let Some(notes_text) = notes {
            if !notes_text.trim().is_empty() {
                state
                    .db
                    .update_flight_notes(flight_id, Some(&notes_text))
                    .map_err(|e| format!("Failed to add notes: {}", e))?;
            }
        }

        // Add "Manual Entry" tag
        let tags = vec!["Manual Entry".to_string()];
        if let Err(e) = state.db.insert_flight_tags(flight_id, &tags) {
            log::warn!("Failed to add tags: {}", e);
        }

        // Generate smart tags based on location
        let stats = crate::models::FlightStats {
            duration_secs,
            total_distance_m: total_distance.unwrap_or(0.0),
            max_altitude_m: max_altitude.unwrap_or(0.0),
            max_speed_ms: 0.0,
            avg_speed_ms: 0.0,
            min_battery: 100,
            home_location: Some([home_lon, home_lat]),
            max_distance_from_home_m: 0.0,
            start_battery_percent: None,
            end_battery_percent: None,
            start_battery_temp: None,
        };
        
        let smart_tags = crate::parser::LogParser::generate_smart_tags(&metadata, &stats);
        if !smart_tags.is_empty() {
            if let Err(e) = state.db.insert_flight_tags(flight_id, &smart_tags) {
                log::warn!("Failed to add smart tags: {}", e);
            }
        }

        log::info!("Successfully created manual flight entry with ID: {}", flight_id);

        Ok(ImportResult {
            success: true,
            flight_id: Some(flight_id),
            message: "Manual flight entry created successfully".to_string(),
            point_count: 0,
            file_hash: None,
        })
    }

    /// Compute SHA256 hash of a file without importing it
    /// Used to check if a file is blacklisted before importing
    #[tauri::command]
    pub fn compute_file_hash(file_path: String) -> Result<String, String> {
        let path = PathBuf::from(&file_path);
        if !path.exists() {
            return Err("File not found".to_string());
        }
        LogParser::calculate_file_hash(&path)
            .map_err(|e| format!("Failed to compute hash: {}", e))
    }

    #[tauri::command]
    pub async fn get_flights(state: State<'_, AppState>) -> Result<Vec<Flight>, String> {
        let start = std::time::Instant::now();
        let flights = state
            .db
            .get_all_flights()
            .map_err(|e| format!("Failed to get flights: {}", e))?;
        log::debug!("get_flights returned {} flights in {:.1}ms", flights.len(), start.elapsed().as_secs_f64() * 1000.0);
        Ok(flights)
    }

    #[tauri::command]
    pub async fn get_flight_data(
        flight_id: i64,
        max_points: Option<usize>,
        state: State<'_, AppState>,
    ) -> Result<FlightDataResponse, String> {
        let start = std::time::Instant::now();
        log::debug!("Fetching flight data for ID: {} (max_points: {:?})", flight_id, max_points);

        let flight = state
            .db
            .get_flight_by_id(flight_id)
            .map_err(|e| match e {
                DatabaseError::FlightNotFound(id) => format!("Flight {} not found", id),
                _ => format!("Failed to get flight: {}", e),
            })?;

        let known_point_count = flight.point_count.map(|c| c as i64);

        let telemetry_records = state
            .db
            .get_flight_telemetry(flight_id, max_points, known_point_count)
            .map_err(|e| match e {
                DatabaseError::FlightNotFound(id) => format!("Flight {} not found", id),
                _ => format!("Failed to get telemetry: {}", e),
            })?;

        let telemetry = TelemetryData::from_records(&telemetry_records);
        let track = telemetry.extract_track(2000);

        // Get flight messages (tips and warnings)
        let messages = state
            .db
            .get_flight_messages(flight_id)
            .unwrap_or_else(|e| {
                log::warn!("Failed to get messages for flight {}: {}", flight_id, e);
                Vec::new()
            });

        log::debug!(
            "get_flight_data for flight {} complete in {:.1}ms: {} telemetry series, {} track points, {} messages",
            flight_id,
            start.elapsed().as_secs_f64() * 1000.0,
            telemetry_records.len(),
            track.len(),
            messages.len()
        );

        Ok(FlightDataResponse {
            flight,
            telemetry,
            track,
            messages,
        })
    }

    #[tauri::command]
    pub async fn get_overview_stats(state: State<'_, AppState>) -> Result<OverviewStats, String> {
        let start = std::time::Instant::now();
        let stats = state
            .db
            .get_overview_stats()
            .map_err(|e| format!("Failed to get overview stats: {}", e))?;
        log::debug!(
            "get_overview_stats complete in {:.1}ms: {} flights, {:.0}m total distance",
            start.elapsed().as_secs_f64() * 1000.0,
            stats.total_flights,
            stats.total_distance_m
        );
        Ok(stats)
    }

    #[tauri::command]
    pub async fn delete_flight(flight_id: i64, state: State<'_, AppState>) -> Result<bool, String> {
        log::info!("Deleting flight: {}", flight_id);
        state
            .db
            .delete_flight(flight_id)
            .map(|_| true)
            .map_err(|e| format!("Failed to delete flight: {}", e))
    }

    #[tauri::command]
    pub async fn delete_all_flights(state: State<'_, AppState>) -> Result<bool, String> {
        log::warn!("Deleting ALL flights and telemetry");
        state
            .db
            .delete_all_flights()
            .map(|_| true)
            .map_err(|e| format!("Failed to delete all flights: {}", e))
    }

    #[tauri::command]
    pub async fn deduplicate_flights(state: State<'_, AppState>) -> Result<usize, String> {
        log::info!("Running flight deduplication");
        state
            .db
            .deduplicate_flights()
            .map_err(|e| format!("Failed to deduplicate flights: {}", e))
    }

    #[tauri::command]
    pub async fn update_flight_name(
        flight_id: i64,
        display_name: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let trimmed = display_name.trim();
        if trimmed.is_empty() {
            return Err("Display name cannot be empty".to_string());
        }

        log::info!("Renaming flight {} to '{}'", flight_id, trimmed);

        state
            .db
            .update_flight_name(flight_id, trimmed)
            .map(|_| true)
            .map_err(|e| format!("Failed to update flight name: {}", e))
    }

    #[tauri::command]
    pub async fn update_flight_notes(
        flight_id: i64,
        notes: Option<String>,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        let notes_ref = notes.as_ref().map(|s| {
            let trimmed = s.trim();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }).flatten();

        log::info!("Updating notes for flight {}", flight_id);

        state
            .db
            .update_flight_notes(flight_id, notes_ref)
            .map(|_| true)
            .map_err(|e| format!("Failed to update flight notes: {}", e))
    }

    #[tauri::command]
    pub async fn has_api_key(state: State<'_, AppState>) -> Result<bool, String> {
        let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
        Ok(api.has_api_key())
    }

    #[tauri::command]
    pub async fn get_api_key_type(state: State<'_, AppState>) -> Result<String, String> {
        let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
        Ok(api.get_api_key_type())
    }

    #[tauri::command]
    pub async fn set_api_key(api_key: String, state: State<'_, AppState>) -> Result<bool, String> {
        let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
        api.save_api_key(&api_key)
            .map(|_| true)
            .map_err(|e| format!("Failed to save API key: {}", e))
    }

    #[tauri::command]
    pub async fn remove_api_key(state: State<'_, AppState>) -> Result<bool, String> {
        let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
        api.remove_api_key()
            .map(|_| true)
            .map_err(|e| format!("Failed to remove API key: {}", e))
    }

    #[tauri::command]
    pub async fn get_app_data_dir(state: State<'_, AppState>) -> Result<String, String> {
        Ok(state.db.data_dir.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub async fn get_app_log_dir(app: AppHandle) -> Result<String, String> {
        app.path()
            .app_log_dir()
            .map_err(|e| format!("Failed to get app log directory: {}", e))
            .map(|dir| dir.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub async fn get_equipment_names(state: State<'_, AppState>) -> Result<(Vec<(String, String)>, Vec<(String, String)>), String> {
        state.db.get_all_equipment_names()
            .map_err(|e| format!("Failed to get equipment names: {}", e))
    }

    #[tauri::command]
    pub async fn set_equipment_name(
        serial: String,
        equipment_type: String,
        display_name: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        state.db.set_equipment_name(&serial, &equipment_type, &display_name)
            .map(|_| true)
            .map_err(|e| format!("Failed to set equipment name: {}", e))
    }

    #[tauri::command]
    pub async fn export_backup(dest_path: String, state: State<'_, AppState>) -> Result<bool, String> {
        let path = std::path::PathBuf::from(&dest_path);
        log::info!("Exporting database backup to: {}", dest_path);
        state
            .db
            .export_backup(&path)
            .map(|_| true)
            .map_err(|e| format!("Failed to export backup: {}", e))
    }

    #[tauri::command]
    pub async fn import_backup(src_path: String, state: State<'_, AppState>) -> Result<String, String> {
        let path = std::path::PathBuf::from(&src_path);
        log::info!("Importing database backup from: {}", src_path);
        state
            .db
            .import_backup(&path)
            .map_err(|e| format!("Failed to import backup: {}", e))
    }

    #[tauri::command]
    pub async fn add_flight_tag(flight_id: i64, tag: String, state: State<'_, AppState>) -> Result<Vec<FlightTag>, String> {
        state
            .db
            .add_flight_tag(flight_id, &tag)
            .map_err(|e| format!("Failed to add tag: {}", e))?;
        state
            .db
            .get_flight_tags(flight_id)
            .map_err(|e| format!("Failed to get tags: {}", e))
    }

    #[tauri::command]
    pub async fn remove_flight_tag(flight_id: i64, tag: String, state: State<'_, AppState>) -> Result<Vec<FlightTag>, String> {
        state
            .db
            .remove_flight_tag(flight_id, &tag)
            .map_err(|e| format!("Failed to remove tag: {}", e))?;
        state
            .db
            .get_flight_tags(flight_id)
            .map_err(|e| format!("Failed to get tags: {}", e))
    }

    #[tauri::command]
    pub async fn get_all_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        state
            .db
            .get_all_unique_tags()
            .map_err(|e| format!("Failed to get tags: {}", e))
    }

    #[tauri::command]
    pub async fn remove_all_auto_tags(state: State<'_, AppState>) -> Result<usize, String> {
        state
            .db
            .remove_all_auto_tags()
            .map_err(|e| format!("Failed to remove auto tags: {}", e))
    }

    #[tauri::command]
    pub async fn get_smart_tags_enabled(state: State<'_, AppState>) -> Result<bool, String> {
        let config_path = state.db.data_dir.join("config.json");
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)
                .map_err(|e| format!("Failed to read config: {}", e))?;
            let val: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            Ok(val.get("smart_tags_enabled").and_then(|v| v.as_bool()).unwrap_or(true))
        } else {
            Ok(true)
        }
    }

    #[tauri::command]
    pub async fn set_smart_tags_enabled(enabled: bool, state: State<'_, AppState>) -> Result<bool, String> {
        let config_path = state.db.data_dir.join("config.json");
        let mut config: serde_json::Value = if config_path.exists() {
            let content = std::fs::read_to_string(&config_path).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        config["smart_tags_enabled"] = serde_json::json!(enabled);
        std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
            .map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(enabled)
    }

    #[tauri::command]
    pub async fn get_enabled_tag_types(state: State<'_, AppState>) -> Result<Vec<String>, String> {
        let config_path = state.db.data_dir.join("config.json");
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)
                .map_err(|e| format!("Failed to read config: {}", e))?;
            let val: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            if let Some(types) = val.get("enabled_tag_types").and_then(|v| v.as_array()) {
                return Ok(types.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect());
            }
        }
        // Default: return all tag types
        Ok(vec![
            "night_flight".to_string(), "high_speed".to_string(), "cold_battery".to_string(),
            "heavy_load".to_string(), "low_battery".to_string(), "high_altitude".to_string(),
            "long_distance".to_string(), "long_flight".to_string(), "short_flight".to_string(),
            "aggressive_flying".to_string(), "no_gps".to_string(), "country".to_string(),
            "continent".to_string(),
        ])
    }

    #[tauri::command]
    pub async fn set_enabled_tag_types(types: Vec<String>, state: State<'_, AppState>) -> Result<Vec<String>, String> {
        let config_path = state.db.data_dir.join("config.json");
        let mut config: serde_json::Value = if config_path.exists() {
            let content = std::fs::read_to_string(&config_path).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        config["enabled_tag_types"] = serde_json::json!(types.clone());
        std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
            .map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(types)
    }

    /// Settings for keeping uploaded files
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct KeepUploadSettings {
        pub enabled: bool,
        pub folder_path: String,
    }

    #[tauri::command]
    pub async fn get_keep_upload_settings(state: State<'_, AppState>) -> Result<KeepUploadSettings, String> {
        let config_path = state.db.data_dir.join("config.json");
        let default_folder = state.db.data_dir.join("uploaded").to_string_lossy().to_string();
        
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)
                .map_err(|e| format!("Failed to read config: {}", e))?;
            let val: serde_json::Value = serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config: {}", e))?;
            
            let enabled = val.get("keep_uploaded_files").and_then(|v| v.as_bool()).unwrap_or(true);
            let folder_path = val.get("uploaded_files_path")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or(default_folder);
            
            Ok(KeepUploadSettings { enabled, folder_path })
        } else {
            Ok(KeepUploadSettings { enabled: true, folder_path: default_folder })
        }
    }

    #[tauri::command]
    pub async fn set_keep_upload_settings(enabled: bool, folder_path: Option<String>, state: State<'_, AppState>) -> Result<KeepUploadSettings, String> {
        let config_path = state.db.data_dir.join("config.json");
        let default_folder = state.db.data_dir.join("uploaded").to_string_lossy().to_string();
        let actual_folder = folder_path.unwrap_or(default_folder);
        
        let mut config: serde_json::Value = if config_path.exists() {
            let content = std::fs::read_to_string(&config_path).unwrap_or_default();
            serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        
        config["keep_uploaded_files"] = serde_json::json!(enabled);
        config["uploaded_files_path"] = serde_json::json!(actual_folder.clone());
        
        std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
            .map_err(|e| format!("Failed to write config: {}", e))?;
        
        Ok(KeepUploadSettings { enabled, folder_path: actual_folder })
    }

    /// Copy uploaded file to the keep folder with hash-based deduplication
    fn copy_uploaded_file(src_path: &PathBuf, dest_folder: &PathBuf, file_hash: Option<&str>) -> Result<(), String> {
        // Create the destination folder if it doesn't exist
        std::fs::create_dir_all(dest_folder)
            .map_err(|e| format!("Failed to create uploaded files folder: {}", e))?;
        
        let file_name = src_path.file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid file name")?;
        
        let dest_path = dest_folder.join(file_name);
        
        // Compute source file hash if not provided
        let computed_hash: String;
        let src_hash = match file_hash {
            Some(h) => h,
            None => {
                computed_hash = LogParser::calculate_file_hash(src_path)
                    .map_err(|e| format!("Failed to hash source file: {}", e))?;
                &computed_hash
            }
        };
        
        // If file with same name exists, check hash
        if dest_path.exists() {
            let existing_hash = LogParser::calculate_file_hash(&dest_path)
                .map_err(|e| format!("Failed to hash existing file: {}", e))?;
            
            // If hashes match, skip (file already exists)
            if existing_hash == src_hash {
                log::info!("File already exists with same hash, skipping: {}", file_name);
                return Ok(());
            }
            
            // Hashes don't match - save with hash suffix
            let stem = src_path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            let extension = src_path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            
            let hash_suffix = &src_hash[..8.min(src_hash.len())];
            let new_name = if extension.is_empty() {
                format!("{}_{}", stem, hash_suffix)
            } else {
                format!("{}_{}.{}", stem, hash_suffix, extension)
            };
            
            let new_dest_path = dest_folder.join(&new_name);
            std::fs::copy(src_path, &new_dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
            log::info!("Copied uploaded file (renamed due to hash mismatch): {} -> {}", file_name, new_name);
        } else {
            // No existing file, just copy
            std::fs::copy(src_path, &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
            log::info!("Copied uploaded file: {}", file_name);
        }
        
        Ok(())
    }

    #[tauri::command]
    pub async fn regenerate_flight_smart_tags(
        state: State<'_, AppState>,
        flight_id: i64,
        enabled_tag_types: Option<Vec<String>>,
    ) -> Result<String, String> {
        use crate::parser::{LogParser, calculate_stats_from_records};

        let flight = state.db.get_flight_by_id(flight_id)
            .map_err(|e| format!("Failed to get flight {}: {}", flight_id, e))?;

        let metadata = crate::models::FlightMetadata {
            id: flight.id,
            file_name: flight.file_name.clone(),
            display_name: flight.display_name.clone(),
            file_hash: None,
            drone_model: flight.drone_model.clone(),
            drone_serial: flight.drone_serial.clone(),
            aircraft_name: flight.aircraft_name.clone(),
            battery_serial: flight.battery_serial.clone(),
            start_time: flight.start_time.as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .or_else(|| flight.start_time.as_deref()
                    .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()
                        .or_else(|| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f").ok()))
                    .map(|ndt| ndt.and_utc())),
            end_time: None,
            duration_secs: flight.duration_secs,
            total_distance: flight.total_distance,
            max_altitude: flight.max_altitude,
            max_speed: flight.max_speed,
            home_lat: flight.home_lat,
            home_lon: flight.home_lon,
            point_count: flight.point_count.unwrap_or(0),
            photo_count: flight.photo_count.unwrap_or(0),
            video_count: flight.video_count.unwrap_or(0),
        };

        match state.db.get_flight_telemetry(flight_id, Some(50000), None) {
            Ok(records) if !records.is_empty() => {
                let stats = calculate_stats_from_records(&records);
                let mut tags = LogParser::generate_smart_tags(&metadata, &stats);
                // Filter tags if enabled_tag_types is provided
                if let Some(ref types) = enabled_tag_types {
                    tags = LogParser::filter_smart_tags(tags, types);
                }
                state.db.replace_auto_tags(flight_id, &tags)
                    .map_err(|e| format!("Failed to replace tags for flight {}: {}", flight_id, e))?;
            }
            Ok(_) => {
                let _ = state.db.replace_auto_tags(flight_id, &[]);
            }
            Err(e) => {
                return Err(format!("Failed to get telemetry for flight {}: {}", flight_id, e));
            }
        }

        Ok("ok".to_string())
    }

    #[tauri::command]
    pub async fn regenerate_all_smart_tags(state: State<'_, AppState>) -> Result<String, String> {
        use crate::parser::{LogParser, calculate_stats_from_records};

        log::info!("Starting smart tag regeneration for all flights");
        let start = std::time::Instant::now();

        let flight_ids = state.db.get_all_flight_ids()
            .map_err(|e| format!("Failed to get flight IDs: {}", e))?;

        let _total = flight_ids.len();
        let mut processed = 0usize;
        let mut errors = 0usize;

        for flight_id in &flight_ids {
            match state.db.get_flight_by_id(*flight_id) {
                Ok(flight) => {
                    // Build FlightMetadata from the Flight record
                    let metadata = crate::models::FlightMetadata {
                        id: flight.id,
                        file_name: flight.file_name.clone(),
                        display_name: flight.display_name.clone(),
                        file_hash: None,
                        drone_model: flight.drone_model.clone(),
                        drone_serial: flight.drone_serial.clone(),
                        aircraft_name: flight.aircraft_name.clone(),
                        battery_serial: flight.battery_serial.clone(),
                        start_time: flight.start_time.as_deref()
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .map(|dt| dt.with_timezone(&chrono::Utc))
                            .or_else(|| flight.start_time.as_deref()
                                .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok()
                                    .or_else(|| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f").ok()))
                                .map(|ndt| ndt.and_utc())),
                        end_time: None,
                        duration_secs: flight.duration_secs,
                        total_distance: flight.total_distance,
                        max_altitude: flight.max_altitude,
                        max_speed: flight.max_speed,
                        home_lat: flight.home_lat,
                        home_lon: flight.home_lon,
                        point_count: flight.point_count.unwrap_or(0),
                        photo_count: flight.photo_count.unwrap_or(0),
                        video_count: flight.video_count.unwrap_or(0),
                    };

                    // Get raw telemetry to compute stats
                    match state.db.get_flight_telemetry(*flight_id, Some(50000), None) {
                        Ok(records) if !records.is_empty() => {
                            let stats = calculate_stats_from_records(&records);
                            let tags = LogParser::generate_smart_tags(&metadata, &stats);
                            if let Err(e) = state.db.replace_auto_tags(*flight_id, &tags) {
                                log::warn!("Failed to replace tags for flight {}: {}", flight_id, e);
                                errors += 1;
                            }
                        }
                        Ok(_) => {
                            // No telemetry — just clear auto tags
                            let _ = state.db.replace_auto_tags(*flight_id, &[]);
                        }
                        Err(e) => {
                            log::warn!("Failed to get telemetry for flight {}: {}", flight_id, e);
                            errors += 1;
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to get flight {}: {}", flight_id, e);
                    errors += 1;
                }
            }
            processed += 1;
        }

        let elapsed = start.elapsed().as_secs_f64();
        let msg = format!(
            "Regenerated smart tags for {} flights ({} errors) in {:.1}s",
            processed, errors, elapsed
        );
        log::info!("{}", msg);
        Ok(msg)
    }

    pub fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                // Focus the existing window when a second instance is launched
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    log::info!("Second instance blocked — focused existing window");
                }
            }))
            .plugin(
                tauri_plugin_log::Builder::new()
                    .targets([
                        Target::new(TargetKind::LogDir { file_name: None }),
                        Target::new(TargetKind::Stdout),
                    ])
                    .level(LevelFilter::Debug)
                    .build(),
            )
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_http::init())
            .plugin(tauri_plugin_window_state::Builder::new().build())
            .setup(|app| {
                let db = init_database(app.handle())?;
                app.manage(AppState { db: Arc::new(db) });
                log::info!("Open DroneLog initialized successfully");
                Ok(())
            })
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    log::info!("Window close requested. Intercepting to cleanly teardown database...");
                    
                    // Prevent immediate close
                    api.prevent_close();
                    
                    // Hide window to give immediate feedback to user
                    let _ = window.hide();
                    
                    let app_handle = window.app_handle().clone();
                    
                    // Spawn task to handle the actual teardown
                    tauri::async_runtime::spawn(async move {
                        // Extract state and drop the DB explicitly
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            log::info!("Forcing explicit drop of AppState DB connection...");
                            
                            // To actually drop the inner value from the Arc, we'd need strong count=1.
                            // But since the process is shutting down anyway, we can just execute CHECKPOINT directly.
                            if let Err(e) = state.db.checkpoint() {
                                log::warn!("Final shutdown WAL checkpoint failed: {}", e);
                            } else {
                                log::info!("Final shutdown WAL checkpoint completed successfully.");
                            }
                        }
                        
                        // We give DuckDB a tiny grace period to flush file handlers
                        std::thread::sleep(std::time::Duration::from_millis(150));
                        log::info!("Safe to exit process now.");
                        app_handle.exit(0);
                    });
                }
            })
            .invoke_handler(tauri::generate_handler![
                import_log,
                create_manual_flight,
                compute_file_hash,
                get_flights,
                get_flight_data,
                get_overview_stats,
                delete_flight,
                delete_all_flights,
                deduplicate_flights,
                update_flight_name,
                update_flight_notes,
                has_api_key,
                get_api_key_type,
                set_api_key,
                remove_api_key,
                get_app_data_dir,
                get_app_log_dir,
                get_equipment_names,
                set_equipment_name,
                export_backup,
                import_backup,
                add_flight_tag,
                remove_flight_tag,
                get_all_tags,
                remove_all_auto_tags,
                get_smart_tags_enabled,
                set_smart_tags_enabled,
                get_enabled_tag_types,
                set_enabled_tag_types,
                get_keep_upload_settings,
                set_keep_upload_settings,
                regenerate_flight_smart_tags,
                regenerate_all_smart_tags,
            ])
            .run(tauri::generate_context!())
            .expect("Failed to run Open DroneLog");
    }
}

// ============================================================================
// WEB SERVER MODE
// ============================================================================

#[cfg(all(feature = "web", not(feature = "tauri-app")))]
async fn run_web() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    let data_dir = std::env::var("DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("/data"))
                .join("drone-logbook")
        });

    log::info!("Data directory: {:?}", data_dir);

    if let Err(e) = server::start_server(data_dir).await {
        log::error!("Server failed: {}", e);
        std::process::exit(1);
    }
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

fn main() {
    #[cfg(feature = "tauri-app")]
    {
        tauri_app::run();
    }

    #[cfg(all(feature = "web", not(feature = "tauri-app")))]
    {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_web());
    }

    #[cfg(not(any(feature = "tauri-app", feature = "web")))]
    {
        eprintln!("Error: No feature flag enabled. Build with --features tauri-app or --features web");
        std::process::exit(1);
    }
}

//! DJI Logbook - Backend
//!
//! A high-performance application for analyzing DJI drone flight logs.
//! Supports two build modes:
//! - `tauri-app` (default): Desktop app with Tauri v2
//! - `web`: REST API server with Axum for Docker/web deployment

#![cfg_attr(
    all(not(debug_assertions), feature = "tauri-app"),
    windows_subsystem = "windows"
)]

mod api;
mod database;
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

    /// Initialize the database in the app data directory
    fn init_database(app: &AppHandle) -> Result<Database, String> {
        let data_dir = app_data_dir_path(app)?;
        log::info!("Initializing database in: {:?}", data_dir);

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
            });
        }

        let parser = LogParser::new(&state.db);

        let parse_result = match parser.parse_log(&path).await {
            Ok(result) => result,
            Err(crate::parser::ParserError::AlreadyImported) => {
                log::info!("Skipping already-imported file: {}", file_path);
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: "This flight log has already been imported".to_string(),
                    point_count: 0,
                });
            }
            Err(e) => {
                log::error!("Failed to parse log {}: {}", file_path, e);
                return Ok(ImportResult {
                    success: false,
                    flight_id: None,
                    message: format!("Failed to parse log: {}", e),
                    point_count: 0,
                });
            }
        };

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
                });
            }
        };

        // Insert smart tags if the feature is enabled
        let smart_tags_enabled = state.db.data_dir.join("config.json");
        let tags_enabled = if smart_tags_enabled.exists() {
            std::fs::read_to_string(&smart_tags_enabled)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("smart_tags_enabled").and_then(|v| v.as_bool()))
                .unwrap_or(true)
        } else {
            true
        };
        if tags_enabled {
            if let Err(e) = state.db.insert_flight_tags(flight_id, &parse_result.tags) {
                log::warn!("Failed to insert tags for flight {}: {}", flight_id, e);
            }
        }

        log::info!(
            "Successfully imported flight {} with {} points in {:.1}s",
            flight_id,
            point_count,
            import_start.elapsed().as_secs_f64()
        );

        Ok(ImportResult {
            success: true,
            flight_id: Some(flight_id),
            message: format!("Successfully imported {} telemetry points", point_count),
            point_count,
        })
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

        log::debug!(
            "get_flight_data for flight {} complete in {:.1}ms: {} telemetry series, {} track points",
            flight_id,
            start.elapsed().as_secs_f64() * 1000.0,
            telemetry_records.len(),
            track.len()
        );

        Ok(FlightDataResponse {
            flight,
            telemetry,
            track,
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
    pub async fn regenerate_flight_smart_tags(state: State<'_, AppState>, flight_id: i64) -> Result<String, String> {
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
        };

        match state.db.get_flight_telemetry(flight_id, Some(50000), None) {
            Ok(records) if !records.is_empty() => {
                let stats = calculate_stats_from_records(&records);
                let tags = LogParser::generate_smart_tags(&metadata, &stats);
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
            .setup(|app| {
                let db = init_database(app.handle())?;
                app.manage(AppState { db: Arc::new(db) });
                log::info!("DJI Logbook initialized successfully");
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                import_log,
                get_flights,
                get_flight_data,
                get_overview_stats,
                delete_flight,
                delete_all_flights,
                update_flight_name,
                has_api_key,
                get_api_key_type,
                set_api_key,
                remove_api_key,
                get_app_data_dir,
                get_app_log_dir,
                export_backup,
                import_backup,
                add_flight_tag,
                remove_flight_tag,
                get_all_tags,
                get_smart_tags_enabled,
                set_smart_tags_enabled,
                regenerate_flight_smart_tags,
                regenerate_all_smart_tags,
            ])
            .run(tauri::generate_context!())
            .expect("Failed to run DJI Logbook");
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
                .join("dji-logviewer")
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

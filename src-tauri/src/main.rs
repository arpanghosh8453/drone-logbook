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

#[cfg(feature = "web")]
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
    use crate::models::{Flight, FlightDataResponse, ImportResult, OverviewStats, TelemetryData};
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
    pub async fn set_api_key(api_key: String, state: State<'_, AppState>) -> Result<bool, String> {
        let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
        api.save_api_key(&api_key)
            .map(|_| true)
            .map_err(|e| format!("Failed to save API key: {}", e))
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
                set_api_key,
                get_app_data_dir,
                get_app_log_dir,
                export_backup,
                import_backup,
            ])
            .run(tauri::generate_context!())
            .expect("Failed to run DJI Logbook");
    }
}

// ============================================================================
// WEB SERVER MODE
// ============================================================================

#[cfg(feature = "web")]
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

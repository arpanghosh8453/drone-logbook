//! Axum REST API server for the web/Docker deployment.
//!
//! This module mirrors all 11 Tauri commands as HTTP endpoints,
//! allowing the frontend to communicate via fetch() instead of invoke().

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State as AxumState},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};
use tokio_cron_scheduler::{Job, JobScheduler};

use crate::api::DjiApi;
use crate::database::Database;
use crate::models::{FlightDataResponse, FlightTag, ImportResult, OverviewStats, TelemetryData};
use crate::parser::LogParser;

/// Shared application state for Axum handlers
#[derive(Clone)]
pub struct WebAppState {
    pub db: Arc<Database>,
}

/// Standard error response
#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn err_response(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<ErrorResponse>) {
    (
        status,
        Json(ErrorResponse {
            error: msg.into(),
        }),
    )
}

/// Compute SHA256 hash of a file
fn compute_file_hash(path: &std::path::Path) -> Result<String, String> {
    LogParser::calculate_file_hash(path)
        .map_err(|e| format!("Failed to compute hash: {}", e))
}

/// Copy uploaded file to the keep folder with hash-based deduplication (web mode)
fn copy_uploaded_file_web(src_path: &std::path::PathBuf, dest_folder: &std::path::PathBuf, file_hash: Option<&str>) -> Result<(), String> {
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
            computed_hash = compute_file_hash(src_path)?;
            &computed_hash
        }
    };
    
    // If file with same name exists, check hash
    if dest_path.exists() {
        let existing_hash = compute_file_hash(&dest_path)?;
        
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

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/// POST /api/import — Upload and import a DJI flight log file
async fn import_log(
    AxumState(state): AxumState<WebAppState>,
    mut multipart: Multipart,
) -> Result<Json<ImportResult>, (StatusCode, Json<ErrorResponse>)> {
    // Read the uploaded file from multipart form data
    let field = multipart
        .next_field()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Multipart error: {}", e)))?
        .ok_or_else(|| err_response(StatusCode::BAD_REQUEST, "No file uploaded"))?;

    let file_name = field
        .file_name()
        .unwrap_or("unknown.txt")
        .to_string();
    let data = field
        .bytes()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Failed to read file: {}", e)))?;

    // Write to a temp file so the parser can read it
    let temp_dir = std::env::temp_dir().join("drone-logbook-uploads");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create temp dir: {}", e)))?;

    let temp_path = temp_dir.join(&file_name);
    std::fs::write(&temp_path, &data)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write temp file: {}", e)))?;

    let import_start = std::time::Instant::now();
    log::info!("Importing uploaded log file: {}", file_name);

    // Check if we should keep uploaded files (via env var or config) - check early for all code paths
    let upload_config_path = state.db.data_dir.join("config.json");
    let upload_config: serde_json::Value = if upload_config_path.exists() {
        std::fs::read_to_string(&upload_config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let keep_enabled = std::env::var("KEEP_UPLOADED_FILES")
        .map(|v| v.to_lowercase() == "true" || v == "1")
        .unwrap_or_else(|_| {
            upload_config.get("keep_uploaded_files").and_then(|v| v.as_bool()).unwrap_or(false)
        });
    let default_upload_folder = state.db.data_dir.join("uploaded");
    let upload_folder = upload_config.get("uploaded_files_path")
        .and_then(|v| v.as_str())
        .map(|s| std::path::PathBuf::from(s))
        .unwrap_or(default_upload_folder);

    // Helper to copy uploaded file if setting is enabled
    let try_copy_file = |file_hash: Option<&str>| {
        if keep_enabled {
            if let Err(e) = copy_uploaded_file_web(&temp_path, &upload_folder, file_hash) {
                log::warn!("Failed to copy uploaded file: {}", e);
            }
        }
    };

    let parser = LogParser::new(&state.db);

    let parse_result = match parser.parse_log(&temp_path).await {
        Ok(result) => result,
        Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
            // Compute file hash so copy_uploaded_file_web can properly deduplicate
            let file_hash = compute_file_hash(&temp_path).ok();
            // Copy the file even though flight is already imported
            try_copy_file(file_hash.as_deref());
            // Clean up temp file
            let _ = std::fs::remove_file(&temp_path);
            return Ok(Json(ImportResult {
                success: false,
                flight_id: None,
                message: format!("This flight log has already been imported (matches: {})", matching_flight),
                point_count: 0,
                file_hash,
            }));
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp_path);
            log::error!("Failed to parse log {}: {}", file_name, e);
            return Ok(Json(ImportResult {
                success: false,
                flight_id: None,
                message: format!("Failed to parse log: {}", e),
                point_count: 0,
                file_hash: None,
            }));
        }
    };

    // Copy uploaded file before cleanup if enabled
    try_copy_file(parse_result.metadata.file_hash.as_deref());

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_path);

    // Check for duplicate flight based on signature (drone_serial + battery_serial + start_time)
    if let Some(matching_flight) = state.db.is_duplicate_flight(
        parse_result.metadata.drone_serial.as_deref(),
        parse_result.metadata.battery_serial.as_deref(),
        parse_result.metadata.start_time,
    ).unwrap_or(None) {
        log::info!("Skipping duplicate flight (signature match): {} - matches flight '{}' in database", file_name, matching_flight);
        return Ok(Json(ImportResult {
            success: false,
            flight_id: None,
            message: format!("Duplicate flight: matches '{}' (same drone, battery, and start time)", matching_flight),
            point_count: 0,
            file_hash: parse_result.metadata.file_hash.clone(),
        }));
    }

    // Insert flight metadata
    let flight_id = state
        .db
        .insert_flight(&parse_result.metadata)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to insert flight: {}", e)))?;

    // Bulk insert telemetry data
    let point_count = match state.db.bulk_insert_telemetry(flight_id, &parse_result.points) {
        Ok(count) => count,
        Err(e) => {
            log::error!("Failed to insert telemetry for flight {}: {}. Cleaning up.", flight_id, e);
            if let Err(cleanup_err) = state.db.delete_flight(flight_id) {
                log::error!("Failed to clean up flight {}: {}", flight_id, cleanup_err);
            }
            return Ok(Json(ImportResult {
                success: false,
                flight_id: None,
                message: format!("Failed to insert telemetry data: {}", e),
                point_count: 0,
                file_hash: parse_result.metadata.file_hash.clone(),
            }));
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

    Ok(Json(ImportResult {
        success: true,
        flight_id: Some(flight_id),
        message: format!("Successfully imported {} telemetry points", point_count),
        point_count,
        file_hash: parse_result.metadata.file_hash.clone(),
    }))
}

/// Request payload for manual flight creation
#[derive(Deserialize)]
struct CreateManualFlightPayload {
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
}

/// POST /api/manual_flight — Create a manual flight entry without log file
async fn create_manual_flight(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<CreateManualFlightPayload>,
) -> Result<Json<ImportResult>, (StatusCode, Json<ErrorResponse>)> {
    use chrono::DateTime;

    log::info!("Creating manual flight entry: {} @ {}", payload.aircraft_name, payload.start_time);

    // Validate required fields
    if payload.aircraft_name.trim().is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Aircraft name is required"));
    }
    if payload.drone_serial.trim().is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Drone serial is required"));
    }
    if payload.battery_serial.trim().is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Battery serial is required"));
    }

    // Parse the start time
    let parsed_start_time = DateTime::parse_from_rfc3339(&payload.start_time)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Invalid start time format: {}", e)))?;

    // Calculate end time
    let end_time = parsed_start_time + chrono::Duration::seconds(payload.duration_secs as i64);

    // Create flight metadata
    // Use flight_title if provided, otherwise fallback to aircraft_name
    let display_name = payload.flight_title
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| payload.aircraft_name.clone());
    
    let flight_id = state.db.generate_flight_id();
    let metadata = crate::models::FlightMetadata {
        id: flight_id,
        file_name: format!("manual_entry_{}.log", flight_id),
        display_name,
        file_hash: None,
        drone_model: Some(format!("Manual Entry ({})", payload.aircraft_name)),
        drone_serial: Some(payload.drone_serial.trim().to_uppercase()),
        aircraft_name: Some(payload.aircraft_name.clone()),
        battery_serial: Some(payload.battery_serial.trim().to_uppercase()),
        start_time: Some(parsed_start_time),
        end_time: Some(end_time),
        duration_secs: Some(payload.duration_secs),
        total_distance: payload.total_distance,
        max_altitude: payload.max_altitude,
        max_speed: None,
        home_lat: Some(payload.home_lat),
        home_lon: Some(payload.home_lon),
        point_count: 0,
        photo_count: 0,
        video_count: 0,
    };

    // Insert flight
    state
        .db
        .insert_flight(&metadata)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to insert flight: {}", e)))?;

    // Update notes if provided
    if let Some(notes_text) = &payload.notes {
        if !notes_text.trim().is_empty() {
            state
                .db
                .update_flight_notes(flight_id, Some(notes_text))
                .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to add notes: {}", e)))?;
        }
    }

    // Add "Manual Entry" tag
    let tags = vec!["Manual Entry".to_string()];
    if let Err(e) = state.db.insert_flight_tags(flight_id, &tags) {
        log::warn!("Failed to add tags: {}", e);
    }

    // Generate smart tags based on location
    let stats = crate::models::FlightStats {
        duration_secs: payload.duration_secs,
        total_distance_m: payload.total_distance.unwrap_or(0.0),
        max_altitude_m: payload.max_altitude.unwrap_or(0.0),
        max_speed_ms: 0.0,
        avg_speed_ms: 0.0,
        min_battery: 100,
        home_location: Some([payload.home_lon, payload.home_lat]),
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

    Ok(Json(ImportResult {
        success: true,
        flight_id: Some(flight_id),
        message: "Manual flight entry created successfully".to_string(),
        point_count: 0,
        file_hash: None,
    }))
}

/// GET /api/flights — List all flights
async fn get_flights(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<Vec<crate::models::Flight>>, (StatusCode, Json<ErrorResponse>)> {
    let flights = state
        .db
        .get_all_flights()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get flights: {}", e)))?;
    Ok(Json(flights))
}

/// GET /api/flights/:id — Get flight data for visualization
#[derive(Deserialize)]
struct FlightDataQuery {
    flight_id: i64,
    max_points: Option<usize>,
}

async fn get_flight_data(
    AxumState(state): AxumState<WebAppState>,
    Query(params): Query<FlightDataQuery>,
) -> Result<Json<FlightDataResponse>, (StatusCode, Json<ErrorResponse>)> {
    let flight = state
        .db
        .get_flight_by_id(params.flight_id)
        .map_err(|e| err_response(StatusCode::NOT_FOUND, format!("Flight not found: {}", e)))?;

    let known_point_count = flight.point_count.map(|c| c as i64);

    let telemetry_records = state
        .db
        .get_flight_telemetry(params.flight_id, params.max_points, known_point_count)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get telemetry: {}", e)))?;

    let telemetry = TelemetryData::from_records(&telemetry_records);
    let track = telemetry.extract_track(2000);

    // Get flight messages (tips and warnings)
    let messages = state
        .db
        .get_flight_messages(params.flight_id)
        .unwrap_or_else(|e| {
            log::warn!("Failed to get messages for flight {}: {}", params.flight_id, e);
            Vec::new()
        });

    Ok(Json(FlightDataResponse {
        flight,
        telemetry,
        track,
        messages,
    }))
}

/// GET /api/overview — Get overview statistics
async fn get_overview_stats(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<OverviewStats>, (StatusCode, Json<ErrorResponse>)> {
    let stats = state
        .db
        .get_overview_stats()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get overview stats: {}", e)))?;
    Ok(Json(stats))
}

/// DELETE /api/flights/:id — Delete a flight
#[derive(Deserialize)]
struct DeleteFlightQuery {
    flight_id: i64,
}

async fn delete_flight(
    AxumState(state): AxumState<WebAppState>,
    Query(params): Query<DeleteFlightQuery>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    log::info!("Deleting flight: {}", params.flight_id);
    state
        .db
        .delete_flight(params.flight_id)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to delete flight: {}", e)))
}

/// DELETE /api/flights — Delete all flights
async fn delete_all_flights(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    log::warn!("Deleting ALL flights and telemetry");
    state
        .db
        .delete_all_flights()
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to delete all flights: {}", e)))
}

/// POST /api/flights/deduplicate — Remove duplicate flights
async fn deduplicate_flights(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<usize>, (StatusCode, Json<ErrorResponse>)> {
    log::info!("Running flight deduplication");
    state
        .db
        .deduplicate_flights()
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to deduplicate flights: {}", e)))
}

/// PUT /api/flights/name — Update flight display name
#[derive(Deserialize)]
struct UpdateNamePayload {
    flight_id: i64,
    display_name: String,
}

async fn update_flight_name(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<UpdateNamePayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let trimmed = payload.display_name.trim();
    if trimmed.is_empty() {
        return Err(err_response(StatusCode::BAD_REQUEST, "Display name cannot be empty"));
    }

    log::info!("Renaming flight {} to '{}'", payload.flight_id, trimmed);

    state
        .db
        .update_flight_name(payload.flight_id, trimmed)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update flight name: {}", e)))
}

#[derive(Deserialize)]
struct UpdateNotesPayload {
    flight_id: i64,
    notes: Option<String>,
}

async fn update_flight_notes(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<UpdateNotesPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let notes_ref = payload.notes.as_ref().map(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    }).flatten();

    log::info!("Updating notes for flight {}", payload.flight_id);

    state
        .db
        .update_flight_notes(payload.flight_id, notes_ref)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to update flight notes: {}", e)))
}

/// GET /api/has_api_key — Check if DJI API key is configured
async fn has_api_key(
    AxumState(state): AxumState<WebAppState>,
) -> Json<bool> {
    let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
    Json(api.has_api_key())
}

/// GET /api/api_key_type — Get the type of the configured API key
async fn get_api_key_type(
    AxumState(state): AxumState<WebAppState>,
) -> Json<String> {
    let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
    Json(api.get_api_key_type())
}

/// POST /api/set_api_key — Set the DJI API key
#[derive(Deserialize)]
struct SetApiKeyPayload {
    api_key: String,
}

async fn set_api_key(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<SetApiKeyPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
    api.save_api_key(&payload.api_key)
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to save API key: {}", e)))
}

/// DELETE /api/remove_api_key — Remove the custom API key (fall back to default)
async fn remove_api_key(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
    api.remove_api_key()
        .map(|_| Json(true))
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove API key: {}", e)))
}

/// GET /api/app_data_dir — Get the app data directory path
async fn get_app_data_dir(
    AxumState(state): AxumState<WebAppState>,
) -> Json<String> {
    Json(state.db.data_dir.to_string_lossy().to_string())
}

/// GET /api/app_log_dir — Get the app log directory path
async fn get_app_log_dir(
    AxumState(state): AxumState<WebAppState>,
) -> Json<String> {
    // In web mode, logs go to stdout/the data dir
    Json(state.db.data_dir.to_string_lossy().to_string())
}

/// GET /api/backup — Download a compressed database backup
async fn export_backup(
    AxumState(state): AxumState<WebAppState>,
) -> Result<axum::response::Response, (StatusCode, Json<ErrorResponse>)> {
    use axum::body::Body;
    use axum::response::IntoResponse;

    let temp_path = std::env::temp_dir().join(format!("dji-logbook-dl-{}.db.backup", uuid::Uuid::new_v4()));

    state
        .db
        .export_backup(&temp_path)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Backup failed: {}", e)))?;

    let file_bytes = tokio::fs::read(&temp_path)
        .await
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read backup file: {}", e)))?;

    let _ = tokio::fs::remove_file(&temp_path).await;

    // Generate timestamped filename
    let now = chrono::Local::now();
    let filename = format!("{}_Open_Dronelog.db.backup", now.format("%Y-%m-%d_%H-%M-%S"));

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", filename).leak()),
        ],
        Body::from(file_bytes),
    ).into_response())
}

/// POST /api/backup/restore — Upload and restore a backup file
async fn import_backup(
    AxumState(state): AxumState<WebAppState>,
    mut multipart: Multipart,
) -> Result<Json<String>, (StatusCode, Json<ErrorResponse>)> {
    let field = multipart
        .next_field()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Multipart error: {}", e)))?
        .ok_or_else(|| err_response(StatusCode::BAD_REQUEST, "No file uploaded"))?;

    let data = field
        .bytes()
        .await
        .map_err(|e| err_response(StatusCode::BAD_REQUEST, format!("Failed to read file: {}", e)))?;

    let temp_path = std::env::temp_dir().join(format!("dji-logbook-restore-{}.db.backup", uuid::Uuid::new_v4()));
    std::fs::write(&temp_path, &data)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write temp file: {}", e)))?;

    let msg = state
        .db
        .import_backup(&temp_path)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Restore failed: {}", e)))?;

    let _ = std::fs::remove_file(&temp_path);

    Ok(Json(msg))
}

// ============================================================================
// TAG MANAGEMENT ENDPOINTS
// ============================================================================

/// POST /api/flights/tags/add — Add a tag to a flight
#[derive(Deserialize)]
struct AddTagPayload {
    flight_id: i64,
    tag: String,
}

async fn add_flight_tag(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<AddTagPayload>,
) -> Result<Json<Vec<FlightTag>>, (StatusCode, Json<ErrorResponse>)> {
    state
        .db
        .add_flight_tag(payload.flight_id, &payload.tag)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to add tag: {}", e)))?;
    state
        .db
        .get_flight_tags(payload.flight_id)
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get tags: {}", e)))
}

/// POST /api/flights/tags/remove — Remove a tag from a flight
#[derive(Deserialize)]
struct RemoveTagPayload {
    flight_id: i64,
    tag: String,
}

async fn remove_flight_tag(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<RemoveTagPayload>,
) -> Result<Json<Vec<FlightTag>>, (StatusCode, Json<ErrorResponse>)> {
    state
        .db
        .remove_flight_tag(payload.flight_id, &payload.tag)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove tag: {}", e)))?;
    state
        .db
        .get_flight_tags(payload.flight_id)
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get tags: {}", e)))
}

/// GET /api/tags — Get all unique tags
async fn get_all_tags(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    state
        .db
        .get_all_unique_tags()
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get tags: {}", e)))
}

/// POST /api/tags/remove_auto — Remove all auto-generated tags from all flights
async fn remove_all_auto_tags(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<usize>, (StatusCode, Json<ErrorResponse>)> {
    log::info!("Removing all auto-generated tags");
    state
        .db
        .remove_all_auto_tags()
        .map(Json)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to remove auto tags: {}", e)))
}

/// GET /api/settings/smart_tags — Check if smart tags are enabled
async fn get_smart_tags_enabled(
    AxumState(state): AxumState<WebAppState>,
) -> Json<bool> {
    let config_path = state.db.data_dir.join("config.json");
    let enabled = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("smart_tags_enabled").and_then(|v| v.as_bool()))
            .unwrap_or(true)
    } else {
        true
    };
    Json(enabled)
}

/// POST /api/settings/smart_tags — Set smart tags enabled
#[derive(Deserialize)]
struct SmartTagsPayload {
    enabled: bool,
}

async fn set_smart_tags_enabled(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<SmartTagsPayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    let config_path = state.db.data_dir.join("config.json");
    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    config["smart_tags_enabled"] = serde_json::json!(payload.enabled);
    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write config: {}", e)))?;
    Ok(Json(payload.enabled))
}

/// GET /api/settings/enabled_tag_types — Get enabled smart tag types
async fn get_enabled_tag_types(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    let config_path = state.db.data_dir.join("config.json");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read config: {}", e)))?;
        let val: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to parse config: {}", e)))?;
        if let Some(types) = val.get("enabled_tag_types").and_then(|v| v.as_array()) {
            return Ok(Json(types.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()));
        }
    }
    // Default: return all tag types
    Ok(Json(vec![
        "night_flight".to_string(), "high_speed".to_string(), "cold_battery".to_string(),
        "heavy_load".to_string(), "low_battery".to_string(), "high_altitude".to_string(),
        "long_distance".to_string(), "long_flight".to_string(), "short_flight".to_string(),
        "aggressive_flying".to_string(), "no_gps".to_string(), "country".to_string(),
        "continent".to_string(),
    ]))
}

/// Request body for setting enabled tag types
#[derive(Deserialize)]
struct EnabledTagTypesPayload {
    types: Vec<String>,
}

/// POST /api/settings/enabled_tag_types — Set enabled smart tag types
async fn set_enabled_tag_types(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<EnabledTagTypesPayload>,
) -> Result<Json<Vec<String>>, (StatusCode, Json<ErrorResponse>)> {
    let config_path = state.db.data_dir.join("config.json");
    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    config["enabled_tag_types"] = serde_json::json!(payload.types.clone());
    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write config: {}", e)))?;
    Ok(Json(payload.types))
}

/// Request body for regenerating smart tags with optional filter
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegenerateTagsPayload {
    enabled_tag_types: Option<Vec<String>>,
}

/// POST /api/regenerate_flight_smart_tags/:id — Regenerate auto tags for a single flight
async fn regenerate_flight_smart_tags(
    AxumState(state): AxumState<WebAppState>,
    Path(flight_id): Path<i64>,
    Json(payload): Json<RegenerateTagsPayload>,
) -> Result<Json<String>, (StatusCode, Json<ErrorResponse>)> {
    use crate::parser::{LogParser, calculate_stats_from_records};

    let flight = state.db.get_flight_by_id(flight_id)
        .map_err(|e| err_response(StatusCode::NOT_FOUND, format!("Failed to get flight {}: {}", flight_id, e)))?;

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
            if let Some(ref types) = payload.enabled_tag_types {
                tags = LogParser::filter_smart_tags(tags, types);
            }
            state.db.replace_auto_tags(flight_id, &tags)
                .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to replace tags: {}", e)))?;
        }
        Ok(_) => {
            let _ = state.db.replace_auto_tags(flight_id, &[]);
        }
        Err(e) => {
            return Err(err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get telemetry: {}", e)));
        }
    }

    Ok(Json("ok".to_string()))
}

/// POST /api/regenerate_smart_tags — Regenerate auto tags for all flights
async fn regenerate_smart_tags(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<String>, (StatusCode, Json<ErrorResponse>)> {
    use crate::parser::{LogParser, calculate_stats_from_records};

    log::info!("Starting smart tag regeneration for all flights");
    let start = std::time::Instant::now();

    let flight_ids = state.db.get_all_flight_ids()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get flight IDs: {}", e)))?;

    let _total = flight_ids.len();
    let mut processed = 0usize;
    let mut errors = 0usize;

    for flight_id in &flight_ids {
        match state.db.get_flight_by_id(*flight_id) {
            Ok(flight) => {
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
    Ok(Json(msg))
}

// ============================================================================
// SYNC FROM FOLDER (for Docker/web deployment)
// ============================================================================

/// Response for sync operation
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponse {
    processed: usize,
    skipped: usize,
    errors: usize,
    message: String,
    sync_path: Option<String>,
    /// Whether automatic scheduled sync is enabled (SYNC_INTERVAL is set)
    auto_sync: bool,
}

/// Response for listing sync folder files
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncFilesResponse {
    files: Vec<String>,
    sync_path: Option<String>,
    message: String,
}

/// Response for single file sync
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncFileResponse {
    success: bool,
    message: String,
    file_hash: Option<String>,
}

/// GET /api/sync/config — Get the sync folder path configuration
async fn get_sync_config() -> Json<SyncResponse> {
    let sync_path = std::env::var("SYNC_LOGS_PATH").ok();
    let auto_sync = std::env::var("SYNC_INTERVAL").is_ok();
    Json(SyncResponse {
        processed: 0,
        skipped: 0,
        errors: 0,
        message: if sync_path.is_some() { "Sync folder configured".to_string() } else { "No sync folder configured".to_string() },
        sync_path,
        auto_sync,
    })
}

/// GET /api/sync/files — List all log files in the sync folder
async fn get_sync_files(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<SyncFilesResponse>, (StatusCode, Json<ErrorResponse>)> {
    let sync_path = match std::env::var("SYNC_LOGS_PATH") {
        Ok(path) => path,
        Err(_) => {
            return Ok(Json(SyncFilesResponse {
                files: vec![],
                sync_path: None,
                message: "SYNC_LOGS_PATH not configured".to_string(),
            }));
        }
    };

    let sync_dir = std::path::PathBuf::from(&sync_path);
    if !sync_dir.exists() {
        return Ok(Json(SyncFilesResponse {
            files: vec![],
            sync_path: Some(sync_path),
            message: "Sync folder does not exist".to_string(),
        }));
    }

    let entries = match std::fs::read_dir(&sync_dir) {
        Ok(entries) => entries,
        Err(e) => {
            return Err(err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read sync folder: {}", e),
            ));
        }
    };

    // Get existing file hashes to filter out already-imported files
    let existing_hashes: std::collections::HashSet<String> = state.db.get_all_file_hashes()
        .unwrap_or_default()
        .into_iter()
        .collect();

    let files: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    return name.ends_with(".txt") || name.ends_with(".csv");
                }
            }
            false
        })
        .filter_map(|entry| {
            let path = entry.path();
            // Check if file is already imported by hash
            if let Ok(hash) = compute_file_hash(&path) {
                if existing_hashes.contains(&hash) {
                    return None; // Skip already imported files
                }
            }
            Some(entry.file_name().to_string_lossy().to_string())
        })
        .collect();

    Ok(Json(SyncFilesResponse {
        files,
        sync_path: Some(sync_path),
        message: "OK".to_string(),
    }))
}

/// POST /api/sync/file — Import a single file from the sync folder
async fn sync_single_file(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<SyncFileResponse>, (StatusCode, Json<ErrorResponse>)> {
    let filename = payload.get("filename")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err_response(StatusCode::BAD_REQUEST, "Missing filename".to_string()))?;

    let sync_path = match std::env::var("SYNC_LOGS_PATH") {
        Ok(path) => path,
        Err(_) => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: "SYNC_LOGS_PATH not configured".to_string(),
                file_hash: None,
            }));
        }
    };

    let file_path = std::path::PathBuf::from(&sync_path).join(filename);
    if !file_path.exists() {
        return Ok(Json(SyncFileResponse {
            success: false,
            message: format!("File not found: {}", filename),
            file_hash: None,
        }));
    }

    // Check smart tags setting
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

    let parser = LogParser::new(&state.db);

    let parse_result = match parser.parse_log(&file_path).await {
        Ok(result) => result,
        Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: format!("Already imported (matches '{}')", matching_flight),
                file_hash: None,
            }));
        }
        Err(e) => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: format!("Parse error: {}", e),
                file_hash: None,
            }));
        }
    };

    // Check for duplicate flight
    if let Some(matching_flight) = state.db.is_duplicate_flight(
        parse_result.metadata.drone_serial.as_deref(),
        parse_result.metadata.battery_serial.as_deref(),
        parse_result.metadata.start_time,
    ).unwrap_or(None) {
        return Ok(Json(SyncFileResponse {
            success: false,
            message: format!("Duplicate flight (matches '{}')", matching_flight),
            file_hash: parse_result.metadata.file_hash.clone(),
        }));
    }

    // Insert flight
    let flight_id = match state.db.insert_flight(&parse_result.metadata) {
        Ok(id) => id,
        Err(e) => {
            return Ok(Json(SyncFileResponse {
                success: false,
                message: format!("Failed to insert flight: {}", e),
                file_hash: None,
            }));
        }
    };

    // Insert telemetry
    if let Err(e) = state.db.bulk_insert_telemetry(flight_id, &parse_result.points) {
        let _ = state.db.delete_flight(flight_id);
        return Ok(Json(SyncFileResponse {
            success: false,
            message: format!("Failed to insert telemetry: {}", e),
            file_hash: None,
        }));
    }

    // Insert smart tags if enabled
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
            log::warn!("Failed to insert tags: {}", e);
        }
    }

    // Insert manual tags from re-imported CSV exports (always inserted regardless of smart_tags_enabled)
    for manual_tag in &parse_result.manual_tags {
        if let Err(e) = state.db.add_flight_tag(flight_id, manual_tag) {
            log::warn!("Failed to insert manual tag '{}': {}", manual_tag, e);
        }
    }

    Ok(Json(SyncFileResponse {
        success: true,
        message: "OK".to_string(),
        file_hash: parse_result.metadata.file_hash,
    }))
}

/// POST /api/sync — Trigger sync from SYNC_LOGS_PATH folder
async fn sync_from_folder(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<SyncResponse>, (StatusCode, Json<ErrorResponse>)> {
    let sync_path = match std::env::var("SYNC_LOGS_PATH") {
        Ok(path) => path,
        Err(_) => {
            return Ok(Json(SyncResponse {
                processed: 0,
                skipped: 0,
                errors: 0,
                message: "SYNC_LOGS_PATH environment variable not configured".to_string(),
                sync_path: None,
                auto_sync: false,
            }));
        }
    };

    let sync_dir = std::path::PathBuf::from(&sync_path);
    if !sync_dir.exists() {
        return Ok(Json(SyncResponse {
            processed: 0,
            skipped: 0,
            errors: 0,
            message: format!("Sync folder does not exist: {}", sync_path),
            sync_path: Some(sync_path),
            auto_sync: false,
        }));
    }

    log::info!("Starting sync from folder: {}", sync_path);
    let start = std::time::Instant::now();

    // Read all log files from the sync folder
    let entries = match std::fs::read_dir(&sync_dir) {
        Ok(entries) => entries,
        Err(e) => {
            return Err(err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read sync folder: {}", e),
            ));
        }
    };

    let log_files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    return name.ends_with(".txt") || name.ends_with(".csv");
                }
            }
            false
        })
        .map(|entry| entry.path())
        .collect();

    if log_files.is_empty() {
        return Ok(Json(SyncResponse {
            processed: 0,
            skipped: 0,
            errors: 0,
            message: "No log files found in sync folder".to_string(),
            sync_path: Some(sync_path),
            auto_sync: false,
        }));
    }

    let parser = LogParser::new(&state.db);
    let mut processed = 0usize;
    let mut skipped = 0usize;
    let mut errors = 0usize;

    // Check smart tags setting
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

    for file_path in log_files {
        let file_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        
        let parse_result = match parser.parse_log(&file_path).await {
            Ok(result) => result,
            Err(crate::parser::ParserError::AlreadyImported(matching_flight)) => {
                log::debug!("Skipping already-imported file: {} — matches flight '{}'", file_name, matching_flight);
                skipped += 1;
                continue;
            }
            Err(e) => {
                log::warn!("Failed to parse {}: {}", file_name, e);
                errors += 1;
                continue;
            }
        };

        // Check for duplicate flight
        if let Some(matching_flight) = state.db.is_duplicate_flight(
            parse_result.metadata.drone_serial.as_deref(),
            parse_result.metadata.battery_serial.as_deref(),
            parse_result.metadata.start_time,
        ).unwrap_or(None) {
            log::debug!("Skipping duplicate flight: {} — matches flight '{}'", file_name, matching_flight);
            skipped += 1;
            continue;
        }

        // Insert flight
        let flight_id = match state.db.insert_flight(&parse_result.metadata) {
            Ok(id) => id,
            Err(e) => {
                log::warn!("Failed to insert flight from {}: {}", file_name, e);
                errors += 1;
                continue;
            }
        };

        // Insert telemetry
        if let Err(e) = state.db.bulk_insert_telemetry(flight_id, &parse_result.points) {
            log::warn!("Failed to insert telemetry for {}: {}", file_name, e);
            let _ = state.db.delete_flight(flight_id);
            errors += 1;
            continue;
        }

        // Insert smart tags if enabled
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
                log::warn!("Failed to insert tags for {}: {}", file_name, e);
            }
        }

        // Insert manual tags from re-imported CSV exports (always inserted regardless of smart_tags_enabled)
        for manual_tag in &parse_result.manual_tags {
            if let Err(e) = state.db.add_flight_tag(flight_id, manual_tag) {
                log::warn!("Failed to insert manual tag '{}' for {}: {}", manual_tag, file_name, e);
            }
        }

        processed += 1;
        log::debug!("Synced: {}", file_name);
    }

    let elapsed = start.elapsed().as_secs_f64();
    let msg = format!(
        "Sync complete: {} imported, {} skipped, {} errors in {:.1}s",
        processed, skipped, errors, elapsed
    );
    log::info!("{}", msg);

    Ok(Json(SyncResponse {
        processed,
        skipped,
        errors,
        message: msg,
        sync_path: Some(sync_path),
        auto_sync: false,
    }))
}

// ============================================================================
// EQUIPMENT NAMES
// ============================================================================

/// Response for equipment names
#[derive(Serialize)]
struct EquipmentNamesResponse {
    battery_names: std::collections::HashMap<String, String>,
    aircraft_names: std::collections::HashMap<String, String>,
}

/// GET /api/equipment_names — Get all custom equipment names
async fn get_equipment_names(
    AxumState(state): AxumState<WebAppState>,
) -> Result<Json<EquipmentNamesResponse>, (StatusCode, Json<ErrorResponse>)> {
    let (battery_list, aircraft_list) = state.db.get_all_equipment_names()
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to get equipment names: {}", e)))?;
    
    let battery_names: std::collections::HashMap<String, String> = battery_list.into_iter().collect();
    let aircraft_names: std::collections::HashMap<String, String> = aircraft_list.into_iter().collect();
    
    Ok(Json(EquipmentNamesResponse { battery_names, aircraft_names }))
}

/// Payload for setting an equipment name
#[derive(Deserialize)]
struct SetEquipmentNamePayload {
    serial: String,
    equipment_type: String,  // "battery" or "aircraft"
    display_name: String,
}

/// POST /api/equipment_names — Set a custom equipment name
async fn set_equipment_name(
    AxumState(state): AxumState<WebAppState>,
    Json(payload): Json<SetEquipmentNamePayload>,
) -> Result<Json<bool>, (StatusCode, Json<ErrorResponse>)> {
    state.db.set_equipment_name(&payload.serial, &payload.equipment_type, &payload.display_name)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to set equipment name: {}", e)))?;
    Ok(Json(true))
}

// ============================================================================
// SERVER SETUP
// ============================================================================

/// Build the Axum router with all API routes
pub fn build_router(state: WebAppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/import", post(import_log))
        .route("/api/manual_flight", post(create_manual_flight))
        .route("/api/flights", get(get_flights))
        .route("/api/flight_data", get(get_flight_data))
        .route("/api/overview", get(get_overview_stats))
        .route("/api/flights/delete", delete(delete_flight))
        .route("/api/flights/delete_all", delete(delete_all_flights))
        .route("/api/flights/deduplicate", post(deduplicate_flights))
        .route("/api/flights/name", put(update_flight_name))
        .route("/api/flights/notes", put(update_flight_notes))
        .route("/api/flights/tags/add", post(add_flight_tag))
        .route("/api/flights/tags/remove", post(remove_flight_tag))
        .route("/api/tags", get(get_all_tags))
        .route("/api/tags/remove_auto", post(remove_all_auto_tags))
        .route("/api/settings/smart_tags", get(get_smart_tags_enabled))
        .route("/api/settings/smart_tags", post(set_smart_tags_enabled))
        .route("/api/settings/enabled_tag_types", get(get_enabled_tag_types))
        .route("/api/settings/enabled_tag_types", post(set_enabled_tag_types))
        .route("/api/regenerate_smart_tags", post(regenerate_smart_tags))
        .route("/api/regenerate_flight_smart_tags/:id", post(regenerate_flight_smart_tags))
        .route("/api/has_api_key", get(has_api_key))
        .route("/api/api_key_type", get(get_api_key_type))
        .route("/api/set_api_key", post(set_api_key))
        .route("/api/remove_api_key", delete(remove_api_key))
        .route("/api/app_data_dir", get(get_app_data_dir))
        .route("/api/app_log_dir", get(get_app_log_dir))
        .route("/api/backup", get(export_backup))
        .route("/api/backup/restore", post(import_backup))
        .route("/api/sync/config", get(get_sync_config))
        .route("/api/sync/files", get(get_sync_files))
        .route("/api/sync/file", post(sync_single_file))
        .route("/api/sync", post(sync_from_folder))
        .route("/api/equipment_names", get(get_equipment_names))
        .route("/api/equipment_names", post(set_equipment_name))
        .layer(cors)
        .layer(DefaultBodyLimit::max(250 * 1024 * 1024)) // 250 MB
        .with_state(state)
}

/// Start the Axum web server
pub async fn start_server(data_dir: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let db = Database::new(data_dir)?;
    let state = WebAppState { db: Arc::new(db) };

    // Start the scheduled sync if SYNC_INTERVAL and SYNC_LOGS_PATH are configured
    if let (Ok(sync_path), Ok(sync_interval)) = (
        std::env::var("SYNC_LOGS_PATH"),
        std::env::var("SYNC_INTERVAL"),
    ) {
        log::info!("Scheduled sync enabled: path={}, interval={}", sync_path, sync_interval);
        let scheduler_state = state.clone();
        
        tokio::spawn(async move {
            if let Err(e) = start_sync_scheduler(scheduler_state, &sync_interval).await {
                log::error!("Failed to start sync scheduler: {}", e);
            }
        });
    } else if std::env::var("SYNC_LOGS_PATH").is_ok() {
        log::info!("SYNC_LOGS_PATH configured but SYNC_INTERVAL not set. Sync is manual-only (via Sync button in web interface).");
    }

    let router = build_router(state);

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let addr = format!("{}:{}", host, port);

    log::info!("Starting Open DroneLog web server on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}

/// Start the cron scheduler for automatic folder sync
async fn start_sync_scheduler(state: WebAppState, cron_expr: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sched = JobScheduler::new().await?;
    
    // Validate cron expression
    let cron_schedule = cron_expr.parse::<cron::Schedule>()
        .map_err(|e| format!("Invalid cron expression '{}': {}", cron_expr, e))?;
    
    // Log next few scheduled times for debugging
    let upcoming: Vec<_> = cron_schedule.upcoming(chrono::Utc).take(3).collect();
    log::info!("Next scheduled sync times: {:?}", upcoming);
    
    let state_clone = state.clone();
    let cron_expr_owned = cron_expr.to_string();
    
    let job = Job::new_async(cron_expr_owned.as_str(), move |_uuid, _lock| {
        let state = state_clone.clone();
        Box::pin(async move {
            log::info!("Starting scheduled folder sync...");
            match run_scheduled_sync(&state).await {
                Ok((processed, skipped, errors)) => {
                    log::info!(
                        "Scheduled sync complete: {} imported, {} skipped, {} errors",
                        processed, skipped, errors
                    );
                }
                Err(e) => {
                    log::error!("Scheduled sync failed: {}", e);
                }
            }
        })
    })?;
    
    sched.add(job).await?;
    sched.start().await?;
    
    log::info!("Sync scheduler started with cron expression: {}", cron_expr);
    
    // Keep the scheduler running
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;
    }
}

/// Run the folder sync operation (called by scheduler)
async fn run_scheduled_sync(state: &WebAppState) -> Result<(usize, usize, usize), String> {
    let sync_path = std::env::var("SYNC_LOGS_PATH")
        .map_err(|_| "SYNC_LOGS_PATH not configured".to_string())?;
    
    let sync_dir = std::path::PathBuf::from(&sync_path);
    if !sync_dir.exists() {
        return Err(format!("Sync folder does not exist: {}", sync_path));
    }
    
    let entries = std::fs::read_dir(&sync_dir)
        .map_err(|e| format!("Failed to read sync folder: {}", e))?;
    
    let log_files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_file() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    return name.ends_with(".txt") || name.ends_with(".csv");
                }
            }
            false
        })
        .map(|entry| entry.path())
        .collect();
    
    if log_files.is_empty() {
        return Ok((0, 0, 0));
    }
    
    let parser = LogParser::new(&state.db);
    let mut processed = 0usize;
    let mut skipped = 0usize;
    let mut errors = 0usize;
    
    // Check smart tags setting
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
    
    for file_path in log_files {
        let file_name = file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        
        let parse_result = match parser.parse_log(&file_path).await {
            Ok(result) => result,
            Err(crate::parser::ParserError::AlreadyImported(_)) => {
                skipped += 1;
                continue;
            }
            Err(e) => {
                log::warn!("Scheduled sync: Failed to parse {}: {}", file_name, e);
                errors += 1;
                continue;
            }
        };
        
        // Check for duplicate flight
        if state.db.is_duplicate_flight(
            parse_result.metadata.drone_serial.as_deref(),
            parse_result.metadata.battery_serial.as_deref(),
            parse_result.metadata.start_time,
        ).unwrap_or(None).is_some() {
            skipped += 1;
            continue;
        }
        
        // Insert flight
        let flight_id = match state.db.insert_flight(&parse_result.metadata) {
            Ok(id) => id,
            Err(e) => {
                log::warn!("Scheduled sync: Failed to insert flight from {}: {}", file_name, e);
                errors += 1;
                continue;
            }
        };
        
        // Insert telemetry
        if let Err(e) = state.db.bulk_insert_telemetry(flight_id, &parse_result.points) {
            log::warn!("Scheduled sync: Failed to insert telemetry for {}: {}", file_name, e);
            let _ = state.db.delete_flight(flight_id);
            errors += 1;
            continue;
        }
        
        // Insert smart tags if enabled
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
                log::warn!("Scheduled sync: Failed to insert tags for {}: {}", file_name, e);
            }
        }

        // Insert manual tags from re-imported CSV exports (always inserted regardless of smart_tags_enabled)
        for manual_tag in &parse_result.manual_tags {
            if let Err(e) = state.db.add_flight_tag(flight_id, manual_tag) {
                log::warn!("Scheduled sync: Failed to insert manual tag '{}' for {}: {}", manual_tag, file_name, e);
            }
        }
        
        processed += 1;
        log::debug!("Scheduled sync: Imported {}", file_name);
    }
    
    Ok((processed, skipped, errors))
}

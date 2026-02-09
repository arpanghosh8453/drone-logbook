//! Axum REST API server for the web/Docker deployment.
//!
//! This module mirrors all 11 Tauri commands as HTTP endpoints,
//! allowing the frontend to communicate via fetch() instead of invoke().

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Multipart, Query, State as AxumState},
    http::StatusCode,
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};

use crate::api::DjiApi;
use crate::database::Database;
use crate::models::{FlightDataResponse, ImportResult, OverviewStats, TelemetryData};
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
    let temp_dir = std::env::temp_dir().join("dji-logviewer-uploads");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create temp dir: {}", e)))?;

    let temp_path = temp_dir.join(&file_name);
    std::fs::write(&temp_path, &data)
        .map_err(|e| err_response(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write temp file: {}", e)))?;

    let import_start = std::time::Instant::now();
    log::info!("Importing uploaded log file: {}", file_name);

    let parser = LogParser::new(&state.db);

    let parse_result = match parser.parse_log(&temp_path).await {
        Ok(result) => result,
        Err(crate::parser::ParserError::AlreadyImported) => {
            // Clean up temp file
            let _ = std::fs::remove_file(&temp_path);
            return Ok(Json(ImportResult {
                success: false,
                flight_id: None,
                message: "This flight log has already been imported".to_string(),
                point_count: 0,
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
            }));
        }
    };

    // Clean up temp file
    let _ = std::fs::remove_file(&temp_path);

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
            }));
        }
    };

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

    Ok(Json(FlightDataResponse {
        flight,
        telemetry,
        track,
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

/// GET /api/has_api_key — Check if DJI API key is configured
async fn has_api_key(
    AxumState(state): AxumState<WebAppState>,
) -> Json<bool> {
    let api = DjiApi::with_app_data_dir(state.db.data_dir.clone());
    Json(api.has_api_key())
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

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=\"DJI_logbook.db.backup\""),
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
        .route("/api/flights", get(get_flights))
        .route("/api/flight_data", get(get_flight_data))
        .route("/api/overview", get(get_overview_stats))
        .route("/api/flights/delete", delete(delete_flight))
        .route("/api/flights/delete_all", delete(delete_all_flights))
        .route("/api/flights/name", put(update_flight_name))
        .route("/api/has_api_key", get(has_api_key))
        .route("/api/set_api_key", post(set_api_key))
        .route("/api/app_data_dir", get(get_app_data_dir))
        .route("/api/app_log_dir", get(get_app_log_dir))
        .route("/api/backup", get(export_backup))
        .route("/api/backup/restore", post(import_backup))
        .layer(cors)
        .layer(DefaultBodyLimit::max(250 * 1024 * 1024)) // 250 MB
        .with_state(state)
}

/// Start the Axum web server
pub async fn start_server(data_dir: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let db = Database::new(data_dir)?;
    let state = WebAppState { db: Arc::new(db) };

    let router = build_router(state);

    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_string());
    let addr = format!("{}:{}", host, port);

    log::info!("Starting DJI Logbook web server on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}

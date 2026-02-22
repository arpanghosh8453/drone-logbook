//! Parser module for DJI flight log files.
//!
//! Handles:
//! - Parsing various DJI log formats using dji-log-parser
//! - Extracting telemetry data points
//! - File hash calculation for duplicate detection
//! - V13+ encrypted log handling with API key fetching
//! - Panic/timeout protection for untrusted file parsing

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::panic;
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc, Timelike};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::time::timeout;

use dji_log_parser::frame::Frame;
use dji_log_parser::DJILog;

use crate::api::DjiApi;
use crate::database::Database;
use crate::dronelogbook_parser::DroneLogbookParser;
use crate::litchi_parser::LitchiParser;
use crate::models::{FlightMetadata, FlightStats, TelemetryPoint};

/// Maximum time allowed for parsing a single log file (seconds)
const PARSE_TIMEOUT_SECS: u64 = 40;

#[derive(Error, Debug)]
pub enum ParserError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("File already imported (matches: {0})")]
    AlreadyImported(String),

    #[error("No valid telemetry data found")]
    NoTelemetryData,

    #[error("Encryption key required for V13+ logs")]
    EncryptionKeyRequired,

    #[error("API error: {0}")]
    Api(String),

    #[error("Parser crashed on this file (internal panic)")]
    Panic(String),

    #[error("Parsing timed out after {0} seconds — file may be corrupt or unsupported")]
    Timeout(u64),

    #[error("Incompatible file format — only DJI flight logs (.txt), Litchi CSV exports, and Drone Logbook CSV exports are supported")]
    IncompatibleFile,
}

/// Result of parsing a DJI log file
pub struct ParseResult {
    pub metadata: FlightMetadata,
    pub points: Vec<TelemetryPoint>,
    pub tags: Vec<String>,
    /// Manual tags to preserve from re-imported CSV exports (inserted with 'manual' type)
    pub manual_tags: Vec<String>,
}

/// DJI Log Parser wrapper
pub struct LogParser<'a> {
    db: &'a Database,
    api: DjiApi,
}

impl<'a> LogParser<'a> {
    pub fn new(db: &'a Database) -> Self {
        Self {
            db,
            api: DjiApi::with_app_data_dir(db.data_dir.clone()),
        }
    }

    /// Calculate SHA256 hash of a file for duplicate detection
    pub fn calculate_file_hash(path: &Path) -> Result<String, ParserError> {
        let file = File::open(path)?;
        let mut reader = BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 8192];

        loop {
            let bytes_read = reader.read(&mut buffer)?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
        }

        Ok(format!("{:x}", hasher.finalize()))
    }

    /// Parse a flight log file (DJI .txt or Litchi .csv) and extract all telemetry data
    pub async fn parse_log(&self, file_path: &Path) -> Result<ParseResult, ParserError> {
        let parse_start = std::time::Instant::now();
        let file_size = fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
        log::info!(
            "Parsing log file: {:?} (size: {:.1} KB)",
            file_path,
            file_size as f64 / 1024.0
        );

        // Calculate file hash to check for duplicates
        let file_hash = Self::calculate_file_hash(file_path)?;
        log::debug!("File hash: {}", file_hash);

        if let Some(matching_flight) = self
            .db
            .is_file_imported(&file_hash)
            .map_err(|e| ParserError::Parse(e.to_string()))?
        {
            log::info!("File already imported (hash match), skipping — matches flight: {}", matching_flight);
            return Err(ParserError::AlreadyImported(matching_flight));
        }

        // Detect file format and route to appropriate parser
        // Check for Drone Logbook CSV format first (our own export)
        if DroneLogbookParser::is_dronelogbook_csv(file_path) {
            log::info!("Detected Drone Logbook CSV format, using DroneLogbookParser");
            let dronelogbook_parser = DroneLogbookParser::new(self.db);
            return dronelogbook_parser.parse(file_path, &file_hash);
        }

        // Check for Litchi CSV format
        if LitchiParser::is_litchi_csv(file_path) {
            log::info!("Detected Litchi CSV format, using LitchiParser");
            let litchi_parser = LitchiParser::new(self.db);
            return litchi_parser.parse(file_path, &file_hash);
        }

        // Check if this looks like a valid DJI log file
        let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("txt") {
            log::warn!("Unsupported file extension: .{}", ext);
            return Err(ParserError::IncompatibleFile);
        }

        // Read the file
        let file_data = fs::read(file_path)?;
        log::debug!("File read into memory: {} bytes", file_data.len());

        // Parse with dji-log-parser inside spawn_blocking + catch_unwind
        // This prevents a panicking/hanging parser from killing the app
        let parser = {
            let data = file_data.clone();
            let result = timeout(
                Duration::from_secs(PARSE_TIMEOUT_SECS),
                tokio::task::spawn_blocking(move || {
                    panic::catch_unwind(panic::AssertUnwindSafe(|| {
                        DJILog::from_bytes(data)
                    }))
                }),
            )
            .await;

            match result {
                Err(_) => return Err(ParserError::Timeout(PARSE_TIMEOUT_SECS)),
                Ok(Err(join_err)) => return Err(ParserError::Panic(format!("Task join error: {}", join_err))),
                Ok(Ok(Err(panic_val))) => {
                    let msg = panic_val
                        .downcast_ref::<String>()
                        .map(|s| s.clone())
                        .or_else(|| panic_val.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "unknown panic".to_string());
                    return Err(ParserError::Panic(msg));
                }
                Ok(Ok(Ok(parse_result))) => {
                    parse_result.map_err(|e| ParserError::Parse(e.to_string()))?
                }
            }
        };

        log::info!(
            "DJILog parsed: version={}, product={:?}, aircraft_sn={}, aircraft_name={}, battery_sn={}, total_time={:.1}s",
            parser.version,
            parser.details.product_type,
            parser.details.aircraft_sn,
            parser.details.aircraft_name,
            parser.details.battery_sn,
            parser.details.total_time
        );

        // Check if we need an encryption key for V13+ logs
        let frames = self.get_frames(&parser).await?;
        log::info!("Extracted {} frames from log", frames.len());

        if frames.is_empty() {
            log::warn!("No frames extracted from log file — file may be empty or corrupt");
            return Err(ParserError::NoTelemetryData);
        }

        // Extract telemetry points
        let details_total_time_secs = parser.details.total_time as f64;
        let points = self.extract_telemetry(&frames, details_total_time_secs);
        log::info!(
            "Extracted {} valid telemetry points from {} frames ({} skipped)",
            points.len(),
            frames.len(),
            frames.len() - points.len()
        );

        if points.is_empty() {
            log::warn!("No valid telemetry points after filtering — all frames had corrupt/missing data");
            return Err(ParserError::NoTelemetryData);
        }

        // Calculate statistics
        let stats = self.calculate_stats(&points);

        // Build metadata
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let display_name = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&file_name)
            .to_string();

        let metadata = FlightMetadata {
            id: self.db.generate_flight_id(),
            file_name,
            display_name,
            file_hash: Some(file_hash),
            drone_model: self.extract_drone_model(&parser),
            drone_serial: self.extract_serial(&parser),
            aircraft_name: self.extract_aircraft_name(&parser),
            battery_serial: self.extract_battery_serial(&parser),
            start_time: self.extract_start_time(&parser),
            end_time: self.extract_end_time(&parser),
            duration_secs: Some(
                if details_total_time_secs > 0.0 {
                    details_total_time_secs
                } else {
                    stats.duration_secs
                }
            ),
            total_distance: Some(stats.total_distance_m),
            max_altitude: Some(stats.max_altitude_m),
            max_speed: Some(stats.max_speed_ms),
            home_lat: stats.home_location.map(|h| h[1]),
            home_lon: stats.home_location.map(|h| h[0]),
            point_count: points.len() as i32,
        };

        log::info!(
            "Parse complete in {:.1}s: duration={:.1}s, distance={:.0}m, max_alt={:.1}m, max_speed={:.1}m/s, home={:?}, points={}",
            parse_start.elapsed().as_secs_f64(),
            stats.duration_secs,
            stats.total_distance_m,
            stats.max_altitude_m,
            stats.max_speed_ms,
            stats.home_location,
            points.len()
        );

        // Generate smart tags based on flight characteristics
        let tags = Self::generate_smart_tags(&metadata, &stats);
        log::info!("Generated smart tags: {:?}", tags);

        Ok(ParseResult { metadata, points, tags, manual_tags: Vec::new() })
    }

    /// Generate smart tags based on flight metadata and statistics
    pub fn generate_smart_tags(metadata: &FlightMetadata, stats: &FlightStats) -> Vec<String> {
        let mut tags = Vec::new();

        // Night Flight: if local flying time is after 7 PM (19:00) or before 6 AM
        if let Some(start_time) = metadata.start_time {
            // Use home location to estimate timezone offset (rough: 1 hour per 15° longitude)
            let utc_hour = start_time.hour();
            let tz_offset_hours = if let Some(home) = stats.home_location {
                (home[0] / 15.0).round() as i32 // lon / 15 = approx TZ offset
            } else {
                0
            };
            let local_hour = ((utc_hour as i32 + tz_offset_hours) % 24 + 24) % 24;
            if local_hour >= 19 || local_hour < 6 {
                tags.push("Night Flight".to_string());
            }
        }

        // High Speed: max speed exceeds 15 m/s
        if stats.max_speed_ms > 15.0 {
            tags.push("High Speed".to_string());
        }

        // Cold Battery: start temperature below 15°C
        if let Some(temp) = stats.start_battery_temp {
            if temp < 15.0 {
                tags.push("Cold Battery".to_string());
            }
        }

        // Heavy Load: battery consumption > 75% but flight time < 20 minutes
        if let (Some(start_pct), Some(end_pct)) = (stats.start_battery_percent, stats.end_battery_percent) {
            let consumption = start_pct - end_pct;
            if consumption > 75 && stats.duration_secs < 1200.0 {
                tags.push("Heavy Load".to_string());
            }
        }

        // Low Battery: battery level dropped below 15% at end of flight
        if let Some(end_pct) = stats.end_battery_percent {
            if end_pct < 15 {
                tags.push("Low Battery".to_string());
            }
        }

        // High Altitude: max height above 120 meters
        if stats.max_altitude_m > 120.0 {
            tags.push("High Altitude".to_string());
        }

        // Long Distance: max distance from home > 1 km
        if stats.max_distance_from_home_m > 1000.0 {
            tags.push("Long Distance".to_string());
        }

        // Long Flight: duration > 25 minutes
        if stats.duration_secs > 1500.0 {
            tags.push("Long Flight".to_string());
        }

        // Short Flight: duration < 2 minutes (likely test/calibration)
        if stats.duration_secs > 0.0 && stats.duration_secs < 120.0 {
            tags.push("Short Flight".to_string());
        }

        // Aggressive Flying: high average speed (> 8 m/s)
        if stats.avg_speed_ms > 8.0 {
            tags.push("Aggressive Flying".to_string());
        }

        // Minimal GPS: very few GPS points relative to total points
        // (Detected from home location absence)
        if stats.home_location.is_none() {
            tags.push("No GPS".to_string());
        }

        // Reverse geocoding: derive city, country, and continent from home coordinates
        if let Some(home) = stats.home_location {
            let lat = home[1];
            let lon = home[0];
            let location_tags = Self::reverse_geocode(lat, lon);
            for tag in location_tags {
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
        }

        tags
    }

    /// Filter smart tags based on enabled tag type IDs.
    /// Tag type IDs map to specific generated tag names.
    pub fn filter_smart_tags(tags: Vec<String>, enabled_types: &[String]) -> Vec<String> {
        // If no filter provided or empty, return all tags
        if enabled_types.is_empty() {
            return tags;
        }

        // Map of tag type IDs to the actual tag name patterns
        let type_to_tag: std::collections::HashMap<&str, &str> = [
            ("night_flight", "Night Flight"),
            ("high_speed", "High Speed"),
            ("cold_battery", "Cold Battery"),
            ("heavy_load", "Heavy Load"),
            ("low_battery", "Low Battery"),
            ("high_altitude", "High Altitude"),
            ("long_distance", "Long Distance"),
            ("long_flight", "Long Flight"),
            ("short_flight", "Short Flight"),
            ("aggressive_flying", "Aggressive Flying"),
            ("no_gps", "No GPS"),
        ].into_iter().collect();

        // Collect enabled tag names and check if location tags are enabled
        let enabled_tag_names: std::collections::HashSet<&str> = enabled_types
            .iter()
            .filter_map(|t| type_to_tag.get(t.as_str()).copied())
            .collect();
        let country_enabled = enabled_types.iter().any(|t| t == "country");
        let continent_enabled = enabled_types.iter().any(|t| t == "continent");

        // List of all continents for filtering
        let continents: std::collections::HashSet<&str> = [
            "Africa", "Antarctica", "Asia", "Europe", 
            "North America", "Oceania", "South America"
        ].into_iter().collect();

        tags.into_iter()
            .filter(|tag| {
                // Check if it's a standard tag type
                if enabled_tag_names.contains(tag.as_str()) {
                    return true;
                }
                // Check if it's a continent tag
                if continents.contains(tag.as_str()) {
                    return continent_enabled;
                }
                // Otherwise it's a country tag (any tag not matching above patterns)
                // Note: Standard tags we know about are already handled above
                let is_standard_tag = type_to_tag.values().any(|&v| v == tag.as_str());
                if !is_standard_tag && !continents.contains(tag.as_str()) {
                    return country_enabled;
                }
                false
            })
            .collect()
    }

    /// Offline reverse geocoding using the `reverse_geocoder` crate.
    /// Returns location tags for country and continent only.
    /// Note: We skip the city/name field as GeoNames data often returns small towns,
    /// suburbs, or other local names that may not be meaningful or accurate.
    pub fn reverse_geocode(lat: f64, lon: f64) -> Vec<String> {
        // Skip invalid coordinates
        if lat.abs() < 0.001 && lon.abs() < 0.001 {
            return Vec::new();
        }

        let geocoder = reverse_geocoder::ReverseGeocoder::new();
        let result = geocoder.search((lat, lon));
        let record = result.record;

        let mut tags = Vec::new();

        // Country from 2-letter country code
        if let Some(country) = Self::country_from_cc(&record.cc) {
            tags.push(country.to_string());
        }

        // Continent from country code
        if let Some(continent) = Self::continent_from_cc(&record.cc) {
            tags.push(continent.to_string());
        }

        tags
    }

    /// Map ISO 3166-1 alpha-2 country code to country name.
    fn country_from_cc(cc: &str) -> Option<&'static str> {
        match cc {
            "AD" => Some("Andorra"), "AE" => Some("UAE"), "AF" => Some("Afghanistan"),
            "AG" => Some("Antigua and Barbuda"), "AI" => Some("Anguilla"), "AL" => Some("Albania"),
            "AM" => Some("Armenia"), "AO" => Some("Angola"), "AQ" => Some("Antarctica"),
            "AR" => Some("Argentina"), "AS" => Some("American Samoa"), "AT" => Some("Austria"),
            "AU" => Some("Australia"), "AW" => Some("Aruba"), "AZ" => Some("Azerbaijan"),
            "BA" => Some("Bosnia and Herzegovina"), "BB" => Some("Barbados"), "BD" => Some("Bangladesh"),
            "BE" => Some("Belgium"), "BF" => Some("Burkina Faso"), "BG" => Some("Bulgaria"),
            "BH" => Some("Bahrain"), "BI" => Some("Burundi"), "BJ" => Some("Benin"),
            "BM" => Some("Bermuda"), "BN" => Some("Brunei"), "BO" => Some("Bolivia"),
            "BR" => Some("Brazil"), "BS" => Some("Bahamas"), "BT" => Some("Bhutan"),
            "BW" => Some("Botswana"), "BY" => Some("Belarus"), "BZ" => Some("Belize"),
            "CA" => Some("Canada"), "CD" => Some("DR Congo"), "CF" => Some("Central African Republic"),
            "CG" => Some("Congo"), "CH" => Some("Switzerland"), "CI" => Some("Ivory Coast"),
            "CL" => Some("Chile"), "CM" => Some("Cameroon"), "CN" => Some("China"),
            "CO" => Some("Colombia"), "CR" => Some("Costa Rica"), "CU" => Some("Cuba"),
            "CV" => Some("Cape Verde"), "CW" => Some("Curaçao"), "CY" => Some("Cyprus"),
            "CZ" => Some("Czech Republic"), "DE" => Some("Germany"), "DJ" => Some("Djibouti"),
            "DK" => Some("Denmark"), "DM" => Some("Dominica"), "DO" => Some("Dominican Republic"),
            "DZ" => Some("Algeria"), "EC" => Some("Ecuador"), "EE" => Some("Estonia"),
            "EG" => Some("Egypt"), "ER" => Some("Eritrea"), "ES" => Some("Spain"),
            "ET" => Some("Ethiopia"), "FI" => Some("Finland"), "FJ" => Some("Fiji"),
            "FK" => Some("Falkland Islands"), "FM" => Some("Micronesia"), "FO" => Some("Faroe Islands"),
            "FR" => Some("France"), "GA" => Some("Gabon"), "GB" => Some("United Kingdom"),
            "GD" => Some("Grenada"), "GE" => Some("Georgia"), "GF" => Some("French Guiana"),
            "GG" => Some("Guernsey"), "GH" => Some("Ghana"), "GI" => Some("Gibraltar"),
            "GL" => Some("Greenland"), "GM" => Some("Gambia"), "GN" => Some("Guinea"),
            "GP" => Some("Guadeloupe"), "GQ" => Some("Equatorial Guinea"), "GR" => Some("Greece"),
            "GT" => Some("Guatemala"), "GU" => Some("Guam"), "GW" => Some("Guinea-Bissau"),
            "GY" => Some("Guyana"), "HK" => Some("Hong Kong"), "HN" => Some("Honduras"),
            "HR" => Some("Croatia"), "HT" => Some("Haiti"), "HU" => Some("Hungary"),
            "ID" => Some("Indonesia"), "IE" => Some("Ireland"), "IL" => Some("Israel"),
            "IM" => Some("Isle of Man"), "IN" => Some("India"), "IQ" => Some("Iraq"),
            "IR" => Some("Iran"), "IS" => Some("Iceland"), "IT" => Some("Italy"),
            "JE" => Some("Jersey"), "JM" => Some("Jamaica"), "JO" => Some("Jordan"),
            "JP" => Some("Japan"), "KE" => Some("Kenya"), "KG" => Some("Kyrgyzstan"),
            "KH" => Some("Cambodia"), "KI" => Some("Kiribati"), "KM" => Some("Comoros"),
            "KN" => Some("Saint Kitts and Nevis"), "KP" => Some("North Korea"), "KR" => Some("South Korea"),
            "KW" => Some("Kuwait"), "KY" => Some("Cayman Islands"), "KZ" => Some("Kazakhstan"),
            "LA" => Some("Laos"), "LB" => Some("Lebanon"), "LC" => Some("Saint Lucia"),
            "LI" => Some("Liechtenstein"), "LK" => Some("Sri Lanka"), "LR" => Some("Liberia"),
            "LS" => Some("Lesotho"), "LT" => Some("Lithuania"), "LU" => Some("Luxembourg"),
            "LV" => Some("Latvia"), "LY" => Some("Libya"), "MA" => Some("Morocco"),
            "MC" => Some("Monaco"), "MD" => Some("Moldova"), "ME" => Some("Montenegro"),
            "MG" => Some("Madagascar"), "MH" => Some("Marshall Islands"), "MK" => Some("North Macedonia"),
            "ML" => Some("Mali"), "MM" => Some("Myanmar"), "MN" => Some("Mongolia"),
            "MO" => Some("Macau"), "MQ" => Some("Martinique"), "MR" => Some("Mauritania"),
            "MS" => Some("Montserrat"), "MT" => Some("Malta"), "MU" => Some("Mauritius"),
            "MV" => Some("Maldives"), "MW" => Some("Malawi"), "MX" => Some("Mexico"),
            "MY" => Some("Malaysia"), "MZ" => Some("Mozambique"), "NA" => Some("Namibia"),
            "NC" => Some("New Caledonia"), "NE" => Some("Niger"), "NF" => Some("Norfolk Island"),
            "NG" => Some("Nigeria"), "NI" => Some("Nicaragua"), "NL" => Some("Netherlands"),
            "NO" => Some("Norway"), "NP" => Some("Nepal"), "NR" => Some("Nauru"),
            "NU" => Some("Niue"), "NZ" => Some("New Zealand"), "OM" => Some("Oman"),
            "PA" => Some("Panama"), "PE" => Some("Peru"), "PF" => Some("French Polynesia"),
            "PG" => Some("Papua New Guinea"), "PH" => Some("Philippines"), "PK" => Some("Pakistan"),
            "PL" => Some("Poland"), "PM" => Some("Saint Pierre and Miquelon"), "PR" => Some("Puerto Rico"),
            "PS" => Some("Palestine"), "PT" => Some("Portugal"), "PW" => Some("Palau"),
            "PY" => Some("Paraguay"), "QA" => Some("Qatar"), "RE" => Some("Réunion"),
            "RO" => Some("Romania"), "RS" => Some("Serbia"), "RU" => Some("Russia"),
            "RW" => Some("Rwanda"), "SA" => Some("Saudi Arabia"), "SB" => Some("Solomon Islands"),
            "SC" => Some("Seychelles"), "SD" => Some("Sudan"), "SE" => Some("Sweden"),
            "SG" => Some("Singapore"), "SH" => Some("Saint Helena"), "SI" => Some("Slovenia"),
            "SK" => Some("Slovakia"), "SL" => Some("Sierra Leone"), "SM" => Some("San Marino"),
            "SN" => Some("Senegal"), "SO" => Some("Somalia"), "SR" => Some("Suriname"),
            "SS" => Some("South Sudan"), "ST" => Some("São Tomé and Príncipe"), "SV" => Some("El Salvador"),
            "SX" => Some("Sint Maarten"), "SY" => Some("Syria"), "SZ" => Some("Eswatini"),
            "TC" => Some("Turks and Caicos"), "TD" => Some("Chad"), "TG" => Some("Togo"),
            "TH" => Some("Thailand"), "TJ" => Some("Tajikistan"), "TK" => Some("Tokelau"),
            "TL" => Some("Timor-Leste"), "TM" => Some("Turkmenistan"), "TN" => Some("Tunisia"),
            "TO" => Some("Tonga"), "TR" => Some("Turkey"), "TT" => Some("Trinidad and Tobago"),
            "TV" => Some("Tuvalu"), "TW" => Some("Taiwan"), "TZ" => Some("Tanzania"),
            "UA" => Some("Ukraine"), "UG" => Some("Uganda"), "US" => Some("United States"),
            "UY" => Some("Uruguay"), "UZ" => Some("Uzbekistan"), "VA" => Some("Vatican City"),
            "VC" => Some("Saint Vincent"), "VE" => Some("Venezuela"), "VG" => Some("British Virgin Islands"),
            "VI" => Some("US Virgin Islands"), "VN" => Some("Vietnam"), "VU" => Some("Vanuatu"),
            "WF" => Some("Wallis and Futuna"), "WS" => Some("Samoa"), "XK" => Some("Kosovo"),
            "YE" => Some("Yemen"), "YT" => Some("Mayotte"), "ZA" => Some("South Africa"),
            "ZM" => Some("Zambia"), "ZW" => Some("Zimbabwe"),
            _ => None,
        }
    }

    /// Map ISO 3166-1 alpha-2 country code to continent name.
    fn continent_from_cc(cc: &str) -> Option<&'static str> {
        match cc {
            // Europe
            "AD"|"AL"|"AT"|"BA"|"BE"|"BG"|"BY"|"CH"|"CY"|"CZ"|"DE"|"DK"|"EE"|"ES"|"FI"|
            "FO"|"FR"|"GB"|"GE"|"GG"|"GI"|"GR"|"HR"|"HU"|"IE"|"IM"|"IS"|"IT"|"JE"|"LI"|
            "LT"|"LU"|"LV"|"MC"|"MD"|"ME"|"MK"|"MT"|"NL"|"NO"|"PL"|"PT"|"RO"|"RS"|"SE"|
            "SI"|"SK"|"SM"|"UA"|"VA"|"XK" => Some("Europe"),
            // North America
            "AG"|"AI"|"AW"|"BB"|"BM"|"BS"|"BZ"|"CA"|"CR"|"CU"|"CW"|"DM"|"DO"|"GD"|"GL"|
            "GP"|"GT"|"GU"|"HN"|"HT"|"JM"|"KN"|"KY"|"LC"|"MQ"|"MS"|"MX"|"NI"|"PA"|"PM"|
            "PR"|"SV"|"SX"|"TC"|"TT"|"US"|"VC"|"VG"|"VI" => Some("North America"),
            // South America
            "AR"|"BO"|"BR"|"CL"|"CO"|"EC"|"FK"|"GF"|"GY"|"PE"|"PY"|"SR"|"UY"|"VE"
                => Some("South America"),
            // Africa
            "AO"|"BF"|"BI"|"BJ"|"BW"|"CD"|"CF"|"CG"|"CI"|"CM"|"CV"|"DJ"|"DZ"|"EG"|"ER"|
            "ET"|"GA"|"GH"|"GM"|"GN"|"GQ"|"GW"|"KE"|"KM"|"LR"|"LS"|"LY"|"MA"|"MG"|"ML"|
            "MR"|"MU"|"MW"|"MZ"|"NA"|"NE"|"NG"|"RE"|"RW"|"SC"|"SD"|"SH"|"SL"|"SN"|"SO"|
            "SS"|"ST"|"SZ"|"TD"|"TG"|"TN"|"TZ"|"UG"|"YT"|"ZA"|"ZM"|"ZW"
                => Some("Africa"),
            // Asia
            "AE"|"AF"|"AM"|"AZ"|"BD"|"BH"|"BN"|"CN"|"HK"|"ID"|"IL"|"IN"|"IQ"|"IR"|"JO"|
            "JP"|"KG"|"KH"|"KP"|"KR"|"KW"|"KZ"|"LA"|"LB"|"LK"|"MM"|"MN"|"MO"|"MV"|"MY"|
            "NP"|"OM"|"PH"|"PK"|"PS"|"QA"|"RU"|"SA"|"SG"|"SY"|"TH"|"TJ"|"TL"|"TM"|"TR"|
            "TW"|"UZ"|"VN"|"YE" => Some("Asia"),
            // Oceania
            "AS"|"AU"|"FJ"|"FM"|"KI"|"MH"|"NC"|"NF"|"NR"|"NU"|"NZ"|"PF"|"PG"|"PW"|"SB"|
            "TK"|"TO"|"TV"|"VU"|"WF"|"WS" => Some("Oceania"),
            // Antarctica
            "AQ" => Some("Antarctica"),
            _ => None,
        }
    }

    /// Get frames from the parser, handling encryption if needed.
    /// Runs the CPU-bound parsing in spawn_blocking with catch_unwind
    /// to prevent panics from crashing the application.
    async fn get_frames(&self, parser: &DJILog) -> Result<Vec<Frame>, ParserError> {
        // Version 13+ requires keychains for decryption
        let keychains = if parser.version >= 13 {
            log::info!("Log version {} >= 13, fetching keychains for decryption", parser.version);
            let api_key = self.api.get_api_key().ok_or_else(|| {
                log::error!("No DJI API key configured — cannot decrypt V13+ log");
                ParserError::EncryptionKeyRequired
            })?;
            let kc = parser
                .fetch_keychains(&api_key)
                .map_err(|e| {
                    log::error!("Keychain fetch failed: {}", e);
                    ParserError::Api(e.to_string())
                })?;
            log::info!("Keychains fetched successfully ({} chains)", kc.len());
            Some(kc)
        } else {
            log::debug!("Log version {} < 13, no decryption needed", parser.version);
            None
        };

        // Clone what we need to move into spawn_blocking
        // DJILog doesn't implement Clone, so we need to use a raw pointer trick
        // Instead, we'll re-read the data inside the blocking task
        // Actually, frames() borrows self, so we need an unsafe approach or restructure.
        // The simplest safe approach: since parser is on the stack, use a scoped approach.
        // We use `unsafe` pointer cast to send the parser ref into spawn_blocking.
        // This is safe because we await the result immediately (parser outlives the task).
        let parser_ptr = parser as *const DJILog as usize;
        let result = timeout(
            Duration::from_secs(PARSE_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || {
                let parser_ref = unsafe { &*(parser_ptr as *const DJILog) };
                panic::catch_unwind(panic::AssertUnwindSafe(|| {
                    parser_ref.frames(keychains)
                }))
            }),
        )
        .await;

        match result {
            Err(_) => {
                log::error!("frames() timed out after {}s", PARSE_TIMEOUT_SECS);
                Err(ParserError::Timeout(PARSE_TIMEOUT_SECS))
            }
            Ok(Err(join_err)) => {
                log::error!("frames() task join error: {}", join_err);
                Err(ParserError::Panic(format!("Task join error: {}", join_err)))
            }
            Ok(Ok(Err(panic_val))) => {
                let msg = panic_val
                    .downcast_ref::<String>()
                    .map(|s| s.clone())
                    .or_else(|| panic_val.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown panic".to_string());
                log::error!("frames() panicked: {}", msg);
                Err(ParserError::Panic(msg))
            }
            Ok(Ok(Ok(frames_result))) => {
                frames_result.map_err(|e| {
                    log::error!("frames() returned error: {}", e);
                    ParserError::Parse(e.to_string())
                })
            }
        }
    }

    /// Extract telemetry points from parsed frames
    fn extract_telemetry(&self, frames: &[Frame], details_total_time_secs: f64) -> Vec<TelemetryPoint> {
        let mut points = Vec::with_capacity(frames.len());
        let mut timestamp_ms: i64 = 0;

        // Counters for logging
        let mut skipped_corrupt: usize = 0;
        let mut skipped_no_gps: usize = 0;
        let mut skipped_out_of_range: usize = 0;
        let mut skipped_alt_clamp: usize = 0;
        let mut skipped_speed_clamp: usize = 0;

        // Check if any frame has a non-zero fly_time
        let has_fly_time = frames.iter().any(|f| f.osd.fly_time > 0.0);
        log::debug!("fly_time available: {}", has_fly_time);

        // When fly_time is unavailable, compute interval from header duration
        // instead of assuming 100ms (10Hz), which inflates duration for high-rate logs
        let fallback_interval_ms: i64 = if !has_fly_time && details_total_time_secs > 0.0 && !frames.is_empty() {
            ((details_total_time_secs * 1000.0) / frames.len() as f64).round() as i64
        } else {
            100 // default 10Hz assumption
        };

        for frame in frames {
            let osd = &frame.osd;
            let gimbal = &frame.gimbal;
            let battery = &frame.battery;
            let rc = &frame.rc;

            let current_timestamp_ms = if osd.fly_time > 0.0 {
                (osd.fly_time * 1000.0) as i64
            } else {
                timestamp_ms
            };

            // Validate core numeric fields — skip entire frame if data is corrupt
            // (e.g. the parser produced garbage like lat=-6.6e-136, lon=5.7e+139)
            if !is_finite_f64(osd.latitude)
                || !is_finite_f64(osd.longitude)
                || !is_finite_f32(osd.altitude)
                || !is_finite_f32(osd.height)
                || !is_finite_f32(osd.x_speed)
                || !is_finite_f32(osd.y_speed)
                || !is_finite_f32(osd.z_speed)
            {
                // Increment timestamp and skip this corrupt frame
                if skipped_corrupt < 5 {
                    log::debug!(
                        "Skipping corrupt frame at {}ms: lat={}, lon={}, alt={}, height={}, vx={}, vy={}, vz={}",
                        current_timestamp_ms,
                        osd.latitude, osd.longitude, osd.altitude, osd.height,
                        osd.x_speed, osd.y_speed, osd.z_speed
                    );
                }
                skipped_corrupt += 1;
                timestamp_ms = current_timestamp_ms + fallback_interval_ms;
                continue;
            }

            let mut point = TelemetryPoint {
                timestamp_ms: current_timestamp_ms,
                ..Default::default()
            };

            // Filter out invalid GPS coordinates:
            //  - 0,0 means no GPS lock
            //  - Values outside physical range (lat ±90, lon ±180) are corrupt data
            let has_gps_lock = !(osd.latitude.abs() < 1e-6 && osd.longitude.abs() < 1e-6);
            let gps_in_range = osd.latitude.abs() <= 90.0 && osd.longitude.abs() <= 180.0;
            if has_gps_lock && gps_in_range {
                point.latitude = Some(osd.latitude);
                point.longitude = Some(osd.longitude);
            } else if has_gps_lock && !gps_in_range {
                skipped_out_of_range += 1;
            } else {
                skipped_no_gps += 1;
            }
            // else: latitude/longitude remain None (from Default)

            // Clamp altitude/height to physically plausible range (reject garbage)
            let alt = osd.altitude as f64;
            let height = osd.height as f64;
            point.altitude = if alt.abs() < 10_000.0 { Some(alt) } else { skipped_alt_clamp += 1; None };
            point.height = if height.abs() < 10_000.0 { Some(height) } else { skipped_alt_clamp += 1; None };
            point.vps_height = Some(osd.vps_height as f64);

            point.speed = if has_gps_lock && gps_in_range {
                let spd = (osd.x_speed.powi(2) + osd.y_speed.powi(2)).sqrt() as f64;
                if spd < 100.0 { Some(spd) } else { skipped_speed_clamp += 1; None } // >100 m/s is clearly garbage
            } else {
                None // Speed from 0,0 origin is meaningless
            };
            point.velocity_x = if has_gps_lock && gps_in_range { Some(osd.x_speed as f64) } else { None };
            point.velocity_y = if has_gps_lock && gps_in_range { Some(osd.y_speed as f64) } else { None };
            point.velocity_z = if has_gps_lock && gps_in_range { Some(osd.z_speed as f64) } else { None };
            point.pitch = Some(osd.pitch as f64);
            point.roll = Some(osd.roll as f64);
            point.yaw = Some(osd.yaw as f64);
            point.satellites = Some(osd.gps_num as i32);
            point.gps_signal = Some(osd.gps_level as i32);
            point.flight_mode = osd.flyc_state.map(|state| format!("{:?}", state));

            point.gimbal_pitch = Some(gimbal.pitch as f64);
            point.gimbal_roll = Some(gimbal.roll as f64);
            point.gimbal_yaw = Some(gimbal.yaw as f64);

            point.battery_percent = Some(battery.charge_level as i32);
            point.battery_voltage = Some(battery.voltage as f64);
            point.battery_current = Some(battery.current as f64);
            point.battery_temp = Some(battery.temperature as f64);

            point.rc_uplink = rc.uplink_signal.map(i32::from);
            point.rc_downlink = rc.downlink_signal.map(i32::from);
            point.rc_signal = rc.downlink_signal.or(rc.uplink_signal).map(i32::from);

            // RC stick inputs: raw u16 centered at 1024 (range 0..2048) → normalized to -100..+100
            point.rc_aileron = Some(((rc.aileron as f64) - 1024.0) / 1024.0 * 100.0);
            point.rc_elevator = Some(((rc.elevator as f64) - 1024.0) / 1024.0 * 100.0);
            point.rc_throttle = Some(((rc.throttle as f64) - 1024.0) / 1024.0 * 100.0);
            point.rc_rudder = Some(((rc.rudder as f64) - 1024.0) / 1024.0 * 100.0);

            // Camera state: extract is_photo and is_video from frame.camera
            let camera = &frame.camera;
            point.is_photo = Some(camera.is_photo);
            point.is_video = Some(camera.is_video);

            points.push(point);

            // Increment timestamp using computed interval
            timestamp_ms = current_timestamp_ms + fallback_interval_ms;
        }

        // Log extraction summary
        if skipped_corrupt > 0 || skipped_out_of_range > 0 || skipped_alt_clamp > 0 || skipped_speed_clamp > 0 {
            log::warn!(
                "Telemetry filtering: {} corrupt frames skipped, {} GPS out-of-range, {} no-GPS-lock, {} altitude clamped, {} speed clamped",
                skipped_corrupt, skipped_out_of_range, skipped_no_gps, skipped_alt_clamp, skipped_speed_clamp
            );
        } else {
            log::debug!(
                "Telemetry extraction clean: {} points, {} frames without GPS lock",
                points.len(), skipped_no_gps
            );
        }

        points
    }

    /// Calculate flight statistics from telemetry points
    pub fn calculate_stats(&self, points: &[TelemetryPoint]) -> FlightStats {
        let duration_secs = points.last().map(|p| p.timestamp_ms as f64 / 1000.0).unwrap_or(0.0);

        let max_altitude = points
            .iter()
            .filter_map(|p| p.height.or(p.altitude))
            .fold(f64::NEG_INFINITY, f64::max);

        let max_speed = points
            .iter()
            .filter_map(|p| p.speed)
            .fold(f64::NEG_INFINITY, f64::max);

        let avg_speed: f64 = {
            let speeds: Vec<f64> = points.iter().filter_map(|p| p.speed).collect();
            if speeds.is_empty() {
                0.0
            } else {
                speeds.iter().sum::<f64>() / speeds.len() as f64
            }
        };

        let min_battery = points
            .iter()
            .filter_map(|p| p.battery_percent)
            .min()
            .unwrap_or(0);

        // Calculate total distance using haversine formula
        let total_distance = self.calculate_total_distance(points);

        // Home location is the first valid GPS point
        let home_location = points
            .iter()
            .find_map(|p| match (p.longitude, p.latitude) {
                (Some(lon), Some(lat)) => Some([lon, lat]),
                _ => None,
            });

        // Max distance from home
        let max_distance_from_home = if let Some(home) = home_location {
            points
                .iter()
                .filter_map(|p| match (p.latitude, p.longitude) {
                    (Some(lat), Some(lon)) => Some(haversine_distance(home[1], home[0], lat, lon)),
                    _ => None,
                })
                .fold(0.0_f64, f64::max)
        } else {
            0.0
        };

        // Start and end battery percent
        let start_battery_percent = points.iter().find_map(|p| p.battery_percent);
        let end_battery_percent = points.iter().rev().find_map(|p| p.battery_percent);

        // Start battery temperature
        let start_battery_temp = points.iter().find_map(|p| p.battery_temp);

        FlightStats {
            duration_secs,
            total_distance_m: total_distance,
            max_altitude_m: if max_altitude.is_finite() {
                max_altitude
            } else {
                0.0
            },
            max_speed_ms: if max_speed.is_finite() { max_speed } else { 0.0 },
            avg_speed_ms: avg_speed,
            min_battery,
            home_location,
            max_distance_from_home_m: max_distance_from_home,
            start_battery_percent,
            end_battery_percent,
            start_battery_temp,
        }
    }

    /// Calculate total distance traveled using haversine formula
    fn calculate_total_distance(&self, points: &[TelemetryPoint]) -> f64 {
        let mut total = 0.0;
        let mut prev_lat: Option<f64> = None;
        let mut prev_lon: Option<f64> = None;

        for point in points {
            if let (Some(lat), Some(lon)) = (point.latitude, point.longitude) {
                if let (Some(p_lat), Some(p_lon)) = (prev_lat, prev_lon) {
                    total += haversine_distance(p_lat, p_lon, lat, lon);
                }
                prev_lat = Some(lat);
                prev_lon = Some(lon);
            }
        }

        total
    }

    /// Extract drone model from parser metadata
    fn extract_drone_model(&self, parser: &DJILog) -> Option<String> {
        let model = format!("{:?}", parser.details.product_type);
        if model.starts_with("Unknown") {
            None
        } else {
            Some(model)
        }
    }

    /// Extract serial number from parser
    fn extract_serial(&self, parser: &DJILog) -> Option<String> {
        let sn = parser.details.aircraft_sn.trim().to_uppercase();
        if sn.is_empty() {
            None
        } else {
            Some(sn)
        }
    }

    /// Extract aircraft name from parser
    fn extract_aircraft_name(&self, parser: &DJILog) -> Option<String> {
        let name = parser.details.aircraft_name.clone();
        if name.trim().is_empty() {
            None
        } else {
            Some(name)
        }
    }

    /// Extract battery serial from parser
    fn extract_battery_serial(&self, parser: &DJILog) -> Option<String> {
        let sn = parser.details.battery_sn.trim().to_uppercase();
        if sn.is_empty() {
            None
        } else {
            Some(sn)
        }
    }

    /// Extract flight start time
    fn extract_start_time(&self, parser: &DJILog) -> Option<DateTime<Utc>> {
        Some(parser.details.start_time)
    }

    /// Extract flight end time
    fn extract_end_time(&self, parser: &DJILog) -> Option<DateTime<Utc>> {
        let start = self.extract_start_time(parser)?;
        let duration_ms = (parser.details.total_time * 1000.0) as i64;
        Some(start + chrono::Duration::milliseconds(duration_ms))
    }
}

/// Calculate FlightStats from stored TelemetryRecords (for tag regeneration without re-parsing files)
pub fn calculate_stats_from_records(records: &[crate::models::TelemetryRecord]) -> FlightStats {
    let duration_secs = records.last().map(|r| r.timestamp_ms as f64 / 1000.0).unwrap_or(0.0)
        - records.first().map(|r| r.timestamp_ms as f64 / 1000.0).unwrap_or(0.0);

    let max_altitude = records.iter()
        .filter_map(|r| r.height.or(r.altitude))
        .fold(0.0_f64, f64::max);

    let max_speed = records.iter()
        .filter_map(|r| r.speed)
        .fold(0.0_f64, f64::max);

    let avg_speed: f64 = {
        let speeds: Vec<f64> = records.iter().filter_map(|r| r.speed).collect();
        if speeds.is_empty() { 0.0 } else { speeds.iter().sum::<f64>() / speeds.len() as f64 }
    };

    let min_battery = records.iter()
        .filter_map(|r| r.battery_percent)
        .min()
        .unwrap_or(0);

    // Total distance using haversine
    let mut total_distance = 0.0;
    let mut prev_lat: Option<f64> = None;
    let mut prev_lon: Option<f64> = None;
    for r in records {
        if let (Some(lat), Some(lon)) = (r.latitude, r.longitude) {
            if lat.abs() < 0.0001 && lon.abs() < 0.0001 { continue; }
            if let (Some(plat), Some(plon)) = (prev_lat, prev_lon) {
                total_distance += haversine_distance(plat, plon, lat, lon);
            }
            prev_lat = Some(lat);
            prev_lon = Some(lon);
        }
    }

    let home_location = records.iter()
        .find_map(|r| match (r.longitude, r.latitude) {
            (Some(lon), Some(lat)) if lat.abs() > 0.0001 || lon.abs() > 0.0001 => Some([lon, lat]),
            _ => None,
        });

    let max_distance_from_home = if let Some(home) = home_location {
        records.iter()
            .filter_map(|r| match (r.latitude, r.longitude) {
                (Some(lat), Some(lon)) => Some(haversine_distance(home[1], home[0], lat, lon)),
                _ => None,
            })
            .fold(0.0_f64, f64::max)
    } else {
        0.0
    };

    let start_battery_percent = records.iter().find_map(|r| r.battery_percent);
    let end_battery_percent = records.iter().rev().find_map(|r| r.battery_percent);
    let start_battery_temp = records.iter().find_map(|r| r.battery_temp);

    FlightStats {
        duration_secs,
        total_distance_m: total_distance,
        max_altitude_m: if max_altitude.is_finite() { max_altitude } else { 0.0 },
        max_speed_ms: if max_speed.is_finite() { max_speed } else { 0.0 },
        avg_speed_ms: avg_speed,
        min_battery,
        home_location,
        max_distance_from_home_m: max_distance_from_home,
        start_battery_percent,
        end_battery_percent,
        start_battery_temp,
    }
}

/// Haversine distance calculation in meters
pub fn haversine_distance(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0; // Earth's radius in meters

    let lat1_rad = lat1.to_radians();
    let lat2_rad = lat2.to_radians();
    let delta_lat = (lat2 - lat1).to_radians();
    let delta_lon = (lon2 - lon1).to_radians();

    let a = (delta_lat / 2.0).sin().powi(2)
        + lat1_rad.cos() * lat2_rad.cos() * (delta_lon / 2.0).sin().powi(2);

    let c = 2.0 * a.sqrt().asin();

    R * c
}

/// Check if an f64 value is finite (not NaN, not Inf)
#[inline]
fn is_finite_f64(v: f64) -> bool {
    v.is_finite()
}

/// Check if an f32 value is finite (not NaN, not Inf)
#[inline]
fn is_finite_f32(v: f32) -> bool {
    v.is_finite()
}

# Custom Parsers Guideline

Open-DroneLog supports plugins for parsing custom and proprietary drone log formats. Instead of writing Rust code and recompiling the application, you can write standalone scripts (in Python, Bash, Node.js, etc.) that convert your logs into the standard **Drone Logbook CSV** format. 

Open-DroneLog will execute your scripts automatically during the import process when it detects a matching file extension.

---

## 1. How the Plugin System Works

1. **Configuration (`parsers.json`)**: You define which file extensions should be handled by your custom scripts.
2. **Execution**: When a user imports a file, Open-DroneLog first tries to parse it using built-in methods. If it fails (incompatible format) and matches a registered extension in your config, Open-DroneLog executes your script as a background process.
3. **Arguments**: The app passes the **input log file path** and a **temporary output CSV path** to your script.
4. **Ingestion**: Your script parses the custom log and writes a valid Drone Logbook CSV to the output path. When your script exits with code `0`, Open-DroneLog imports the resulting CSV.

---

## 2. Configuration (`parsers.json`)

Create a `parsers.json` file in your application's data directory.

**For the Desktop App:**
- **Linux**: `~/.local/share/com.drone-logbook/parsers.json`
- **Windows**: `C:\Users\<User>\AppData\Local\com.drone-logbook\parsers.json`
- **macOS**: `~/Library/Application Support/com.drone-logbook/parsers.json`

**For the Web/Docker App:**
- **Linux/Docker**: map as a volume, e.g., `./data/parsers.json:/app/data/parsers.json`

### Example `parsers.json`

```json
{
  "mappings": {
    "mylog": {
      "command": "python3",
      "args": ["/absolute/path/to/my_parser.py", "$INPUT", "$OUTPUT"]
    },
    "binlog": {
      "command": "/absolute/path/to/binlog-parser-executable",
      "args": ["--input", "$INPUT", "--export-csv", "$OUTPUT"]
    }
  }
}
```

* `$INPUT`: Will be replaced by Open-DroneLog with the absolute path of the uploaded file.
* `$OUTPUT`: Will be replaced by Open-DroneLog with the absolute path where your script must save the CSV for the import.

---

## 3. The Target CSV Format

Your script **must** output a CSV file that matches the Drone Logbook CSV specification. 

### Minimal Required Columns
To successfully trace a flight path and calculate statistics, your CSV must contain a header row with at least these columns (case-insensitive):
- `time_s`: Timestamp relative to the start of the flight, in decimal seconds (e.g., `1.2`, `1.4`).
- `lat`: Latitude in decimal degrees.
- `lng`: Longitude in decimal degrees.
- `alt_m` (or `alt_ft`): Altitude relative to the takeoff point.
- `distance_to_home_m` (or `distance_to_home_ft`): Straight-line distance between the drone and the recorded home point.

*If an exact value is unknown for a particular row, leave the field empty (e.g. `1.2,45.0,9.0,,10.5`).*

### Extended Columns (Optional)
Including these columns enables the matching charts and telemetry panels in the dashboard:
- **Velocity**: `speed_ms` (or `speed_mph`), `velocity_x_ms`, `velocity_y_ms`, `velocity_z_ms`
- **Battery**: `battery_percent`, `battery_voltage_v`, `battery_temp_c` (or `battery_temp_f`), `cell_voltages` (JSON array: `[4.1, 4.1, 4.1]`)
- **Orientation**: `pitch_deg`, `roll_deg`, `yaw_deg`
- **Height (Ultrasonic/VPS)**: `vps_height_m` (or `vps_height_ft`)
- **Action/State**: `is_photo` (`1` or `0`), `is_video` (`1` or `0`), `flight_mode`
- **RC Inputs**: `rc_aileron`, `rc_elevator`, `rc_throttle`, `rc_rudder`
- **Signal**: `satellites`, `rc_signal`

### Metadata Column (Highly Recommended)
You can provide flight-level metadata by embedding a JSON string inside the `Metadata` column of your CSV. This string only needs to be present in the **first data row**, and can be left blank for subsequent rows. Open-DroneLog extracts details like the drone model, pilot notes, serial numbers, and tags from this object.

Example JSON structure:
```json
{
  "drone_model": "Custom Quadcopter",
  "drone_serial": "SN-12345",
  "battery_serial": "BAT-999",
  "start_time": "2026-03-14T15:30:00Z",
  "notes": "Test flight over the field",
  "tags": [
    {"tag": "Survey", "tag_type": "manual"},
    {"tag": "High Wind", "tag_type": "auto"}
  ]
}
```
*Note: Ensure the JSON string is properly escaped if written manually inside the CSV.*

### App Messages Column (Optional)
Similar to metadata, you can provide warnings or tips (like "Wind Warning") by adding a `Messages` column. Put a JSON array in the first data row:
```json
[
  { "timestamp_ms": 15000, "type": "warning", "message": "High Wind Velocity" },
  { "timestamp_ms": 120000, "type": "tip", "message": "Return to Home Triggered" }
]
```

---

## 4. Script Execution Guidelines

1. **Exit Codes**: Open-DroneLog only ingests the `$OUTPUT` CSV if your script exits with status code `0`. If your parser encounters an error or an invalid file, it should exit with a non-zero status code (e.g. `1`) and print the error to standard error (`stderr`).
2. **Performance**: Avoid heavy computations. If your script takes longer than 40 seconds, Open-DroneLog will timeout and cancel the import process.
3. **Environment**: If running Open-DroneLog via Docker, remember that your scripts run inside the container. 
   - **Python 3 and Node.js are bundled natively** in the Docker image. You can invoke them directly in your `parsers.json` `command` and mount your scripts via volumes.
   - For other languages, write a self-contained compiled binary (like Go or Rust) statically linked for Linux, or build a custom image extending the base Dockerfile.

### Example Python Parser (`my_parser.py`)

```python
import sys
import csv
import json

def parse_my_format(input_path, output_path):
    # Dummy logic to read custom format
    # ...

    with open(output_path, 'w', newline='') as f:
        writer = csv.writer(f)
        
        # Write Drone Logbook headers
        writer.writerow(['time_s', 'lat', 'lng', 'alt_m', 'distance_to_home_m', 'battery_percent', 'Metadata'])
        
        # Write first row with Metadata JSON
        meta_json = json.dumps({
            "drone_model": "Custom FPV",
            "start_time": "2026-03-14T10:00:00Z"
        })
        writer.writerow(['0.1', '37.7749', '-122.4194', '0.0', '0.0', '100', meta_json])
        
        # Write subsequent rows
        writer.writerow(['1.1', '37.7750', '-122.4195', '5.2', '10.5', '99', ''])
        writer.writerow(['2.1', '37.7751', '-122.4196', '10.1', '21.0', '98', ''])

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(1)
        
    in_file = sys.argv[1]
    out_file = sys.argv[2]
    
    try:
        parse_my_format(in_file, out_file)
        sys.exit(0)
    except Exception as e:
        print(f"Failed to parse log: {e}", file=sys.stderr)
        sys.exit(1)
```

---

## 5. Docker Deployment

When deploying Open-DroneLog in Docker, map a plugins folder in your `docker-compose.yml`:

```yaml
services:
  open-dronelog:
    image: arpanghosh8453/open-dronelog:latest
    volumes:
      - ./data:/app/data
      - ./plugins:/app/plugins  # Mount your custom scripts here
```

And configure your `parsers.json` (placed in `/app/data/parsers.json`) to invoke your script using available tools in the container or standalone binaries:
```json
{
  "mappings": {
    "custom": {
      "command": "/app/plugins/my-binary-parser-linux-amd64",
      "args": ["$INPUT", "$OUTPUT"]
    }
  }
}
```

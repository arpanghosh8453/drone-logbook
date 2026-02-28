# Drone Logbook User Manual

**A comprehensive guide to using Drone Logbook, your local-first drone flight log analyzer.**

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Interface Layout](#interface-layout)
- [Importing Flight Logs](#importing-flight-logs)
- [Manual Flight Entry](#manual-flight-entry)
- [Flight List and Selection](#flight-list-and-selection)
- [Filters and Search](#filters-and-search)
- [Tags System](#tags-system)
- [Flight Statistics](#flight-statistics)
- [Telemetry Charts](#telemetry-charts)
- [Flight Map and Replay](#flight-map-and-replay)
- [Overview Dashboard](#overview-dashboard)
- [Battery and Maintenance Tracking](#battery-and-maintenance-tracking)
- [Exporting Data](#exporting-data)
- [Settings](#settings)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Tips and Tricks](#tips-and-tricks)
- [Troubleshooting](#troubleshooting)

---

## Overview

Drone Logbook is a high-performance application for analyzing drone flight logs. It supports DJI flight logs (`.txt` format) and Litchi CSV exports. All your data is stored locally in a DuckDB database with no cloud uploads, no subscriptions, and complete privacy.

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Unlimited Imports** | Import and manage as many flight logs as you need |
| **3D Visualization** | Interactive flight path visualization with replay |
| **Telemetry Analysis** | Comprehensive charts for all flight data |
| **Smart Tagging** | Automatic descriptive tags based on flight characteristics |
| **Advanced Filtering** | Powerful filtering, search, and sorting options |
| **Photo/Video Tracking** | Automatic detection and counting of media captures |
| **Battery Tracking** | Health monitoring and maintenance scheduling |
| **Manual Entry** | Record flights without log files |
| **Multiple Exports** | Export to CSV, JSON, GPX, and KML formats |
| **Full Backup** | Complete database backup and restore |
| **Single Instance** | Only one app window runs at a time (desktop) |

---

## Getting Started

### First Launch

When you first open Drone Logbook, you will see an empty dashboard with the import section expanded. The application automatically detects whether you have existing flights and adjusts the interface accordingly.

### Importing Your First Flight

1. Click **Browse Files** or drag-and-drop flight log files onto the import area
2. Select your DJI `.txt` files or Litchi `.csv` files
3. Wait for processing (the app will decrypt DJI logs, which requires internet on first import)
4. Your flights appear in the sidebar list

> [!NOTE]
> DJI V13+ flight logs require decryption keys from DJI's servers. You need to be online during the first import of each new log file. Once imported, the keys are cached locally for offline use.

---

## Interface Layout

The application is divided into three main areas:

### Left Sidebar

| Component | Function |
|-----------|----------|
| **View Toggle** | Switch between "Flights" and "Overview" modes |
| **Import Section** | Drag-drop area and browse button (collapsible) |
| **Filters Section** | Date range, drone, battery, tags, and range filters (collapsible) |
| **Flight List** | All imported flights with selection, sorting, and search |

### Main Panel: Flights View

| Section | Content |
|---------|---------|
| **Top** | Telemetry charts showing flight data over time |
| **Bottom** | Interactive 3D flight map with replay controls |

### Main Panel: Overview View

| Section | Content |
|---------|---------|
| **Statistics Cards** | Total flights, distance, time, and data points |
| **Activity Heatmap** | Calendar view of flight activity |
| **Charts** | Flights by drone, battery, and duration breakdowns |
| **Cluster Map** | Geographic view of all flight locations |
| **Battery Health** | Per-battery health indicators |
| **Top Flights** | Longest and furthest flights |
| **Maintenance** | Track maintenance schedules for batteries and aircraft |

### Resizable Panels

- Drag the divider between sidebar and main panel to resize
- Drag the horizontal divider between charts and map to adjust the split
- Collapse the telemetry panel completely by dragging it to minimum width

---

## Importing Flight Logs

### Supported Formats

| Format | File Extension | Source |
|--------|----------------|--------|
| DJI Flight Logs | `.txt` | Modern DJI format from DJI Fly app |
| Litchi CSV | `.csv` | Exported from Litchi app |

### Import Methods

| Method | Description |
|--------|-------------|
| **Drag and Drop** | Drag files directly onto the import area |
| **Browse Button** | Click "Browse Files" to open a file picker |
| **Multiple Files** | Select multiple files at once for batch import |
| **Folder Sync** | Configure automatic import from a mounted folder |

### Duplicate Detection

The app automatically detects and prevents duplicate imports based on:

- Drone serial number
- Battery serial number
- Exact start time

> [!TIP]
> You can safely re-import files without creating duplicates. The app will skip any flights that already exist in your database.

### Import Progress

During import, you will see:

- Current file being processed
- Progress counter (X of Y files)
- Any errors or warnings

---

## Manual Flight Entry

For flights where no log file is available (e.g., flights with other apps, flights before you started logging, or when logs were lost), you can manually create flight records.

### Accessing Manual Entry

Click the **Manual Entry** button in the Import section of the sidebar.

### Required Information

| Field | Description |
|-------|-------------|
| **Flight Title** | Optional custom display name (defaults to Aircraft Name if left blank) |
| **Aircraft Name** | Name or model of the drone used |
| **Drone Serial** | Serial number of the aircraft |
| **Battery Serial** | Serial number of the battery used |
| **Date** | Flight date (calendar picker) |
| **Time** | Takeoff time in 12-hour format (converted to UTC internally) |
| **Duration** | Flight duration in seconds |
| **Home Latitude** | Takeoff location latitude (-90 to 90) |
| **Home Longitude** | Takeoff location longitude (-180 to 180) |

### Optional Information

| Field | Description |
|-------|-------------|
| **Total Distance** | Distance traveled (in current units) |
| **Max Altitude** | Maximum altitude reached (in current units) |
| **Notes** | Additional notes about the flight |

### After Creating a Manual Entry

- The flight is automatically tagged with "Manual Entry"
- Smart location tags (city, country, continent) are generated from the coordinates
- The flight appears in your flight list and overview statistics
- Manual entries can be exported, but since they have no telemetry data:
  - **CSV** exports contain a single row with home coordinates and metadata
  - **GPX** exports contain a waypoint at the home location
  - **KML** exports contain a point placemark at the home location

> [!NOTE]
> Manual entries have no telemetry data, so the charts panel will be empty and the map will show only the home location marker.

---

## Flight List and Selection

### Viewing Flights

The flight list displays all imported flights with the following information:

| Field | Description |
|-------|-------------|
| **Flight Name** | Editable display name |
| **Date and Time** | When the flight occurred |
| **Duration** | Total flight time |
| **Distance** | Total distance traveled |
| **Drone Model** | Aircraft used |
| **Tags** | Colored badges for categorization |

### Selecting a Flight

- **Single Click** loads the flight data into charts and map
- Selected flight is highlighted with a colored border
- **Double-click** opens rename mode

### Renaming Flights

1. Double-click on a flight name, **OR**
2. Hover over a flight and click the edit icon
3. Type the new name
4. Press **Enter** to save or **Escape** to cancel

### Deleting Flights

1. Hover over a flight to reveal the delete button
2. Click the delete button
3. Confirm the deletion in the popup

> [!WARNING]
> Deleted flights cannot be recovered unless you have a database backup.

### Context Menu Actions

Right-click on any flight in the list to access additional actions:

| Action | Description |
|--------|-------------|
| **Rename** | Edit the flight name |
| **Delete** | Remove the flight from the database |
| **Regenerate Smart Tags** | Re-apply automatic tags to this flight |
| **Generate FlyCard** | Create a shareable image with flight stats (disabled in Overview mode) |
| **Export** | Export this flight to CSV, JSON, GPX, or KML |

### Sorting Options

Click the sort dropdown to sort flights by:

| Option | Behavior |
|--------|----------|
| **Name** | Alphabetical order |
| **Date** | Newest or oldest first |
| **Duration** | Longest or shortest |
| **Distance** | Furthest or nearest |

Toggle ascending/descending with the arrow button.

---

## Filters and Search

### Accessing Filters

Click the **Filters** header in the sidebar to expand or collapse the filter section. Filters persist across sessions.

### Available Filters

#### Date Range

- Click the date button to open a calendar picker
- Select a start date (From) and end date (To)
- Clear with the X button

#### Drone Filter

- Multi-select dropdown showing all your drones
- Drones are listed with their display name and serial
- Selected drones appear at the top of the list

#### Battery Filter

- Multi-select dropdown showing all battery serials
- Batteries use custom names if you have renamed them
- Selected batteries appear at the top

#### Tag Filter

- Multi-select dropdown with all available tags
- Type to search and filter tags
- Select multiple tags (flight must have ALL selected tags)

#### Range Filters

| Filter | Description |
|--------|-------------|
| **Duration Range** | Set minimum and maximum duration in minutes |
| **Altitude Range** | Filter by maximum altitude reached |
| **Distance Range** | Filter by total distance traveled |

> [!NOTE]
> Range filter units adapt to your preference setting (metric or imperial).

#### Map Area Filter

- Toggle "Filter by visible map area" in Overview
- Only shows flights with takeoff location within the current map view

### Search

- Type in the search box to filter flights by name
- Search is case-insensitive
- Works in combination with other filters

### Filter Inversion

Click the **Invert** button to negate all filters. Instead of "show flights matching these criteria," it becomes "hide flights matching these criteria."

### Clearing Filters

- Click the X on individual filters to clear them
- Use the clear button on dropdowns to reset selections
- Date range has a dedicated clear button

---

## Tags System

### Automatic Tags (Smart Tags)

When enabled, the app automatically generates descriptive tags during import:

| Tag | Condition |
|-----|-----------|
| **Night Flight** | Flight occurred during nighttime hours |
| **High Speed** | Maximum speed exceeded threshold |
| **Cold Battery** | Battery temperature was low during flight |
| **Low Battery** | Minimum battery level dropped below threshold |
| **High Altitude** | Maximum altitude exceeded threshold |
| **Long Distance** | Total distance or distance from home exceeded threshold |
| **Country** | Reverse geocoded from takeoff coordinates |
| **Continent** | Reverse geocoded from takeoff coordinates |
| **Litchi** | Flight was imported from Litchi CSV |
| **Manual Entry** | Flight was created via manual entry (no log file) |

### Manual Tags

1. Select a flight to view its details
2. In the stats bar, click the **+** button next to existing tags
3. Type a new tag name or select from suggestions
4. Press **Enter** to add the tag

### Removing Tags

- Click the **X** on any tag badge to remove it
- Auto-generated tags show a special indicator to distinguish them from manual tags

### Managing Smart Tags in Settings

| Action | Description |
|--------|-------------|
| **Toggle Smart Tags** | Enable or disable automatic tagging for new imports |
| **Regenerate Smart Tags** | Re-apply automatic tags to all existing flights |
| **Remove Auto Tags** | Remove all auto-generated tags while preserving manual tags |

### Bulk Tag Operations

The sidebar provides two buttons for bulk tag management on filtered flights:

| Button | Description |
|--------|-------------|
| **Untag filtered** | Removes the currently selected tag filter(s) from all filtered flights. Requires at least one tag filter to be selected. Shows confirmation before proceeding. |
| **Bulk tag filtered** | Adds a manual tag to all filtered flights. Enter a tag name and press Enter or click the checkmark to apply. Supports autocomplete from existing tags. |

Both operations show a progress overlay while processing and automatically refresh the flight list when complete.

---

## Flight Statistics

When a flight is selected, the stats bar shows key metrics:

### Primary Statistics

| Metric | Description |
|--------|-------------|
| **Duration** | Total flight time |
| **Distance** | Total distance traveled |
| **Max Altitude** | Highest point reached |
| **Max Speed** | Fastest speed recorded |

### Additional Information

| Field | Description |
|-------|-------------|
| **Start Time** | When the flight began |
| **Drone Model** | Aircraft used |
| **Battery** | Battery serial and health indicators |
| **Home Location** | Takeoff coordinates |
| **Photos** | Number of photo captures detected |
| **Videos** | Number of video recordings detected |

### Weather Data

Click the **Weather** button to fetch historical weather data for the flight:

- Temperature
- Wind speed and direction
- Humidity
- Weather conditions

> [!NOTE]
> Weather data requires an external API request. You need to be online, and the data is fetched based on the flight's location and time.

---

## Telemetry Charts

### Available Charts

The telemetry panel displays synchronized charts:

| Chart | Data Shown |
|-------|------------|
| **Height / VPS** | Altitude and Visual Positioning System height |
| **Speed** | Ground speed over time |
| **Battery** | Battery percentage and voltage |
| **Cell Voltages** | Individual battery cell voltages (dynamic legend per cell) |
| **Attitude** | Pitch, roll, and yaw angles |
| **RC Signal** | Remote controller signal strength |
| **GPS Satellites** | Number of connected satellites |
| **RC Uplink/Downlink** | Signal quality metrics |
| **Distance to Home** | How far from takeoff point |
| **Velocity X/Y/Z** | Speed components in 3D space |

> [!NOTE]
> The Cell Voltages chart is only displayed when cell voltage data is available from the flight log. Not all DJI drones record per-cell voltages.

### Interacting with Charts

#### Zooming

| Action | Description |
|--------|-------------|
| **Drag to zoom** | Click and drag horizontally to zoom into a time range |
| **Reset zoom** | Click the reset button to show full flight |
| **Toggle drag zoom** | Click the zoom toggle to enable or disable drag zooming |

### Customizing Charts

You can customize which telemetry fields are displayed in each chart category:

1. Click the **x/y dropdown** in the top-left of the charts panel
2. In the dropdown, select or deselect fields (you can select upto 4 data types) for each chart category:
   - **Height & Altitude**: Height, Altitude, VPS Height
   - **Speed & Motion**: Speed, Velocity X/Y/Z
   - **Battery**: Battery Percent, Voltage, Cell Voltages
   - **Attitude**: Pitch, Roll, Yaw
   - **Signal**: RC Signal, Uplink, Downlink, GPS Satellites
   - **Distance**: Distance to Home

> [!TIP]
> Your chart configuration is automatically saved and will persist across sessions in the same device. 

#### Synchronized Views

- All charts stay synchronized: zoom one, and they all zoom
- Hover shows values across all charts at that timestamp

#### Chart Sync with Map

- Enable **Sync with Map** to link chart position with map replay
- As you scrub through the flight replay, charts highlight the current position

---

## Flight Map and Replay

### Map Controls

#### View Options

| Control | Function |
|---------|----------|
| **3D Toggle** | Switch between 3D terrain and flat map view |
| **Satellite Toggle** | Switch between satellite imagery and street map |
| **Navigation Controls** | Zoom, rotation, and tilt buttons |

#### Display Options

| Option | Description |
|--------|-------------|
| **Color By** | Change how the flight path is colored (see below) |
| **Show Aircraft** | Toggle the 3D aircraft marker |
| **Show Media** | Display photo/video capture points on the path |
| **Tooltip** | Toggle hover information display |
| **Line Thickness** | Adjust flight path line width (1-5, default 3) |

All map display options are grouped in a collapsible settings panel. Click the settings gear to expand or collapse.

#### Color By Options

| Mode | Description |
|------|-------------|
| **Start to End** | Yellow to red gradient showing flight progress |
| **Height** | Color based on altitude (green = low, red = high) |
| **Speed** | Color based on velocity |
| **Dist. from Home** | Color based on distance from takeoff |
| **Video Segment** | Highlights when video was recording |

### Flight Path

The flight path is displayed as a 3D ribbon following the GPS track:

| Marker | Meaning |
|--------|---------|
| **Green Pin** | Takeoff location (start) |
| **Red Pin** | Landing location (end) |
| **Home Point** | Registered home position |

### Flight Replay

#### Playback Controls

| Control | Function |
|---------|----------|
| **Play/Pause** | Start or stop the replay animation |
| **Progress Slider** | Drag to scrub through the flight |
| **Speed Control** | Adjust playback speed (0.5x, 1x, 2x, 4x, 8x, 16x) |

#### During Replay

The 3D aircraft model follows the flight path at the correct altitude.

**Telemetry Overlay** shows real-time data:

- Height above ground
- Speed
- Battery level
- Distance from home
- Attitude (pitch/roll/yaw)

**RC Stick Overlay** visualizes controller inputs:

- Left stick: Throttle and Rudder
- Right stick: Elevator and Aileron

---

## Overview Dashboard

Switch to Overview mode using the toggle at the top of the sidebar.

### Statistics Summary

#### Primary Stats (Large Cards)

- Total Flights
- Total Distance
- Total Time
- Data Points
- Total Photos
- Total Videos

#### Secondary Stats (Smaller Cards)

- Max Altitude
- Max Distance from Home
- Average Distance per Flight
- Average Duration per Flight
- Average Speed

### Activity Heatmap

A calendar-style visualization showing flight activity:

- Darker colors indicate more flights on that day
- Hover to see exact count
- **Double-click** a day to filter the flight list to that date
- Adjust date range with the From/To pickers

### Breakdown Charts

Three donut charts showing flight distribution:

| Chart | Breakdown |
|-------|-----------|
| **Flights by Drone** | Which aircraft you fly most |
| **Flights by Battery** | Battery usage distribution |
| **Flights by Duration** | Short (<10min), Mid (10-20min), Long (>20min) |

### Flight Cluster Map

An interactive map showing all flight locations:

- Clusters group nearby flights
- Click a cluster to zoom in
- Click individual markers to select that flight
- Map respects current sidebar filters

### Top Flights

Lists your record-setting flights:

| Category | Selection |
|----------|-----------|
| **Top 3 Longest** | By duration |
| **Top 3 Furthest** | By maximum distance from home |

Click any entry to load that flight.

---

## Battery and Maintenance Tracking

### Battery Health

The Overview shows health indicators for each battery:

- Health percentage based on voltage characteristics
- Usage statistics (flight count, total time)
- Inline renaming: click to give batteries friendly names

### Battery Usage Timeline

View per-minute charge usage over time:

- Shows battery drain patterns
- Zoomable timeline
- Helps identify battery degradation

### Maintenance Tracking

Set up maintenance reminders for batteries and aircraft.

#### Setting Thresholds

1. In Overview, scroll to the Maintenance section
2. Click **Configure** for batteries or aircraft
3. Set thresholds for:
   - Flight count (e.g., "every 50 flights")
   - Flight time (e.g., "every 10 hours")

#### Progress Indicators

| Color | Status |
|-------|--------|
| **Green** | Good, plenty of headroom |
| **Yellow** | Approaching threshold |
| **Orange** | Near threshold |
| **Red** | Exceeded, maintenance recommended |

#### Recording Maintenance

1. Click **Perform Maintenance** when you have serviced equipment
2. Select a date (defaults to today)
3. Counters reset from that date

---

## Exporting Data

### Single Flight Export

With a flight selected, use the **Export** dropdown in the stats bar:

| Format | Description |
|--------|-------------|
| **CSV** | Spreadsheet-compatible with all telemetry data |
| **JSON** | Structured data including flight metadata |
| **GPX** | GPS track for mapping applications |
| **KML** | Google Earth compatible flight path |

### FlyCard Generator

Create shareable social media images from your flights:

1. **Right-click** on any flight in the list (must be in Flights view, not Overview)
2. Select **Generate FlyCard** from the context menu
3. The app will load the flight and capture the current map view
4. A preview modal shows the generated 1080x1080 image with:
   - Map background with your flight path
   - Semi-transparent dark overlay for readability
   - Flight stats (distance, max altitude, duration, max speed)
   - Aircraft name
   - App branding with logo
5. Click **Download** to save the image

> [!TIP]
> Position and zoom the map before generating for the best composition. The FlyCard captures exactly what you see on screen.

> [!NOTE]
> The Generate FlyCard option is disabled (grayed out) when in Overview mode. Switch to Flights view to enable it.

### Bulk Export

From the flight list, you can export all filtered flights:

1. Apply desired filters
2. Click the export button in the flight list header
3. Choose format
4. Files are packaged into a ZIP archive

### HTML Report

Generate a configurable, print-ready flight regulation report:

1. From the bulk export dropdown, select **HTML Report**
2. In the modal, set:
   - **Document Title** (default: "Flight Regulation Report")
   - **Pilot Name** (remembered for future sessions)
3. Select which field groups to include:
   - General Info, Equipment, Flight Stats, Battery, Weather, Media
4. Click **Generate Report** to save the HTML file

The generated report features:
- A4-width layout optimized for printing
- Flights grouped by day with subtotals and a grand total
- Weather data for each flight (if available)

> [!TIP]
> The HTML report is print-ready. Open it in any browser and press **Ctrl+P** (or Cmd+P on Mac) to print or save as PDF.

### Export Contents

#### CSV and JSON Exports Include:

- Timestamp data
- GPS coordinates (latitude, longitude, altitude)
- All telemetry values
- Flight metadata in the first row

#### GPX and KML Exports Include:

- GPS track with timestamps
- Altitude data
- Compatible with Google Earth and other mapping apps

#### Manual Entry Exports

Since manual entries have no telemetry data, exports are handled specially:

- **CSV**: Contains a single row with home coordinates and all available metadata
- **JSON**: Contains flight metadata (no telemetry arrays)
- **GPX**: Contains a waypoint at the takeoff location
- **KML**: Contains a point placemark at the takeoff location

---

## Settings

Access settings via the **gear icon** in the header.

### Preferences

#### Units

| Option | Units Used |
|--------|------------|
| **Metric** | meters, km/h, Celsius |
| **Imperial** | feet, mph, Fahrenheit |

#### Theme

| Option | Behavior |
|--------|----------|
| **System** | Follows your OS preference |
| **Dark** | Dark interface (default) |
| **Light** | Light interface |

#### Hide Serial Numbers

Toggle to mask aircraft and battery serial numbers in the interface. Useful for screenshots and screen sharing.

### Smart Tags

| Action | Description |
|--------|-------------|
| **Toggle** | Enable or disable automatic tagging on import |
| **Regenerate** | Re-apply smart tags to all existing flights |
| **Remove Auto Tags** | Clear all auto-generated tags (keeps manual tags) |

### DJI API Key

Required for decrypting V13+ DJI flight logs.

- The app ships with a default key
- You can add your own personal key for better rate limits
- See the README for instructions on obtaining a key

#### Status Indicators

| Status | Meaning |
|--------|---------|
| **None** | No valid key configured |
| **Default** | Using the bundled default key |
| **Personal** | Using your own API key |

### Data Management

| Action | Description |
|--------|-------------|
| **Backup Database** | Export entire database to a `.backup` file (includes all flights, telemetry, tags, and settings) |
| **Import Backup** | Restore from a previously exported backup file (replaces current database) |
| **Delete All Logs** | Remove all flight data (requires confirmation) |
| **Remove Duplicate Flights** | Scan and remove any duplicate entries |
| **Clear Sync Blacklist** | (Docker only) Reset the list of files excluded from auto-sync |

> [!IMPORTANT]
> Backup files are portable and can be restored on any instance, whether desktop or Docker.

### App Information

- Current version number
- Update availability check
- Data storage location
- Log file location

### Donation and Support

Options to support the project and activate a supporter badge.

---

## Keyboard Shortcuts

### Global Shortcuts

| Shortcut | Action |
|----------|--------|
| **Up / Down Arrow** | Navigate through flight list |
| **Enter** | Select highlighted flight |
| **Ctrl + Click** | Jump to flight details (works in both Overview and Flights mode) |
| **Escape** | Close modals, cancel editing |

### Dropdown Navigation

When a dropdown is open:

| Shortcut | Action |
|----------|--------|
| **Up / Down Arrow** | Navigate options |
| **Enter** | Select highlighted option |
| **Type** | Filter the list |

---

## Tips and Tricks

### Performance with Large Datasets

- The app uses DuckDB for fast queries even with thousands of flights
- Telemetry data is automatically downsampled for smooth charting
- If charts feel slow, try zooming into a smaller time range

### Organizing Flights

- Rename flights with meaningful names for easy searching
- Use manual tags for custom categorization (e.g., "Client Work", "Practice", "Scenic")
- Filter by tags to quickly find related flights

### Understanding Telemetry

| Observation | Explanation |
|-------------|-------------|
| **VPS differs from GPS altitude** | VPS uses visual sensors and measures height above ground |
| **RC signal drops** | Often indicate obstacles or range limits |
| **Faster voltage drop** | Battery voltage drops faster in cold weather |

### Map Tips

- Use satellite view for better spatial context
- 3D terrain helps visualize elevation changes
- Color-by-height reveals altitude patterns at a glance

### Backup Strategy

- Export backups regularly, especially before updates
- Store backups in a separate location
- Backup files are compressed and portable

### Docker Users

- Mount your log folder for automatic import
- Set the `SYNC_LOGS_PATH` environment variable to enable folder sync
- Set the `SYNC_INTERVAL` environment variable with a cron expression for scheduled automatic sync (e.g., `0 0 */8 * * *` for every 8 hours)
- Data persists in the Docker volume and survives container updates

### Privacy

- All data stays on your device
- Decryption keys are cached locally after first use
- No telemetry or tracking
- Use "Hide Serial Numbers" for screenshots

### Single Instance (Desktop)

- The desktop app ensures only one instance runs at a time
- Opening a second instance will focus the existing window instead of launching a new one
- This prevents database conflicts and accidental duplicate windows

---

## Troubleshooting

### Flight Will Not Import

| Check | Solution |
|-------|----------|
| **File format** | Ensure the file is a valid DJI `.txt` or Litchi `.csv` |
| **Internet connection** | Required for DJI log decryption on first import |
| **Isolate the issue** | Try importing a single file |

### Map Not Loading

| Check | Solution |
|-------|----------|
| **Internet connection** | Map tiles load from online sources |
| **Toggle views** | Try switching between satellite and street view |
| **Restart** | Refresh the page or restart the app |

### Charts Look Empty

| Check | Solution |
|-------|----------|
| **Telemetry data** | Verify the flight has telemetry data |
| **Flight duration** | Very short flights may have limited data |
| **Zoom level** | Try resetting zoom level |

### macOS "Damaged File" Error

> [!WARNING]
> This is a Gatekeeper warning for unsigned apps, not an actual corrupted file.

Run this command in Terminal:

```bash
xattr -d com.apple.quarantine /path/to/Drone\ Logbook.app
```

---

**For more information, visit the [GitHub repository](https://github.com/arpanghosh8453/open-dronelog) or check the README for technical details.**

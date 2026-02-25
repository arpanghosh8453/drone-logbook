<p align="center">
    <img src="src-tauri/icons/icon.png" alt="Open DroneLog" width="96" />
</p>

<H1 align="center"> OPEN DRONELOG </H1>

<p align="center">
    <a href="https://github.com/arpanghosh8453/open-dronelog/releases">
        <img src="https://img.shields.io/badge/Download-Latest%20Release-1a7f37?style=for-the-badge&logo=github" alt="Download Latest Release" height="48"/>
    </a>
    &nbsp;&nbsp;
    <a href="https://opendronelog.com">
        <img src="https://img.shields.io/badge/opendronelog.com-blue?style=for-the-badge&logo=globe" alt="Visit Website" height="48"/>
    </a>
    &nbsp;&nbsp;
    <a href="https://app.opendronelog.com">
        <img src="https://img.shields.io/badge/Launch-Webapp-red?style=for-the-badge&logo=globe" alt="Launch Webapp" height="48"/>
    </a>
</p>


<p align="center">A high-performance application for analyzing drone flight logs (DJI and Litchi CSV formats). Available as a Tauri v2 desktop app or a Docker-deployable web app. Built with DuckDB and React.</p>

> [!IMPORTANT]
> *DJI is a registered trademark of SZ DJI Technology Co., Ltd. DroneLogbook® is a registered trademark of DroneAnalytics Inc. This project is independent and is not affiliated with, sponsored by, authorized by, or endorsed by SZ DJI Technology Co. Ltd. or DroneAnalytics Inc. or its affiliates.*

<p align="center">
    <img src="screenshots/Comparison.png" alt="Comparison chart" width="900" />
</p>
<p align="center">
    <img src="screenshots/interface_dark.png" alt="Interface (dark)" width="900" />
</p>
<p align="center">
    <img src="screenshots/interface_light.png" alt="Interface (light)" width="900" />
</p>
<p align="center">
    <img src="screenshots/individual_stats.png" alt="Individual stats" width="900" />
</p>
<p align="center">
    <img src="screenshots/individual_stats_light.png" alt="Individual stats (light)" width="900" />
</p>
<p align="center">
    <img src="screenshots/weather_preview.png" alt="Weather preview" width="900" />
</p>
<p align="center">
    <img src="screenshots/telemetry_1.png" alt="Telemetry charts" width="900" />
</p>
<p align="center">
    <img src="screenshots/telemetry_2.png" alt="Telemetry charts 2" width="900" />
</p>
<p align="center">
    <img src="screenshots/overall_stats_dark.png" alt="Overall stats (dark)" width="900" />
</p>
<p align="center">
    <img src="screenshots/overall_stats.png" alt="Overall stats" width="900" />
</p>
<p align="center">
    <img src="screenshots/map_dark.png" alt="Flight map replay (dark)" width="900" />
</p>
<p align="center">
    <img src="screenshots/map_light.png" alt="Flight map replay (light)" width="900" />
</p>
<p align="center">
    <img src="screenshots/flight_map.png" alt="Flight map" width="900" />
</p>
<p align="center">
    <img src="screenshots/flight_map_2.png" alt="Flight map 2" width="900" />
</p>

## Contents

- [Features](#features)
- [Accessing flight log files](#accessing-flight-log-files)
  - [DJI Flight Logs](#dji-flight-logs)
  - [Litchi CSV Exports](#litchi-csv-exports)
- [Setup and installation (Windows/MacOS)](#setup-and-installation-windowsmacos)
  - [Try the Webapp First](#try-the-webapp-first-no-installation-required)
  - [macOS Users: "Damaged File" Error Fix](#macos-users-damaged-file-error-fix)
- [Usage](#usage)
- [Building from source (Linux users)](#building-from-source-linux-users)
- [Docker deployment (Self-hosted Web)](#docker-deployment-self-hosted-web)
- [Configuration](#configuration)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [How to obtain your own DJI Developer API key](#how-to-obtain-your-own-dji-developer-api-key)
- [Contribution Guidelines](#contribution-guidelines)
- [Love this project?](#love-this-project)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## Features

- **High-Performance Analytics**: DuckDB-powered queries with automatic downsampling for large datasets. Free, open source, no subscription required.
- **Multi-Format Support**: Import DJI logs (.txt) and Litchi CSV exports with automatic unit detection. Third-party apps (Dronelink, DroneDeploy) supported.
- **Smart Deduplication**: Prevents duplicate imports based on drone serial, battery serial, and start time.
- **Interactive Flight Maps**: 3D terrain, satellite toggle, flight replay with speed control (0.5x-16x), live telemetry overlay, and RC stick input visualization.
- **Telemetry Charts**: Height, speed, battery, attitude, RC signal, GPS, distance-to-home, and velocity with synchronized drag-to-zoom.
- **Local-First Storage**: All data in a local DuckDB database. No cloud upload required (except DJI key fetch during first import).
- **Smart Tags**: Auto-tagging (Night Flight, High Speed, Low Battery, etc.) and offline reverse geocoding for location tags. Manual tags and bulk operations supported.
- **Filters & Search**: Date range, drone/battery filters, duration/altitude/distance sliders, tag filter, map area filter, and filter inversion.
- **Overview Dashboard**: Aggregate stats, activity heatmap, pie charts by drone/battery/duration, cluster map, and top-flight highlights.
- **Battery Health**: Per-battery health bars, serial renaming, and per-minute usage history with zoom.
- **Maintenance Tracking**: Configurable thresholds with color-coded progress bars and date-based maintenance recording.
- **Exports**: CSV, JSON, GPX, and KML export. FlyCard generator for shareable 1080x1080 social media images.
- **Manual Flight Entry**: Record flights without log files with optional coordinates and metadata.
- **Backup & Restore**: Export/import full database across desktop and Docker instances.

## Accessing flight log files

### DJI Flight Logs

You first need to collect the DJI flight log files that you can import to this application. This project supports modern DJI log files in the `.txt` format. For DJI fly apps on Android or RC remotes, they are usually in `Internal Storage > Android > data > dji.go.v5 > files > FlightRecord`. For iOS, Connect your iPhone/iPad to a computer, open iTunes/Finder, select the device, go to the "File Sharing" tab, select the DJI app, and copy the "Logs" folder. If you are already using other online sync applications, you can download the original logs files directly from there too. 

You can find more details resources from this simple [google search](https://www.google.com/search?q=where+can+i+find+the+DJI+log+files&oq=where+can+i+find+the+DJI+log+files)

### Litchi CSV Exports

Litchi flight logs can be exported as CSV files from the Litchi app. The parser automatically detects whether the export uses metric or imperial units based on the column headers (e.g., `altitude(feet)` vs `altitude(m)`) and converts everything to metric internally. Litchi-imported flights are automatically tagged with "Litchi" for easy filtering.

## Setup and installation (Windows/MacOS)

There is no installation step if you want to use the standalone binary builds, just visit the latest [release page](https://github.com/arpanghosh8453/open-dronelog/releases), and download the appropriate binary for Windows or MacOS and run them.

> [!WARNING]
> For macOS, there are [additional steps](#macos-users-damaged-file-error-fix) required before you can use the application.

> [!IMPORTANT]
> When you are copying from RC or mobile device, you can NOT directly drag and drop the files to the interface. This is because these external devices are mounted differently and only accessible to the file manager. Please copy the files to a local folder or the device sync folder before trying to upload or sync. 

> [!TIP]
> Explore the [full manual](/docs/manual.md) if you want to have a comprehensive overview of all the available options and features inside the app. 

### Try the Webapp First (No Installation Required)

Want to quickly test the tool before committing to a full installation? Try the hosted webapp. Please only use it for evaluation and temporary visit. 

<a href="https://app.opendronelog.com">
    <img src="https://img.shields.io/badge/Launch-Webapp-red?style=for-the-badge&logo=globe" alt="Launch Webapp" height="48"/>
</a>
<br><br>

- **Zero setup** – just open the link in your browser
- **Perfect for evaluation** – see if the tool fits your needs before installing
- **Single flight visualization** – upload and analyze one flight log at a time
- **All core features** – view telemetry charts, 3D flight path replay, and flight statistics
- **No data persistence** – your data is processed locally in the browser and not stored on any server

> **Note:** For the full experience with multi-flight management, database persistence, filtering, overview analytics, and backup/restore capabilities, use the desktop app or self-hosted Docker deployment. 

### macOS Users: "Damaged File" Error Fix

<img width="320" height="311" alt="image" src="https://github.com/user-attachments/assets/2787ffff-9961-433c-898a-b548c738f1a2" />

> [!IMPORTANT]
> If you see **"Drone Logbook is damaged and can't be opened"** on macOS, this is a Gatekeeper security warning for unsigned apps, **not a corrupted file**. Apple charges $99/year for developer signing, so we provide these free workarounds instead.

#### Method 1: Right-Click to Open

This is the simplest method and works for most users:

1. **Locate the app** in your Applications folder (or wherever you placed it after downloading)
2. **Right-click** (or Control+click) on "Drone Logbook.app"
3. **Select "Open"** from the context menu
4. **Click "Open"** in the dialog that appears

#### Method 2: Terminal Command

Open **Terminal** (search for "Terminal" in Spotlight) and run:

Simply type `xattr -cr ` (with a space at the end), then **drag and drop** the app onto the Terminal window - it will auto-fill the file path:

```bash
xattr -cr <delete-this-part-after-cr-and-drag-and-drop-the-app-here>
```

Then press Enter and try opening the app again.

## Usage

1. **Import a Flight Log**: Click "Browse Files" or drag-and-drop a drone log file
2. **Select a Flight**: Click on a flight in the sidebar
3. **Analyze Data**: View telemetry charts and the 3D flight path on the map
4. **Filter/Search/Sort**: Use date range, drone/device, battery serial filters, search, and sorting
5. **Overview Analytics**: Sidebar filters (date, drone, battery, duration) automatically apply to overview statistics
5. **Export**: Use the Export dropdown in the stats bar (CSV/JSON/GPX/KML)
6. **Backup & Restore**: Use Settings → Backup Database to export, or Import Backup to restore
7. **Configure Settings**: Set API key, theme, units, and view app data/log directories


## Building from source (Linux users)

### Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+)
- [pnpm](https://pnpm.io/) or npm


```bash
# Clone the repository
git clone https://github.com/arpanghosh8453/open-dronelog
cd open-dronelog

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri
```

## Docker deployment (Self-hosted Web)

The app can also be deployed as a self-hosted web application using Docker. This uses an Axum REST backend instead of Tauri IPC, with Nginx serving the frontend and proxying API requests.

> [!IMPORTANT]
> This Web interface is primarily designed for Desktop or larger screen viewing. Basic mobile responsiveness is available but the full experience is best on larger screens.

### Quick start (recommended)

Pull the pre-built image from GitHub Container Registry:

```bash
docker pull ghcr.io/arpanghosh8453/open-dronelog:latest

docker run -d \
  -p 8080:80 \
  -v drone-data:/data/drone-logbook \
  --name open-dronelog \
  ghcr.io/arpanghosh8453/open-dronelog:latest
```

Or use docker-compose (uses the same pre-built image):

```bash
git clone https://github.com/arpanghosh8453/open-dronelog
cd open-dronelog
docker compose up -d
```

Then open http://localhost:8080 in your browser.

### Building locally from source

If you want to build the Docker image from source instead of pulling the pre-built one:

```bash
git clone https://github.com/arpanghosh8453/open-dronelog
cd open-dronelog
docker compose -f docker-compose-build.yml up -d
```

> **Note:** The initial build takes ~10–15 minutes (Rust compilation). Subsequent rebuilds are much faster thanks to Docker layer caching.

### Data persistence

All flight data (DuckDB database, cached decryption keys, and optionally uploaded log files) is stored in a Docker named volume (`drone-data`) mapped to `/data/drone-logbook` internally inside the container. Data persists across container restarts, image updates, and rebuilds. It is only removed if you explicitly delete the volume with `docker compose down -v`.

When `KEEP_UPLOADED_FILES=true` is set, original log files are preserved in an `uploaded` subfolder using their SHA256 hash as filename for deduplication.

### Environment variables

| Variable        | Default                | Description                                                                 |
|-----------------|------------------------|-----------------------------------------------------------------------------|
| `DATA_DIR`      | `/data/drone-logbook`  | Database and config storage                                                 |
| `RUST_LOG`      | `info`                 | Log level (debug, info, warn)                                               |
| `SYNC_LOGS_PATH`| (not set)              | Path to internal folder for automatic log import (e.g., `/sync-logs`)        |
| `SYNC_INTERVAL` | (not set)              | Cron expression for scheduled sync (e.g., `0 0 */8 * * *` for every 8 hours)|
| `KEEP_UPLOADED_FILES` | `true`      | When `true`, keeps copies of uploaded log files in the `uploaded` folder    |

### Automatic log sync (Docker)

You can mount a folder containing your drone flight logs and have the app automatically import new files:

1. Uncomment the volume mount in `docker-compose.yml` and set the path to your logs folder:
   ```yaml
   - /path/to/your/drone/logs:/sync-logs:ro
   ```
2. Uncomment the `SYNC_LOGS_PATH` environment variable:
   ```yaml
   - SYNC_LOGS_PATH=/sync-logs
   ```
3. (Optional) Enable scheduled automatic sync by setting a cron expression:
   ```yaml
   - SYNC_INTERVAL=0 0 */8 * * *
   ```
4. Restart the container.

**Sync behavior:**
- Without `SYNC_INTERVAL`: Manual sync only - use the "Sync" button in the web interface to import new files
- With `SYNC_INTERVAL`: The server automatically syncs at the scheduled times, plus manual sync via the button

**Common cron expressions:**
| Expression | Schedule |
|------------|----------|
| `0 0 */8 * * *` | Every 8 hours |
| `0 0 0 * * *` | Daily at midnight |
| `0 0 */2 * * *` | Every 2 hours |
| `0 30 6 * * *` | Daily at 6:30 AM |
| `0 0 0 * * 0` | Weekly on Sunday at midnight |

The sync status and a manual "Sync" button will appear in the Import section when configured. During sync, the app shows file-by-file progress (current filename, X of Y counter) matching the desktop app experience.

### Keep uploaded files (Docker)

To retain copies of uploaded log files in Docker, enable the `KEEP_UPLOADED_FILES` environment variable (`true` by default):

Uploaded files are stored in `/data/drone-logbook/uploaded` inside the container (part of the `drone-data` volume). You can adjust the external mount volume to have direct access.

> [!TIP]
> You can set the external host path same for both `/sync-logs` and `/data/drone-logbook/uploaded` to unify the log file collection. Make sure to remove the `:ro` part from the `/sync-logs` mount. I do it myself for convinience, but we recommend our users to keep them separate to make sure you accidentally don't lose any log files from the sync folder due to overwrite or any issue with the application. 


## Configuration

- **DJI API Key**: Stored locally in `config.json`. You can also provide it via `.env` or via the `settings` menu inside the application. The standalone app ships with a default key, but users should enter their own to avoid rate limits for log file decryption key fetching.
- **Sync folder**: Set and use the `sync folder` (application interface for Desktop and ENV variable for docker) for seamless log file import and re-import with de-duplication. The files uploaded through drag and drop or browse are also collected by default in the `Uploaded` folder of application storage (customizable via settings options for Desktop and ENV variable for docker). You can use a common folder (essentially unifying the raw log files storage location), but that is not generally recommended to prevent any mishaps or file overwrites.  
- **Database Location**: Stored in the platform-specific app data directory (e.g., AppData on Windows, Application Support on macOS, and local share on Linux). In Docker mode, data is stored in `/data/drone-logbook` (persisted via a Docker volume).
- **Log Files**: App logs are written to the platform-specific log directory and surfaced in Settings. In Docker mode, logs are written to stdout.

## Tech Stack

### Backend (Rust)
- **Tauri v2**: Desktop application framework (feature-gated behind `tauri-app`)
- **Axum 0.7**: Web REST API server for Docker/web deployment (feature-gated behind `web`)
- **DuckDB**: Embedded analytical database (bundled, no installation required)
- **dji-log-parser**: DJI flight log parsing library
- **reverse_geocoder**: Offline city/country/continent geocoding (bundled GeoNames dataset)

### Frontend (React)
- **React 18 + TypeScript**: UI framework
- **Vite**: Build tool
- **Tailwind CSS**: Styling
- **Zustand**: State management
- **ECharts**: Telemetry charting
- **react-map-gl + MapLibre**: Map visualization
- **deck.gl**: 3D flight path overlay

## Project Structure

```
├── src-tauri/               # RUST BACKEND
│   ├── src/
│   │   ├── main.rs          # Entry point (feature-gated: Tauri or Axum)
│   │   ├── server.rs        # Axum REST API (web feature only)
│   │   ├── database.rs      # DuckDB connection & schema
│   │   ├── parser.rs        # dji-log-parser wrapper
│   │   ├── models.rs        # Data structures
│   │   └── api.rs           # DJI API key fetching (if present)
│   ├── Cargo.toml           # Rust dependencies + feature flags
│   └── tauri.conf.json      # App configuration
│
├── src/                     # REACT FRONTEND
│   ├── components/
│   │   ├── dashboard/       # Layout components
│   │   ├── charts/          # ECharts components
│   │   ├── map/             # MapLibre components
│   │   └── ui/              # Reusable UI components (Select)
│   ├── stores/              # Zustand state
│   ├── types/               # TypeScript interfaces
│   └── lib/
│       ├── utils.ts         # Utilities
│       └── api.ts           # Backend adapter (invoke/fetch)
│
├── docker/                  # DOCKER CONFIG
│   ├── nginx.conf           # Nginx reverse proxy config
│   └── entrypoint.sh        # Container startup script
│
├── Dockerfile               # Multi-stage build
├── docker-compose.yml       # Deploy with pre-built GHCR image
├── docker-compose-build.yml # Build from source locally
│
└── [App Data Directory]     # RUNTIME DATA
    ├── flights.db           # DuckDB database (flights, telemetry, flight_tags, keychains)
    ├── config.json          # API key and smart tags settings
    └── keychains/           # Cached decryption keys
```

## How to obtain your own DJI Developer API key

I have shipped this project with my own API key to save you from some extra painful steps. If you are tech savvy please read the following guide to generate and use your own API key for this project. To acquire an apiKey, follow these steps:

1. Visit [DJI Developer Technologies](https://developer.dji.com/user) and log in. Create an account if you don't have one, this is different registration than your existing DJI account, but you can login with your existing account as well. 
2. Fill out personal info (for those who value privacy, I’m not sure if it needs to be real info)
3. Click `CREATE APP`, choose `Open API` as the App Type, and provide the necessary details like `App Name`, `Category`, and `Description`.
4. After creating the app, activate it through the link sent to your email.
6. On your developer user page, find your app's details to retrieve the 31 character long alphanumeric ApiKey (labeled as the SDK key or APP key). Do not use the APP ID number, that is not your API key. 


## Contribution Guidelines

We welcome meaningful contributions to Open DroneLog! Before implementing a new feature, please open an issue first to discuss your idea with the maintainer—this ensures alignment with the project's scope and avoids wasted effort.

For more details, see [CONTRIBUTING.md](CONTRIBUTING.md).

### User Scripts

Looking to extend functionality without waiting for official features? Check out the **[Discussions](https://github.com/arpanghosh8453/open-dronelog/discussions)** channel with the `User-Script` tag, where community members share custom scripts, collaborate with developers, and find useful enhancements for custom workflow.


## Love this project?

I'm thrilled that you're using this dashboard. Your interest and engagement mean a lot to me! You can view and analyze more detailed DJI flight statistics with this setup than paying for any commertial solution.

Maintaining and improving this project takes a significant amount of my free time. Your support helps keep me motivated to add new features and work on similar projects that benefit the community.

If you find this project helpful, please consider:

⭐ Starring this repository to show your support and spread the news!

☕ Buying me a coffee if you'd like to contribute to its maintenance and future development.

<img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="ko-fi">

## License

AGPL-3.0 - see [LICENSE](LICENSE) for details.

## Declaration

While some parts of this codebase were written with AI assistance (Claude Opus) for convinience, the entirety of OpenDroneLog is thoughtfully architected, manually tested before every release, and managed by the me in my free time. Long-term maintenance remain my priority with this project as it grows. The `context.json` file provides a machine parsable high quality summary of the project overview, which is updated alongside the project for future references.  

## Acknowledgments

- [dji-log-parser](https://github.com/lvauvillier/dji-log-parser) - DJI log parsing
- [DuckDB](https://duckdb.org/) - Analytical database
- [Tauri](https://tauri.app/) - Desktop app framework

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=arpanghosh8453/open-dronelog&type=date&legend=top-left)](https://www.star-history.com/#arpanghosh8453/open-dronelog&type=date&legend=top-left)

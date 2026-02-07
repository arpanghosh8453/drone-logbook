<p align="center">
    <img src="src-tauri/icons/icon.png" alt="DJI Log Viewer" width="96" />
</p>

<h1 align="center">DJI Flight Log Viewer</h1>

<p align="center">A high-performance desktop application for analyzing DJI drone flight logs. Built with Tauri v2, DuckDB, and React.</p>


<p align="center">
    <img src="screenshots/overview_panel.png" alt="Overview dashboard" width="900" />
</p>
<p align="center">
    <img src="screenshots/Flights_panel_1.png" alt="Flights panel" width="900" />
</p>
<p align="center">
    <img src="screenshots/Settings_panel.png" alt="Settings panel" width="900" />
</p>
<p align="center">
    <img src="screenshots/overview_panel_light.png" alt="Overview dashboard (light)" width="900" />
</p>
<p align="center">
    <img src="screenshots/Flights_panel_light_1.png" alt="Flights panel (light)" width="900" />
</p>

## Features

- **High-Performance Analytics**: DuckDB-powered analytical queries with automatic downsampling for large datasets - import all your flight logs in one place. Free and open source, zero maintanance cost, no monthly subscription for unlimited number of flight log analysis.
- **Universally available**: The application can be built locally from source, but for ease of use, standalone binaries are provided for Windows and MacOS - ready to deploy. 
- **Interactive Flight Maps**: MapLibre GL with 3D terrain, satellite toggle, start/end markers, and a deck.gl 3D path overlay - visualize your flight map in 3D interatively. 
- **Telemetry Charts**: Height/VPS, speed, battery, attitude, RC signal, GPS satellites, RC uplink/downlink, distance-to-home, and velocity X/Y/Z for each of your drone sessions
- **V13+ Log Support**: Automatic encryption key handling for newer DJI logs
- **Local-First**: All data stored locally in a single DuckDB database - No sketchy server upload. No need to even upload in DJI's servers, you can copy the log files locally and process them locally (for log decryption, the key will be sent to DJI's server during import, so you need to be online during the first import of a new log file)
- **Filters, Search & Sort**: Date range picker, drone/device filter, battery serial filter, search, and sorting
- **Overview Dashboard**: Aggregate totals, averages, heatmap activity, pie-chart activity breakdowns, and top-flight highlights
- **Battery Health Insights**: Per-battery health bars and per‑minute charge usage history timeline
- **Theme & Units**: Light/Dark/System theme and Metric/Imperial units
- **Exports**: Direct CSV, JSON, GPX, and KML export from the flight stats bar

## Accessing the log fileshttps://github.com/arpanghosh8453/dji-logbook/

You first need to collect the log files that you can import to this application. This project currently only support modern DJI log files in the `.txt` format. For DJI fly apps on Android or RC remotes, they are usually in `Internal Storage > Android > data > dji.go.v5 > files > FlightRecord`. For iOS, Connect your iPhone/iPad to a computer, open iTunes/Finder, select the device, go to the "File Sharing" tab, select the DJI app, and copy the "Logs" folder. If you are already using Airdata sync, yoiu can download the original logs files directly from there too. 

You can find more details resources from this simple [google search](https://www.google.com/search?q=where+can+i+find+the+DJI+log+files&oq=where+can+i+find+the+DJI+log+files)

## Setup and installation (Windows/MacOS)

There is no installation step if you want to use the standalone binary builds, just visit the latest [release page](https://github.com/arpanghosh8453/dji-logbook/releases), and download the appropriate binary for Windows or MacOS and run them. 

## Usage

1. **Import a Flight Log**: Click "Browse Files" or drag-and-drop a DJI log file
2. **Select a Flight**: Click on a flight in the sidebar
3. **Analyze Data**: View telemetry charts and the 3D flight path on the map
4. **Filter/Search/Sort**: Use date range, drone/device, battery serial filters, search, and sorting
5. **Overview Filters**: Apply the same date/drone/battery filters to overview analytics (no search)
5. **Export**: Use the Export dropdown in the stats bar (CSV/JSON/GPX/KML)
6. **Configure Settings**: Set API key, theme, units, and view app data/log directories


## Building from source (Linux users)

### Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+)
- [pnpm](https://pnpm.io/) or npm


```bash
# Clone the repository
git clone https://github.com/yourusername/dji-logviewer.git
cd dji-logviewer

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri
```

## Configuration

- **DJI API Key**: Stored locally in `config.json`. You can also provide it via `.env` or via the `settings` menu inside the application. The standalone app ships with a default key, but users should enter their own to avoid rate limits for log file decryption key fetching.
- **Database Location**: Stored in the platform-specific app data directory (e.g., AppData on Windows, Application Support on macOS, and local share on Linux).
- **Log Files**: App logs are written to the platform-specific log directory and surfaced in Settings.

## Tech Stack

### Backend (Rust)
- **Tauri v2**: Desktop application framework
- **DuckDB**: Embedded analytical database (bundled, no installation required)
- **dji-log-parser**: DJI flight log parsing library

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
│   │   ├── main.rs          # Entry point (Tauri commands)
│   │   ├── database.rs      # DuckDB connection & schema
│   │   ├── parser.rs        # dji-log-parser wrapper
│   │   ├── models.rs        # Data structures
│   │   └── api.rs           # DJI API key fetching (if present)
│   ├── Cargo.toml           # Rust dependencies
│   └── tauri.conf.json      # App configuration
│
├── src/                     # REACT FRONTEND
│   ├── components/
│   │   ├── dashboard/       # Layout components
│   │   ├── charts/          # ECharts components
│   │   └── map/             # MapLibre components
│   ├── stores/              # Zustand state
│   ├── types/               # TypeScript interfaces
│   └── lib/                 # Utilities
│
└── [App Data Directory]     # RUNTIME DATA
    ├── flights.db           # DuckDB database
    ├── raw_logs/            # Original log files
    └── keychains/           # Cached decryption keys
```

## Love this project?

I'm thrilled that you're using this dashboard. Your interest and engagement mean a lot to me! You can view and analyze more detailed DJI flight statistics with this setup than paying for any commertial solution.

Maintaining and improving this project takes a significant amount of my free time. Your support helps keep me motivated to add new features and work on similar projects that benefit the community.

If you find this project helpful, please consider:

⭐ Starring this repository to show your support and spread the news!

☕ Buying me a coffee if you'd like to contribute to its maintenance and future development.

<img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="ko-fi">

## License

BSD 3-clause - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [dji-log-parser](https://github.com/lvauvillier/dji-log-parser) - DJI log parsing
- [DuckDB](https://duckdb.org/) - Analytical database
- [Tauri](https://tauri.app/) - Desktop app framework




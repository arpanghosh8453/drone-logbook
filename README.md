<p align="center">
    <img src="src-tauri/icons/icon.png" alt="DJI Log Viewer" width="96" />
</p>

# DJI Flight Log Viewer

A high-performance desktop application for analyzing DJI drone flight logs. Built with Tauri v2, DuckDB, and React.

## Features

- 📊 **High-Performance Analytics**: DuckDB-powered analytical queries with automatic downsampling for large datasets
- 🗺️ **Interactive Flight Maps**: MapLibre GL with 3D terrain, satellite toggle, start/end markers, and a deck.gl 3D path overlay
- 📈 **Telemetry Charts**: Height/VPS, speed, battery, attitude, RC signal, GPS satellites, RC uplink/downlink, distance-to-home, and velocity X/Y/Z
- 🔐 **V13+ Log Support**: Automatic encryption key handling for newer DJI logs
- 💾 **Local-First**: All data stored locally in a single DuckDB database
- 🎛️ **Filters, Search & Sort**: Date range picker, drone/device filter, battery serial filter, search, and sorting
- 🧭 **Overview Dashboard**: Aggregate totals, averages, and battery usage insights
- 🎨 **Theme & Units**: Light/Dark/System theme and Metric/Imperial units
- ✏️ **Editable Flight Names**: Rename flights directly in the sidebar
- 🗑️ **Safe Deletion**: Confirmations for single-flight and delete-all actions
- 🔍 **Synced Zoom**: Pan/zoom charts together with reset zoom
- 📦 **Exports**: CSV, JSON, GPX, and KML export from the flight stats bar
- 🧾 **App Logging**: File + console logs via tauri-plugin-log; log directory shown in Settings
- 🚀 **Cross-Platform**: Works on Windows, macOS, and Linux

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

## Prerequisites

- [Rust](https://rustup.rs/) (1.70+)
- [Node.js](https://nodejs.org/) (18+)
- [pnpm](https://pnpm.io/) or npm

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/dji-logviewer.git
cd dji-logviewer

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri
```

Optional: run without file watching (useful on slow filesystems)

```bash
npm run tauri:nowatch
```

## Building for Production

```bash
# Build the application
npm run tauri build
```

The built application will be in `src-tauri/target/release/bundle/`.

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

## Database Schema

### flights table
- Flight metadata (drone model, duration, statistics)
- Optimized with indexes for date-based queries

### telemetry table
- Time-series telemetry data
- Composite primary key (flight_id, timestamp_ms) for efficient range queries
- Automatic downsampling for large flights (>5000 points)
- Column order enforcement with automatic rebuild if mismatched

## Usage

1. **Import a Flight Log**: Click "Browse Files" or drag-and-drop a DJI log file
2. **Select a Flight**: Click on a flight in the sidebar
3. **Analyze Data**: View telemetry charts and the 3D flight path on the map
4. **Filter/Search/Sort**: Use date range, drone/device, battery serial filters, search, and sorting
5. **Export**: Use the Export dropdown in the stats bar (CSV/JSON/GPX/KML)
6. **Configure Settings**: Set API key, theme, units, and view app data/log directories

## Supported Log Formats

- `.txt` - DJI Go app logs
- `.dat` - DJI binary logs
- `.log` - Various DJI log formats

## Performance Optimizations

- **Bulk Inserts**: Uses DuckDB's Appender for fast data ingestion
- **Automatic Downsampling**: Long flights are downsampled to ~5000 points for visualization
- **Canvas Rendering**: ECharts uses canvas with animations disabled for smooth scrolling
- **Lazy Loading**: Flight data is loaded on-demand when selected

## Configuration

- **DJI API Key**: Stored locally in `config.json` (never sent to third parties except DJI API). You can also provide it via `.env`. The standalone app ships with a default key, but users should enter their own to avoid rate limits.
- **Database Location**: Stored in the platform-specific app data directory (e.g., AppData on Windows, Application Support on macOS, and local share on Linux).
- **Log Files**: App logs are written to the platform-specific log directory and surfaced in Settings.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- [dji-log-parser](https://github.com/lvauvillier/dji-log-parser) - DJI log parsing
- [DuckDB](https://duckdb.org/) - Analytical database
- [Tauri](https://tauri.app/) - Desktop app framework

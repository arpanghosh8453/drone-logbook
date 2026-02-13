/**
 * Overview panel with comprehensive flight statistics
 * Features: activity heatmap, donut charts, battery health, top flights
 * Uses sidebar filters from the flight list for all calculations
 */

import { useMemo, useState, useRef, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import { DayPicker, type DateRange } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import type { BatteryHealthPoint, Flight, OverviewStats } from '@/types';
import {
  formatDistance,
  formatDuration,
  formatSpeed,
  formatAltitude,
  formatDateTime,
  type UnitSystem,
} from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';
import { FlightClusterMap } from './FlightClusterMap';

function resolveThemeMode(mode: 'system' | 'dark' | 'light'): 'dark' | 'light' {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return 'dark';
  }
  return mode;
}

interface OverviewProps {
  stats: OverviewStats;
  flights: Flight[];
  unitSystem: UnitSystem;
  onSelectFlight?: (flightId: number) => void;
}

export function Overview({ stats, flights, unitSystem, onSelectFlight }: OverviewProps) {
  const themeMode = useFlightStore((state) => state.themeMode);
  const getBatteryDisplayName = useFlightStore((state) => state.getBatteryDisplayName);
  const renameBattery = useFlightStore((state) => state.renameBattery);
  const getDroneDisplayName = useFlightStore((state) => state.getDroneDisplayName);
  const renameDrone = useFlightStore((state) => state.renameDrone);
  const droneNameMap = useFlightStore((state) => state.droneNameMap);
  const sidebarFilteredFlightIds = useFlightStore((state) => state.sidebarFilteredFlightIds);
  const getDisplaySerial = useFlightStore((state) => state.getDisplaySerial);
  const overviewHighlightedFlightId = useFlightStore((state) => state.overviewHighlightedFlightId);
  const resolvedTheme = useMemo(() => resolveThemeMode(themeMode), [themeMode]);

  // Use sidebar-filtered flights (fall back to all flights if no filter set yet)
  const filteredFlights = useMemo(() => {
    if (!sidebarFilteredFlightIds) return flights;
    return flights.filter((f) => sidebarFilteredFlightIds.has(f.id));
  }, [flights, sidebarFilteredFlightIds]);

  // Compute filtered stats
  const filteredStats = useMemo(() => {
    const totalFlights = filteredFlights.length;
    const totalDistanceM = filteredFlights.reduce((sum, f) => sum + (f.totalDistance ?? 0), 0);
    const totalDurationSecs = filteredFlights.reduce((sum, f) => sum + (f.durationSecs ?? 0), 0);
    const totalPoints = filteredFlights.reduce((sum, f) => sum + (f.pointCount ?? 0), 0);
    const maxAltitudeM = Math.max(0, ...filteredFlights.map((f) => f.maxAltitude ?? 0));

    // Battery usage
    const batteryMap = new Map<string, { count: number; duration: number }>();
    filteredFlights.forEach((f) => {
      if (f.batterySerial) {
        const existing = batteryMap.get(f.batterySerial) || { count: 0, duration: 0 };
        batteryMap.set(f.batterySerial, {
          count: existing.count + 1,
          duration: existing.duration + (f.durationSecs ?? 0),
        });
      }
    });
    const batteriesUsed = Array.from(batteryMap.entries())
      .map(([serial, data]) => ({
        batterySerial: serial,
        flightCount: data.count,
        totalDurationSecs: data.duration,
      }))
      .sort((a, b) => b.flightCount - a.flightCount);

    // Drone usage with disambiguation for same model names
    const droneMap = new Map<string, { model: string; serial: string | null; name: string | null; count: number; totalDurationSecs: number }>();
    filteredFlights.forEach((f) => {
      const key = `${f.droneModel ?? 'Unknown'}||${f.droneSerial ?? ''}`;
      const existing = droneMap.get(key);
      if (existing) {
        existing.count++;
        existing.totalDurationSecs += f.durationSecs ?? 0;
      } else {
        droneMap.set(key, {
          model: f.droneModel ?? 'Unknown',
          serial: f.droneSerial ?? null,
          name: f.aircraftName ?? null,
          count: 1,
          totalDurationSecs: f.durationSecs ?? 0,
        });
      }
    });

    // Check if any display names are duplicated (using renamed names)
    const modelCounts = new Map<string, number>();
    droneMap.forEach((d) => {
      const fallback = d.name || d.model;
      const displayName = d.serial ? getDroneDisplayName(d.serial, fallback) : fallback;
      modelCounts.set(displayName, (modelCounts.get(displayName) || 0) + 1);
    });

    const dronesUsed = Array.from(droneMap.entries())
      .map(([_, data]) => {
        const fallback = data.name || data.model;
        const displayName = data.serial ? getDroneDisplayName(data.serial, fallback) : fallback;
        const needsSerial = (modelCounts.get(displayName) || 0) > 1 && data.serial;
        return {
          droneModel: data.model,
          droneSerial: data.serial,
          aircraftName: data.name,
          flightCount: data.count,
          totalDurationSecs: data.totalDurationSecs,
          displayLabel: needsSerial ? `${displayName} (${getDisplaySerial(data.serial!)})` : displayName,
        };
      })
      .sort((a, b) => b.totalDurationSecs - a.totalDurationSecs);

    // Flights by date (from filtered)
    const dateMap = new Map<string, number>();
    const pad = (value: number) => String(value).padStart(2, '0');
    const toDateKey = (value: string) => {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value.split('T')[0];
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    filteredFlights.forEach((f) => {
      if (f.startTime) {
        const date = toDateKey(f.startTime);
        dateMap.set(date, (dateMap.get(date) || 0) + 1);
      }
    });
    const flightsByDate = Array.from(dateMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const filteredIdSet = new Set(filteredFlights.map((f) => f.id));

    // Top 3 longest flights
    const topFlights = [...filteredFlights]
      .filter((f) => f.durationSecs !== null)
      .sort((a, b) => (b.durationSecs ?? 0) - (a.durationSecs ?? 0))
      .slice(0, 3)
      .map((f) => ({
        id: f.id,
        displayName: f.displayName || f.fileName,
        durationSecs: f.durationSecs ?? 0,
        startTime: f.startTime,
      }));


    // For max distance from home, compute from per-flight data (works with filters)
    const maxDistanceFromHomeM = stats.topDistanceFlights
      ? stats.topDistanceFlights
          .filter((df) => filteredIdSet.has(df.id))
          .reduce((max, df) => Math.max(max, df.maxDistanceFromHomeM), 0)
      : stats.maxDistanceFromHomeM;

    return {
      totalFlights,
      totalDistanceM,
      totalDurationSecs,
      totalPoints,
      maxAltitudeM,
      maxDistanceFromHomeM,
      batteriesUsed,
      dronesUsed,
      flightsByDate,
      topFlights,
    };
  }, [filteredFlights, stats.maxDistanceFromHomeM, stats.topDistanceFlights, getDroneDisplayName, droneNameMap]);

  const filteredHealthPoints = useMemo(() => {
    if (!stats.batteryHealthPoints.length) return [] as BatteryHealthPoint[];
    const idSet = new Set(filteredFlights.map((flight) => flight.id));
    return stats.batteryHealthPoints.filter((point) => idSet.has(point.flightId));
  }, [filteredFlights, stats.batteryHealthPoints]);

  const filteredTopDistanceFlights = useMemo(() => {
    if (!stats.topDistanceFlights?.length) return [] as typeof stats.topDistanceFlights;
    const idSet = new Set(filteredFlights.map((flight) => flight.id));
    return stats.topDistanceFlights
      .filter((flight) => idSet.has(flight.id))
      .sort((a, b) => b.maxDistanceFromHomeM - a.maxDistanceFromHomeM)
      .slice(0, 3);
  }, [filteredFlights, stats.topDistanceFlights]);

  const avgDistancePerFlight =
    filteredStats.totalFlights > 0
      ? filteredStats.totalDistanceM / filteredStats.totalFlights
      : 0;
  const avgDurationPerFlight =
    filteredStats.totalFlights > 0
      ? filteredStats.totalDurationSecs / filteredStats.totalFlights
      : 0;
  const avgSpeed =
    filteredStats.totalDurationSecs > 0
      ? filteredStats.totalDistanceM / filteredStats.totalDurationSecs
      : 0;

  return (
    <div className="min-w-[1100px] px-4 pt-4 pb-24 space-y-5">
        {/* Primary Stats */}
        <div className="grid grid-cols-4 gap-3">
        <StatCard label="Total Flights" value={filteredStats.totalFlights.toLocaleString()} icon={<FlightIcon />} />
        <StatCard label="Total Distance" value={formatDistance(filteredStats.totalDistanceM, unitSystem)} icon={<DistanceIcon />} />
        <StatCard label="Total Time" value={formatDuration(filteredStats.totalDurationSecs)} icon={<ClockIcon />} />
        <StatCard label="Data Points" value={filteredStats.totalPoints.toLocaleString()} icon={<DataIcon />} />
      </div>

      {/* Secondary Stats */}
        <div className="grid grid-cols-5 gap-3">
        <StatCard label="Max Altitude" value={formatAltitude(filteredStats.maxAltitudeM, unitSystem)} small />
        <StatCard
          label="Max Distance from Home"
          value={formatDistance(filteredStats.maxDistanceFromHomeM, unitSystem)}
          small
        />
        <StatCard label="Avg Distance / Flight" value={formatDistance(avgDistancePerFlight, unitSystem)} small />
        <StatCard label="Avg Duration / Flight" value={formatDuration(avgDurationPerFlight)} small />
        <StatCard label="Avg Speed" value={formatSpeed(avgSpeed, unitSystem)} small />
      </div>

      {/* Activity Heatmap + Drone Flight Time Row */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '60% minmax(0, 1fr)', minHeight: '240px' }}>
        {/* Activity Heatmap */}
        <ActivityHeatmapCard
          flightsByDate={filteredStats.flightsByDate}
          isLight={resolvedTheme === 'light'}
        />

        {/* Drone Flight Time */}
        <DroneFlightTimeList
          drones={filteredStats.dronesUsed}
          isLight={resolvedTheme === 'light'}
          getDroneDisplayName={getDroneDisplayName}
          renameDrone={renameDrone}
          getDisplaySerial={getDisplaySerial}
        />
      </div>

      {/* Charts Row */}
        <div className="grid grid-cols-3 gap-4">
        {/* Drone Model Chart */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Flights by Drone</h3>
          <DonutChart
            data={filteredStats.dronesUsed.map((d) => ({
              name: d.displayLabel,
              value: d.flightCount,
            }))}
            emptyMessage="No drone data available"
          />
        </div>

        {/* Battery Usage Chart */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Flights by Battery</h3>
          <DonutChart
            data={filteredStats.batteriesUsed.map((b) => ({
              name: getBatteryDisplayName(b.batterySerial),
              value: b.flightCount,
            }))}
            emptyMessage="No battery data available"
          />
        </div>

        {/* Flights by Duration Chart */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Flights by Duration</h3>
          <DonutChart
            data={(() => {
              let short = 0, mid = 0, long = 0;
              filteredFlights.forEach((f) => {
                const dur = f.durationSecs ?? 0;
                if (dur < 600) short++;
                else if (dur < 1200) mid++;
                else long++;
              });
              return [
                { name: 'Short (<10 min)', value: short },
                { name: 'Mid (10–20 min)', value: mid },
                { name: 'Long (>20 min)', value: long },
              ].filter((d) => d.value > 0);
            })()}
            emptyMessage="No flight data available"
          />
        </div>
      </div>

      {/* Flight Locations Cluster Map */}
      <div id="overview-cluster-map">
        <FlightClusterMap
          flights={filteredFlights}
          allFlights={flights}
          unitSystem={unitSystem}
          themeMode={themeMode}
          onSelectFlight={onSelectFlight}
          highlightedFlightId={overviewHighlightedFlightId}
        />
      </div>

      {/* Battery Health & Top Flights Row */}
        <div className="grid grid-cols-2 gap-4">
        {/* Battery Health Indicators */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Battery Health</h3>
          <BatteryHealthList
            batteries={filteredStats.batteriesUsed}
            points={filteredHealthPoints}
            isLight={resolvedTheme === 'light'}
            getBatteryDisplayName={getBatteryDisplayName}
            renameBattery={renameBattery}
            getDisplaySerial={getDisplaySerial}
          />
        </div>

        {/* Top 3 Longest Flights */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Top 3 Longest Flights</h3>
          {filteredStats.topFlights.length === 0 ? (
            <p className="text-sm text-gray-400">No flights available.</p>
          ) : (
            <div className="space-y-2">
              {filteredStats.topFlights.map((flight, index) => (
                <div
                  key={flight.id}
                  onClick={() => onSelectFlight?.(flight.id)}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-700/30 cursor-pointer transition-colors"
                >
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                      index === 0
                        ? 'bg-yellow-500/20 text-yellow-400'
                        : index === 1
                          ? 'bg-gray-400/20 text-gray-300'
                          : 'bg-amber-700/20 text-amber-600'
                    }`}
                  >
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{flight.displayName}</p>
                    <p className="text-xs text-gray-400">{formatDateTime(flight.startTime)}</p>
                  </div>
                  <div className="text-sm font-medium text-dji-accent">
                    {formatDuration(flight.durationSecs)}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-white mb-3">Top 3 Furthest Flights</h3>
            {filteredTopDistanceFlights.length === 0 ? (
              <p className="text-sm text-gray-400">No flights available.</p>
            ) : (
              <div className="space-y-2">
                {filteredTopDistanceFlights.map((flight, index) => (
                  <div
                    key={flight.id}
                    onClick={() => onSelectFlight?.(flight.id)}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-700/30 cursor-pointer transition-colors"
                  >
                    <div
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        index === 0
                          ? 'bg-yellow-500/20 text-yellow-400'
                          : index === 1
                            ? 'bg-gray-400/20 text-gray-300'
                            : 'bg-amber-700/20 text-amber-600'
                      }`}
                    >
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{flight.displayName}</p>
                      <p className="text-xs text-gray-400">{formatDateTime(flight.startTime)}</p>
                    </div>
                    <div className="text-sm font-medium text-dji-accent">
                      {formatDistance(flight.maxDistanceFromHomeM, unitSystem)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function StatCard({
  label,
  value,
  icon,
  small,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
  small?: boolean;
}) {
  return (
    <div className={`stat-card ${small ? 'py-3' : ''}`}>
      {icon && <div className="text-dji-primary mb-1">{icon}</div>}
      <span className={small ? 'text-lg font-bold text-white' : 'stat-value'}>{value}</span>
      <span className={small ? 'text-xs text-gray-400' : 'stat-label'}>{label}</span>
    </div>
  );
}

function ActivityHeatmapCard({
  flightsByDate,
  isLight,
}: {
  flightsByDate: { date: string; count: number }[];
  isLight: boolean;
}) {
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  oneYearAgo.setDate(oneYearAgo.getDate() + 1);

  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: oneYearAgo,
    to: today,
  });
  // Track which date is being picked: 'from' or 'to'
  const [pickingDate, setPickingDate] = useState<'from' | 'to' | null>(null);
  const fromButtonRef = useRef<HTMLButtonElement>(null);
  const toButtonRef = useRef<HTMLButtonElement>(null);
  const [dateAnchor, setDateAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    const ref = pickingDate === 'from' ? fromButtonRef.current : toButtonRef.current;
    if (pickingDate && ref) {
      const rect = ref.getBoundingClientRect();
      setDateAnchor({
        top: rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - 330), // Keep within viewport
        width: 320,
      });
    }
  }, [pickingDate]);

  const formatDate = (d: Date | undefined) => {
    if (!d) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Filter flights by date range
  const filteredByDate = useMemo(() => {
    if (!dateRange?.from || !dateRange?.to) return flightsByDate;
    const fromStr = dateRange.from.toISOString().split('T')[0];
    const toStr = dateRange.to.toISOString().split('T')[0];
    return flightsByDate.filter((f) => f.date >= fromStr && f.date <= toStr);
  }, [flightsByDate, dateRange]);

  const handleDateSelect = (date: Date | undefined) => {
    if (!date) return;
    
    if (pickingDate === 'from') {
      // If picking 'from' and it's after current 'to', adjust 'to'
      const newTo = dateRange?.to && date > dateRange.to ? date : dateRange?.to;
      setDateRange({ from: date, to: newTo });
    } else if (pickingDate === 'to') {
      // If picking 'to' and it's before current 'from', adjust 'from'
      const newFrom = dateRange?.from && date < dateRange.from ? date : dateRange?.from;
      setDateRange({ from: newFrom, to: date });
    }
    setPickingDate(null);
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Flight Activity</h3>
        <div className="flex items-center gap-1 text-xs">
          <CalendarIcon />
          <button
            ref={fromButtonRef}
            type="button"
            onClick={() => setPickingDate(pickingDate === 'from' ? null : 'from')}
            className={`px-1.5 py-0.5 rounded transition-colors ${
              pickingDate === 'from'
                ? 'bg-dji-primary/20 text-dji-primary'
                : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
            }`}
            title="Select start date"
          >
            {formatDate(dateRange?.from)}
          </button>
          <span className="text-gray-500">–</span>
          <button
            ref={toButtonRef}
            type="button"
            onClick={() => setPickingDate(pickingDate === 'to' ? null : 'to')}
            className={`px-1.5 py-0.5 rounded transition-colors ${
              pickingDate === 'to'
                ? 'bg-dji-primary/20 text-dji-primary'
                : 'text-gray-300 hover:text-white hover:bg-gray-700/50'
            }`}
            title="Select end date"
          >
            {formatDate(dateRange?.to)}
          </button>
        </div>
      </div>

      {pickingDate && dateAnchor && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setPickingDate(null)}
          />
          <div
            className={`fixed z-50 rounded-xl border p-3 shadow-xl ${isLight ? 'border-gray-300 bg-white' : 'border-gray-700 bg-dji-surface'}`}
            style={{
              top: dateAnchor.top,
              left: dateAnchor.left,
              width: dateAnchor.width,
            }}
          >
            <div className={`text-xs font-medium mb-2 ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
              Select {pickingDate === 'from' ? 'start' : 'end'} date
            </div>
            <DayPicker
              mode="single"
              selected={pickingDate === 'from' ? dateRange?.from : dateRange?.to}
              onSelect={handleDateSelect}
              disabled={{ after: today }}
              defaultMonth={pickingDate === 'from' ? dateRange?.from : dateRange?.to}
              weekStartsOn={1}
              numberOfMonths={1}
              className={`rdp-theme ${isLight ? 'rdp-light' : 'rdp-dark'}`}
            />
            <div className="mt-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setDateRange({ from: oneYearAgo, to: today });
                  setPickingDate(null);
                }}
                className={`text-xs ${isLight ? 'text-gray-500 hover:text-gray-900' : 'text-gray-400 hover:text-white'}`}
              >
                Reset to 365 days
              </button>
              <button
                type="button"
                onClick={() => setPickingDate(null)}
                className={`text-xs ${isLight ? 'text-gray-700 hover:text-gray-900' : 'text-gray-200 hover:text-white'}`}
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}

      <div className="overflow-x-auto">
        <ActivityHeatmap
          flightsByDate={filteredByDate}
          isLight={isLight}
          dateRange={dateRange}
        />
      </div>
    </div>
  );
}

function ActivityHeatmap({
  flightsByDate,
  isLight,
  dateRange,
}: {
  flightsByDate: { date: string; count: number }[];
  isLight: boolean;
  dateRange?: DateRange;
}) {
  const maxWidth = 1170;
  const labelWidth = 28;
  const gapSize = 2;
  const cellSize = 13; // Increased from 12 for better visibility

  const { grid, months, maxCount, weekCount } = useMemo(() => {
    const pad = (value: number) => String(value).padStart(2, '0');
    const toDateKey = (date: Date) => {
      const year = date.getFullYear();
      const month = pad(date.getMonth() + 1);
      const day = pad(date.getDate());
      return `${year}-${month}-${day}`;
    };

    // Build map of date -> count
    const dateMap = new Map<string, number>();
    flightsByDate.forEach((f) => dateMap.set(f.date, f.count));

    // Use date range or default to last 365 days
    const endDate = dateRange?.to ?? new Date();
    const startDateRaw = dateRange?.from ?? (() => {
      const d = new Date(endDate);
      d.setFullYear(d.getFullYear() - 1);
      d.setDate(d.getDate() + 1);
      return d;
    })();

    // Find the first Sunday on or before startDate
    const startDate = new Date(startDateRaw);
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const weeks: { date: Date; count: number }[][] = [];
    const currentDate = new Date(startDate);
    let maxCount = 0;

    while (currentDate <= endDate) {
      const week: { date: Date; count: number }[] = [];
      for (let day = 0; day < 7; day++) {
        if (currentDate <= endDate && currentDate >= startDateRaw) {
          const dateStr = toDateKey(currentDate);
          const count = dateMap.get(dateStr) || 0;
          maxCount = Math.max(maxCount, count);
          week.push({ date: new Date(currentDate), count });
        } else {
          week.push({ date: new Date(currentDate), count: -1 });
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }
      weeks.push(week);
    }

    // Extract month labels aligned to week columns
    const months: { label: string; col: number }[] = [];
    let lastMonth = -1;
    weeks.forEach((week, weekIdx) => {
      const firstValidDay = week.find((d) => d.count >= 0);
      if (firstValidDay) {
        const month = firstValidDay.date.getMonth();
        if (month !== lastMonth) {
          months.push({
            label: firstValidDay.date.toLocaleDateString(undefined, { month: 'short' }),
            col: weekIdx,
          });
          lastMonth = month;
        }
      }
    });

    return { grid: weeks, months, maxCount, weekCount: weeks.length };
  }, [flightsByDate, dateRange]);

  const getColor = (count: number) => {
    if (count < 0) return 'transparent';
    if (count === 0) return isLight ? '#e2e8f0' : '#2f3548';
    const intensity = Math.min(count / Math.max(maxCount, 1), 1);
    if (isLight) {
      const r = Math.round(94 + intensity * 0);
      const g = Math.round(134 + intensity * 102);
      const b = Math.round(183 + intensity * 72);
      return `rgb(${r}, ${g}, ${b})`;
    }
    const r = Math.round(20 + intensity * 0);
    const g = Math.round(80 + intensity * 150);
    const b = Math.round(110 + intensity * 120);
    return `rgb(${r}, ${g}, ${b})`;
  };

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const colSize = cellSize + gapSize;
  const contentWidth = weekCount * colSize + labelWidth * 2;

  return (
    <div className="w-full flex justify-center">
      <div className="w-full flex justify-center overflow-x-auto" style={{ maxWidth: `${maxWidth}px` }}>
        <div className="flex flex-col" style={{ width: `${contentWidth}px` }}>
          {/* Month labels */}
          <div
            className="grid text-[10px] text-gray-500 mb-1"
            style={{
              gridTemplateColumns: `repeat(${weekCount}, ${colSize}px)`,
              marginLeft: `${labelWidth}px`,
              columnGap: `${gapSize}px`,
              paddingRight: `${labelWidth}px`,
            }}
          >
            {months.map((m, i) => (
              <div key={i} style={{ gridColumnStart: m.col + 1 }}>
                {m.label}
              </div>
            ))}
          </div>

          {/* Grid */}
          <div className="flex" style={{ columnGap: `${gapSize}px` }}>
            {/* Day labels */}
            <div
              className="flex flex-col text-[10px] text-gray-500"
              style={{ rowGap: `${gapSize}px`, width: `${labelWidth}px` }}
            >
              {dayLabels.map((d, i) => (
                <div key={i} style={{ height: cellSize }} className="flex items-center">
                  {i % 2 === 1 ? d : ''}
                </div>
              ))}
            </div>

            {/* Weeks */}
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${weekCount}, ${colSize}px)`,
                gridTemplateRows: `repeat(7, ${colSize}px)`,
                columnGap: `${gapSize}px`,
                rowGap: `${gapSize}px`,
              }}
            >
              {grid.map((week, weekIdx) =>
                week.map((day, dayIdx) => (
                  <div
                    key={`${weekIdx}-${dayIdx}`}
                    className="rounded-[2px] transition-colors"
                    style={{
                      width: cellSize,
                      height: cellSize,
                      gridColumnStart: weekIdx + 1,
                      gridRowStart: dayIdx + 1,
                      backgroundColor: getColor(day.count),
                    }}
                    title={
                      day.count >= 0
                        ? `${day.date.toLocaleDateString()}: ${day.count} flight${day.count !== 1 ? 's' : ''}`
                        : ''
                    }
                  />
                ))
              )}
            </div>

            <div style={{ width: `${labelWidth}px` }} />
          </div>

          {/* Legend */}
          <div className="flex items-center gap-2 mt-2 text-[10px] text-gray-500">
            <span>Less</span>
            <div className="flex gap-0.5">
              {[0, 0.25, 0.5, 0.75, 1].map((intensity, i) => (
                <div
                  key={i}
                  className="w-[10px] h-[10px] rounded-[2px]"
                  style={{
                    backgroundColor: getColor(i === 0 ? 0 : intensity * Math.max(maxCount, 1)),
                  }}
                />
              ))}
            </div>
            <span>More</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-400"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function DroneFlightTimeList({
  drones,
  isLight,
  getDroneDisplayName,
  renameDrone,
  getDisplaySerial,
}: {
  drones: { droneModel: string; droneSerial: string | null; aircraftName: string | null; flightCount: number; totalDurationSecs: number; displayLabel: string }[];
  isLight: boolean;
  getDroneDisplayName: (serial: string, fallbackName: string) => string;
  renameDrone: (serial: string, displayName: string) => void;
  getDisplaySerial: (serial: string) => string;
}) {
  const [editingSerial, setEditingSerial] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  if (drones.length === 0) {
    return (
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-white mb-3">Drone Flight Time</h3>
        <p className="text-sm text-gray-400">No drone data available.</p>
      </div>
    );
  }

  // Find max duration for progress bar scaling
  const maxDuration = Math.max(...drones.map((d) => d.totalDurationSecs));

  const handleStartRename = (serial: string, fallbackName: string) => {
    setEditingSerial(serial);
    setDraftName(getDroneDisplayName(serial, fallbackName));
    setRenameError(null);
  };

  const handleSaveRename = (serial: string) => {
    const name = draftName.trim();
    if (name.length === 0) {
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    // If name equals the serial itself, just clear the mapping
    if (name === serial) {
      renameDrone(serial, '');
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    renameDrone(serial, name);
    setEditingSerial(null);
    setRenameError(null);
  };

  const handleCancelRename = () => {
    setEditingSerial(null);
    setDraftName('');
    setRenameError(null);
  };

  // Check for duplicate display names to show serial
  const displayNameCounts = new Map<string, number>();
  drones.forEach((d) => {
    const fallback = d.aircraftName || d.droneModel;
    const displayName = d.droneSerial ? getDroneDisplayName(d.droneSerial, fallback) : fallback;
    displayNameCounts.set(displayName, (displayNameCounts.get(displayName) || 0) + 1);
  });

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-white mb-3">Drone Flight Time</h3>
      <div className="space-y-2 max-h-[200px] overflow-y-auto" style={{ padding: '0 8px 0 4px' }}>
        {drones.map((drone) => {
          const fallbackName = drone.aircraftName || drone.droneModel;
          const displayName = drone.droneSerial ? getDroneDisplayName(drone.droneSerial, fallbackName) : fallbackName;
          const hasDuplicate = (displayNameCounts.get(displayName) || 0) > 1;
          const isEditing = drone.droneSerial && editingSerial === drone.droneSerial;
          const progressPercent = (drone.totalDurationSecs / maxDuration) * 100;

          // Format duration as Xh Ym
          const hours = Math.floor(drone.totalDurationSecs / 3600);
          const minutes = Math.floor((drone.totalDurationSecs % 3600) / 60);
          const durationLabel = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

          return (
            <div key={drone.droneSerial || drone.droneModel}>
              {isEditing ? (
                <div className="mb-1">
                  <input
                    value={draftName}
                    onChange={(e) => {
                      setDraftName(e.target.value);
                      setRenameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveRename(drone.droneSerial!);
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    className="input h-6 text-xs px-2 w-full"
                    placeholder="Drone name"
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-0.5">
                    <button
                      onClick={() => handleSaveRename(drone.droneSerial!)}
                      className="text-[10px] text-dji-primary hover:text-dji-primary/80"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelRename}
                      className="text-[10px] text-gray-400 hover:text-gray-300"
                    >
                      Cancel
                    </button>
                    {renameError && (
                      <span className="text-[10px] text-red-400">{renameError}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid items-center gap-1.5 text-xs" style={{ gridTemplateColumns: '140px 1fr 55px' }}>
                  <span
                    className={`text-gray-300 font-medium truncate flex items-center justify-end gap-1 ${drone.droneSerial ? 'group cursor-pointer' : ''}`}
                    onDoubleClick={() => drone.droneSerial && handleStartRename(drone.droneSerial, fallbackName)}
                    title={drone.droneSerial ? `${displayName}${hasDuplicate ? ` (${getDisplaySerial(drone.droneSerial)})` : ''} — double-click to rename` : displayName}
                  >
                    <span className="truncate">
                      {displayName}
                      {hasDuplicate && drone.droneSerial && (
                        <span className="text-gray-500 text-[10px] ml-1">({getDisplaySerial(drone.droneSerial)})</span>
                      )}
                    </span>
                    {drone.droneSerial && (
                      <button
                        onClick={() => handleStartRename(drone.droneSerial!, fallbackName)}
                        className="p-0.5 text-sky-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        title="Rename drone"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                        </svg>
                      </button>
                    )}
                  </span>
                  <div className="relative h-2 bg-gray-700/50 rounded-full overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                      style={{
                        width: `${progressPercent}%`,
                        backgroundColor: isLight ? '#0ea5e9' : '#00a0dc',
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-400 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {durationLabel}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DonutChart({
  data,
  emptyMessage,
}: {
  data: { name: string; value: number }[];
  emptyMessage: string;
}) {
  if (data.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-8">{emptyMessage}</p>;
  }

  const colors = [
    '#00a0dc', // DJI blue
    '#00d4aa', // Teal accent
    '#f59e0b', // Amber
    '#8b5cf6', // Purple
    '#ec4899', // Pink
    '#10b981', // Emerald
    '#f97316', // Orange
    '#6366f1', // Indigo
  ];

  const option = {
    tooltip: {
      trigger: 'item' as const,
      backgroundColor: 'rgba(22, 33, 62, 0.95)',
      borderColor: '#374151',
      textStyle: { color: '#e5e7eb' },
      formatter: (params: { name: string; value: number; percent: number }) => {
        return `<strong>${params.name}</strong><br/>Flights: ${params.value} (${params.percent.toFixed(1)}%)`;
      },
    },
    legend: {
      type: 'scroll' as const,
      orient: 'vertical' as const,
      right: 10,
      top: 'center',
      textStyle: { color: '#9ca3af', fontSize: 11 },
      pageTextStyle: { color: '#9ca3af' },
    },
    series: [
      {
        type: 'pie' as const,
        radius: ['50%', '75%'],
        center: ['35%', '50%'],
        avoidLabelOverlap: true,
        padAngle: 2,
        itemStyle: {
          borderRadius: 4,
          borderColor: 'transparent',
          borderWidth: 0,
        },
        label: { show: false },
        emphasis: {
          label: {
            show: false,
          },
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)',
          },
        },
        labelLine: { show: false },
        data: data.map((item, i) => ({
          name: item.name,
          value: item.value,
          itemStyle: { color: colors[i % colors.length] },
        })),
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 200 }} />;
}

function BatteryHealthList({
  batteries,
  points,
  isLight,
  getBatteryDisplayName,
  renameBattery,
  getDisplaySerial,
}: {
  batteries: { batterySerial: string; flightCount: number; totalDurationSecs: number }[];
  points: BatteryHealthPoint[];
  isLight: boolean;
  getBatteryDisplayName: (serial: string) => string;
  renameBattery: (serial: string, displayName: string) => void;
  getDisplaySerial: (serial: string) => string;
}) {
  const [editingSerial, setEditingSerial] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  if (batteries.length === 0) {
    return <p className="text-sm text-gray-400">No battery data available.</p>;
  }

  // Estimate health based on flight count (assuming 400 cycles = end of life)
  const maxCycles = 400;

  const handleStartRename = (serial: string) => {
    setEditingSerial(serial);
    setDraftName(getBatteryDisplayName(serial));
    setRenameError(null);
  };

  const handleSaveRename = (serial: string) => {
    const name = draftName.trim();
    if (name.length === 0) {
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    // If name equals the serial itself, just clear the mapping
    if (name === serial) {
      renameBattery(serial, '');
      setEditingSerial(null);
      setRenameError(null);
      return;
    }
    // Check uniqueness: name must not match any other battery's custom name or serial
    const otherSerials = batteries
      .map((b) => b.batterySerial)
      .filter((s) => s !== serial);
    const otherNames = otherSerials.map((s) => getBatteryDisplayName(s));
    if (otherNames.includes(name) || otherSerials.includes(name)) {
      setRenameError('Name must be unique across all batteries');
      return;
    }
    renameBattery(serial, name);
    setEditingSerial(null);
    setRenameError(null);
  };

  const handleCancelRename = () => {
    setEditingSerial(null);
    setDraftName('');
    setRenameError(null);
  };

  const seriesMap = new Map<string, BatteryHealthPoint[]>();
  points.forEach((point) => {
    const list = seriesMap.get(point.batterySerial) ?? [];
    list.push(point);
    seriesMap.set(point.batterySerial, list);
  });

  const series = Array.from(seriesMap.entries()).flatMap(([serial, items]) => {
    const sorted = [...items].sort((a, b) => {
      const aTime = a.startTime ? Date.parse(a.startTime) : 0;
      const bTime = b.startTime ? Date.parse(b.startTime) : 0;
      return aTime - bTime;
    });

    const limited = sorted.length > 20 ? sorted.slice(-20) : sorted;
    const data = limited
      .map((p) => {
        const time = p.startTime ? Date.parse(p.startTime) : NaN;
        if (!Number.isFinite(time)) return null;
        return [time, Number(p.ratePerMin.toFixed(3))] as [number, number];
      })
      .filter((p): p is [number, number] => p !== null);

    const displayName = getBatteryDisplayName(serial);

    return [
      {
        name: displayName,
        type: 'line' as const,
        smooth: true,
        showSymbol: true,
        symbolSize: 6,
        connectNulls: true,
        data,
      },
      {
        name: displayName,
        type: 'scatter' as const,
        symbolSize: 7,
        data,
      },
    ];
  });

  const allY = series.flatMap((s) => s.data.map((p: [number, number]) => p[1]));
  const yMin = allY.length ? Math.min(...allY) : 0;
  const yMax = allY.length ? Math.max(...allY) : 1;

  const titleColor = isLight ? '#0f172a' : '#e5e7eb';
  const axisLineColor = isLight ? '#cbd5f5' : '#374151';
  const splitLineColor = isLight ? '#e2e8f0' : '#1f2937';
  const axisLabelColor = isLight ? '#475569' : '#9ca3af';
  const tooltipStyle = isLight
    ? { background: '#ffffff', border: '#e2e8f0', text: '#0f172a' }
    : { background: 'rgba(22, 33, 62, 0.95)', border: '#374151', text: '#e5e7eb' };

  const chartOption = {
    title: {
      text: 'Per minute battery % usage history',
      left: 'center',
      textStyle: { color: titleColor, fontSize: 12, fontWeight: 'normal' as const },
    },
    toolbox: {
      feature: {
        dataZoom: {
          yAxisIndex: 'none',
          title: { zoom: 'Drag to zoom', back: 'Reset zoom' },
        },
      },
      right: 16,
      top: -4,
      itemSize: 13,
      iconStyle: {
        borderColor: isLight ? '#94a3b8' : '#6b7280',
      },
      emphasis: {
        iconStyle: {
          borderColor: isLight ? '#007acc' : '#00a0dc',
        },
      },
    },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: tooltipStyle.background,
      borderColor: tooltipStyle.border,
      textStyle: { color: tooltipStyle.text },
      formatter: (params: Array<{ seriesName: string; value: [string, number] }>) => {
        if (!params?.length) return '';
        const dateLabel = params[0].value?.[0]
          ? new Date(params[0].value[0]).toLocaleDateString()
          : 'Unknown date';
        const lines = params
          .map((item) => `${item.seriesName}: ${item.value[1]} %/min`)
          .join('<br/>');
        return `<strong>${dateLabel}</strong><br/>${lines}`;
      },
    },
    legend: {
      type: 'scroll' as const,
      bottom: 0,
      textStyle: { color: axisLabelColor, fontSize: 11 },
    },
    grid: { left: 16, right: 16, top: 46, bottom: 72, containLabel: true },
    xAxis: {
      type: 'time' as const,
      axisLine: { lineStyle: { color: axisLineColor } },
      axisLabel: { color: axisLabelColor, fontSize: 10 },
      splitLine: { lineStyle: { color: splitLineColor } },
    },
    yAxis: {
      type: 'value' as const,
      min: yMin,
      max: yMax,
      name: '% per min',
      nameTextStyle: { color: axisLabelColor, fontSize: 10 },
      axisLine: { lineStyle: { color: axisLineColor } },
      axisLabel: { color: axisLabelColor, fontSize: 10 },
      splitLine: { lineStyle: { color: splitLineColor } },
    },
    dataZoom: [
      {
        type: 'inside' as const,
        xAxisIndex: 0,
        filterMode: 'filter' as const,
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: false,
      },
      {
        type: 'slider' as const,
        xAxisIndex: 0,
        height: 18,
        bottom: 28,
        brushSelect: false,
        borderColor: isLight ? '#cbd5e1' : '#374151',
        backgroundColor: isLight ? '#f1f5f9' : '#1e293b',
        fillerColor: isLight ? 'rgba(0, 122, 204, 0.15)' : 'rgba(0, 160, 220, 0.2)',
        handleStyle: {
          color: isLight ? '#007acc' : '#00a0dc',
        },
        textStyle: {
          color: axisLabelColor,
        },
        dataBackground: {
          lineStyle: { color: isLight ? '#94a3b8' : '#4a4e69' },
          areaStyle: { color: isLight ? '#cbd5e1' : '#2a2a4e' },
        },
        selectedDataBackground: {
          lineStyle: { color: isLight ? '#007acc' : '#00a0dc' },
          areaStyle: { color: isLight ? 'rgba(0, 122, 204, 0.1)' : 'rgba(0, 160, 220, 0.15)' },
        },
      },
    ],
    series,
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2 max-h-[200px] overflow-y-auto" style={{ padding: '0 16px 0 10px' }}>
        {batteries.map((battery) => {
          const healthPercent = Math.max(0, 100 - (battery.flightCount / maxCycles) * 100);
          const healthColor =
            healthPercent > 70 ? '#10b981' : healthPercent > 40 ? '#f59e0b' : '#ef4444';
          const displayName = getBatteryDisplayName(battery.batterySerial);
          const isEditing = editingSerial === battery.batterySerial;

          return (
            <div key={battery.batterySerial}>
              {isEditing ? (
                <div className="mb-1">
                  <input
                    value={draftName}
                    onChange={(e) => {
                      setDraftName(e.target.value);
                      setRenameError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveRename(battery.batterySerial);
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    className="input h-6 text-xs px-2 w-full"
                    placeholder="Battery name"
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-0.5">
                    <button
                      onClick={() => handleSaveRename(battery.batterySerial)}
                      className="text-[10px] text-dji-primary hover:text-dji-primary/80"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelRename}
                      className="text-[10px] text-gray-400 hover:text-gray-300"
                    >
                      Cancel
                    </button>
                    {renameError && (
                      <span className="text-[10px] text-red-400">{renameError}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid items-center gap-1.5 text-xs" style={{ gridTemplateColumns: '160px 1fr 32px 150px' }}>
                  <span
                    className="text-gray-300 font-medium truncate flex items-center justify-end gap-1 group cursor-pointer"
                    onDoubleClick={() => handleStartRename(battery.batterySerial)}
                    title={`${displayName}${displayName !== battery.batterySerial && displayName !== '*****' ? ` (${getDisplaySerial(battery.batterySerial)})` : ''} — double-click to rename`}
                  >
                    <span className="truncate">{displayName}</span>
                    <button
                      onClick={() => handleStartRename(battery.batterySerial)}
                      className="p-0.5 text-sky-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      title="Rename battery"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                  </span>
                  <div className="relative h-2 bg-gray-700/50 rounded-full overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                      style={{
                        width: `${healthPercent}%`,
                        backgroundColor: healthColor,
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-500 text-right" style={{ fontVariantNumeric: 'tabular-nums', minWidth: '32px' }}>
                    {healthPercent.toFixed(0)}%
                  </span>
                  <span className="text-gray-400 text-[10px] text-left truncate">
                    {battery.flightCount} flights · {formatDuration(battery.totalDurationSecs)}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {series.length > 0 ? (
        <div className="h-[260px]">
          <ReactECharts option={chartOption} style={{ height: '100%' }} onChartReady={(chart) => {
            chart.dispatchAction({ type: 'takeGlobalCursor', key: 'dataZoomSelect', dataZoomSelectActive: true });
          }} />
        </div>
      ) : (
        <p className="text-xs text-gray-500">No battery usage points available.</p>
      )}
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function FlightIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
      />
    </svg>
  );
}

function DistanceIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function DataIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
      />
    </svg>
  );
}

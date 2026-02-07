/**
 * Overview panel with comprehensive flight statistics
 * Features: filters, activity heatmap, donut charts, battery health, top flights
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

interface OverviewProps {
  stats: OverviewStats;
  flights: Flight[];
  unitSystem: UnitSystem;
  onSelectFlight?: (flightId: number) => void;
}

export function Overview({ stats, flights, unitSystem, onSelectFlight }: OverviewProps) {
  // Filter state
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [isDateOpen, setIsDateOpen] = useState(false);
  const [dateAnchor, setDateAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [selectedDrone, setSelectedDrone] = useState('');
  const [selectedBattery, setSelectedBattery] = useState('');
  const dateButtonRef = useRef<HTMLButtonElement | null>(null);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
    []
  );

  const today = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }, []);

  const dateRangeLabel = useMemo(() => {
    if (!dateRange?.from && !dateRange?.to) return 'Any date';
    if (dateRange?.from && !dateRange?.to) {
      return `From ${dateFormatter.format(dateRange.from)}`;
    }
    if (dateRange?.from && dateRange?.to) {
      return `${dateFormatter.format(dateRange.from)} – ${dateFormatter.format(dateRange.to)}`;
    }
    return 'Any date';
  }, [dateFormatter, dateRange]);

  const updateDateAnchor = useCallback(() => {
    const rect = dateButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDateAnchor({ top: rect.bottom + 8, left: rect.left, width: rect.width });
  }, []);

  useEffect(() => {
    if (!isDateOpen) return;
    updateDateAnchor();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsDateOpen(false);
    };

    window.addEventListener('resize', updateDateAnchor);
    window.addEventListener('scroll', updateDateAnchor, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('resize', updateDateAnchor);
      window.removeEventListener('scroll', updateDateAnchor, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDateOpen, updateDateAnchor]);

  // Drone options from flights
  const droneOptions = useMemo(() => {
    const entries = flights
      .map((flight) => ({
        key: `${flight.droneModel ?? ''}||${flight.droneSerial ?? ''}`,
        label: `${flight.aircraftName || flight.droneModel || 'Unknown'}${
          flight.droneSerial ? ` : ${flight.droneSerial}` : ''
        }`,
      }))
      .filter((entry) => entry.label.trim().length > 0);

    const unique = new Map<string, string>();
    entries.forEach((entry) => {
      if (!unique.has(entry.key)) unique.set(entry.key, entry.label);
    });

    return Array.from(unique.entries()).map(([key, label]) => ({ key, label }));
  }, [flights]);

  // Battery options from flights
  const batteryOptions = useMemo(() => {
    const unique = new Set<string>();
    flights.forEach((flight) => {
      if (flight.batterySerial) unique.add(flight.batterySerial);
    });
    return Array.from(unique);
  }, [flights]);

  // Filter flights
  const filteredFlights = useMemo(() => {
    const start = dateRange?.from ?? null;
    const end = dateRange?.to ? new Date(dateRange.to) : null;
    if (end) end.setHours(23, 59, 59, 999);

    return flights.filter((flight) => {
      if (start || end) {
        if (!flight.startTime) return false;
        const flightDate = new Date(flight.startTime);
        if (start && flightDate < start) return false;
        if (end && flightDate > end) return false;
      }

      if (selectedDrone) {
        const key = `${flight.droneModel ?? ''}||${flight.droneSerial ?? ''}`;
        if (key !== selectedDrone) return false;
      }

      if (selectedBattery) {
        if (flight.batterySerial !== selectedBattery) return false;
      }

      return true;
    });
  }, [dateRange, flights, selectedBattery, selectedDrone]);

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
    const droneMap = new Map<string, { model: string; serial: string | null; name: string | null; count: number }>();
    filteredFlights.forEach((f) => {
      const key = `${f.droneModel ?? 'Unknown'}||${f.droneSerial ?? ''}`;
      const existing = droneMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        droneMap.set(key, {
          model: f.droneModel ?? 'Unknown',
          serial: f.droneSerial ?? null,
          name: f.aircraftName ?? null,
          count: 1,
        });
      }
    });

    // Check if any model names are duplicated
    const modelCounts = new Map<string, number>();
    droneMap.forEach((d) => {
      const displayName = d.name || d.model;
      modelCounts.set(displayName, (modelCounts.get(displayName) || 0) + 1);
    });

    const dronesUsed = Array.from(droneMap.entries())
      .map(([_, data]) => {
        const displayName = data.name || data.model;
        const needsSerial = (modelCounts.get(displayName) || 0) > 1 && data.serial;
        return {
          droneModel: data.model,
          droneSerial: data.serial,
          aircraftName: data.name,
          flightCount: data.count,
          displayLabel: needsSerial ? `${displayName} (${data.serial})` : displayName,
        };
      })
      .sort((a, b) => b.flightCount - a.flightCount);

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


    // For max distance from home, use the global stat if no filter applied
    const hasFilters = dateRange?.from || dateRange?.to || selectedDrone || selectedBattery;
    const maxDistanceFromHomeM = hasFilters ? 0 : stats.maxDistanceFromHomeM;

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
  }, [filteredFlights, dateRange, selectedDrone, selectedBattery, stats.maxDistanceFromHomeM]);

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

  const hasFilters = dateRange?.from || dateRange?.to || selectedDrone || selectedBattery;

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
    <div className="h-full flex flex-col">
      {/* Filter Bar */}
      <div className="sticky top-0 z-30 bg-dji-dark/95 backdrop-blur p-4 pb-2">
        <div className="card p-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs text-gray-400 mb-1">Date range</label>
            <button
              ref={dateButtonRef}
              type="button"
              onClick={() => setIsDateOpen((open) => !open)}
              className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
            >
              <span className={dateRange?.from || dateRange?.to ? 'text-gray-100' : 'text-gray-400'}>
                {dateRangeLabel}
              </span>
              <CalendarIcon />
            </button>
            {isDateOpen && dateAnchor && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setIsDateOpen(false)} />
                <div
                  className="fixed z-50 rounded-xl border border-gray-700 bg-dji-surface p-3 shadow-xl"
                  style={{
                    top: dateAnchor.top,
                    left: dateAnchor.left,
                    width: Math.max(320, dateAnchor.width),
                  }}
                >
                  <DayPicker
                    mode="range"
                    selected={dateRange}
                    onSelect={(range) => {
                      setDateRange(range);
                      if (range?.from && range?.to) setIsDateOpen(false);
                    }}
                    disabled={{ after: today }}
                    weekStartsOn={1}
                    numberOfMonths={1}
                    className="rdp-theme"
                  />
                  <div className="mt-2 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setDateRange(undefined)}
                      className="text-xs text-gray-400 hover:text-white"
                    >
                      Clear range
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsDateOpen(false)}
                      className="text-xs text-gray-200 hover:text-white"
                    >
                      Done
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs text-gray-400 mb-1">Drone</label>
            <select
              value={selectedDrone}
              onChange={(e) => setSelectedDrone(e.target.value)}
              className="input w-full text-xs h-8 px-3 py-0 leading-[1.2]"
            >
              <option value="">All drones</option>
              {droneOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[180px]">
            <label className="block text-xs text-gray-400 mb-1">Battery serial</label>
            <select
              value={selectedBattery}
              onChange={(e) => setSelectedBattery(e.target.value)}
              className="input w-full text-xs h-8 px-3 py-0 leading-[1.2]"
            >
              <option value="">All batteries</option>
              {batteryOptions.map((serial) => (
                <option key={serial} value={serial}>
                  {serial}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => {
              setDateRange(undefined);
              setSelectedDrone('');
              setSelectedBattery('');
            }}
            disabled={!hasFilters}
            className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors ${
              hasFilters
                ? 'bg-dji-primary/20 text-dji-primary hover:bg-dji-primary/30'
                : 'text-gray-500 cursor-not-allowed'
            }`}
          >
            Clear filters
          </button>
        </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-5">
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
          value={hasFilters ? '--' : formatDistance(filteredStats.maxDistanceFromHomeM, unitSystem)}
          small
        />
        <StatCard label="Avg Distance / Flight" value={formatDistance(avgDistancePerFlight, unitSystem)} small />
        <StatCard label="Avg Duration / Flight" value={formatDuration(avgDurationPerFlight)} small />
        <StatCard label="Avg Speed" value={formatSpeed(avgSpeed, unitSystem)} small />
      </div>

      {/* Activity Heatmap */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3 text-center">
            Flight Activity (Last 365 Days)
          </h3>
        <ActivityHeatmap flightsByDate={filteredStats.flightsByDate} />
      </div>

      {/* Charts Row */}
        <div className="grid grid-cols-2 gap-4">
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
              name: b.batterySerial,
              value: b.flightCount,
            }))}
            emptyMessage="No battery data available"
          />
        </div>
      </div>

      {/* Battery Health & Top Flights Row */}
        <div className="grid grid-cols-2 gap-4">
        {/* Battery Health Indicators */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Battery Health</h3>
          <BatteryHealthList
            batteries={filteredStats.batteriesUsed}
            points={filteredHealthPoints}
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

function ActivityHeatmap({ flightsByDate }: { flightsByDate: { date: string; count: number }[] }) {
  const maxWidth = 1170;
  const labelWidth = 28;
  const gapSize = 2;
  const cellSize = 12;

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

    // Generate 365 days grid (7 rows x ~52 columns)
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    oneYearAgo.setDate(oneYearAgo.getDate() + 1);

    // Find the first Sunday on or before oneYearAgo
    const startDate = new Date(oneYearAgo);
    startDate.setDate(startDate.getDate() - startDate.getDay());

    const weeks: { date: Date; count: number }[][] = [];
    const currentDate = new Date(startDate);
    let maxCount = 0;

    while (currentDate <= today) {
      const week: { date: Date; count: number }[] = [];
      for (let day = 0; day < 7; day++) {
        if (currentDate <= today && currentDate >= oneYearAgo) {
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
  }, [flightsByDate]);

  const getColor = (count: number) => {
    if (count < 0) return 'transparent';
    if (count === 0) return 'rgb(30, 35, 50)';
    const intensity = Math.min(count / Math.max(maxCount, 1), 1);
    // Gradient from dark teal to bright cyan
    const r = Math.round(0 + intensity * 0);
    const g = Math.round(50 + intensity * 162);
    const b = Math.round(80 + intensity * 140);
    return `rgb(${r}, ${g}, ${b})`;
  };

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const colSize = cellSize + gapSize;
  const contentWidth = weekCount * colSize + labelWidth * 2;

  return (
    <div className="w-full flex justify-center">
      <div className="w-full flex justify-center overflow-x-hidden" style={{ maxWidth: `${maxWidth}px` }}>
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
                    backgroundColor:
                      i === 0
                        ? 'rgb(30, 35, 50)'
                        : `rgb(${Math.round(0 + intensity * 0)}, ${Math.round(50 + intensity * 162)}, ${Math.round(80 + intensity * 140)})`,
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
        itemStyle: {
          borderRadius: 4,
          borderColor: 'rgb(22, 33, 62)',
          borderWidth: 2,
        },
        label: { show: false },
        emphasis: {
          label: {
            show: true,
            fontSize: 12,
            fontWeight: 'bold' as const,
            color: '#fff',
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
}: {
  batteries: { batterySerial: string; flightCount: number; totalDurationSecs: number }[];
  points: BatteryHealthPoint[];
}) {
  if (batteries.length === 0) {
    return <p className="text-sm text-gray-400">No battery data available.</p>;
  }

  // Estimate health based on flight count (assuming 400 cycles = end of life)
  const maxCycles = 400;

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

    return [
      {
        name: serial,
        type: 'line' as const,
        smooth: true,
        showSymbol: true,
        symbolSize: 6,
        connectNulls: true,
        data,
      },
      {
        name: serial,
        type: 'scatter' as const,
        symbolSize: 7,
        data,
      },
    ];
  });

  const allY = series.flatMap((s) => s.data.map((p: [number, number]) => p[1]));
  const yMin = allY.length ? Math.min(...allY) : 0;
  const yMax = allY.length ? Math.max(...allY) : 1;

  const chartOption = {
    title: {
      text: 'Per minute battery % usage history',
      left: 'center',
      textStyle: { color: '#e5e7eb', fontSize: 12, fontWeight: 'normal' as const },
    },
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: 'rgba(22, 33, 62, 0.95)',
      borderColor: '#374151',
      textStyle: { color: '#e5e7eb' },
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
      textStyle: { color: '#9ca3af', fontSize: 11 },
    },
    grid: { left: 16, right: 16, top: 46, bottom: 48, containLabel: true },
    xAxis: {
      type: 'time' as const,
      axisLine: { lineStyle: { color: '#374151' } },
      axisLabel: { color: '#9ca3af', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1f2937' } },
    },
    yAxis: {
      type: 'value' as const,
      min: yMin,
      max: yMax,
      name: '% per min',
      nameTextStyle: { color: '#9ca3af', fontSize: 10 },
      axisLine: { lineStyle: { color: '#374151' } },
      axisLabel: { color: '#9ca3af', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1f2937' } },
    },
    series,
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 max-h-[200px] overflow-y-auto">
        {batteries.map((battery) => {
          const healthPercent = Math.max(0, 100 - (battery.flightCount / maxCycles) * 100);
          const healthColor =
            healthPercent > 70 ? '#10b981' : healthPercent > 40 ? '#f59e0b' : '#ef4444';

          return (
            <div key={battery.batterySerial} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-300 font-medium truncate">{battery.batterySerial}</span>
                <span className="text-gray-400">
                  {battery.flightCount} flights · {formatDuration(battery.totalDurationSecs)}
                </span>
              </div>
              <div className="relative h-2 bg-gray-700/50 rounded-full overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                  style={{
                    width: `${healthPercent}%`,
                    backgroundColor: healthColor,
                  }}
                />
              </div>
              <div className="text-[10px] text-gray-500 text-right">
                Est. health: {healthPercent.toFixed(0)}%
              </div>
            </div>
          );
        })}
      </div>

      {series.length > 0 ? (
        <div className="h-[220px]">
          <ReactECharts option={chartOption} style={{ height: '100%' }} />
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

function CalendarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-400"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

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

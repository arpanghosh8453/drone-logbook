/**
 * Flight list component for the sidebar
 * Displays all imported flights with selection
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFlightStore } from '@/stores/flightStore';
import { formatDuration, formatDateTime, formatDistance } from '@/lib/utils';
import { DayPicker, type DateRange } from 'react-day-picker';
import 'react-day-picker/dist/style.css';

export function FlightList({ showControls = true }: { showControls?: boolean } = {}) {
  const {
    flights,
    selectedFlightId,
    selectFlight,
    deleteFlight,
    updateFlightName,
    unitSystem,
  } =
    useFlightStore();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [isDateOpen, setIsDateOpen] = useState(false);
  const [dateAnchor, setDateAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [selectedDrone, setSelectedDrone] = useState('');
  const [selectedBattery, setSelectedBattery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<
    'name' | 'date' | 'duration' | 'distance'
  >('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [isSortOpen, setIsSortOpen] = useState(false);
  const dateButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortButtonRef = useRef<HTMLButtonElement | null>(null);

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
      return `${dateFormatter.format(dateRange.from)} – ${dateFormatter.format(
        dateRange.to
      )}`;
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
      if (event.key === 'Escape') {
        setIsDateOpen(false);
      }
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

  useEffect(() => {
    if (!isSortOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsSortOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSortOpen]);

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
      if (!unique.has(entry.key)) {
        unique.set(entry.key, entry.label);
      }
    });

    return Array.from(unique.entries()).map(([key, label]) => ({ key, label }));
  }, [flights]);

  const batteryOptions = useMemo(() => {
    const unique = new Set<string>();
    flights.forEach((flight) => {
      if (flight.batterySerial) {
        unique.add(flight.batterySerial);
      }
    });
    return Array.from(unique);
  }, [flights]);

  const filteredFlights = useMemo(() => {
    if (!showControls) return flights;
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

  const normalizedSearch = useMemo(
    () => (showControls ? searchQuery.trim().toLowerCase() : ''),
    [searchQuery, showControls]
  );

  const getFlightTitle = useCallback((flight: { displayName?: string | null; fileName?: string | null }) => {
    return (flight.displayName || flight.fileName || '').toString();
  }, []);

  const searchedFlights = useMemo(() => {
    if (!normalizedSearch) return filteredFlights;
    return filteredFlights.filter((flight) => {
      const title = getFlightTitle(flight).toLowerCase();
      return title.includes(normalizedSearch);
    });
  }, [filteredFlights, getFlightTitle, normalizedSearch]);

  const sortedFlights = useMemo(() => {
    const list = [...searchedFlights];
    list.sort((a, b) => {
      if (!showControls) {
        const aDate = a.startTime ? new Date(a.startTime).getTime() : 0;
        const bDate = b.startTime ? new Date(b.startTime).getTime() : 0;
        return bDate - aDate;
      }
      if (sortOption === 'name') {
        const nameA = getFlightTitle(a).toLowerCase();
        const nameB = getFlightTitle(b).toLowerCase();
        const cmp = nameA.localeCompare(nameB);
        return sortDirection === 'asc' ? cmp : -cmp;
      }
      if (sortOption === 'duration') {
        const aDuration = a.durationSecs ?? 0;
        const bDuration = b.durationSecs ?? 0;
        return sortDirection === 'asc'
          ? aDuration - bDuration
          : bDuration - aDuration;
      }
      if (sortOption === 'distance') {
        const aDistance = a.totalDistance ?? 0;
        const bDistance = b.totalDistance ?? 0;
        return sortDirection === 'asc'
          ? aDistance - bDistance
          : bDistance - aDistance;
      }
      const aDate = a.startTime ? new Date(a.startTime).getTime() : 0;
      const bDate = b.startTime ? new Date(b.startTime).getTime() : 0;
      return sortDirection === 'asc' ? aDate - bDate : bDate - aDate;
    });
    return list;
  }, [getFlightTitle, searchedFlights, showControls, sortDirection, sortOption]);

  const sortOptions = useMemo(
    () => [
      { value: 'name', label: 'Name' },
      { value: 'date', label: 'Date' },
      { value: 'duration', label: 'Duration' },
      { value: 'distance', label: 'Distance' },
    ],
    []
  );

  const activeSortLabel = useMemo(() => {
    return sortOptions.find((option) => option.value === sortOption)?.label ?? 'Sort';
  }, [sortOption, sortOptions]);

  if (flights.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        <p className="text-sm">No flights imported yet.</p>
        <p className="text-xs mt-1">
          Drag & drop a log file above to get started.
        </p>
      </div>
    );
  }

  return (
    <div
      className="divide-y divide-gray-700/50"
      onClick={() => setConfirmDeleteId(null)}
    >
      {showControls && (
        <div className="p-3 border-b border-gray-700 space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Date range</label>
          <button
            ref={dateButtonRef}
            type="button"
            onClick={() => setIsDateOpen((open) => !open)}
            className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
          >
            <span
              className={
                dateRange?.from || dateRange?.to ? 'text-gray-100' : 'text-gray-400'
              }
            >
              {dateRangeLabel}
            </span>
            <CalendarIcon />
          </button>
          {isDateOpen && dateAnchor && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setIsDateOpen(false)}
              />
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
                    if (range?.from && range?.to) {
                      setIsDateOpen(false);
                    }
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

        <div>
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

        <div>
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
          className="text-xs text-gray-400 hover:text-white"
        >
          Clear filters
        </button>

        <div className="flex items-center gap-2">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search flights"
            className="input w-full text-xs h-8 px-3"
            aria-label="Search flights"
          />
          <div className="relative flex items-center">
            <button
              ref={sortButtonRef}
              type="button"
              onClick={() => setIsSortOpen((open) => !open)}
              className="h-8 w-8 rounded-l-md border border-gray-700/70 bg-dji-dark text-gray-300 hover:text-white hover:border-gray-600 transition-colors flex items-center justify-center"
              aria-label={`Sort flights: ${activeSortLabel}`}
            >
              <SortIcon />
            </button>
            <button
              type="button"
              onClick={() => setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'))}
              className="h-8 w-7 rounded-r-md border border-l-0 border-gray-700/70 bg-dji-dark text-gray-300 hover:text-white hover:border-gray-600 transition-colors flex items-center justify-center"
              aria-label={`Toggle sort direction: ${sortDirection === 'asc' ? 'ascending' : 'descending'}`}
            >
              <SortDirectionIcon direction={sortDirection} />
            </button>
            {isSortOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setIsSortOpen(false)}
                />
                <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-gray-700 bg-dji-surface p-1 shadow-xl">
                  {sortOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setSortOption(option.value as typeof sortOption);
                        setIsSortOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs rounded-lg transition-colors ${
                        sortOption === option.value
                          ? 'bg-dji-primary/20 text-white'
                          : 'text-gray-300 hover:bg-gray-700/40 hover:text-white'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      )}

      {sortedFlights.map((flight) => (
        <div
          key={flight.id}
          onClick={() => selectFlight(flight.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              selectFlight(flight.id);
            }
          }}
          className={`w-full p-3 text-left hover:bg-gray-700/30 transition-colors group ${
            selectedFlightId === flight.id
              ? 'bg-dji-primary/20 border-l-2 border-dji-primary'
              : 'border-l-2 border-transparent'
          }`}
        >
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              {/* Display Name */}
              {editingId === flight.id ? (
                <div className="flex flex-col gap-2">
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="input h-8 text-sm px-2 w-full"
                    placeholder="Flight name"
                  />
                  <div className="flex items-center gap-2 pb-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const name = draftName.trim();
                        if (name.length > 0) {
                          updateFlightName(flight.id, name);
                        }
                        setEditingId(null);
                      }}
                      className="text-xs text-dji-primary hover:text-dji-accent"
                    >
                      Save
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(null);
                      }}
                      className="text-xs text-gray-400 hover:text-gray-200"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <p className="font-medium text-white truncate">
                    {flight.displayName || flight.fileName}
                  </p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(flight.id);
                      setDraftName(flight.displayName || flight.fileName);
                      setConfirmDeleteId(null);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-white transition-colors"
                    title="Rename flight"
                  >
                    <EditIcon />
                  </button>
                </div>
              )}

              {/* Drone Model */}
              {flight.droneModel && !flight.droneModel.startsWith('Unknown') && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {flight.droneModel}
                </p>
              )}

              {/* Flight Date */}
              <p className="text-xs text-gray-400 mt-0.5">
                {formatDateTime(flight.startTime)}
              </p>

              {/* Stats Row */}
              <div className="flex gap-3 mt-2 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <ClockIcon />
                  {formatDuration(flight.durationSecs)}
                </span>
                <span className="flex items-center gap-1">
                  <DistanceIcon />
                  {formatDistance(flight.totalDistance, unitSystem)}
                </span>
              </div>

              {confirmDeleteId === flight.id && editingId !== flight.id && (
                <div className="flex items-center gap-2 mt-2 text-xs">
                  <span className="text-gray-400">Are you sure?</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteFlight(flight.id);
                      setConfirmDeleteId(null);
                    }}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Yes
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDeleteId(null);
                    }}
                    className="text-xs text-gray-400 hover:text-gray-200"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Delete Button */}
            {editingId !== flight.id && (
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  setConfirmDeleteId(flight.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all"
                title="Delete flight"
              >
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
      ))}
      {showControls && sortedFlights.length === 0 && normalizedSearch.length === 0 && (
        <div className="p-4 text-center text-gray-500 text-xs">
          No flights match the current filters or search.
        </div>
      )}
    </div>
  );
}

function ClockIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function DistanceIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      className="w-4 h-4 text-red-400"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 5h2m-1 0v14m-7 0h14"
      />
    </svg>
  );
}

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
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 6h10M3 12h14M3 18h18"
      />
    </svg>
  );
}

function SortDirectionIcon({ direction }: { direction: 'asc' | 'desc' }) {
  const rotation = direction === 'asc' ? 'rotate(180deg)' : 'rotate(0deg)';
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      style={{ transform: rotation }}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M19 9l-7 7-7-7"
      />
    </svg>
  );
}

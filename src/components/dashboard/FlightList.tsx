/**
 * Flight list component for the sidebar
 * Displays all imported flights with selection
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as api from '@/lib/api';
import { isWebMode, downloadFile, downloadBlob } from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';
import { formatDuration, formatDateTime, formatDistance } from '@/lib/utils';
import { DayPicker, type DateRange } from 'react-day-picker';
import type { FlightDataResponse, Flight, TelemetryData } from '@/types';
import { addToBlacklist } from './FlightImporter';
import 'react-day-picker/dist/style.css';
import JSZip from 'jszip';

/**
 * Check if element is mostly visible in the viewport
 */
function isElementInView(element: HTMLElement, threshold: number = 0.6): boolean {
  const rect = element.getBoundingClientRect();
  const windowHeight = window.innerHeight;
  
  // Calculate how much of the element is visible
  const visibleTop = Math.max(0, rect.top);
  const visibleBottom = Math.min(windowHeight, rect.bottom);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleRatio = visibleHeight / rect.height;
  
  return visibleRatio >= threshold;
}

/**
 * Custom smooth scroll with easing for a more polished feel
 * Skips animation if element is already mostly visible
 */
function smoothScrollToElement(
  element: HTMLElement,
  duration: number = 800,
  offset: number = 0
): Promise<void> {
  return new Promise((resolve) => {
    // If element is already mostly in view, resolve immediately
    if (isElementInView(element, 0.5)) {
      resolve();
      return;
    }
    
    const scrollContainer = element.closest('.overflow-auto') || document.documentElement;
    const isDocScroll = scrollContainer === document.documentElement;
    
    const elementRect = element.getBoundingClientRect();
    const containerRect = isDocScroll 
      ? { top: 0, height: window.innerHeight }
      : (scrollContainer as HTMLElement).getBoundingClientRect();
    
    // Calculate target position to center the element
    const elementCenter = elementRect.top + elementRect.height / 2;
    const containerCenter = containerRect.top + containerRect.height / 2;
    const scrollOffset = elementCenter - containerCenter + offset;
    
    const startScroll = isDocScroll 
      ? window.scrollY 
      : (scrollContainer as HTMLElement).scrollTop;
    const targetScroll = startScroll + scrollOffset;
    
    const startTime = performance.now();
    
    // Ease-in-out cubic for smooth acceleration and deceleration
    const easeInOutCubic = (t: number): number => {
      return t < 0.5 
        ? 4 * t * t * t 
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };
    
    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeInOutCubic(progress);
      
      const currentScroll = startScroll + (targetScroll - startScroll) * easedProgress;
      
      if (isDocScroll) {
        window.scrollTo(0, currentScroll);
      } else {
        (scrollContainer as HTMLElement).scrollTop = currentScroll;
      }
      
      if (progress < 1) {
        requestAnimationFrame(animateScroll);
      } else {
        resolve();
      }
    };
    
    requestAnimationFrame(animateScroll);
  });
}

export function FlightList({ 
  onSelectFlight,
  onHighlightFlight,
  activeView = 'flights',
}: { 
  onSelectFlight?: (flightId: number) => void;
  onHighlightFlight?: (flightId: number | null) => void;
  activeView?: 'flights' | 'overview';
} = {}) {
  const {
    flights,
    selectedFlightId,
    selectFlight,
    deleteFlight,
    updateFlightName,
    unitSystem,
    themeMode,
    getBatteryDisplayName,
    getDroneDisplayName,
    droneNameMap,
    allTags,
    mapAreaFilterEnabled,
    mapVisibleBounds,
    setMapAreaFilterEnabled,
    clearSelection,
    getDisplaySerial,
    overviewHighlightedFlightId,
    setOverviewHighlightedFlightId,
    addTag,
    removeTag,
    loadAllTags,
    clearFlightDataCache,
  } =
    useFlightStore();

  // Resolve theme mode for styling
  const resolvedTheme = themeMode === 'system'
    ? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : themeMode;
  const isLight = resolvedTheme === 'light';
  const heatmapDateFilter = useFlightStore((s) => s.heatmapDateFilter);
  const setHeatmapDateFilter = useFlightStore((s) => s.setHeatmapDateFilter);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [isDateOpen, setIsDateOpen] = useState(false);
  const [dateAnchor, setDateAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [selectedDrones, setSelectedDrones] = useState<string[]>([]);
  const [selectedBatteries, setSelectedBatteries] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  
  // For keyboard navigation: preview ID for visual highlighting before Enter confirms selection
  const [previewFlightId, setPreviewFlightId] = useState<number | null>(null);
  const [isFilterInverted, setIsFilterInverted] = useState(false);
  const [isTagDropdownOpen, setIsTagDropdownOpen] = useState(false);
  const [isDroneDropdownOpen, setIsDroneDropdownOpen] = useState(false);
  const [isBatteryDropdownOpen, setIsBatteryDropdownOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [droneSearch, setDroneSearch] = useState('');
  const [batterySearch, setBatterySearch] = useState('');
  const [durationFilterMin, setDurationFilterMin] = useState<number | null>(null);
  const [durationFilterMax, setDurationFilterMax] = useState<number | null>(null);
  const [altitudeFilterMin, setAltitudeFilterMin] = useState<number | null>(null);
  const [altitudeFilterMax, setAltitudeFilterMax] = useState<number | null>(null);
  const [distanceFilterMin, setDistanceFilterMin] = useState<number | null>(null);
  const [distanceFilterMax, setDistanceFilterMax] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOption, setSortOption] = useState<
    'name' | 'date' | 'duration' | 'distance'
  >('date');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [isSortOpen, setIsSortOpen] = useState(false);
  const [sortHighlightedIndex, setSortHighlightedIndex] = useState(0);
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useState(() => {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('filtersCollapsed');
      if (stored !== null) return stored === 'true';
    }
    return true;
  });
  const [isExportDropdownOpen, setIsExportDropdownOpen] = useState(false);
  const [exportHighlightedIndex, setExportHighlightedIndex] = useState(0);
  const [tagHighlightedIndex, setTagHighlightedIndex] = useState(0);
  const [droneHighlightedIndex, setDroneHighlightedIndex] = useState(0);
  const [batteryHighlightedIndex, setBatteryHighlightedIndex] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ done: 0, total: 0, currentFile: '' });
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState({ done: 0, total: 0, currentFile: '' });
  const [confirmUntag, setConfirmUntag] = useState(false);
  const [isUntagging, setIsUntagging] = useState(false);
  const [untagProgress, setUntagProgress] = useState({ done: 0, total: 0 });
  const [showBulkTagInput, setShowBulkTagInput] = useState(false);
  const [bulkTagInput, setBulkTagInput] = useState('');
  const [isBulkTagging, setIsBulkTagging] = useState(false);
  const [bulkTagProgress, setBulkTagProgress] = useState({ done: 0, total: 0 });
  const dateButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortButtonRef = useRef<HTMLButtonElement | null>(null);
  const sortDropdownRef = useRef<HTMLDivElement | null>(null);
  const exportDropdownRef = useRef<HTMLDivElement | null>(null);
  const tagDropdownRef = useRef<HTMLDivElement | null>(null);
  const droneDropdownRef = useRef<HTMLDivElement | null>(null);
  const batteryDropdownRef = useRef<HTMLDivElement | null>(null);

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

  // Prevent all scrolling when overlay is active
  useEffect(() => {
    if (isExporting || isDeleting || isUntagging || isBulkTagging) {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      // Add class to hide all scrollbars
      document.body.classList.add('overlay-active');
      return () => {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
        document.body.classList.remove('overlay-active');
      };
    }
  }, [isExporting, isDeleting, isUntagging, isBulkTagging]);

  // Sync filtered flight IDs to the store so Overview can use them
  // Only sync after flights have loaded to avoid setting an empty Set prematurely
  const setSidebarFilteredFlightIds = useFlightStore((s) => s.setSidebarFilteredFlightIds);
  
  // Apply heatmap date filter when set from Overview (double-click on heatmap day)
  // This effect must run BEFORE the general sync effect to avoid race conditions
  useEffect(() => {
    if (heatmapDateFilter) {
      // Set date range to the single selected day (from and to are the same day)
      // Use separate Date objects to avoid mutation issues
      const fromDate = new Date(heatmapDateFilter);
      fromDate.setHours(0, 0, 0, 0);
      const toDate = new Date(heatmapDateFilter);
      toDate.setHours(0, 0, 0, 0);
      setDateRange({ from: fromDate, to: toDate });
      // Expand filters section if collapsed so user can see the applied filter
      setIsFiltersCollapsed(false);
      // Clear the heatmap filter after applying (one-time action)
      setHeatmapDateFilter(null);
    }
  }, [heatmapDateFilter, setHeatmapDateFilter]);

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

  // Sort dropdown keyboard navigation
  useEffect(() => {
    if (!isSortOpen) {
      setSortHighlightedIndex(0);
      return;
    }
    sortDropdownRef.current?.focus();
  }, [isSortOpen]);

  // Export dropdown keyboard navigation
  useEffect(() => {
    if (!isExportDropdownOpen) {
      setExportHighlightedIndex(0);
      return;
    }
    exportDropdownRef.current?.focus();
  }, [isExportDropdownOpen]);

  // Tag dropdown keyboard navigation
  useEffect(() => {
    if (!isTagDropdownOpen) {
      setTagHighlightedIndex(0);
      return;
    }
  }, [isTagDropdownOpen]);

  const droneOptions = useMemo(() => {
    const entries = flights
      .map((flight) => ({
        key: `${flight.droneModel ?? ''}||${flight.droneSerial ?? ''}`,
        label: (() => {
          const fallback = flight.aircraftName || flight.droneModel || 'Unknown';
          const displayName = flight.droneSerial
            ? getDroneDisplayName(flight.droneSerial, fallback)
            : fallback;
          return `${displayName}${flight.droneSerial ? ` : ${getDisplaySerial(flight.droneSerial)}` : ''}`;
        })(),
      }))
      .filter((entry) => entry.label.trim().length > 0);

    const unique = new Map<string, string>();
    entries.forEach((entry) => {
      if (!unique.has(entry.key)) {
        unique.set(entry.key, entry.label);
      }
    });

    return Array.from(unique.entries()).map(([key, label]) => ({ key, label }));
  }, [flights, getDroneDisplayName, droneNameMap, getDisplaySerial]);

  const batteryOptions = useMemo(() => {
    const unique = new Set<string>();
    flights.forEach((flight) => {
      if (flight.batterySerial) {
        unique.add(flight.batterySerial);
      }
    });
    return Array.from(unique);
  }, [flights]);

  // Helper: filtered & sorted drone list for multi-select dropdown
  const getDroneSorted = useCallback(() => {
    const filtered = droneOptions.filter((d) => d.label.toLowerCase().includes(droneSearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const aSelected = selectedDrones.includes(a.key);
      const bSelected = selectedDrones.includes(b.key);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [droneOptions, droneSearch, selectedDrones]);

  // Helper: filtered & sorted battery list for multi-select dropdown
  const getBatterySorted = useCallback(() => {
    const all = batteryOptions.map((serial) => ({ value: serial, label: getBatteryDisplayName(serial) }));
    const filtered = all.filter((b) => b.label.toLowerCase().includes(batterySearch.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const aSelected = selectedBatteries.includes(a.value);
      const bSelected = selectedBatteries.includes(b.value);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return a.label.localeCompare(b.label);
    });
  }, [batteryOptions, batterySearch, selectedBatteries, getBatteryDisplayName]);

  const durationRange = useMemo(() => {
    const durations = flights
      .map((f) => f.durationSecs ?? 0)
      .filter((d) => d > 0);
    if (durations.length === 0) return { minMins: 0, maxMins: 60 };
    return {
      minMins: Math.floor(Math.min(...durations) / 60),
      maxMins: Math.ceil(Math.max(...durations) / 60),
    };
  }, [flights]);

  const altitudeRange = useMemo(() => {
    const altitudes = flights
      .map((f) => f.maxAltitude ?? 0)
      .filter((a) => a > 0);
    if (altitudes.length === 0) return { min: 0, max: 500 };
    return {
      min: Math.floor(Math.min(...altitudes)),
      max: Math.ceil(Math.max(...altitudes)),
    };
  }, [flights]);

  const distanceRange = useMemo(() => {
    const distances = flights
      .map((f) => f.totalDistance ?? 0)
      .filter((d) => d > 0);
    if (distances.length === 0) return { min: 0, max: 10000 };
    return {
      min: Math.floor(Math.min(...distances)),
      max: Math.ceil(Math.max(...distances)),
    };
  }, [flights]);

  const filteredFlights = useMemo(() => {
    // Always apply filters
    const start = dateRange?.from ?? null;
    const end = dateRange?.to ? new Date(dateRange.to) : null;
    if (end) end.setHours(23, 59, 59, 999);

    const hasAnyFilter = !!(start || end || selectedDrones.length > 0 || selectedBatteries.length > 0 || durationFilterMin !== null || durationFilterMax !== null || altitudeFilterMin !== null || altitudeFilterMax !== null || distanceFilterMin !== null || distanceFilterMax !== null || selectedTags.length > 0 || (mapAreaFilterEnabled && mapVisibleBounds));

    return flights.filter((flight) => {
      // When no filters are active, show all
      if (!hasAnyFilter) return true;

      // Each filter check returns true if the flight matches that filter.
      // Normal mode: AND all filters (must match ALL).
      // Inverted mode: negate each individual filter, then AND (must fail ALL).
      //   i.e. NOT A AND NOT B AND NOT C — exclude flights that match any active filter.

      if (start || end) {
        let matchesDate = true;
        if (!flight.startTime) {
          matchesDate = false;
        } else {
          const flightDate = new Date(flight.startTime);
          if (start && flightDate < start) matchesDate = false;
          if (end && flightDate > end) matchesDate = false;
        }
        if (isFilterInverted ? matchesDate : !matchesDate) return false;
      }

      if (selectedDrones.length > 0) {
        const key = `${flight.droneModel ?? ''}||${flight.droneSerial ?? ''}`;
        const matchesDrone = selectedDrones.includes(key);
        if (isFilterInverted ? matchesDrone : !matchesDrone) return false;
      }

      if (selectedBatteries.length > 0) {
        const matchesBattery = flight.batterySerial ? selectedBatteries.includes(flight.batterySerial) : false;
        if (isFilterInverted ? matchesBattery : !matchesBattery) return false;
      }

      if (durationFilterMin !== null || durationFilterMax !== null) {
        const durationMins = (flight.durationSecs ?? 0) / 60;
        let matchesDuration = true;
        if (durationFilterMin !== null && durationMins < durationFilterMin) matchesDuration = false;
        if (durationFilterMax !== null && durationMins > durationFilterMax) matchesDuration = false;
        if (isFilterInverted ? matchesDuration : !matchesDuration) return false;
      }

      if (altitudeFilterMin !== null || altitudeFilterMax !== null) {
        const altitude = flight.maxAltitude ?? 0;
        let matchesAltitude = true;
        if (altitudeFilterMin !== null && altitude < altitudeFilterMin) matchesAltitude = false;
        if (altitudeFilterMax !== null && altitude > altitudeFilterMax) matchesAltitude = false;
        if (isFilterInverted ? matchesAltitude : !matchesAltitude) return false;
      }

      if (distanceFilterMin !== null || distanceFilterMax !== null) {
        const distance = flight.totalDistance ?? 0;
        let matchesDistance = true;
        if (distanceFilterMin !== null && distance < distanceFilterMin) matchesDistance = false;
        if (distanceFilterMax !== null && distance > distanceFilterMax) matchesDistance = false;
        if (isFilterInverted ? matchesDistance : !matchesDistance) return false;
      }

      // Tag filter: normal = flight must have ALL selected tags; inverted = must have NONE
      if (selectedTags.length > 0) {
        const flightTagNames = (flight.tags ?? []).map(t => typeof t === 'string' ? t : t.tag);
        const matchesTags = selectedTags.every((tag) => flightTagNames.includes(tag));
        if (isFilterInverted ? matchesTags : !matchesTags) return false;
      }

      // Map area filter (not affected by inversion - always AND)
      if (mapAreaFilterEnabled && mapVisibleBounds) {
        if (flight.homeLat == null || flight.homeLon == null) return false;
        const { west, south, east, north } = mapVisibleBounds;
        const inBounds = flight.homeLon >= west && flight.homeLon <= east &&
                         flight.homeLat >= south && flight.homeLat <= north;
        if (!inBounds) return false;
      }

      return true;
    });
  }, [dateRange, flights, selectedBatteries, selectedDrones, durationFilterMin, durationFilterMax, altitudeFilterMin, altitudeFilterMax, distanceFilterMin, distanceFilterMax, selectedTags, isFilterInverted, mapAreaFilterEnabled, mapVisibleBounds]);

  // Sync filtered flight IDs to the store so Overview can use them
  // Use useLayoutEffect to ensure sync happens synchronously before browser paint
  // This prevents Overview from seeing stale/intermediate filter states
  useLayoutEffect(() => {
    // Don't sync if flights haven't loaded yet - this prevents setting an empty Set
    // which would cause Overview to show "no flights" incorrectly
    if (flights.length === 0) return;
    setSidebarFilteredFlightIds(new Set(filteredFlights.map((f) => f.id)));
  }, [flights.length, filteredFlights, setSidebarFilteredFlightIds]);

  // Clear selection if the currently selected flight is not in the filtered results
  useEffect(() => {
    if (selectedFlightId !== null && filteredFlights.length > 0) {
      const isSelectedInFiltered = filteredFlights.some((f) => f.id === selectedFlightId);
      if (!isSelectedInFiltered) {
        clearSelection();
      }
    } else if (selectedFlightId !== null && filteredFlights.length === 0) {
      // No flights match the filter - clear selection
      clearSelection();
    }
  }, [filteredFlights, selectedFlightId, clearSelection]);

  const normalizedSearch = useMemo(
    () => searchQuery.trim().toLowerCase(),
    [searchQuery]
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
  }, [getFlightTitle, searchedFlights, sortDirection, sortOption]);

  // Keyboard navigation: Up/Down arrows to navigate flights
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle if typing in an input field
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      
      // Don't handle if a modal/dropdown is open
      if (isDateOpen || isSortOpen || isTagDropdownOpen || isExportDropdownOpen || editingId !== null) {
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        
        if (sortedFlights.length === 0) return;
        
        // Use previewFlightId if set (during navigation), otherwise use selectedFlightId
        const currentId = previewFlightId ?? (activeView === 'overview' ? overviewHighlightedFlightId : selectedFlightId);
        const currentIndex = currentId 
          ? sortedFlights.findIndex(f => f.id === currentId)
          : -1;
        
        let nextIndex: number;
        if (event.key === 'ArrowDown') {
          nextIndex = currentIndex < sortedFlights.length - 1 ? currentIndex + 1 : 0;
        } else {
          nextIndex = currentIndex > 0 ? currentIndex - 1 : sortedFlights.length - 1;
        }
        
        const nextFlight = sortedFlights[nextIndex];
        if (nextFlight) {
          if (activeView === 'overview') {
            // In overview mode, arrow keys only highlight in the list (no map scroll yet)
            setOverviewHighlightedFlightId(nextFlight.id);
          } else {
            // In flights mode, arrow keys update preview
            setPreviewFlightId(nextFlight.id);
          }
          
          // Scroll the item into view in the flight list
          const flightElement = document.querySelector(`[data-flight-id="${nextFlight.id}"]`);
          flightElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
      
      // Enter key selects and loads the previewed/highlighted flight
      if (event.key === 'Enter') {
        event.preventDefault();
        const targetFlightId = previewFlightId ?? (activeView === 'overview' ? overviewHighlightedFlightId : null);
        if (targetFlightId !== null) {
          if (activeView === 'overview') {
            // In overview mode, Enter scrolls to map and shows the flight
            const mapElement = document.getElementById('overview-cluster-map');
            if (mapElement) {
              smoothScrollToElement(mapElement, 800).then(() => {
                onHighlightFlight?.(targetFlightId);
              });
            } else {
              onHighlightFlight?.(targetFlightId);
            }
          } else {
            // In flights mode, Enter loads the flight
            selectFlight(targetFlightId);
            onSelectFlight?.(targetFlightId);
            setPreviewFlightId(null);
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [sortedFlights, selectedFlightId, previewFlightId, overviewHighlightedFlightId, activeView, selectFlight, onSelectFlight, onHighlightFlight, setOverviewHighlightedFlightId, isDateOpen, isSortOpen, isTagDropdownOpen, isExportDropdownOpen, editingId]);

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

  const sanitizeFileName = (name: string): string => {
    return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').replace(/_{2,}/g, '_');
  };

  const buildCsv = (data: FlightDataResponse): string => {
    const { telemetry, flight } = data;
    if (!telemetry.time || telemetry.time.length === 0) return '';

    const trackAligned = data.track.length === telemetry.time.length;
    const latSeries = telemetry.latitude ?? [];
    const lngSeries = telemetry.longitude ?? [];
    
    // Build metadata JSON for the first row's metadata column
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
    const metadata: Record<string, string | number | null> = {
      format: 'Drone Logbook CSV Export',
      app_version: appVersion,
      exported_at: new Date().toISOString(),
      display_name: flight.displayName,
      drone_model: flight.droneModel,
      drone_serial: flight.droneSerial,
      aircraft_name: flight.aircraftName,
      battery_serial: flight.batterySerial,
      start_time: flight.startTime,
      duration_secs: flight.durationSecs,
      total_distance_m: flight.totalDistance,
      max_altitude_m: flight.maxAltitude,
      max_speed_ms: flight.maxSpeed,
      home_lat: flight.homeLat ?? null,
      home_lon: flight.homeLon ?? null,
    };
    // Remove null values for cleaner JSON
    const cleanMetadata = Object.fromEntries(
      Object.entries(metadata).filter(([_, v]) => v != null)
    );
    const metadataJson = JSON.stringify(cleanMetadata);

    // Calculate distance to home
    const computeDistanceToHome = () => {
      const lats = telemetry.latitude ?? [];
      const lngs = telemetry.longitude ?? [];
      let homeLat: number | null = null;
      let homeLng: number | null = null;
      for (let i = 0; i < lats.length; i += 1) {
        const lat = lats[i];
        const lng = lngs[i];
        if (typeof lat === 'number' && typeof lng === 'number') {
          homeLat = lat;
          homeLng = lng;
          break;
        }
      }
      if (homeLat === null || homeLng === null) {
        return telemetry.time.map(() => null);
      }

      return telemetry.time.map((_, index) => {
        const lat = lats[index];
        const lng = lngs[index];
        if (typeof lat !== 'number' || typeof lng !== 'number') return null;
        const toRad = (value: number) => (value * Math.PI) / 180;
        const r = 6371000;
        const dLat = toRad(lat - homeLat);
        const dLon = toRad(lng - homeLng);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(homeLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return r * c;
      });
    };

    const distanceToHome = computeDistanceToHome();

    const headers = [
      'time_s',
      'lat',
      'lng',
      'alt_m',
      'distance_to_home_m',
      'height_m',
      'vps_height_m',
      'altitude_m',
      'speed_ms',
      'velocity_x_ms',
      'velocity_y_ms',
      'velocity_z_ms',
      'battery_percent',
      'battery_voltage_v',
      'battery_temp_c',
      'satellites',
      'rc_signal',
      'rc_uplink',
      'rc_downlink',
      'pitch_deg',
      'roll_deg',
      'yaw_deg',
      'rc_aileron',
      'rc_elevator',
      'rc_throttle',
      'rc_rudder',
      'is_photo',
      'is_video',
      'flight_mode',
      'metadata',
    ];

    const escapeCsv = (value: string) => {
      if (value.includes('"')) value = value.replace(/"/g, '""');
      if (value.includes(',') || value.includes('\n') || value.includes('\r')) {
        return `"${value}"`;
      }
      return value;
    };

    const getValue = (arr: (number | null)[] | undefined, index: number) => {
      const val = arr?.[index];
      return val === null || val === undefined ? '' : String(val);
    };

    const getBoolValue = (arr: (boolean | null)[] | undefined, index: number) => {
      const val = arr?.[index];
      return val === null || val === undefined ? '' : val ? '1' : '0';
    };

    const getStrValue = (arr: (string | null)[] | undefined, index: number) => {
      const val = arr?.[index];
      return val === null || val === undefined ? '' : val;
    };

    const rows = telemetry.time.map((time, index) => {
      const track = trackAligned ? data.track[index] : null;
      const lat = track ? track[1] : latSeries[index];
      const lng = track ? track[0] : lngSeries[index];
      const alt = track ? track[2] : '';
      const values = [
        String(time),
        lat === null || lat === undefined ? '' : String(lat),
        lng === null || lng === undefined ? '' : String(lng),
        alt === null || alt === undefined ? '' : String(alt),
        distanceToHome[index] === null || distanceToHome[index] === undefined
          ? ''
          : String(distanceToHome[index]),
        getValue(telemetry.height, index),
        getValue(telemetry.vpsHeight, index),
        getValue(telemetry.altitude, index),
        getValue(telemetry.speed, index),
        getValue(telemetry.velocityX, index),
        getValue(telemetry.velocityY, index),
        getValue(telemetry.velocityZ, index),
        getValue(telemetry.battery, index),
        getValue(telemetry.batteryVoltage, index),
        getValue(telemetry.batteryTemp, index),
        getValue(telemetry.satellites, index),
        getValue(telemetry.rcSignal, index),
        getValue(telemetry.rcUplink, index),
        getValue(telemetry.rcDownlink, index),
        getValue(telemetry.pitch, index),
        getValue(telemetry.roll, index),
        getValue(telemetry.yaw, index),
        getValue(telemetry.rcAileron, index),
        getValue(telemetry.rcElevator, index),
        getValue(telemetry.rcThrottle, index),
        getValue(telemetry.rcRudder, index),
        getBoolValue(telemetry.isPhoto, index),
        getBoolValue(telemetry.isVideo, index),
        getStrValue(telemetry.flightMode, index),
        // Metadata JSON only on first row (time 0)
        index === 0 ? metadataJson : '',
      ].map(escapeCsv);
      return values.join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  };

  const buildJson = (data: FlightDataResponse): string => {
    // Create an enriched export with explicit metadata for re-import support
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
    const exportData = {
      _exportInfo: {
        format: 'Drone Logbook JSON Export',
        appVersion,
        exportedAt: new Date().toISOString(),
      },
      flight: data.flight,
      telemetry: data.telemetry,
      track: data.track,
    };
    return JSON.stringify(exportData, null, 2);
  };

  const escapeXml = (str: string | number | null | undefined): string => {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  const buildGpx = (data: FlightDataResponse): string => {
    if (!data.telemetry.time || data.telemetry.time.length === 0) return '';

    // Get flight start time as Unix timestamp in milliseconds
    const startTimeMs = data.flight.startTime ? new Date(data.flight.startTime).getTime() : null;
    
    // Use telemetry arrays directly (they're all aligned) instead of track which may be downsampled differently
    const points = data.telemetry.time
      .map((relativeTime, index) => {
        const lat = data.telemetry.latitude?.[index];
        const lng = data.telemetry.longitude?.[index];
        const alt = data.telemetry.altitude?.[index];
        if (lat == null || lng == null) return null;
        // telemetry.time is seconds from flight start, convert to absolute timestamp
        const absoluteTimeMs = startTimeMs != null && relativeTime != null 
          ? startTimeMs + (relativeTime * 1000) 
          : null;
        return `    <trkpt lat="${lat}" lon="${lng}">
      ${alt != null ? `<ele>${alt}</ele>` : ''}
      ${absoluteTimeMs != null ? `<time>${new Date(absoluteTimeMs).toISOString()}</time>` : ''}
    </trkpt>`;
      })
      .filter(Boolean)
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Drone Logbook">
  <trk>
    <name>${escapeXml((data.flight as any).original_filename || 'Flight')}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
  };

  const buildKml = (data: FlightDataResponse): string => {
    if (!data.track || data.track.length === 0) return '';

    const coordinates = data.track
      .map(([lng, lat, alt]) => {
        if (lat == null || lng == null) return null;
        return `${lng},${lat}${alt != null ? `,${alt}` : ''}`;
      })
      .filter(Boolean)
      .join(' ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml((data.flight as any).original_filename || 'Flight')}</name>
    <Placemark>
      <name>Flight Path</name>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${coordinates}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
  };

  const buildSummaryCsv = (flightsData: { flight: Flight; data: FlightDataResponse }[], getDroneDisplayNameFn: (serial: string, fallbackName: string) => string): string => {
    const headers = [
      'Aircraft Name',
      'Aircraft SN',
      'Battery SN',
      'Date',
      'Takeoff Time',
      'Duration',
      'Landing Time',
      'Travelled Distance (m)',
      'Max Altitude (m)',
      'Max Distance from Home (m)',
      'Max Velocity (m/s)',
      'Takeoff Lat',
      'Takeoff Lon',
    ];

    const escapeCsv = (value: string) => {
      if (value.includes('"')) value = value.replace(/"/g, '""');
      if (value.includes(',') || value.includes('\n') || value.includes('\r')) {
        return `"${value}"`;
      }
      return value;
    };

    const formatDuration = (seconds: number | null): string => {
      if (!seconds) return '';
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return `${mins}m ${secs}s`;
    };

    const formatTime = (isoString: string | null): string => {
      if (!isoString) return '';
      const date = new Date(isoString);
      return date.toTimeString().slice(0, 5); // HH:MM
    };

    const formatDate = (isoString: string | null): string => {
      if (!isoString) return '';
      const date = new Date(isoString);
      return date.toISOString().split('T')[0]; // YYYY-MM-DD
    };

    const calculateLandingTime = (takeoffTime: string | null, durationSecs: number | null): string => {
      if (!takeoffTime || !durationSecs) return '';
      const takeoff = new Date(takeoffTime);
      const landing = new Date(takeoff.getTime() + durationSecs * 1000);
      return landing.toTimeString().slice(0, 5); // HH:MM
    };

    const calculateMaxDistanceFromHome = (telemetry: TelemetryData): number | null => {
      const lats = telemetry.latitude ?? [];
      const lngs = telemetry.longitude ?? [];
      
      let homeLat: number | null = null;
      let homeLng: number | null = null;
      for (let i = 0; i < lats.length; i++) {
        const lat = lats[i];
        const lng = lngs[i];
        if (typeof lat === 'number' && typeof lng === 'number') {
          homeLat = lat;
          homeLng = lng;
          break;
        }
      }
      
      if (homeLat === null || homeLng === null) return null;

      let maxDistance = 0;
      for (let i = 0; i < lats.length; i++) {
        const lat = lats[i];
        const lng = lngs[i];
        if (typeof lat !== 'number' || typeof lng !== 'number') continue;
        
        const toRad = (value: number) => (value * Math.PI) / 180;
        const r = 6371000;
        const dLat = toRad(lat - homeLat);
        const dLon = toRad(lng - homeLng);
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(homeLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = r * c;
        
        if (distance > maxDistance) maxDistance = distance;
      }
      
      return maxDistance;
    };

    const rows = flightsData.map(({ flight, data }) => {
      const maxDistanceFromHome = calculateMaxDistanceFromHome(data.telemetry);
      const takeoffLat = flight.homeLat ?? (data.telemetry.latitude?.[0] || null);
      const takeoffLon = flight.homeLon ?? (data.telemetry.longitude?.[0] || null);
      
      // Get aircraft name - use edited name if available, otherwise fall back to aircraftName or droneModel
      const fallbackName = flight.aircraftName || flight.droneModel || '';
      const aircraftName = flight.droneSerial 
        ? getDroneDisplayNameFn(flight.droneSerial, fallbackName) 
        : fallbackName;

      return [
        escapeCsv(aircraftName),
        escapeCsv(flight.droneSerial || ''),
        escapeCsv(flight.batterySerial || ''),
        escapeCsv(formatDate(flight.startTime)),
        escapeCsv(formatTime(flight.startTime)),
        escapeCsv(formatDuration(flight.durationSecs)),
        escapeCsv(calculateLandingTime(flight.startTime, flight.durationSecs)),
        escapeCsv(flight.totalDistance != null ? flight.totalDistance.toFixed(2) : ''),
        escapeCsv(flight.maxAltitude != null ? flight.maxAltitude.toFixed(2) : ''),
        escapeCsv(maxDistanceFromHome != null ? maxDistanceFromHome.toFixed(2) : ''),
        escapeCsv(flight.maxSpeed != null ? flight.maxSpeed.toFixed(2) : ''),
        escapeCsv(takeoffLat != null ? takeoffLat.toFixed(7) : ''),
        escapeCsv(takeoffLon != null ? takeoffLon.toFixed(7) : ''),
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  };

  const handleBulkExport = async (format: string, extension: string) => {
    try {
      setIsExporting(true);
      setExportProgress({ done: 0, total: filteredFlights.length, currentFile: '' });
      
      const flightsData: { flight: Flight; data: FlightDataResponse }[] = [];

      // In Tauri mode, pick a directory first
      let dirPath: string | null = null;
      if (!isWebMode()) {
        const { open } = await import('@tauri-apps/plugin-dialog');
        dirPath = await open({ directory: true, multiple: false }) as string | null;
        if (!dirPath) {
          setIsExporting(false);
          return;
        }
      }

      // For web mode, collect files in a ZIP
      const zip = isWebMode() ? new JSZip() : null;

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        const baseName = flight.displayName || flight.fileName || `flight`;
        const safeName = sanitizeFileName(`${baseName}_${flight.id}`);
        setExportProgress({ done: i, total: filteredFlights.length, currentFile: safeName });
        
        try {
          const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);

          // Store for summary
          flightsData.push({ flight, data });

          let content = '';
          if (format === 'csv') content = buildCsv(data);
          else if (format === 'json') content = buildJson(data);
          else if (format === 'gpx') content = buildGpx(data);
          else if (format === 'kml') content = buildKml(data);

          if (isWebMode() && zip) {
            // Add file to ZIP
            zip.file(`${safeName}.${extension}`, content);
          } else if (!isWebMode()) {
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(`${dirPath}/${safeName}.${extension}`, content);
          }
        } catch (err) {
          console.error(`Failed to export flight ${flight.id}:`, err);
        }
      }

      // For web mode, generate and download the ZIP file
      if (isWebMode() && zip) {
        setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: 'Creating ZIP...' });
        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const timestamp = new Date().toISOString().slice(0, 10);
        downloadBlob(`drone_flights_${timestamp}_${format}.zip`, zipBlob);
      }

      setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
      setTimeout(() => setIsExporting(false), 1000);
    } catch (err) {
      console.error('Export failed:', err);
      setIsExporting(false);
    }
  };

  const handleSummaryExport = async () => {
    if (filteredFlights.length <= 1) return;
    
    try {
      setIsExporting(true);
      setExportProgress({ done: 0, total: filteredFlights.length, currentFile: 'Building summary...' });
      
      const flightsData: { flight: Flight; data: FlightDataResponse }[] = [];

      // In Tauri mode, pick a file location first
      let filePath: string | null = null;
      if (!isWebMode()) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        filePath = await save({
          defaultPath: 'filtered_flights_summary.csv',
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        }) as string | null;
        if (!filePath) {
          setIsExporting(false);
          return;
        }
      }

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        const baseName = flight.displayName || flight.fileName || `flight`;
        const safeName = sanitizeFileName(`${baseName}_${flight.id}`);
        setExportProgress({ done: i, total: filteredFlights.length, currentFile: safeName });
        
        try {
          const data: FlightDataResponse = await api.getFlightData(flight.id, 999999999);
          flightsData.push({ flight, data });
        } catch (err) {
          console.error(`Failed to fetch flight ${flight.id} for summary:`, err);
        }
      }

      const summaryCsv = buildSummaryCsv(flightsData, getDroneDisplayName);
      
      if (isWebMode()) {
        downloadFile('filtered_flights_summary.csv', summaryCsv);
      } else {
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(filePath!, summaryCsv);
      }

      setExportProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
      setTimeout(() => setIsExporting(false), 1000);
    } catch (err) {
      console.error('Summary export failed:', err);
      setIsExporting(false);
    }
  };

  const handleBulkDelete = async () => {
    try {
      setIsDeleting(true);
      setConfirmBulkDelete(false);
      setDeleteProgress({ done: 0, total: filteredFlights.length, currentFile: '' });

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        setDeleteProgress({ done: i, total: filteredFlights.length, currentFile: flight.fileName || '' });
        
        // Add to blacklist before deleting (so sync won't re-import)
        if (flight.fileHash) {
          addToBlacklist(flight.fileHash);
        }
        
        await deleteFlight(flight.id);
      }

      setDeleteProgress({ done: filteredFlights.length, total: filteredFlights.length, currentFile: '' });
      setTimeout(() => setIsDeleting(false), 1000);
    } catch (err) {
      console.error('Delete failed:', err);
      setIsDeleting(false);
    }
  };

  // Handle bulk untag (remove selected tags from filtered flights)
  const handleBulkUntag = async () => {
    if (selectedTags.length === 0 || filteredFlights.length === 0) return;
    
    try {
      setIsUntagging(true);
      setConfirmUntag(false);
      const tagsToRemove = [...selectedTags];
      const flightsToProcess = filteredFlights.filter(f => 
        f.tags?.some(t => tagsToRemove.includes(t.tag))
      );
      
      if (flightsToProcess.length === 0) {
        setIsUntagging(false);
        return;
      }
      
      setUntagProgress({ done: 0, total: flightsToProcess.length });

      for (let i = 0; i < flightsToProcess.length; i++) {
        const flight = flightsToProcess[i];
        setUntagProgress({ done: i, total: flightsToProcess.length });
        
        // Remove each selected tag from this flight
        for (const tag of tagsToRemove) {
          if (flight.tags?.some(t => t.tag === tag)) {
            await removeTag(flight.id, tag);
          }
        }
      }

      setUntagProgress({ done: flightsToProcess.length, total: flightsToProcess.length });
      // Clear the tag filter since those tags may no longer exist
      setSelectedTags([]);
      // Refresh all tags list and clear cache so UI reflects changes
      await loadAllTags();
      clearFlightDataCache();
      setTimeout(() => setIsUntagging(false), 500);
    } catch (err) {
      console.error('Untag failed:', err);
      setIsUntagging(false);
    }
  };

  // Handle bulk tag (add a tag to all filtered flights)
  const handleBulkTag = async () => {
    const tagToAdd = bulkTagInput.trim();
    if (!tagToAdd || filteredFlights.length === 0) {
      setShowBulkTagInput(false);
      setBulkTagInput('');
      return;
    }
    
    try {
      setIsBulkTagging(true);
      setShowBulkTagInput(false);
      setBulkTagProgress({ done: 0, total: filteredFlights.length });

      for (let i = 0; i < filteredFlights.length; i++) {
        const flight = filteredFlights[i];
        setBulkTagProgress({ done: i, total: filteredFlights.length });
        
        // Only add if flight doesn't already have this tag
        if (!flight.tags?.some(t => t.tag === tagToAdd)) {
          await addTag(flight.id, tagToAdd);
        }
      }

      setBulkTagProgress({ done: filteredFlights.length, total: filteredFlights.length });
      setBulkTagInput('');
      // Refresh all tags list and clear cache so UI reflects changes
      await loadAllTags();
      clearFlightDataCache();
      setTimeout(() => setIsBulkTagging(false), 500);
    } catch (err) {
      console.error('Bulk tag failed:', err);
      setIsBulkTagging(false);
    }
  };

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
    <div className="flex flex-col flex-1 min-h-0" onClick={() => {
      setConfirmDeleteId(null);
      setConfirmBulkDelete(false);
    }}>
        <div className="border-b border-gray-700 flex-shrink-0">
        {/* Collapsible filter header */}
        <button
          type="button"
          onClick={() => setIsFiltersCollapsed((v) => {
            const next = !v;
            localStorage.setItem('filtersCollapsed', String(next));
            return next;
          })}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-400 hover:text-white transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <span className={`font-medium ${(dateRange?.from || dateRange?.to || selectedDrones.length > 0 || selectedBatteries.length > 0 || durationFilterMin !== null || durationFilterMax !== null || altitudeFilterMin !== null || altitudeFilterMax !== null || distanceFilterMin !== null || distanceFilterMax !== null || selectedTags.length > 0 || mapAreaFilterEnabled) ? (isFilterInverted ? 'text-red-400' : 'text-emerald-400') : ''}`}>
              {dateRange?.from || dateRange?.to || selectedDrones.length > 0 || selectedBatteries.length > 0 || durationFilterMin !== null || durationFilterMax !== null || altitudeFilterMin !== null || altitudeFilterMax !== null || distanceFilterMin !== null || distanceFilterMax !== null || selectedTags.length > 0 || mapAreaFilterEnabled
                ? isFilterInverted ? 'Filters — Active — Inverted' : 'Filters — Active'
                : isFiltersCollapsed ? 'Filters — click to expand' : 'Filters'}
            </span>
            {(dateRange?.from || dateRange?.to || selectedDrones.length > 0 || selectedBatteries.length > 0 || durationFilterMin !== null || durationFilterMax !== null || altitudeFilterMin !== null || altitudeFilterMax !== null || distanceFilterMin !== null || distanceFilterMax !== null || selectedTags.length > 0 || mapAreaFilterEnabled) && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsFilterInverted((v) => !v);
                }}
                title={isFilterInverted ? 'Switch to normal filtering' : 'Invert filter selection'}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors ${
                  isFilterInverted
                    ? 'text-red-400 bg-red-500/20 hover:bg-red-500/30'
                    : 'text-gray-400 hover:text-emerald-400 hover:bg-emerald-500/10'
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1-.25 1.94-.68 2.77l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1 .25-1.94.68-2.77L5.22 7.77C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
                </svg>
              </button>
            )}
          </span>
          <span
            className={`w-5 h-5 rounded-full border border-gray-600 flex items-center justify-center transition-transform duration-200 ${
              isFiltersCollapsed ? 'rotate-180' : ''
            }`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
          </span>
        </button>

        {/* Collapsible filter body */}
        <div
          className={`transition-all duration-200 ease-in-out ${
            isFiltersCollapsed ? 'max-h-0 overflow-hidden opacity-0' : 'max-h-[600px] overflow-visible opacity-100'
          }`}
        >
        <div className="px-3 pb-3 space-y-3">
        {/* Map area filter toggle */}
        <div className="flex items-center justify-between">
          <label className="text-xs text-gray-400">Overview map area filter</label>
          <button
            type="button"
            onClick={() => setMapAreaFilterEnabled(!mapAreaFilterEnabled)}
            className="flex items-center gap-2"
            aria-pressed={mapAreaFilterEnabled}
          >
            <span
              className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${
                mapAreaFilterEnabled
                  ? 'bg-drone-primary/90 border-drone-primary'
                  : 'bg-drone-surface border-gray-600 toggle-track-off'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  mapAreaFilterEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>

        {/* Duration range slider */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0 text-center">Duration</label>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <div className="flex-1 min-w-0">
              {(() => {
                const lo = durationFilterMin ?? durationRange.minMins;
                const hi = durationFilterMax ?? durationRange.maxMins;
                const span = Math.max(durationRange.maxMins - durationRange.minMins, 1);
                const loPct = ((lo - durationRange.minMins) / span) * 100;
                const hiPct = ((hi - durationRange.minMins) / span) * 100;
                return (
                  <div className="dual-range-wrap" style={{ '--lo-pct': `${loPct}%`, '--hi-pct': `${hiPct}%` } as React.CSSProperties}>
                    <div className="dual-range-track" />
                    <div className="dual-range-fill" />
                    <input
                      type="range"
                      min={durationRange.minMins}
                      max={durationRange.maxMins}
                      step={1}
                      value={lo}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        const clamped = Math.min(val, hi - 1);
                        setDurationFilterMin(clamped <= durationRange.minMins ? null : clamped);
                      }}
                      className="dual-range-input"
                    />
                    <input
                      type="range"
                      min={durationRange.minMins}
                      max={durationRange.maxMins}
                      step={1}
                      value={hi}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        const clamped = Math.max(val, lo + 1);
                        setDurationFilterMax(clamped >= durationRange.maxMins ? null : clamped);
                      }}
                      className="dual-range-input"
                    />
                  </div>
                );
              })()}
            </div>
            <span className={`text-xs font-medium whitespace-nowrap min-w-[60px] flex items-center justify-center flex-shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
              {(() => {
                const lo = durationFilterMin ?? durationRange.minMins;
                const hi = durationFilterMax ?? durationRange.maxMins;
                const fmt = (m: number) => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 > 0 ? m % 60 : ''}` : `${m}m`;
                if (durationFilterMin === null && durationFilterMax === null) return 'Any';
                return `${fmt(lo)}–${fmt(hi)}`;
              })()}
            </span>
          </div>
        </div>

        {/* Max Altitude range slider */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0 text-center">Altitude</label>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <div className="flex-1 min-w-0">
              {(() => {
                const lo = altitudeFilterMin ?? altitudeRange.min;
                const hi = altitudeFilterMax ?? altitudeRange.max;
                const span = Math.max(altitudeRange.max - altitudeRange.min, 1);
                const loPct = ((lo - altitudeRange.min) / span) * 100;
                const hiPct = ((hi - altitudeRange.min) / span) * 100;
                return (
                  <div className="dual-range-wrap" style={{ '--lo-pct': `${loPct}%`, '--hi-pct': `${hiPct}%` } as React.CSSProperties}>
                    <div className="dual-range-track" />
                    <div className="dual-range-fill" />
                    <input
                      type="range"
                      min={altitudeRange.min}
                      max={altitudeRange.max}
                      step={1}
                      value={lo}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        const clamped = Math.min(val, hi - 1);
                        setAltitudeFilterMin(clamped <= altitudeRange.min ? null : clamped);
                      }}
                      className="dual-range-input"
                    />
                    <input
                      type="range"
                      min={altitudeRange.min}
                      max={altitudeRange.max}
                      step={1}
                      value={hi}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        const clamped = Math.max(val, lo + 1);
                        setAltitudeFilterMax(clamped >= altitudeRange.max ? null : clamped);
                      }}
                      className="dual-range-input"
                    />
                  </div>
                );
              })()}
            </div>
            <span className={`text-xs font-medium whitespace-nowrap min-w-[60px] flex items-center justify-center flex-shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
              {(() => {
                const lo = altitudeFilterMin ?? altitudeRange.min;
                const hi = altitudeFilterMax ?? altitudeRange.max;
                const fmt = (m: number) => unitSystem === 'imperial' ? `${Math.round(m * 3.28084)}ft` : `${m}m`;
                if (altitudeFilterMin === null && altitudeFilterMax === null) return 'Any';
                return `${fmt(lo)}–${fmt(hi)}`;
              })()}
            </span>
          </div>
        </div>

        {/* Total Distance range slider */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0 text-center">Distance</label>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <div className="flex-1 min-w-0">
              {(() => {
                const lo = distanceFilterMin ?? distanceRange.min;
                const hi = distanceFilterMax ?? distanceRange.max;
                const span = Math.max(distanceRange.max - distanceRange.min, 1);
                const loPct = ((lo - distanceRange.min) / span) * 100;
                const hiPct = ((hi - distanceRange.min) / span) * 100;
                return (
                  <div className="dual-range-wrap" style={{ '--lo-pct': `${loPct}%`, '--hi-pct': `${hiPct}%` } as React.CSSProperties}>
                    <div className="dual-range-track" />
                    <div className="dual-range-fill" />
                    <input
                      type="range"
                      min={distanceRange.min}
                      max={distanceRange.max}
                      step={1}
                      value={lo}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        const clamped = Math.min(val, hi - 1);
                        setDistanceFilterMin(clamped <= distanceRange.min ? null : clamped);
                      }}
                      className="dual-range-input"
                    />
                    <input
                      type="range"
                      min={distanceRange.min}
                      max={distanceRange.max}
                      step={1}
                      value={hi}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        const clamped = Math.max(val, lo + 1);
                        setDistanceFilterMax(clamped >= distanceRange.max ? null : clamped);
                      }}
                      className="dual-range-input"
                    />
                  </div>
                );
              })()}
            </div>
            <span className={`text-xs font-medium whitespace-nowrap min-w-[60px] flex items-center justify-center flex-shrink-0 ${isLight ? 'text-gray-700' : 'text-gray-200'}`}>
              {(() => {
                const lo = distanceFilterMin ?? distanceRange.min;
                const hi = distanceFilterMax ?? distanceRange.max;
                const fmt = (m: number) => {
                  if (unitSystem === 'imperial') {
                    const miles = m * 0.000621371;
                    return miles >= 1 ? `${miles.toFixed(1)}mi` : `${Math.round(m * 3.28084)}ft`;
                  }
                  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
                };
                if (distanceFilterMin === null && distanceFilterMax === null) return 'Any';
                return `${fmt(lo)}–${fmt(hi)}`;
              })()}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">Date</label>
          <button
            ref={dateButtonRef}
            type="button"
            onClick={() => setIsDateOpen((open) => !open)}
            className="input flex-1 text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
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
                className="fixed z-50 rounded-xl border border-gray-700 bg-drone-surface p-3 shadow-xl"
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

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">Drone</label>
          <div className="relative flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setIsDroneDropdownOpen((v) => !v)}
              className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
            >
              <span className={`truncate ${selectedDrones.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                {selectedDrones.length > 0
                  ? selectedDrones.map((k) => droneOptions.find((d) => d.key === k)?.label ?? k).join(', ')
                  : 'All drones'}
              </span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            {isDroneDropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => { setIsDroneDropdownOpen(false); setDroneSearch(''); }}
                />
                <div
                  ref={droneDropdownRef}
                  className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                >
                  {droneOptions.length > 4 && (
                    <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                      <input
                        type="text"
                        value={droneSearch}
                        onChange={(e) => { setDroneSearch(e.target.value); setDroneHighlightedIndex(0); }}
                        onKeyDown={(e) => {
                          const sorted = getDroneSorted();
                          if (e.key === 'ArrowDown') { e.preventDefault(); setDroneHighlightedIndex((prev) => prev < sorted.length - 1 ? prev + 1 : 0); }
                          else if (e.key === 'ArrowUp') { e.preventDefault(); setDroneHighlightedIndex((prev) => prev > 0 ? prev - 1 : sorted.length - 1); }
                          else if (e.key === 'Enter' && sorted.length > 0) {
                            e.preventDefault();
                            const item = sorted[droneHighlightedIndex];
                            if (item) setSelectedDrones((prev) => prev.includes(item.key) ? prev.filter((k) => k !== item.key) : [...prev, item.key]);
                          } else if (e.key === 'Escape') { e.preventDefault(); setIsDroneDropdownOpen(false); setDroneSearch(''); }
                        }}
                        placeholder="Search drones…"
                        autoFocus
                        className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                      />
                    </div>
                  )}
                  <div className="overflow-auto flex-1">
                    {(() => {
                      const sorted = getDroneSorted();
                      if (sorted.length === 0) return <p className="text-xs text-gray-500 px-3 py-2">No matching drones</p>;
                      return sorted.map((drone, index) => {
                        const isSelected = selectedDrones.includes(drone.key);
                        return (
                          <button
                            key={drone.key}
                            type="button"
                            onClick={() => setSelectedDrones((prev) => isSelected ? prev.filter((k) => k !== drone.key) : [...prev, drone.key])}
                            onMouseEnter={() => setDroneHighlightedIndex(index)}
                            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                              isSelected ? 'bg-sky-500/20 text-gray-800 dark:text-sky-200' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                            } ${index === droneHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                          >
                            <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                              isSelected ? 'border-sky-500 bg-sky-500' : 'border-gray-400 dark:border-gray-600'
                            }`}>
                              {isSelected && (
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                              )}
                            </span>
                            <span className="truncate">{drone.label}</span>
                          </button>
                        );
                      });
                    })()}
                    {selectedDrones.length > 0 && (
                      <button
                        type="button"
                        onClick={() => { setSelectedDrones([]); setDroneSearch(''); setIsDroneDropdownOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                      >
                        Clear drone filter
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">Battery</label>
          <div className="relative flex-1 min-w-0">
            <button
              type="button"
              onClick={() => setIsBatteryDropdownOpen((v) => !v)}
              className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
            >
              <span className={`truncate ${selectedBatteries.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                {selectedBatteries.length > 0
                  ? selectedBatteries.map((s) => getBatteryDisplayName(s)).join(', ')
                  : 'All batteries'}
              </span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            {isBatteryDropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => { setIsBatteryDropdownOpen(false); setBatterySearch(''); }}
                />
                <div
                  ref={batteryDropdownRef}
                  className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                >
                  {batteryOptions.length > 4 && (
                    <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                      <input
                        type="text"
                        value={batterySearch}
                        onChange={(e) => { setBatterySearch(e.target.value); setBatteryHighlightedIndex(0); }}
                        onKeyDown={(e) => {
                          const sorted = getBatterySorted();
                          if (e.key === 'ArrowDown') { e.preventDefault(); setBatteryHighlightedIndex((prev) => prev < sorted.length - 1 ? prev + 1 : 0); }
                          else if (e.key === 'ArrowUp') { e.preventDefault(); setBatteryHighlightedIndex((prev) => prev > 0 ? prev - 1 : sorted.length - 1); }
                          else if (e.key === 'Enter' && sorted.length > 0) {
                            e.preventDefault();
                            const item = sorted[batteryHighlightedIndex];
                            if (item) setSelectedBatteries((prev) => prev.includes(item.value) ? prev.filter((k) => k !== item.value) : [...prev, item.value]);
                          } else if (e.key === 'Escape') { e.preventDefault(); setIsBatteryDropdownOpen(false); setBatterySearch(''); }
                        }}
                        placeholder="Search batteries…"
                        autoFocus
                        className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                      />
                    </div>
                  )}
                  <div className="overflow-auto flex-1">
                    {(() => {
                      const sorted = getBatterySorted();
                      if (sorted.length === 0) return <p className="text-xs text-gray-500 px-3 py-2">No matching batteries</p>;
                      return sorted.map((bat, index) => {
                        const isSelected = selectedBatteries.includes(bat.value);
                        return (
                          <button
                            key={bat.value}
                            type="button"
                            onClick={() => setSelectedBatteries((prev) => isSelected ? prev.filter((k) => k !== bat.value) : [...prev, bat.value])}
                            onMouseEnter={() => setBatteryHighlightedIndex(index)}
                            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                              isSelected ? 'bg-amber-500/20 text-gray-800 dark:text-amber-200' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                            } ${index === batteryHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                          >
                            <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                              isSelected ? 'border-amber-500 bg-amber-500' : 'border-gray-400 dark:border-gray-600'
                            }`}>
                              {isSelected && (
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                              )}
                            </span>
                            <span className="truncate">{bat.label}</span>
                          </button>
                        );
                      });
                    })()}
                    {selectedBatteries.length > 0 && (
                      <button
                        type="button"
                        onClick={() => { setSelectedBatteries([]); setBatterySearch(''); setIsBatteryDropdownOpen(false); }}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                      >
                        Clear battery filter
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Tag filter */}
        {allTags.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-400 whitespace-nowrap w-[52px] flex-shrink-0">Tags</label>
            <div className="relative flex-1 min-w-0">
              <button
                type="button"
                onClick={() => setIsTagDropdownOpen((v) => !v)}
                className="input w-full text-xs h-8 px-3 py-1.5 flex items-center justify-between gap-2"
              >
                <span className={`truncate ${selectedTags.length > 0 ? 'text-gray-100' : 'text-gray-400'}`}>
                  {selectedTags.length > 0 ? selectedTags.join(', ') : 'All tags'}
                </span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              {isTagDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => { setIsTagDropdownOpen(false); setTagSearch(''); }}
                  />
                  <div
                    ref={tagDropdownRef}
                    className="absolute left-0 right-0 top-full mt-1 z-50 max-h-56 rounded-lg border border-gray-700 bg-drone-surface shadow-xl flex flex-col overflow-hidden"
                  >
                    {/* Search input */}
                    <div className="px-2 pt-2 pb-1 border-b border-gray-700 flex-shrink-0">
                      <input
                        type="text"
                        value={tagSearch}
                        onChange={(e) => { setTagSearch(e.target.value); setTagHighlightedIndex(0); }}
                        onKeyDown={(e) => {
                          const filtered = allTags.filter((tag) => tag.toLowerCase().includes(tagSearch.toLowerCase()));
                          const sorted = [...filtered].sort((a, b) => {
                            const aSelected = selectedTags.includes(a);
                            const bSelected = selectedTags.includes(b);
                            if (aSelected && !bSelected) return -1;
                            if (!aSelected && bSelected) return 1;
                            return a.localeCompare(b);
                          });
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setTagHighlightedIndex(prev => prev < sorted.length - 1 ? prev + 1 : 0);
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setTagHighlightedIndex(prev => prev > 0 ? prev - 1 : sorted.length - 1);
                          } else if (e.key === 'Enter' && sorted.length > 0) {
                            e.preventDefault();
                            const tag = sorted[tagHighlightedIndex];
                            if (tag) {
                              setSelectedTags((prev) =>
                                prev.includes(tag)
                                  ? prev.filter((t) => t !== tag)
                                  : [...prev, tag]
                              );
                            }
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setIsTagDropdownOpen(false);
                            setTagSearch('');
                          }
                        }}
                        placeholder="Search tags…"
                        autoFocus
                        className="w-full bg-drone-dark text-xs text-gray-200 rounded px-2 py-1 border border-gray-600 focus:border-drone-primary focus:outline-none placeholder-gray-500"
                      />
                    </div>
                    <div className="overflow-auto flex-1">
                    {(() => {
                      const filtered = allTags.filter((tag) => tag.toLowerCase().includes(tagSearch.toLowerCase()));
                      if (filtered.length === 0) {
                        return <p className="text-xs text-gray-500 px-3 py-2">No matching tags</p>;
                      }
                      // Sort: selected tags first, then unselected alphabetically
                      const sorted = [...filtered].sort((a, b) => {
                        const aSelected = selectedTags.includes(a);
                        const bSelected = selectedTags.includes(b);
                        if (aSelected && !bSelected) return -1;
                        if (!aSelected && bSelected) return 1;
                        return a.localeCompare(b);
                      });
                      return sorted.map((tag, index) => {
                      const isSelected = selectedTags.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => {
                            setSelectedTags((prev) =>
                              isSelected
                                ? prev.filter((t) => t !== tag)
                                : [...prev, tag]
                            );
                          }}
                          onMouseEnter={() => setTagHighlightedIndex(index)}
                          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                            isSelected
                              ? 'bg-violet-500/20 text-gray-800 dark:text-violet-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-700/50'
                          } ${index === tagHighlightedIndex && !isSelected ? 'bg-gray-200/50 dark:bg-gray-700/50' : ''}`}
                        >
                          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                            isSelected ? 'border-violet-500 bg-violet-500' : 'border-gray-400 dark:border-gray-600'
                          }`}>
                            {isSelected && (
                              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                            )}
                          </span>
                          {tag}
                        </button>
                      );
                    });
                    })()}
                    {selectedTags.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTags([]);
                          setTagSearch('');
                          setIsTagDropdownOpen(false);
                        }}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:text-white border-t border-gray-700"
                      >
                        Clear tag filter
                      </button>
                    )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Filtered count and Clear filters on same line */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {filteredFlights.length} of {flights.length} logs selected
          </span>
          <button
            onClick={() => {
              setDateRange(undefined);
              setSelectedDrones([]);
              setSelectedBatteries([]);
              setDurationFilterMin(null);
              setDurationFilterMax(null);
              setAltitudeFilterMin(null);
              setAltitudeFilterMax(null);
              setDistanceFilterMin(null);
              setDistanceFilterMax(null);
              setSelectedTags([]);
              setIsFilterInverted(false);
              setMapAreaFilterEnabled(false);
            }}
            className="text-xs text-gray-400 hover:text-white"
          >
            Clear filters
          </button>
        </div>

        {/* Export and Delete Filtered Buttons */}
        <div className="flex items-center gap-2">
          {/* Export Dropdown */}
          <div className="relative flex-1">
            <button
              onClick={() => setIsExportDropdownOpen(!isExportDropdownOpen)}
              disabled={filteredFlights.length === 0}
              className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors w-full ${
                filteredFlights.length > 0
                  ? 'bg-drone-primary/20 text-drone-primary hover:bg-drone-primary/30'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              Export filtered
            </button>

            {isExportDropdownOpen && (
              <>
                <div 
                  className="fixed inset-0 z-40" 
                  onClick={() => setIsExportDropdownOpen(false)} 
                />
                <div
                  ref={exportDropdownRef}
                  tabIndex={-1}
                  onKeyDown={(e) => {
                    const exportOptions = [
                      { id: 'csv', label: 'CSV', ext: 'csv', disabled: false },
                      { id: 'json', label: 'JSON', ext: 'json', disabled: false },
                      { id: 'gpx', label: 'GPX', ext: 'gpx', disabled: false },
                      { id: 'kml', label: 'KML', ext: 'kml', disabled: false },
                      { id: 'summary', label: 'Summary', ext: 'csv', disabled: filteredFlights.length <= 1 },
                    ];
                    const enabledOptions = exportOptions.filter(o => !o.disabled);
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setExportHighlightedIndex(prev => {
                        let next = prev + 1;
                        while (next < exportOptions.length && exportOptions[next].disabled) next++;
                        return next >= exportOptions.length ? enabledOptions.length > 0 ? exportOptions.findIndex(o => !o.disabled) : 0 : next;
                      });
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setExportHighlightedIndex(prev => {
                        let next = prev - 1;
                        while (next >= 0 && exportOptions[next].disabled) next--;
                        if (next < 0) {
                          // Find last enabled option
                          for (let i = exportOptions.length - 1; i >= 0; i--) {
                            if (!exportOptions[i].disabled) return i;
                          }
                          return 0;
                        }
                        return next;
                      });
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      const opt = exportOptions[exportHighlightedIndex];
                      if (!opt.disabled) {
                        setIsExportDropdownOpen(false);
                        if (opt.id === 'summary') {
                          handleSummaryExport();
                        } else {
                          handleBulkExport(opt.id, opt.ext);
                        }
                      }
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsExportDropdownOpen(false);
                    }
                  }}
                  className="themed-select-dropdown absolute left-0 top-full mt-2 w-full border border-gray-700 rounded-lg shadow-xl z-50 outline-none"
                >
                  <div className="p-2">
                    {[
                      { id: 'csv', label: 'CSV', ext: 'csv', disabled: false },
                      { id: 'json', label: 'JSON', ext: 'json', disabled: false },
                      { id: 'gpx', label: 'GPX', ext: 'gpx', disabled: false },
                      { id: 'kml', label: 'KML', ext: 'kml', disabled: false },
                      { id: 'summary', label: 'Summary', ext: 'csv', disabled: filteredFlights.length <= 1 },
                    ].map((opt, index) => (
                      <button
                        key={opt.id}
                        onClick={() => {
                          if (opt.disabled) return;
                          setIsExportDropdownOpen(false);
                          if (opt.id === 'summary') {
                            handleSummaryExport();
                          } else {
                            handleBulkExport(opt.id, opt.ext);
                          }
                        }}
                        onMouseEnter={() => !opt.disabled && setExportHighlightedIndex(index)}
                        disabled={opt.disabled}
                        className={`themed-select-option w-full text-left px-3 py-2 text-sm rounded transition-colors ${
                          opt.disabled 
                            ? 'text-gray-500 cursor-not-allowed' 
                            : index === exportHighlightedIndex ? 'bg-drone-primary/20' : ''
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Delete Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirmBulkDelete(true);
            }}
            disabled={filteredFlights.length === 0}
            className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors flex-1 ${
              filteredFlights.length > 0
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'
            }`}
          >
            Delete filtered
          </button>
        </div>

        {/* Bulk Delete Confirmation */}
        {confirmBulkDelete && filteredFlights.length > 0 && (
          <div 
            className="flex items-center gap-2 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-gray-400">
              Delete {filteredFlights.length} filtered flight{filteredFlights.length !== 1 ? 's' : ''}?
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleBulkDelete();
              }}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Yes
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmBulkDelete(false);
              }}
              className="text-xs text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Untag and Bulk Tag Buttons */}
        <div className="flex items-center gap-2">
          {/* Untag Filtered Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirmUntag(true);
            }}
            disabled={filteredFlights.length === 0 || selectedTags.length === 0}
            className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors flex-1 ${
              filteredFlights.length > 0 && selectedTags.length > 0
                ? 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'
            }`}
          >
            Untag filtered
          </button>

          {/* Bulk Tag Filtered Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowBulkTagInput(true);
            }}
            disabled={filteredFlights.length === 0}
            className={`h-8 px-3 rounded-lg text-xs font-medium transition-colors flex-1 ${
              filteredFlights.length > 0
                ? 'bg-violet-500/20 text-violet-400 hover:bg-violet-500/30'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'
            }`}
          >
            Bulk tag filtered
          </button>
        </div>

        {/* Untag Confirmation */}
        {confirmUntag && filteredFlights.length > 0 && selectedTags.length > 0 && (
          <div 
            className="flex items-center gap-2 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-gray-400">
              Remove tag{selectedTags.length !== 1 ? 's' : ''} "{selectedTags.join(', ')}" from filtered flights?
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleBulkUntag();
              }}
              className="text-xs text-orange-400 hover:text-orange-300"
            >
              Yes
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setConfirmUntag(false);
              }}
              className="text-xs text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Bulk Tag Input */}
        {showBulkTagInput && filteredFlights.length > 0 && (
          <div 
            className="flex items-center gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="text"
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleBulkTag();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setShowBulkTagInput(false);
                  setBulkTagInput('');
                }
              }}
              placeholder="Enter tag name..."
              autoFocus
              className="input flex-1 text-xs h-7 px-2"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleBulkTag();
              }}
              className="text-xs text-violet-400 hover:text-violet-300"
            >
              OK
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowBulkTagInput(false);
                setBulkTagInput('');
              }}
              className="text-xs text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
        )}

        </div>
        </div>
        {/* Search + sort — always visible */}
        <div className="px-3 py-2 space-y-0">
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
              className="h-8 w-8 rounded-l-md border border-gray-700/70 bg-drone-dark text-gray-300 hover:text-white hover:border-gray-600 transition-colors flex items-center justify-center"
              aria-label={`Sort flights: ${activeSortLabel}`}
            >
              <SortIcon />
            </button>
            <button
              type="button"
              onClick={() => setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'))}
              className="h-8 w-7 rounded-r-md border border-l-0 border-gray-700/70 bg-drone-dark text-gray-300 hover:text-white hover:border-gray-600 transition-colors flex items-center justify-center"
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
                <div
                  ref={sortDropdownRef}
                  tabIndex={-1}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSortHighlightedIndex(prev => prev < sortOptions.length - 1 ? prev + 1 : 0);
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSortHighlightedIndex(prev => prev > 0 ? prev - 1 : sortOptions.length - 1);
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      setSortOption(sortOptions[sortHighlightedIndex].value as typeof sortOption);
                      setIsSortOpen(false);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setIsSortOpen(false);
                    }
                  }}
                  className="themed-select-dropdown absolute right-0 z-50 mt-2 w-56 rounded-xl border border-gray-700 p-1 shadow-xl outline-none"
                >
                  {sortOptions.map((option, index) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setSortOption(option.value as typeof sortOption);
                        setIsSortOpen(false);
                      }}
                      onMouseEnter={() => setSortHighlightedIndex(index)}
                      className={`themed-select-option w-full text-left px-3 py-2 text-xs rounded-lg transition-colors ${
                        sortOption === option.value ? 'font-medium' : ''
                      } ${index === sortHighlightedIndex ? 'bg-drone-primary/20' : ''}`}
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
      </div>

      {/* Scrollable flight list */}
      <div className="flex-1 overflow-y-auto divide-y divide-gray-700/50">
      {sortedFlights.map((flight) => (
        <div
          key={flight.id}
          data-flight-id={flight.id}
          onClick={() => {
            setPreviewFlightId(null);
            if (activeView === 'overview') {
              // Single click in overview mode: scroll to map then highlight
              const mapElement = document.getElementById('overview-cluster-map');
              if (mapElement) {
                smoothScrollToElement(mapElement, 800).then(() => {
                  setOverviewHighlightedFlightId(flight.id);
                  onHighlightFlight?.(flight.id);
                });
              } else {
                setOverviewHighlightedFlightId(flight.id);
                onHighlightFlight?.(flight.id);
              }
            } else {
              // Single click in flights mode: select and load flight
              selectFlight(flight.id);
              onSelectFlight?.(flight.id);
            }
          }}
          onDoubleClick={() => {
            if (activeView === 'overview') {
              // Double click in overview mode: navigate to flight details
              setOverviewHighlightedFlightId(null);
              selectFlight(flight.id);
              onSelectFlight?.(flight.id);
            }
            // In flights mode, double-click does nothing extra (single click already loads)
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              if (activeView === 'overview') {
                // Enter in overview mode: navigate to flight details
                setOverviewHighlightedFlightId(null);
              }
              selectFlight(flight.id);
              onSelectFlight?.(flight.id);
            }
          }}
          className={`w-full px-3 py-2 text-left cursor-pointer transition-colors duration-150 ${
            (activeView === 'overview' 
              ? overviewHighlightedFlightId === flight.id
              : (selectedFlightId === flight.id || previewFlightId === flight.id))
              ? 'bg-drone-primary/20 border-l-2 border-drone-primary'
              : 'border-l-2 border-transparent hover:bg-gray-700/30 hover:border-l-gray-500'
          }`}
        >
          {/* Rename mode */}
          {editingId === flight.id ? (
            <div>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="input h-7 text-sm px-2 w-full"
                placeholder="Flight name"
              />
              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const name = draftName.trim();
                    if (name.length > 0) {
                      updateFlightName(flight.id, name);
                    }
                    setEditingId(null);
                  }}
                  className="text-xs text-drone-primary"
                >
                  Save
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(null);
                  }}
                  className="text-xs text-gray-400"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-1">
              <p
                className="text-sm text-gray-300 truncate flex-1 min-w-0"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingId(flight.id);
                  setDraftName(flight.displayName || flight.fileName);
                  setConfirmDeleteId(null);
                }}
                title={flight.displayName || flight.fileName}
              >
                {flight.displayName || flight.fileName}
              </p>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(flight.id);
                    setDraftName(flight.displayName || flight.fileName);
                    setConfirmDeleteId(null);
                  }}
                  className="p-0.5 text-sky-400 hover:text-sky-300"
                  title="Rename flight"
                >
                  <PencilIcon />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDeleteId(flight.id);
                  }}
                  className="p-0.5 text-red-400 hover:text-red-300"
                  title="Delete flight"
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          )}

          {/* Subtitle: date + duration */}
          {editingId !== flight.id && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">
              {formatDateTime(flight.startTime)}
              {flight.durationSecs ? ` · ${formatDuration(flight.durationSecs)}` : ''}
              {flight.totalDistance ? ` · ${formatDistance(flight.totalDistance, unitSystem)}` : ''}
            </p>
          )}

          {/* Delete confirmation */}
          {confirmDeleteId === flight.id && editingId !== flight.id && (
            <div className="flex items-center gap-2 mt-1 text-xs">
              <span className="text-gray-400">Delete?</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // Add to blacklist before deleting (so sync won't re-import)
                  if (flight.fileHash) {
                    addToBlacklist(flight.fileHash);
                  }
                  deleteFlight(flight.id);
                  setConfirmDeleteId(null);
                }}
                className="text-red-400"
              >
                Yes
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteId(null);
                }}
                className="text-gray-400"
              >
                No
              </button>
            </div>
          )}
        </div>
      ))}
      {sortedFlights.length === 0 && normalizedSearch.length === 0 && (
        <div className="p-4 text-center text-gray-500 text-xs">
          No flights match the current filters or search.
        </div>
      )}
      </div>

      {/* Export Progress Overlay */}
      {isExporting && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">Exporting Flights</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>Progress</span>
                <span>{exportProgress.done} / {exportProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-drone-primary transition-all duration-300"
                  style={{ width: `${(exportProgress.done / exportProgress.total) * 100}%` }}
                />
              </div>
              {exportProgress.currentFile && (
                <div className="text-xs text-gray-500 truncate">
                  Current: {exportProgress.currentFile}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Progress Overlay */}
      {isDeleting && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">Deleting Flights</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>Progress</span>
                <span>{deleteProgress.done} / {deleteProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-red-500 transition-all duration-300"
                  style={{ width: `${(deleteProgress.done / deleteProgress.total) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Untag Progress Overlay */}
      {isUntagging && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">Removing Tags</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>Progress</span>
                <span>{untagProgress.done} / {untagProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-orange-500 transition-all duration-300"
                  style={{ width: `${untagProgress.total > 0 ? (untagProgress.done / untagProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Tag Progress Overlay */}
      {isBulkTagging && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-drone-surface border border-gray-700 rounded-xl p-6 min-w-[320px] shadow-2xl">
            <h3 className="text-lg font-semibold mb-4">Adding Tags</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm text-gray-400">
                <span>Progress</span>
                <span>{bulkTagProgress.done} / {bulkTagProgress.total}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full bg-violet-500 transition-all duration-300"
                  style={{ width: `${bulkTagProgress.total > 0 ? (bulkTagProgress.done / bulkTagProgress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TrashIcon() {
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
        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
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

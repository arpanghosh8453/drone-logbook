/**
 * Flight Cluster Map - shows aggregated flight counts on a global map.
 * Uses MapLibre GL native GeoJSON clustering. Clusters merge on zoom-out,
 * split on zoom-in, and single-flight points show a tooltip on click.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import Map, { Source, Layer, NavigationControl, Popup } from 'react-map-gl/maplibre';
import type { MapRef, MapLayerMouseEvent } from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Flight } from '@/types';
import { formatDuration, formatDistance, formatAltitude, formatDateTime } from '@/lib/utils';
import type { UnitSystem } from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';

// ---------------------------------------------------------------------------
// Map styles (shared with FlightMap)
// ---------------------------------------------------------------------------

const MAP_STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
} as const;

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf',
  sources: {
    satellite: {
      type: 'raster',
      tiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 18,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [
    {
      id: 'satellite-base',
      type: 'raster',
      source: 'satellite',
      paint: { 'raster-fade-duration': 150 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Layer styles
// ---------------------------------------------------------------------------

/** Cluster circles — size & color scale with point count */
const clusterLayer: maplibregl.LayerSpecification = {
  id: 'clusters',
  type: 'circle',
  source: 'flights',
  filter: ['has', 'point_count'],
  paint: {
    'circle-color': [
      'step',
      ['get', 'point_count'],
      '#6366f1', // indigo for small clusters
      10,
      '#4f46e5', // deeper indigo
      50,
      '#4338ca', // even deeper
      200,
      '#3730a3', // large clusters
    ],
    'circle-radius': [
      'step',
      ['get', 'point_count'],
      18,   // <10
      10, 22, // 10-49
      50, 28, // 50-199
      200, 34, // 200+
    ],
    'circle-stroke-width': 2,
    'circle-stroke-color': 'rgba(255,255,255,0.25)',
  },
};

/** Cluster count labels */
const clusterCountLayer: maplibregl.LayerSpecification = {
  id: 'cluster-count',
  type: 'symbol',
  source: 'flights',
  filter: ['has', 'point_count'],
  layout: {
    'text-field': [
      'case',
      ['>=', ['get', 'point_count'], 1000],
      ['concat', ['to-string', ['/', ['round', ['/', ['get', 'point_count'], 100]], 10]], 'k'],
      ['to-string', ['get', 'point_count']],
    ] as unknown as string,
    'text-size': 13,
    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
    'text-allow-overlap': true,
  },
  paint: {
    'text-color': '#ffffff',
  },
};

/** Unclustered single-flight points */
const unclusteredPointLayer: maplibregl.LayerSpecification = {
  id: 'unclustered-point',
  type: 'circle',
  source: 'flights',
  filter: ['!', ['has', 'point_count']],
  paint: {
    'circle-color': '#6366f1',
    'circle-radius': 7,
    'circle-stroke-width': 2,
    'circle-stroke-color': '#ffffff',
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FlightClusterMapProps {
  flights: Flight[];
  allFlights?: Flight[];  // All flights for reset zoom
  unitSystem: UnitSystem;
  themeMode: 'system' | 'dark' | 'light';
  onSelectFlight?: (flightId: number) => void;
  highlightedFlightId?: number | null;  // Flight to highlight on the map
}

export function FlightClusterMap({
  flights,
  allFlights,
  unitSystem,
  themeMode,
  onSelectFlight,
  highlightedFlightId,
}: FlightClusterMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const hasFittedRef = useRef(false);
  const [isSatellite, setIsSatellite] = useState(false);
  const [popupInfo, setPopupInfo] = useState<{
    longitude: number;
    latitude: number;
    flight: Flight;
  } | null>(null);

  // Pulsing animation state for highlighted flight
  const [pulseRadius, setPulseRadius] = useState(16);
  const [pulseOpacity, setPulseOpacity] = useState(0.2);
  const pulseAnimationRef = useRef<number | null>(null);

  // Animate the pulse effect
  useEffect(() => {
    if (!highlightedFlightId) {
      // Clean up animation when highlight is removed
      if (pulseAnimationRef.current) {
        cancelAnimationFrame(pulseAnimationRef.current);
        pulseAnimationRef.current = null;
      }
      return;
    }

    let startTime: number | null = null;
    const duration = 1500; // 1.5 second cycle

    const animate = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = (elapsed % duration) / duration;
      
      // Ease in-out sine wave for smooth pulsing
      const easedProgress = Math.sin(progress * Math.PI * 2) * 0.5 + 0.5;
      
      // Pulse radius between 16 and 28
      setPulseRadius(16 + easedProgress * 12);
      // Pulse opacity between 0.1 and 0.35
      setPulseOpacity(0.1 + easedProgress * 0.25);
      
      pulseAnimationRef.current = requestAnimationFrame(animate);
    };

    pulseAnimationRef.current = requestAnimationFrame(animate);

    return () => {
      if (pulseAnimationRef.current) {
        cancelAnimationFrame(pulseAnimationRef.current);
        pulseAnimationRef.current = null;
      }
    };
  }, [highlightedFlightId]);

  // Map area filter state from store
  const mapAreaFilterEnabled = useFlightStore((s) => s.mapAreaFilterEnabled);
  const setMapVisibleBounds = useFlightStore((s) => s.setMapVisibleBounds);

  // Overview map viewport persistence from store
  const savedViewport = useFlightStore((s) => s.overviewMapViewport);
  const setOverviewMapViewport = useFlightStore((s) => s.setOverviewMapViewport);

  // Store initial bounds for reset
  const initialBoundsRef = useRef<{ west: number; south: number; east: number; north: number } | null>(null);

  // Track viewport so we can preserve it across style-driven remounts
  // Initialize from saved state if available
  const [viewport, setViewport] = useState(() => savedViewport || {
    longitude: 0,
    latitude: 20,
    zoom: 1.5,
  });

  const resolvedTheme = useMemo(() => {
    if (themeMode === 'system') {
      return typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return themeMode;
  }, [themeMode]);

  // Derive a stable string key for the map style so <Map> remounts cleanly
  // when switching between URL styles and the inline satellite style.
  const styleMode = isSatellite ? 'satellite' : resolvedTheme;

  const activeMapStyle = useMemo(
    () => (isSatellite ? SATELLITE_STYLE : MAP_STYLES[resolvedTheme]),
    [isSatellite, resolvedTheme],
  );

  // Update visible bounds when map moves (only if filter is enabled)
  const updateBounds = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    if (bounds) {
      const boundsObj = {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
      if (mapAreaFilterEnabled) {
        setMapVisibleBounds(boundsObj);
      }
      // Store initial bounds on first load
      if (!initialBoundsRef.current) {
        initialBoundsRef.current = boundsObj;
      }
    }
  }, [mapAreaFilterEnabled, setMapVisibleBounds]);

  // When map area filter is enabled, immediately update bounds
  useEffect(() => {
    if (mapAreaFilterEnabled) {
      updateBounds();
    } else {
      // Clear bounds when filter is disabled
      setMapVisibleBounds(null);
    }
  }, [mapAreaFilterEnabled, updateBounds, setMapVisibleBounds]);

  // Reset zoom to fit all flights (use allFlights for global view)
  const handleResetZoom = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    
    const flightsToFit = allFlights || flights;
    const coords = flightsToFit
      .filter((f): f is Flight & { homeLat: number; homeLon: number } =>
        f.homeLat != null && f.homeLon != null)
      .map((f) => [f.homeLon, f.homeLat] as [number, number]);
    
    if (coords.length === 0) return;
    
    if (coords.length === 1) {
      map.flyTo({ center: coords[0], zoom: 12, duration: 800 });
      return;
    }

    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    coords.forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    });

    map.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]],
      { padding: 50, maxZoom: 14, duration: 800 },
    );
  }, [flights, allFlights]);

  // Build GeoJSON from flights with valid homeLat/homeLon
  const geojson = useMemo(() => {
    const features = flights
      .filter(
        (f): f is Flight & { homeLat: number; homeLon: number } =>
          f.homeLat != null && f.homeLon != null,
      )
      .map((f) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [f.homeLon, f.homeLat],
        },
        properties: {
          id: f.id,
          displayName: f.displayName || f.fileName,
          startTime: f.startTime ?? '',
          durationSecs: f.durationSecs ?? 0,
          totalDistance: f.totalDistance ?? 0,
          maxAltitude: f.maxAltitude ?? 0,
          droneModel: f.droneModel ?? '',
          aircraftName: f.aircraftName ?? '',
        },
      }));

    return {
      type: 'FeatureCollection' as const,
      features,
    };
  }, [flights]);

  // GeoJSON for highlighted flight (separate source for distinct styling)
  const highlightedGeojson = useMemo(() => {
    if (!highlightedFlightId) {
      return { type: 'FeatureCollection' as const, features: [] };
    }
    const flight = flights.find((f) => f.id === highlightedFlightId);
    if (!flight || flight.homeLat == null || flight.homeLon == null) {
      return { type: 'FeatureCollection' as const, features: [] };
    }
    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [flight.homeLon, flight.homeLat],
        },
        properties: {
          id: flight.id,
        },
      }],
    };
  }, [highlightedFlightId, flights]);

  // Fit bounds to all points on first render / when flights change
  // Skip if we have a saved viewport from previous session
  useEffect(() => {
    if (hasFittedRef.current) return;
    // If we have a saved viewport, don't auto-fit, just mark as fitted
    if (savedViewport) {
      hasFittedRef.current = true;
      return;
    }
    const map = mapRef.current;
    if (!map || geojson.features.length === 0) return;

    // Small delay to ensure map is loaded
    const timeout = setTimeout(() => {
      hasFittedRef.current = true;
      const coords = geojson.features.map(
        (f) => f.geometry.coordinates as [number, number],
      );
      if (coords.length === 1) {
        map.flyTo({ center: coords[0], zoom: 12, duration: 800 });
        return;
      }

      let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      coords.forEach(([lng, lat]) => {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      });

      map.fitBounds(
        [[minLng, minLat], [maxLng, maxLat]],
        { padding: 50, maxZoom: 14, duration: 800 },
      );
    }, 300);

    return () => clearTimeout(timeout);
  }, [geojson]);

  // Zoom to highlighted flight when it changes
  useEffect(() => {
    if (!highlightedFlightId) return;
    const map = mapRef.current;
    if (!map) return;

    const highlightedFlight = flights.find((f) => f.id === highlightedFlightId);
    if (!highlightedFlight || highlightedFlight.homeLat == null || highlightedFlight.homeLon == null) return;

    // Fly to the highlighted flight location
    map.flyTo({
      center: [highlightedFlight.homeLon, highlightedFlight.homeLat],
      zoom: 12,
      duration: 800,
    });
  }, [highlightedFlightId, flights]);

  // Click handler — zoom into clusters or show popup for individual points
  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const map = mapRef.current;
      if (!map) return;

      // Check clusters first
      const clusterFeatures = map.queryRenderedFeatures(e.point, {
        layers: ['clusters'],
      });
      if (clusterFeatures.length > 0) {
        const feature = clusterFeatures[0];
        const clusterId = feature.properties?.cluster_id;
        const source = map.getSource('flights') as any;
        if (source && clusterId != null) {
          // MapLibre GL v4+ uses Promise API
          Promise.resolve(source.getClusterExpansionZoom(clusterId))
            .then((zoom: number) => {
              const geom = feature.geometry as GeoJSON.Point;
              map.easeTo({
                center: geom.coordinates as [number, number],
                zoom: Math.min(zoom, 18),
                duration: 500,
              });
            })
            .catch(() => {});
        }
        return;
      }

      // Check unclustered points
      const pointFeatures = map.queryRenderedFeatures(e.point, {
        layers: ['unclustered-point'],
      });
      if (pointFeatures.length > 0) {
        const feature = pointFeatures[0];
        const geom = feature.geometry as GeoJSON.Point;
        const props = feature.properties;
        if (props) {
          // GeoJSON properties are serialized as strings by MapLibre
          const flightId = typeof props.id === 'string' ? parseInt(props.id, 10) : props.id;
          const flight = flights.find((f) => f.id === flightId);
          if (flight) {
            setPopupInfo({
              longitude: geom.coordinates[0],
              latitude: geom.coordinates[1],
              flight,
            });
          }
        }
      }
    },
    [flights],
  );

  // Cursor pointer on interactive layers
  const handleMouseEnter = useCallback(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = 'pointer';
  }, []);

  const handleMouseLeave = useCallback(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = '';
  }, []);

  if (geojson.features.length === 0) {
    return (
      <div className={`card p-4 transition-all duration-300 ${mapAreaFilterEnabled ? 'ring-2 ring-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.15)]' : ''}`}>
        <h3 className="text-sm font-semibold mb-3">
          <span className="text-white">Flight Locations</span>
          {mapAreaFilterEnabled && (
            <span className="text-emerald-400 ml-1">— Global filter active</span>
          )}
        </h3>
        <p className="text-sm text-gray-400 text-center py-10">
          No flights with location data available.
        </p>
      </div>
    );
  }

  return (
    <div 
      className={`card p-4 transition-all duration-300 resize-y overflow-hidden ${mapAreaFilterEnabled ? 'ring-2 ring-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.15)]' : ''}`}
      style={{ height: 480, minHeight: 480, maxHeight: 850 }}
    >
      <h3 className="text-sm font-semibold mb-3">
        <span className="text-white">Flight Locations</span>
        {mapAreaFilterEnabled && (
          <span className="text-emerald-400 ml-1">— Global filter active</span>
        )}
      </h3>
      <div 
        className="relative rounded-lg overflow-hidden" 
        style={{ height: 'calc(100% - 32px)' }}
      >
        <Map
          key={styleMode}
          ref={mapRef}
          initialViewState={viewport}
          style={{ width: '100%', height: '100%' }}
          mapStyle={activeMapStyle}
          attributionControl={false}
          onMove={(evt) => {
            const { longitude, latitude, zoom } = evt.viewState;
            setViewport({ longitude, latitude, zoom });
          }}
          onMoveEnd={() => {
            updateBounds();
            // Save viewport to store for persistence across tab switches
            setOverviewMapViewport(viewport);
          }}
          onLoad={updateBounds}
          onClick={handleClick}
          interactiveLayerIds={['clusters', 'unclustered-point']}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <NavigationControl position="top-right" />

          {/* Satellite toggle */}
          <div className="map-overlay absolute top-2 left-2 z-10 bg-drone-dark/80 border border-gray-700 rounded-xl px-3 py-2 shadow-lg">
            <ToggleRow
              label="Satellite"
              checked={isSatellite}
              onChange={setIsSatellite}
            />
          </div>

          {/* Reset zoom button */}
          <button
            type="button"
            onClick={handleResetZoom}
            className="absolute bottom-2 right-2 z-10 bg-drone-dark/80 border border-gray-700 rounded-lg px-2.5 py-1.5 shadow-lg text-xs text-gray-300 hover:text-white hover:bg-drone-dark transition-colors flex items-center gap-1.5"
            title="Reset zoom to fit all flights"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              <polyline points="23 1 23 10 14 10" />
              <polyline points="1 23 1 14 10 14" />
            </svg>
            Reset zoom
          </button>

          <Source
            id="flights"
            type="geojson"
            data={geojson}
            cluster
            clusterMaxZoom={14}
            clusterRadius={50}
          >
            <Layer {...clusterLayer} />
            <Layer {...clusterCountLayer} />
            <Layer {...unclusteredPointLayer} />
          </Source>

          {/* Highlighted flight marker (shown above other markers) */}
          {highlightedFlightId && highlightedGeojson.features.length > 0 && (
            <Source
              id="highlighted-flight"
              type="geojson"
              data={highlightedGeojson}
            >
              {/* Animated pulsing glow ring */}
              <Layer
                id="highlighted-flight-glow"
                type="circle"
                source="highlighted-flight"
                paint={{
                  'circle-color': '#10b981',
                  'circle-radius': pulseRadius,
                  'circle-stroke-width': 0,
                  'circle-opacity': pulseOpacity,
                }}
              />
              {/* Main marker dot */}
              <Layer
                id="highlighted-flight-outer"
                type="circle"
                source="highlighted-flight"
                paint={{
                  'circle-color': '#10b981',
                  'circle-radius': 10,
                  'circle-stroke-width': 2,
                  'circle-stroke-color': '#ffffff',
                  'circle-opacity': 0.95,
                }}
              />
            </Source>
          )}

          {/* Popup for individual flights */}
          {popupInfo && (() => {
            const isLight = resolvedTheme === 'light';
            const iconColor = isLight ? '#6366f1' : '#818cf8';
            return (
            <Popup
              longitude={popupInfo.longitude}
              latitude={popupInfo.latitude}
              anchor="bottom"
              onClose={() => setPopupInfo(null)}
              closeButton
              closeOnClick
              className={['flight-cluster-popup', resolvedTheme === 'dark' && 'flight-cluster-popup--dark'].filter(Boolean).join(' ')}
              maxWidth="300px"
              offset={12}
            >
              <div
                className="cursor-pointer select-none"
                onClick={() => {
                  if (onSelectFlight) {
                    onSelectFlight(popupInfo.flight.id);
                    setPopupInfo(null);
                  }
                }}
              >
                {/* Header strip */}
                <div className="px-3.5 py-2.5" style={{ background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)' }}>
                  <p className="text-[13px] font-semibold truncate leading-tight" style={{ color: '#ffffff' }}>
                    {(() => { const name = popupInfo.flight.displayName || popupInfo.flight.fileName; return name.length > 20 ? name.slice(0, 20) + '…' : name; })()}
                  </p>
                  {(popupInfo.flight.aircraftName || popupInfo.flight.droneModel) && (
                    <p className="text-[11px] truncate mt-0.5" style={{ color: '#c7d2fe' }}>
                      {popupInfo.flight.aircraftName || popupInfo.flight.droneModel}
                      {popupInfo.flight.aircraftName && popupInfo.flight.droneModel
                        ? ` · ${popupInfo.flight.droneModel}`
                        : ''}
                    </p>
                  )}
                </div>

                {/* Stats grid */}
                <div className="popup-body px-3.5 py-2.5 space-y-1.5">
                  <PopupStatRow
                    icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>}
                    label="Date"
                    value={formatDateTime(popupInfo.flight.startTime)}
                  />
                  <PopupStatRow
                    icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
                    label="Duration"
                    value={formatDuration(popupInfo.flight.durationSecs)}
                  />
                  <PopupStatRow
                    icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
                    label="Distance"
                    value={formatDistance(popupInfo.flight.totalDistance, unitSystem)}
                  />
                  <PopupStatRow
                    icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>}
                    label="Max Alt"
                    value={formatAltitude(popupInfo.flight.maxAltitude, unitSystem)}
                  />
                </div>

                {/* Footer CTA */}
                {onSelectFlight && (
                  <div className="popup-footer px-3.5 pb-2.5">
                    <div className={`flex items-center justify-center gap-1 text-[11px] font-medium rounded-md py-1.5 transition-colors ${
                      isLight
                        ? 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100'
                        : 'text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25'
                    }`}>
                      <span>View flight details</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  </div>
                )}
              </div>
            </Popup>
            );
          })()}
        </Map>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 text-xs text-gray-300 hover:text-white transition-colors"
      aria-pressed={checked}
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${
          checked
            ? 'bg-drone-primary/90 border-drone-primary'
            : 'bg-drone-surface border-gray-600 toggle-track-off'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-1'
          }`}
        />
      </span>
    </button>
  );
}

function PopupStatRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex-shrink-0 opacity-70">{icon}</span>
      <span className="popup-stat-label text-[11px] w-[52px] flex-shrink-0">{label}</span>
      <span className="popup-stat-value text-[12px] font-medium truncate">{value}</span>
    </div>
  );
}

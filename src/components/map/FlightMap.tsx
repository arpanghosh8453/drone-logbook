/**
 * Flight map component using react-map-gl with MapLibre
 * Displays the GPS track of the selected flight
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Map, { NavigationControl, Marker } from 'react-map-gl/maplibre';
import type { MapRef } from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import { PathLayer } from '@deck.gl/layers';
import DeckGL from '@deck.gl/react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getTrackCenter, calculateBounds } from '@/lib/utils';

interface FlightMapProps {
  track: [number, number, number][]; // [lng, lat, alt][]
  themeMode: 'system' | 'dark' | 'light';
}

const MAP_STYLES = {
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
} as const;

const SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Tiles © Esri',
    },
  },
  layers: [
    {
      id: 'satellite-base',
      type: 'raster',
      source: 'satellite',
    },
  ],
};

const TERRAIN_SOURCE_ID = 'terrain-dem';
const TERRAIN_SOURCE = {
  type: 'raster-dem',
  url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
  tileSize: 256,
  maxzoom: 14,
} as const;

const getSessionBool = (key: string, fallback: boolean) => {
  if (typeof window === 'undefined') return fallback;
  const stored = window.sessionStorage.getItem(key);
  if (stored === null) return fallback;
  return stored === 'true';
};

export function FlightMap({ track, themeMode }: FlightMapProps) {
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 0,
    zoom: 14,
    pitch: 45,
    bearing: 0,
  });
  const [is3D, setIs3D] = useState(() => getSessionBool('map:is3d', true));
  const [isSatellite, setIsSatellite] = useState(() => getSessionBool('map:isSatellite', true));
  const mapRef = useRef<MapRef | null>(null);

  const resolvedTheme = useMemo(() => {
    if (themeMode === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    return themeMode;
  }, [themeMode]);

  const activeMapStyle = useMemo(
    () => (isSatellite ? SATELLITE_STYLE : MAP_STYLES[resolvedTheme]),
    [isSatellite, resolvedTheme]
  );

  // Calculate center and bounds when track changes
  useEffect(() => {
    if (track.length > 0) {
      const [lng, lat] = getTrackCenter(track);
      const bounds = calculateBounds(track);

      // Estimate zoom from bounds
      let zoom = 14;
      if (bounds) {
        const lngDiff = bounds[1][0] - bounds[0][0];
        const latDiff = bounds[1][1] - bounds[0][1];
        const maxDiff = Math.max(lngDiff, latDiff);
        zoom = Math.max(10, Math.min(18, 16 - Math.log2(maxDiff * 111)));
      }

      setViewState((prev) => ({
        ...prev,
        longitude: lng,
        latitude: lat,
        zoom,
      }));
    }
  }, [track]);

  const deckPathData = useMemo(() => {
    if (track.length < 2) return [];
    const segments: { path: [number, number, number][]; color: [number, number, number] }[] = [];
    const startColor: [number, number, number] = [250, 204, 21];
    const endColor: [number, number, number] = [239, 68, 68];

    const toAlt = (altitude: number) => (is3D ? altitude : 0);

    for (let i = 0; i < track.length - 1; i += 1) {
      const t = i / Math.max(1, track.length - 2);
      const color: [number, number, number] = [
        Math.round(startColor[0] + (endColor[0] - startColor[0]) * t),
        Math.round(startColor[1] + (endColor[1] - startColor[1]) * t),
        Math.round(startColor[2] + (endColor[2] - startColor[2]) * t),
      ];
      const [lng1, lat1, alt1] = track[i];
      const [lng2, lat2, alt2] = track[i + 1];
      segments.push({
        path: [
          [lng1, lat1, toAlt(alt1)],
          [lng2, lat2, toAlt(alt2)],
        ],
        color,
      });
    }

    return segments;
  }, [is3D, track]);

  const deckLayers = useMemo(() => {
    if (deckPathData.length === 0) return [];
    return [
      new PathLayer({
        id: 'flight-path-3d',
        data: deckPathData,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: 4,
        widthUnits: 'pixels',
        widthMinPixels: 4,
        capRounded: true,
        jointRounded: true,
        billboard: true,
        opacity: 1,
        pickable: false,
        parameters: {
          depthTest: false,
        },
      }),
    ];
  }, [deckPathData]);

  // Start and end markers
  const startPoint = track[0];
  const endPoint = track[track.length - 1];

  const handleMapMove = useCallback(
    ({ viewState: nextViewState }: { viewState: typeof viewState }) => {
      setViewState(nextViewState);
    },
    []
  );

  const enableTerrain = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    if (!map.getSource(TERRAIN_SOURCE_ID)) {
      map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
    }

    if (!map.getLayer('sky')) {
      map.addLayer({
        id: 'sky',
        type: 'sky',
        paint: {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0.0, 0.0],
          'sky-atmosphere-sun-intensity': 10,
        },
      } as any);
    }

    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1.4 });
  }, []);

  const disableTerrain = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    map.setTerrain(null);
  }, []);

  useEffect(() => {
    if (is3D) {
      enableTerrain();
      setViewState((prev) => ({ ...prev, pitch: 60 }));
    } else {
      disableTerrain();
      setViewState((prev) => ({ ...prev, pitch: 0 }));
    }
  }, [disableTerrain, enableTerrain, is3D]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:is3d', String(is3D));
    }
  }, [is3D]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('map:isSatellite', String(isSatellite));
    }
  }, [isSatellite]);

  useEffect(() => {
    if (is3D) {
      enableTerrain();
    }
  }, [enableTerrain, is3D, resolvedTheme]);

  if (track.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-dji-dark">
        <p className="text-gray-500">No GPS data available</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full min-h-0">
      <Map
        {...viewState}
        style={{ width: '100%', height: '100%', position: 'absolute', top: '0', right: '0', bottom: '0', left: '0' }}
        mapStyle={activeMapStyle}
        attributionControl={false}
        ref={mapRef}
        onMove={handleMapMove}
        onLoad={() => {
          if (is3D) {
            enableTerrain();
          }
        }}
      >
        <NavigationControl position="top-right" />

        {/* Map Controls */}
        <div className="absolute top-2 left-2 z-10 bg-dji-dark/80 border border-gray-700 rounded-xl px-3 py-2 space-y-2 shadow-lg">
          <ToggleRow
            label="3D Terrain"
            checked={is3D}
            onChange={setIs3D}
          />
          <ToggleRow
            label="Satellite"
            checked={isSatellite}
            onChange={setIsSatellite}
          />
        </div>

        {/* Start Marker (Yellow) */}
        {startPoint && (
          <Marker longitude={startPoint[0]} latitude={startPoint[1]} anchor="center">
            <div className="relative">
              <div className="w-4 h-4 bg-yellow-400 rounded-full border-2 border-white shadow-lg" />
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs bg-yellow-500 text-black px-1.5 py-0.5 rounded whitespace-nowrap">
                Start
              </div>
            </div>
          </Marker>
        )}

        {/* End Marker (Red) */}
        {endPoint && (
          <Marker longitude={endPoint[0]} latitude={endPoint[1]} anchor="center">
            <div className="relative">
              <div className="w-4 h-4 bg-red-500 rounded-full border-2 border-white shadow-lg" />
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-xs bg-red-500 text-white px-1.5 py-0.5 rounded whitespace-nowrap">
                End
              </div>
            </div>
          </Marker>
        )}
      </Map>

      <DeckGL
        viewState={viewState}
        controller={false}
        layers={deckLayers}
        style={{ width: '100%', height: '100%', pointerEvents: 'none', position: 'absolute', top: '0', right: '0', bottom: '0', left: '0' }}
      />
    </div>
  );
}

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
      className="w-full flex items-center justify-between gap-3 text-xs text-gray-200 hover:text-white transition-colors"
      aria-pressed={checked}
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-all ${
          checked
            ? 'bg-dji-primary/90 border-dji-primary'
            : 'bg-dji-surface border-gray-600'
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

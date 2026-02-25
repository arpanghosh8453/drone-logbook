/**
 * Telemetry charts component using ECharts
 * Displays height, VPS height, speed, battery, attitude, RC, GPS, distance to home, and velocity data
 * Optimized for performance with large datasets
 */

import { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption, ECharts, LineSeriesOption } from 'echarts';
import type { TelemetryData } from '@/types';
import type { UnitSystem } from '@/lib/utils';
import { useFlightStore } from '@/stores/flightStore';

interface TelemetryChartsProps {
  data: TelemetryData;
  unitSystem: UnitSystem;
  startTime?: string | null;
}

export function TelemetryCharts({ data, unitSystem, startTime }: TelemetryChartsProps) {
  const chartsRef = useRef<ECharts[]>([]);
  const isSyncingRef = useRef(false);
  const themeMode = useFlightStore((state) => state.themeMode);
  const mapSyncEnabled = useFlightStore((state) => state.mapSyncEnabled);
  const setMapSyncEnabled = useFlightStore((state) => state.setMapSyncEnabled);
  const mapReplayProgress = useFlightStore((state) => state.mapReplayProgress);
  const resolvedTheme = useMemo(() => resolveThemeMode(themeMode), [themeMode]);
  const splitLineColor = resolvedTheme === 'light' ? '#e2e8f0' : '#2a2a4e';
  const tooltipFormatter = useMemo(
    () => createTooltipFormatter(startTime ?? null, resolvedTheme),
    [resolvedTheme, startTime]
  );
  const tooltipColors = useMemo(
    () =>
      resolvedTheme === 'light'
        ? {
            background: '#ffffff',
            border: '#e2e8f0',
            text: '#0f172a',
          }
        : {
            background: '#16213e',
            border: '#4a4e69',
            text: '#ffffff',
          },
    [resolvedTheme]
  );

  // Update module-level base config when theme changes
  useMemo(() => {
    baseChartConfig = createBaseChartConfig(resolvedTheme);
    return resolvedTheme;
  }, [resolvedTheme]);

  const [dragZoomActive, setDragZoomActive] = useState(true);

  const toggleDragZoom = useCallback(() => {
    setDragZoomActive((prev) => {
      const next = !prev;
      chartsRef.current.forEach((chart) => {
        chart.dispatchAction({
          type: 'takeGlobalCursor',
          key: 'dataZoomSelect',
          dataZoomSelectActive: next,
        });
      });
      return next;
    });
  }, []);

  const resetZoom = useCallback(() => {
    chartsRef.current.forEach((chart) => {
      chart.dispatchAction({
        type: 'dataZoom',
        start: 0,
        end: 100,
      });
    });
  }, []);

  const syncZoom = useCallback((sourceChart: ECharts) => {
    if (isSyncingRef.current) return;
    const dataZoom = sourceChart.getOption().dataZoom as
      | { start?: number; end?: number; startValue?: number; endValue?: number }[]
      | undefined;
    if (!dataZoom || dataZoom.length === 0) return;

    const { start, end, startValue, endValue } = dataZoom[0] ?? {};

    isSyncingRef.current = true;
    chartsRef.current.forEach((chart) => {
      if (chart === sourceChart) return;
      chart.dispatchAction({
        type: 'dataZoom',
        start,
        end,
        startValue,
        endValue,
      });
    });
    window.setTimeout(() => {
      isSyncingRef.current = false;
    }, 0);
  }, []);

  const registerChart = useCallback(
    (chart: ECharts) => {
      if (chartsRef.current.includes(chart)) return;
      chartsRef.current.push(chart);

      chart.on('dataZoom', () => {
        syncZoom(chart);
      });

      // Activate drag-to-zoom by default after the toolbox feature is fully initialized.
      // A deferred dispatch is required because onChartReady fires synchronously
      // after setOption, before the toolbox dataZoom feature is ready to handle
      // the takeGlobalCursor action.
      requestAnimationFrame(() => {
        chart.dispatchAction({
          type: 'takeGlobalCursor',
          key: 'dataZoomSelect',
          dataZoomSelectActive: true,
        });
      });
    },
    [syncZoom]
  );

  // Show vertical line indicator when map replay progress changes
  useEffect(() => {
    if (!mapSyncEnabled || mapReplayProgress === 0) {
      // Clear axis pointer when not syncing or at start
      chartsRef.current.forEach((chart) => {
        chart.dispatchAction({
          type: 'hideTip',
        });
      });
      return;
    }

    const dataLength = data.time?.length ?? 0;
    if (dataLength === 0) return;

    const dataIndex = Math.round(mapReplayProgress * (dataLength - 1));

    chartsRef.current.forEach((chart) => {
      chart.dispatchAction({
        type: 'showTip',
        seriesIndex: 0,
        dataIndex,
      });
    });
  }, [mapSyncEnabled, mapReplayProgress, data.time]);

  // Memoize chart options to prevent unnecessary re-renders
  const altitudeSpeedOption = useMemo(
    () =>
      createAltitudeSpeedChart(
        data,
        unitSystem,
        splitLineColor,
        tooltipFormatter,
        tooltipColors
      ),
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem]
  );
  const batteryOption = useMemo(
    () => createBatteryChart(data, splitLineColor, tooltipFormatter, tooltipColors),
    [data, splitLineColor, tooltipColors, tooltipFormatter]
  );
  const cellVoltageOption = useMemo(
    () => createCellVoltageChart(data, splitLineColor, tooltipFormatter, tooltipColors),
    [data, splitLineColor, tooltipColors, tooltipFormatter]
  );
  const attitudeOption = useMemo(
    () => createAttitudeChart(data, splitLineColor, tooltipFormatter, tooltipColors),
    [data, splitLineColor, tooltipColors, tooltipFormatter]
  );
  const rcSignalOption = useMemo(
    () => createRcSignalChart(data, splitLineColor, tooltipFormatter, tooltipColors),
    [data, splitLineColor, tooltipColors, tooltipFormatter]
  );
  const distanceToHomeOption = useMemo(
    () => createDistanceToHomeChart(data, unitSystem, splitLineColor, tooltipFormatter, tooltipColors),
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem]
  );
  const velocityOption = useMemo(
    () => createVelocityChart(data, unitSystem, splitLineColor, tooltipFormatter, tooltipColors),
    [data, splitLineColor, tooltipColors, tooltipFormatter, unitSystem]
  );
  const gpsOption = useMemo(
    () => createGpsChart(data, splitLineColor, tooltipFormatter, tooltipColors),
    [data, splitLineColor, tooltipColors, tooltipFormatter]
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-1.5">
        <button
          onClick={() => setMapSyncEnabled(!mapSyncEnabled)}
          className={`text-xs border rounded px-2 py-1 transition-colors ${
            mapSyncEnabled
              ? 'text-drone-accent border-drone-accent/50 bg-drone-accent/10'
              : 'text-gray-400 hover:text-white border-gray-700'
          }`}
          title={mapSyncEnabled ? 'Disable map sync' : 'Enable map sync'}
        >
          <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          Map sync
        </button>
        <button
          onClick={toggleDragZoom}
          className={`text-xs border rounded px-2 py-1 transition-colors ${
            dragZoomActive
              ? 'text-drone-primary border-drone-primary/50 bg-drone-primary/10'
              : 'text-gray-400 hover:text-white border-gray-700'
          }`}
          title={dragZoomActive ? 'Disable drag to zoom' : 'Enable drag to zoom'}
        >
          <svg className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" viewBox="0 0 1024 1024" fill="currentColor">
            <path d="M1005.3 967.5L755.8 718.1c63.2-74.5 101.5-171 101.5-276.4C857.3 198 665.3 6 429.6 6S2 198 2 441.7s192 435.7 427.7 435.7c105.4 0 201.9-38.3 276.4-101.5l249.4 249.4c10.4 10.4 27.3 10.4 37.8 0l12-12c10.4-10.5 10.4-27.3 0-37.8zM429.6 810.4c-203.4 0-368.7-165.3-368.7-368.7s165.3-368.7 368.7-368.7 368.7 165.3 368.7 368.7-165.3 368.7-368.7 368.7z" />
          </svg>
          Drag zoom
        </button>
        <button
          onClick={resetZoom}
          className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-1"
          title="Reset zoom on all charts"
        >
          Reset zoom
        </button>
      </div>
      {/* Altitude & Speed Chart */}
      <div className="h-60">
        <ReactECharts
          option={altitudeSpeedOption}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
          onChartReady={registerChart}
        />
      </div>

      {/* Battery Chart */}
      <div className="h-56">
        <ReactECharts
          option={batteryOption}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
          onChartReady={registerChart}
        />
      </div>

      {/* Cell Voltage Chart - only shown if cell voltage data exists */}
      {cellVoltageOption && (
        <div className="h-48">
          <ReactECharts
            option={cellVoltageOption}
            style={{ height: '100%', width: '100%' }}
            opts={{ renderer: 'canvas' }}
            notMerge={true}
            onChartReady={registerChart}
          />
        </div>
      )}

      {/* Attitude Chart */}
      <div className="h-60">
        <ReactECharts
          option={attitudeOption}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
          onChartReady={registerChart}
        />
      </div>

      {/* RC Signal Chart */}
      <div className="h-40">
        <ReactECharts
          option={rcSignalOption}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
          onChartReady={registerChart}
        />
      </div>

      {/* Distance to Home Chart */}
      <div className="h-48">
        <ReactECharts
          option={distanceToHomeOption}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
          onChartReady={registerChart}
        />
      </div>

      {/* Velocity Chart */}
      <div className="h-48">
        <ReactECharts
          option={velocityOption}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
          onChartReady={registerChart}
        />
      </div>

      {/* GPS Satellites Chart */}
      <div className="h-[200px]">
        <ReactECharts
          option={gpsOption}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
          onChartReady={registerChart}
        />
      </div>
    </div>
  );
}

/** Shared chart configuration - theme-aware */
function createBaseChartConfig(theme: 'dark' | 'light'): Partial<EChartsOption> {
  const isLight = theme === 'light';
  const axisColor = isLight ? '#cbd5e1' : '#4a4e69';
  const labelColor = isLight ? '#64748b' : '#9ca3af';
  const zoomBg = isLight ? '#f1f5f9' : '#16213e';
  const zoomBorder = isLight ? '#cbd5e1' : '#2a2a4e';
  const zoomFiller = isLight ? 'rgba(0, 122, 204, 0.15)' : 'rgba(0, 160, 220, 0.2)';
  const handleColor = isLight ? '#007acc' : '#00A0DC';

  return {
    animation: false,
    toolbox: {
      show: true,
      feature: {
        dataZoom: {
          yAxisIndex: 'none',
          title: { zoom: '', back: '' },
          iconStyle: { opacity: 0 },
          emphasis: { iconStyle: { opacity: 0 } },
        },
      },
      right: -999,
      top: -999,
      itemSize: 0,
    },
    grid: {
      left: 50,
      right: 46,
      top: 30,
      bottom: 50,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      renderMode: 'html',
      appendToBody: true,
      extraCssText: 'z-index: 40;',
      backgroundColor: isLight ? '#ffffff' : '#16213e',
      borderColor: isLight ? '#e2e8f0' : '#4a4e69',
      textStyle: {
        color: isLight ? '#0f172a' : '#fff',
      },
      axisPointer: {
        type: 'line',
        axis: 'x',
        lineStyle: {
          color: axisColor,
        },
      },
    },
    legend: {
      textStyle: {
        color: labelColor,
      },
      top: 0,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine: {
        lineStyle: {
          color: axisColor,
        },
      },
      axisLabel: {
        color: labelColor,
        formatter: (value: string) => {
          const secs = parseFloat(value);
          const mins = Math.floor(secs / 60);
          const remainingSecs = Math.floor(secs % 60);
          return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
        },
      },
      splitLine: {
        show: false,
      },
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'filter',
        zoomOnMouseWheel: 'ctrl',
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: false,
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        height: 18,
        bottom: 12,
        brushSelect: false,
        borderColor: zoomBorder,
        backgroundColor: zoomBg,
        fillerColor: zoomFiller,
        handleStyle: {
          color: handleColor,
        },
        textStyle: {
          color: labelColor,
        },
        dataBackground: {
          lineStyle: { color: isLight ? '#94a3b8' : '#4a4e69' },
          areaStyle: { color: isLight ? '#cbd5e1' : '#2a2a4e' },
        },
        selectedDataBackground: {
          lineStyle: { color: handleColor },
          areaStyle: { color: isLight ? 'rgba(0, 122, 204, 0.1)' : 'rgba(0, 160, 220, 0.15)' },
        },
      },
    ],
  };
}

// Module-level cache for current base config (set by TelemetryCharts component)
let baseChartConfig: Partial<EChartsOption> = createBaseChartConfig('dark');

function createAltitudeSpeedChart(
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const hasHeight = data.height.some((val) => val !== null);
  const fallbackHeight = data.altitude ?? [];
  const heightSource = hasHeight ? data.height : fallbackHeight;
  const heightSeries =
    unitSystem === 'imperial'
      ? heightSource.map((val) => (val === null ? null : val * 3.28084))
      : heightSource;
  const vpsHeightSeries =
    unitSystem === 'imperial'
      ? data.vpsHeight.map((val) => (val === null ? null : val * 3.28084))
      : data.vpsHeight;
  const speedSeries =
    unitSystem === 'imperial'
      ? data.speed.map((val) => (val === null ? null : val * 2.236936))
      : data.speed.map((val) => (val === null ? null : val * 3.6));
  const heightUnit = unitSystem === 'imperial' ? 'ft' : 'm';
  const speedUnit = unitSystem === 'imperial' ? 'mph' : 'km/h';
  const heightRange = computeRange([
    ...heightSeries,
    ...vpsHeightSeries,
  ]);
  const speedRange = computeRange(speedSeries);

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Height', 'VPS Height', 'Speed'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: [
      {
        type: 'value',
        name: `Height (${heightUnit})`,
        min: heightRange.min,
        max: heightRange.max,
        nameTextStyle: {
          color: '#00A0DC',
        },
        axisLine: {
          lineStyle: {
            color: '#00A0DC',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          lineStyle: {
            color: splitLineColor,
          },
        },
      },
      {
        type: 'value',
        name: `Speed (${speedUnit})`,
        min: speedRange.min,
        max: speedRange.max,
        nameTextStyle: {
          color: '#00D4AA',
        },
        axisLine: {
          lineStyle: {
            color: '#00D4AA',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          show: false,
        },
      },
    ],
    series: [
      {
        name: 'Height',
        type: 'line',
        data: heightSeries,
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#00A0DC',
        },
        lineStyle: {
          color: '#00A0DC',
          width: 2,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(0, 160, 220, 0.3)' },
              { offset: 1, color: 'rgba(0, 160, 220, 0.05)' },
            ],
          },
        },
      },
      {
        name: 'VPS Height',
        type: 'line',
        data: vpsHeightSeries,
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f97316',
        },
        lineStyle: {
          color: '#f97316',
          width: 1.5,
        },
      },
      {
        name: 'Speed',
        type: 'line',
        data: speedSeries,
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#00D4AA',
        },
        lineStyle: {
          color: '#00D4AA',
          width: 2,
        },
      },
    ],
  };
}

function createBatteryChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const batteryRange = computeRange(data.battery, { clampMin: 0, clampMax: 100 });
  const voltageRange = computeRange(data.batteryVoltage);
  const tempRange = computeRange(data.batteryTemp);
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Battery %', 'Voltage', 'Temperature'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: [
      {
        type: 'value',
        name: 'Battery %',
        min: batteryRange.min,
        max: batteryRange.max,
        axisLine: {
          lineStyle: {
            color: '#f59e0b',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          lineStyle: {
            color: splitLineColor,
          },
        },
      },
      {
        type: 'value',
        name: 'Temp (°C)',
        position: 'right',
        min: tempRange.min,
        max: tempRange.max,
        axisLine: {
          lineStyle: {
            color: '#a855f7',
          },
        },
        axisLabel: {
          color: '#9ca3af',
        },
        splitLine: {
          show: false,
        },
      },
      {
        type: 'value',
        position: 'right',
        offset: 44,
        min: voltageRange.min,
        max: voltageRange.max,
        axisLabel: {
          show: false,
        },
        axisLine: {
          show: false,
        },
        axisTick: {
          show: false,
        },
        splitLine: {
          show: false,
        },
      },
    ],
    series: [
      {
        name: 'Battery %',
        type: 'line',
        data: data.battery,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f59e0b',
        },
        lineStyle: {
          color: '#f59e0b',
          width: 2,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(245, 158, 11, 0.3)' },
              { offset: 1, color: 'rgba(245, 158, 11, 0.05)' },
            ],
          },
        },
        markArea: {
          silent: true,
          itemStyle: {
            color: 'rgba(239, 68, 68, 0.18)',
          },
          data: [[{ yAxis: 0 }, { yAxis: 20 }]],
        },
      },
      {
        name: 'Voltage',
        type: 'line',
        data: data.batteryVoltage,
        yAxisIndex: 2,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#38bdf8',
        },
        lineStyle: {
          color: '#38bdf8',
          width: 1.5,
        },
      },
      {
        name: 'Temperature',
        type: 'line',
        data: data.batteryTemp,
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#a855f7',
        },
        lineStyle: {
          color: '#a855f7',
          width: 1.5,
        },
      },
    ],
  };
}

// Colors for cell voltage series (up to 12 cells)
const cellVoltageColors = [
  '#10b981', // emerald-500
  '#3b82f6', // blue-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
  '#6366f1', // indigo-500
  '#84cc16', // lime-500
  '#06b6d4', // cyan-500
  '#a855f7', // purple-500
];

function createCellVoltageChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption | null {
  // Determine the number of cells from the first non-null entry
  const cellVoltages = data.cellVoltages;
  if (!cellVoltages || cellVoltages.length === 0) {
    return null;
  }

  // Find first non-null entry to determine cell count
  const firstValidEntry = cellVoltages.find((v) => v !== null && v !== undefined);
  if (!firstValidEntry) {
    return null;
  }

  const numCells = firstValidEntry.length;
  if (numCells === 0) {
    return null;
  }

  // Extract individual cell series
  const cellSeries: (number | null)[][] = Array.from({ length: numCells }, () => []);
  for (const voltages of cellVoltages) {
    for (let i = 0; i < numCells; i++) {
      if (voltages && voltages[i] !== undefined) {
        cellSeries[i].push(voltages[i]);
      } else {
        cellSeries[i].push(null);
      }
    }
  }

  // Compute range across all cells
  const allVoltages = cellSeries.flat().filter((v): v is number => v !== null);
  const voltageRange = computeRange(allVoltages, { paddingRatio: 0.05 });

  const legendData = Array.from({ length: numCells }, (_, i) => `Cell ${i + 1}`);

  const series: LineSeriesOption[] = cellSeries.map((values, i) => ({
    name: `Cell ${i + 1}`,
    type: 'line',
    data: values,
    smooth: true,
    symbol: 'none',
    itemStyle: {
      color: cellVoltageColors[i % cellVoltageColors.length],
    },
    lineStyle: {
      color: cellVoltageColors[i % cellVoltageColors.length],
      width: 1.5,
    },
  }));

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: legendData,
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'Cell Voltage (V)',
      min: voltageRange.min,
      max: voltageRange.max,
      axisLine: {
        lineStyle: {
          color: '#10b981',
        },
      },
      axisLabel: {
        color: '#9ca3af',
        formatter: '{value}',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series,
  };
}

function createAttitudeChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const attitudeRange = computeRange([
    ...data.pitch,
    ...data.roll,
    ...data.yaw,
  ]);
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Pitch', 'Roll', 'Yaw'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'Rotations',
      nameTextStyle: {
        color: '#8b5cf6',
      },
      min: attitudeRange.min,
      max: attitudeRange.max,
      axisLine: {
        lineStyle: {
          color: '#8b5cf6',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'Pitch',
        type: 'line',
        data: data.pitch,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#8b5cf6',
        },
        lineStyle: {
          color: '#8b5cf6',
          width: 1.5,
        },
      },
      {
        name: 'Roll',
        type: 'line',
        data: data.roll,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#ec4899',
        },
        lineStyle: {
          color: '#ec4899',
          width: 1.5,
        },
      },
      {
        name: 'Yaw',
        type: 'line',
        data: data.yaw,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#14b8a6',
        },
        lineStyle: {
          color: '#14b8a6',
          width: 1.5,
        },
      },
    ],
  };
}

function createRcSignalChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const rcUplink = data.rcUplink ?? [];
  const rcDownlink = data.rcDownlink ?? [];
  const hasUplink = rcUplink.some((val) => val !== null && val !== undefined);
  const hasDownlink = rcDownlink.some((val) => val !== null && val !== undefined);
  const showCombined = !hasUplink && !hasDownlink;
  const series: LineSeriesOption[] = [
    ...(showCombined
      ? [
          {
            name: 'RC Signal',
            type: 'line' as const,
            data: data.rcSignal,
            smooth: true,
            symbol: 'none',
            itemStyle: {
              color: '#22c55e',
            },
            lineStyle: {
              color: '#22c55e',
              width: 1.5,
            },
          },
        ]
      : [
          {
            name: 'RC Uplink',
            type: 'line' as const,
            data: rcUplink,
            smooth: true,
            symbol: 'none',
            itemStyle: {
              color: '#22c55e',
            },
            lineStyle: {
              color: '#22c55e',
              width: 1.5,
            },
          },
          {
            name: 'RC Downlink',
            type: 'line' as const,
            data: rcDownlink,
            smooth: true,
            symbol: 'none',
            itemStyle: {
              color: '#38bdf8',
            },
            lineStyle: {
              color: '#38bdf8',
              width: 1.5,
            },
          },
        ]),
  ];
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: showCombined ? ['RC Signal'] : ['RC Uplink', 'RC Downlink'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'RC Signal',
      min: 0,
      max: 100,
      interval: 50,
      axisLine: {
        lineStyle: {
          color: '#22c55e',
        },
      },
      axisLabel: {
        color: '#9ca3af',
        formatter: (value: number) => (value % 50 === 0 ? String(value) : ''),
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series,
  };
}

function createDistanceToHomeChart(
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const distances = computeDistanceToHomeSeries(data);
  const distanceSeries =
    unitSystem === 'imperial'
      ? distances.map((val) => (val === null ? null : val * 3.28084))
      : distances;
  const distanceUnit = unitSystem === 'imperial' ? 'ft' : 'm';
  const distanceRange = computeRange(distanceSeries, { clampMin: 0 });

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['Distance to Home'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: `Distance (${distanceUnit})`,
      min: distanceRange.min,
      max: distanceRange.max,
      axisLine: {
        lineStyle: {
          color: '#22c55e',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'Distance to Home',
        type: 'line',
        data: distanceSeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#22c55e',
        },
        lineStyle: {
          color: '#22c55e',
          width: 1.5,
        },
      },
    ],
  };
}

function createVelocityChart(
  data: TelemetryData,
  unitSystem: UnitSystem,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const velocityX = data.velocityX ?? [];
  const velocityY = data.velocityY ?? [];
  const velocityZ = data.velocityZ ?? [];
  const speedSeriesFactor = unitSystem === 'imperial' ? 2.236936 : 3.6;
  const xSeries = velocityX.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const ySeries = velocityY.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const zSeries = velocityZ.map((val) => (val === null || val === undefined ? null : val * speedSeriesFactor));
  const speedUnit = unitSystem === 'imperial' ? 'mph' : 'km/h';
  const speedRange = computeRange([...xSeries, ...ySeries, ...zSeries]);

  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['X Speed', 'Y Speed', 'Z Speed'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: `Speed (${speedUnit})`,
      min: speedRange.min,
      max: speedRange.max,
      axisLine: {
        lineStyle: {
          color: '#f59e0b',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'X Speed',
        type: 'line',
        data: xSeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#f59e0b',
        },
        lineStyle: {
          color: '#f59e0b',
          width: 1.5,
        },
      },
      {
        name: 'Y Speed',
        type: 'line',
        data: ySeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#ec4899',
        },
        lineStyle: {
          color: '#ec4899',
          width: 1.5,
        },
      },
      {
        name: 'Z Speed',
        type: 'line',
        data: zSeries,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#38bdf8',
        },
        lineStyle: {
          color: '#38bdf8',
          width: 1.5,
        },
      },
    ],
  };
}

function computeDistanceToHomeSeries(data: TelemetryData): Array<number | null> {
  const lats = data.latitude ?? [];
  const lngs = data.longitude ?? [];
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
    return data.time.map(() => null);
  }

  return data.time.map((_, index) => {
    const lat = lats[index];
    const lng = lngs[index];
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return haversineDistance(homeLat, homeLng, lat, lng);
  });
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function createGpsChart(
  data: TelemetryData,
  splitLineColor: string,
  tooltipFormatter: TooltipFormatter,
  tooltipColors: TooltipColors
): EChartsOption {
  const gpsRange = computeRange(data.satellites, { clampMin: 0 });
  return {
    ...baseChartConfig,
    tooltip: {
      ...baseChartConfig.tooltip,
      backgroundColor: tooltipColors.background,
      borderColor: tooltipColors.border,
      textStyle: { color: tooltipColors.text },
      formatter: tooltipFormatter,
    },
    legend: {
      ...baseChartConfig.legend,
      data: ['GPS Satellites'],
    },
    xAxis: {
      ...createTimeAxis(data.time),
    },
    yAxis: {
      type: 'value',
      name: 'Satellites',
      min: gpsRange.min,
      max: gpsRange.max,
      axisLine: {
        lineStyle: {
          color: '#0ea5e9',
        },
      },
      axisLabel: {
        color: '#9ca3af',
      },
      splitLine: {
        lineStyle: {
          color: splitLineColor,
        },
      },
    },
    series: [
      {
        name: 'GPS Satellites',
        type: 'line',
        data: data.satellites,
        smooth: true,
        symbol: 'none',
        itemStyle: {
          color: '#0ea5e9',
        },
        lineStyle: {
          color: '#0ea5e9',
          width: 1.5,
        },
      },
    ],
  };
}

function computeRange(
  values: Array<number | null | undefined>,
  options: { clampMin?: number; clampMax?: number; paddingRatio?: number } = {}
): { min?: number; max?: number } {
  const cleaned = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  if (cleaned.length === 0) return {};

  let min = Math.min(...cleaned);
  let max = Math.max(...cleaned);
  if (min === max) {
    const delta = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= delta;
    max += delta;
  }

  const paddingRatio = options.paddingRatio ?? 0.08;
  const padding = (max - min) * paddingRatio;
  min -= padding;
  max += padding;

  if (typeof options.clampMin === 'number') {
    min = Math.max(min, options.clampMin);
  }
  if (typeof options.clampMax === 'number') {
    max = Math.min(max, options.clampMax);
  }

  min = roundAxisValue(min);
  max = roundAxisValue(max);

  if (min === max) {
    const bump = min === 0 ? 1 : Math.abs(min) * 0.1;
    min = roundAxisValue(min - bump);
    max = roundAxisValue(max + bump);
  }

  return { min, max };
}

function roundAxisValue(value: number): number {
  if (Math.abs(value) < 0.0001) return 0;
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return Number(value.toFixed(decimals));
}

function resolveThemeMode(mode: 'system' | 'dark' | 'light'): 'dark' | 'light' {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

type TooltipFormatter = (params: any) => string;
type TooltipColors = {
  background: string;
  border: string;
  text: string;
};

function createTooltipFormatter(
  startTime: string | null,
  theme: 'light' | 'dark'
): TooltipFormatter {
  return (params) => {
    const items = Array.isArray(params) ? params : [params];
    const axisValue = items[0]?.axisValue ?? '';
    const seconds =
      typeof axisValue === 'number'
        ? axisValue
        : Number.parseFloat(String(axisValue));
    const header = formatTooltipHeader(startTime, seconds, theme);

    const lines = items.map((item) => {
      const marker = typeof item.marker === 'string' ? item.marker : '';
      const label = item.seriesName ?? '';
      const rawValue =
        Array.isArray(item.value) && item.value.length > 0
          ? item.value[item.value.length - 1]
          : item.value ?? item.data;
      const value =
        typeof rawValue === 'number' && Number.isFinite(rawValue)
          ? formatNumericValue(rawValue)
          : rawValue ?? '-';
      return `${marker} ${label}: ${value}`;
    });

    return [header, ...lines].join('<br/>');
  };
}

function formatTooltipHeader(
  startTime: string | null,
  seconds: number,
  theme: 'light' | 'dark'
): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const durationLabel = formatDurationLabel(safeSeconds);
  if (!startTime) {
    return durationLabel;
  }
  const startDate = new Date(startTime);
  const timestamp = new Date(startDate.getTime() + safeSeconds * 1000);
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(timestamp);
  const durationBg = theme === 'light' ? 'rgba(15, 23, 42, 0.08)' : 'rgba(0,212,170,0.2)';
  const timeBg = theme === 'light' ? 'rgba(2, 132, 199, 0.12)' : 'rgba(0,160,220,0.22)';
  const textColor = theme === 'light' ? '#0f172a' : '#e2e8f0';
  return `<div style="margin-bottom:0px;display:flex;gap:6px;align-items:center;">
    <span class="tooltip-duration-tag" style="display:inline-block;padding:2px 8px;border-radius:999px;background:${durationBg};color:${textColor};font-size:11px;line-height:1.2;">${durationLabel}</span>
    <span class="tooltip-time-tag" style="display:inline-block;padding:2px 8px;border-radius:999px;background:${timeBg};color:${textColor};font-size:11px;line-height:1.2;">${timeLabel}</span>
  </div>`;
}

function formatDurationLabel(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(remaining).padStart(2, '0');
  return `${mm}m ${ss}s`;
}

function formatNumericValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/\.00$/, '');
}

function createTimeAxis(time: number[]): EChartsOption['xAxis'] {
  const values = time.map((t) => t.toFixed(1));
  return {
    type: 'category',
    boundaryGap: false,
    data: values,
    axisLine: {
      lineStyle: {
        color: '#4a4e69',
      },
    },
    axisTick: {
      alignWithLabel: true,
    } as any,
    axisLabel: {
      color: '#9ca3af',
      showMinLabel: false,
      showMaxLabel: false,
      hideOverlap: true,
      rotate: 30,
      interval: (index: number) => {
        if (index === 0) return true;
        const current = time[index];
        const previous = time[index - 1];
        if (!Number.isFinite(current) || !Number.isFinite(previous)) return false;
        return Math.floor(previous / 60) !== Math.floor(current / 60);
      },
      formatter: (value: string) => {
        return formatTimeLabel(value);
      },
    },
    splitLine: {
      show: false,
    },
  };
}

function formatTimeLabel(value: string): string {
  const secs = Number.parseFloat(value);
  if (!Number.isFinite(secs)) return '';
  const rounded = Math.round(secs);
  const mins = Math.floor(rounded / 60);
  const remainingSecs = Math.floor(rounded % 60);
  return `${mins}:${remainingSecs.toString().padStart(2, '0')}`;
}

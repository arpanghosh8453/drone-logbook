/**
 * Open-Meteo Historical Weather API client.
 *
 * Uses the free archive-api.open-meteo.com endpoint (no API key required).
 * A single request fetches all needed hourly variables for the flight hour.
 */

export interface WeatherData {
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  windSpeed: number;
  windGusts: number;
  windDirection: number;
  cloudCover: number;
  precipitation: number;
  pressure: number;
  conditionLabel: string;
}

/**
 * WMO weather interpretation codes -> human-readable label
 */
function wmoCodeToLabel(code: number): string {
  const map: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snowfall',
    73: 'Moderate snowfall',
    75: 'Heavy snowfall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return map[code] ?? `WMO ${code}`;
}

/**
 * Fetch historical weather for the given location and time.
 *
 * Requests hourly data for the flight date and picks the hour matching
 * the flight start time.
 */
export async function fetchFlightWeather(
  lat: number,
  lon: number,
  startTime: string,
): Promise<WeatherData> {
  const dt = new Date(startTime);
  if (isNaN(dt.getTime())) {
    throw new Error('Invalid flight start time');
  }

  const date = dt.toISOString().slice(0, 10); // yyyy-mm-dd
  const hour = dt.getUTCHours();

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    start_date: date,
    end_date: date,
    hourly: [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'wind_speed_10m',
      'wind_gusts_10m',
      'wind_direction_10m',
      'cloud_cover',
      'precipitation',
      'surface_pressure',
      'weather_code',
    ].join(','),
    timezone: 'GMT',
  });

  const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `Could not reach the weather service. Please check your internet connection.`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = '';
    try {
      const j = JSON.parse(body);
      if (j.reason) detail = j.reason;
    } catch { /* ignore */ }
    throw new Error(detail || `Weather API returned status ${res.status}`);
  }

  const json = await res.json();
  const h = json.hourly;

  if (!h || !h.time || !Array.isArray(h.time) || h.time.length === 0) {
    throw new Error('No weather data available for this flight date');
  }

  // Find the index for the matching hour
  const idx = Math.min(hour, h.time.length - 1);

  const val = (arr: number[] | null | undefined, fallback = 0): number => {
    if (!arr || idx >= arr.length) return fallback;
    return arr[idx] ?? fallback;
  };

  return {
    temperature: Math.round(val(h.temperature_2m) * 10) / 10,
    apparentTemperature: Math.round(val(h.apparent_temperature) * 10) / 10,
    humidity: Math.round(val(h.relative_humidity_2m)),
    windSpeed: Math.round(val(h.wind_speed_10m) * 10) / 10,
    windGusts: Math.round(val(h.wind_gusts_10m) * 10) / 10,
    windDirection: Math.round(val(h.wind_direction_10m)),
    cloudCover: Math.round(val(h.cloud_cover)),
    precipitation: Math.round(val(h.precipitation) * 10) / 10,
    pressure: Math.round(val(h.surface_pressure)),
    conditionLabel: wmoCodeToLabel(val(h.weather_code)),
  };
}

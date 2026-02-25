/**
 * Manual Flight Entry Modal
 * Allows users to create flight entries without log files.
 */

import { useState, useEffect, useRef } from 'react';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { createManualFlight } from '@/lib/api';
import { useFlightStore } from '@/stores/flightStore';

function resolveThemeMode(mode: 'system' | 'dark' | 'light'): 'dark' | 'light' {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  }
  return mode;
}

interface ManualEntryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface FormData {
  flightTitle: string;
  aircraftName: string;
  droneSerial: string;
  batterySerial: string;
  date: Date | undefined;
  time: string; // HH:MM:SS in 24h format
  durationSecs: string;
  totalDistance: string;
  maxAltitude: string;
  homeLat: string;
  homeLon: string;
  notes: string;
}

interface FormErrors {
  aircraftName?: string;
  droneSerial?: string;
  batterySerial?: string;
  date?: string;
  time?: string;
  durationSecs?: string;
  totalDistance?: string;
  maxAltitude?: string;
  homeLat?: string;
  homeLon?: string;
}

const getInitialFormData = (): FormData => ({
  flightTitle: '',
  aircraftName: '',
  droneSerial: '',
  batterySerial: '',
  date: new Date(),
  time: '12:00:00',
  durationSecs: '',
  totalDistance: '',
  maxAltitude: '',
  homeLat: '',
  homeLon: '',
  notes: '',
});

export function ManualEntryModal({ isOpen, onClose }: ManualEntryModalProps) {
  const [formData, setFormData] = useState<FormData>(getInitialFormData);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
  const datePickerRef = useRef<HTMLDivElement>(null);

  const { unitSystem, loadFlights, loadOverview, loadAllTags, themeMode } = useFlightStore();
  const isLight = resolveThemeMode(themeMode) === 'light';

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setFormData(getInitialFormData());
      setErrors({});
      setMessage(null);
      setIsDatePickerOpen(false);
    }
  }, [isOpen]);

  // Helper to filter numeric input (only digits, minus, dot allowed)
  const filterNumericInput = (value: string, allowNegative: boolean = true): string => {
    // Remove all non-numeric characters except minus and dot
    let filtered = value.replace(/[^0-9.\-]/g, '');
    // Only allow minus at the start
    if (!allowNegative) {
      filtered = filtered.replace(/-/g, '');
    } else {
      const parts = filtered.split('-');
      if (parts.length > 1) {
        filtered = '-' + parts.join('').replace(/-/g, '');
      }
    }
    // Only allow one decimal point
    const dotParts = filtered.split('.');
    if (dotParts.length > 2) {
      filtered = dotParts[0] + '.' + dotParts.slice(1).join('');
    }
    return filtered;
  };

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    if (!formData.aircraftName.trim()) {
      newErrors.aircraftName = 'Required';
    }
    if (!formData.droneSerial.trim()) {
      newErrors.droneSerial = 'Required';
    }
    if (!formData.batterySerial.trim()) {
      newErrors.batterySerial = 'Required';
    }
    if (!formData.date) {
      newErrors.date = 'Required';
    }
    if (!formData.time) {
      newErrors.time = 'Required';
    } else if (!/^\d{2}:\d{2}:\d{2}$/.test(formData.time)) {
      newErrors.time = 'Use HH:MM:SS format';
    }
    
    const duration = parseFloat(formData.durationSecs);
    if (!formData.durationSecs || isNaN(duration) || duration <= 0) {
      newErrors.durationSecs = 'Required (positive number)';
    }

    // Validate distance if provided
    if (formData.totalDistance) {
      const distance = parseFloat(formData.totalDistance);
      if (isNaN(distance) || distance < 0) {
        newErrors.totalDistance = 'Must be a positive number';
      }
    }

    // Validate altitude if provided
    if (formData.maxAltitude) {
      const altitude = parseFloat(formData.maxAltitude);
      if (isNaN(altitude) || altitude < 0) {
        newErrors.maxAltitude = 'Must be a positive number';
      }
    }

    const lat = parseFloat(formData.homeLat);
    if (!formData.homeLat || isNaN(lat)) {
      newErrors.homeLat = 'Required';
    } else if (lat < -90 || lat > 90) {
      newErrors.homeLat = 'Must be -90 to 90';
    }

    const lon = parseFloat(formData.homeLon);
    if (!formData.homeLon || isNaN(lon)) {
      newErrors.homeLon = 'Required';
    } else if (lon < -180 || lon > 180) {
      newErrors.homeLon = 'Must be -180 to 180';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;

    setIsSubmitting(true);
    setMessage(null);

    try {
      // Convert distance/altitude from display units to meters if provided
      let totalDistanceMeters: number | undefined;
      let maxAltitudeMeters: number | undefined;

      if (formData.totalDistance) {
        const distance = parseFloat(formData.totalDistance);
        if (!isNaN(distance)) {
          // If imperial, convert from feet to meters
          totalDistanceMeters = unitSystem === 'imperial' ? distance * 0.3048 : distance;
        }
      }

      if (formData.maxAltitude) {
        const altitude = parseFloat(formData.maxAltitude);
        if (!isNaN(altitude)) {
          // If imperial, convert from feet to meters
          maxAltitudeMeters = unitSystem === 'imperial' ? altitude * 0.3048 : altitude;
        }
      }

      // Create ISO 8601 timestamp in UTC
      // Build local datetime from selected date and time, then convert to UTC
      const dateStr = formData.date!.toISOString().split('T')[0]; // YYYY-MM-DD
      const localDateTime = new Date(`${dateStr}T${formData.time}`);
      const startTime = localDateTime.toISOString(); // Converts to UTC ISO format

      const result = await createManualFlight({
        flightTitle: formData.flightTitle.trim() || undefined,
        aircraftName: formData.aircraftName.trim(),
        droneSerial: formData.droneSerial.trim(),
        batterySerial: formData.batterySerial.trim(),
        startTime,
        durationSecs: parseFloat(formData.durationSecs),
        totalDistance: totalDistanceMeters,
        maxAltitude: maxAltitudeMeters,
        homeLat: parseFloat(formData.homeLat),
        homeLon: parseFloat(formData.homeLon),
        notes: formData.notes.trim() || undefined,
      });

      if (result.success) {
        setMessage({ type: 'success', text: 'Flight entry created successfully!' });
        // Refresh flight list
        await Promise.all([loadFlights(), loadOverview(), loadAllTags()]);
        // Close after brief delay
        setTimeout(() => {
          onClose();
        }, 1000);
      } else {
        setMessage({ type: 'error', text: result.message || 'Failed to create flight entry' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to create flight entry' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFieldChange = (field: keyof FormData, value: string | Date | undefined) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error for this field when user types
    if (errors[field as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const formatDateDisplay = (date: Date | undefined): string => {
    if (!date) return 'Select date';
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (!isOpen) return null;

  const distanceUnit = unitSystem === 'imperial' ? 'ft' : 'm';
  const altitudeUnit = unitSystem === 'imperial' ? 'ft' : 'm';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isSubmitting ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative bg-drone-secondary rounded-xl border border-gray-700 shadow-2xl w-full max-w-2xl max-h-full grid grid-rows-[auto_1fr_auto]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">Manual Flight Entry</h2>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto space-y-4">
          {/* Message */}
          {message && (
            <div
              className={`p-3 rounded-lg text-sm ${
                message.type === 'success'
                  ? 'bg-green-900/50 text-green-300 border border-green-700'
                  : 'bg-red-900/50 text-red-300 border border-red-700'
              }`}
            >
              {message.text}
            </div>
          )}

          {/* Flight Title and Aircraft Name Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Flight Title */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Flight Title
              </label>
              <input
                type="text"
                value={formData.flightTitle}
                onChange={(e) => handleFieldChange('flightTitle', e.target.value)}
                placeholder="Optional - defaults to Aircraft Name"
                className="w-full px-3 py-2 bg-drone-dark border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary"
              />
            </div>

            {/* Aircraft Name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Aircraft Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={formData.aircraftName}
                onChange={(e) => handleFieldChange('aircraftName', e.target.value)}
                placeholder="e.g., DJI Mini 3 Pro"
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.aircraftName ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.aircraftName && <p className="mt-1 text-xs text-red-400">{errors.aircraftName}</p>}
            </div>
          </div>

          {/* Serial Numbers Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Drone Serial */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Aircraft SN <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={formData.droneSerial}
                onChange={(e) => handleFieldChange('droneSerial', e.target.value)}
                placeholder="e.g., 3NZCH..."
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.droneSerial ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.droneSerial && <p className="mt-1 text-xs text-red-400">{errors.droneSerial}</p>}
            </div>

            {/* Battery Serial */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Battery SN <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={formData.batterySerial}
                onChange={(e) => handleFieldChange('batterySerial', e.target.value)}
                placeholder="e.g., 5QBH..."
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.batterySerial ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.batterySerial && <p className="mt-1 text-xs text-red-400">{errors.batterySerial}</p>}
            </div>
          </div>

          {/* Date and Time Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Date */}
            <div className="relative" ref={datePickerRef}>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Date <span className="text-red-400">*</span>
              </label>
              <button
                type="button"
                onClick={() => setIsDatePickerOpen(!isDatePickerOpen)}
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white text-left focus:outline-none focus:ring-1 focus:ring-drone-primary flex items-center justify-between ${
                  errors.date ? 'border-red-500' : 'border-gray-600'
                }`}
              >
                <span className={formData.date ? '' : 'text-gray-500'}>
                  {formatDateDisplay(formData.date)}
                </span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-60">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                  <line x1="16" y1="2" x2="16" y2="6"/>
                  <line x1="8" y1="2" x2="8" y2="6"/>
                  <line x1="3" y1="10" x2="21" y2="10"/>
                </svg>
              </button>
              {isDatePickerOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setIsDatePickerOpen(false)}
                  />
                  <div
                    className={`absolute left-0 top-full mt-1 z-50 rounded-xl border p-3 shadow-xl ${
                      isLight
                        ? 'bg-white border-gray-200'
                        : 'bg-drone-surface border-gray-700'
                    }`}
                  >
                    <DayPicker
                      mode="single"
                      selected={formData.date}
                      onSelect={(date) => {
                        handleFieldChange('date', date);
                        setIsDatePickerOpen(false);
                      }}
                      disabled={{ after: new Date() }}
                      defaultMonth={formData.date}
                      weekStartsOn={1}
                      className={`rdp-theme ${isLight ? 'rdp-light' : 'rdp-dark'}`}
                    />
                  </div>
                </>
              )}
              {errors.date && <p className="mt-1 text-xs text-red-400">{errors.date}</p>}
            </div>

            {/* Time */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Takeoff Time <span className="text-red-400">*</span>
              </label>
              <input
                type="time"
                step="1"
                value={formData.time}
                onChange={(e) => {
                  const val = e.target.value;
                  // Ensure HH:MM:SS format
                  if (val.includes(':') && val.split(':').length === 2) {
                    handleFieldChange('time', `${val}:00`);
                  } else {
                    handleFieldChange('time', val);
                  }
                }}
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.time ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.time && <p className="mt-1 text-xs text-red-400">{errors.time}</p>}
              <p className="mt-1 text-xs text-gray-500">24h format (local time)</p>
            </div>
          </div>

          {/* Distance and Altitude Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Total Distance */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Travelled Distance ({distanceUnit})
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={formData.totalDistance}
                onChange={(e) => handleFieldChange('totalDistance', filterNumericInput(e.target.value, false))}
                placeholder="Optional"
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.totalDistance ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.totalDistance && <p className="mt-1 text-xs text-red-400">{errors.totalDistance}</p>}
            </div>

            {/* Max Altitude */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Max Altitude ({altitudeUnit})
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={formData.maxAltitude}
                onChange={(e) => handleFieldChange('maxAltitude', filterNumericInput(e.target.value, false))}
                placeholder="Optional"
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.maxAltitude ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.maxAltitude && <p className="mt-1 text-xs text-red-400">{errors.maxAltitude}</p>}
            </div>
          </div>

          {/* Coordinates Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Latitude */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Takeoff Latitude <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={formData.homeLat}
                onChange={(e) => handleFieldChange('homeLat', filterNumericInput(e.target.value, true))}
                placeholder="e.g., 37.7749"
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.homeLat ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.homeLat && <p className="mt-1 text-xs text-red-400">{errors.homeLat}</p>}
              <p className="mt-1 text-xs text-gray-500">-90 to 90</p>
            </div>

            {/* Longitude */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Takeoff Longitude <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={formData.homeLon}
                onChange={(e) => handleFieldChange('homeLon', filterNumericInput(e.target.value, true))}
                placeholder="e.g., -122.4194"
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.homeLon ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.homeLon && <p className="mt-1 text-xs text-red-400">{errors.homeLon}</p>}
              <p className="mt-1 text-xs text-gray-500">-180 to 180</p>
            </div>
          </div>

          {/* Duration and Notes Row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Duration */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Duration (seconds) <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={formData.durationSecs}
                onChange={(e) => handleFieldChange('durationSecs', filterNumericInput(e.target.value, false))}
                placeholder="e.g., 600"
                className={`w-full px-3 py-2 bg-drone-dark border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary ${
                  errors.durationSecs ? 'border-red-500' : 'border-gray-600'
                }`}
              />
              {errors.durationSecs && <p className="mt-1 text-xs text-red-400">{errors.durationSecs}</p>}
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Notes</label>
              <textarea
                value={formData.notes}
                onChange={(e) => handleFieldChange('notes', e.target.value)}
                placeholder="Optional notes about this flight..."
                rows={2}
                maxLength={500}
                className="w-full px-3 py-2 bg-drone-dark border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-drone-primary resize-none"
              />
              <p className="mt-1 text-xs text-gray-500">{formData.notes.length}/500</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-gray-700">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm text-gray-300 hover:text-white transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm bg-drone-primary text-white rounded-lg hover:bg-drone-primary/80 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting && (
              <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="opacity-75" />
              </svg>
            )}
            Create Flight
          </button>
        </div>
      </div>
    </div>
  );
}

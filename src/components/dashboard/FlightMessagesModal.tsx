/**
 * Flight Messages Modal
 * Displays all tip/warning messages for a flight in a scrollable list.
 * Shows clock time (local timezone), flight time offset, and the message with icon.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { FlightMessage } from '@/types';

interface FlightMessagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  messages: FlightMessage[];
  /** ISO string for flight start time, used to compute clock time */
  flightStartTime: string | null;
}

/** Format milliseconds offset as mm:ss */
function formatFlightTime(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Compute clock time string in local timezone from flight start ISO + offset ms */
function formatClockTime(flightStartTime: string | null, offsetMs: number): string {
  if (!flightStartTime) return '—';
  try {
    const startMs = new Date(flightStartTime).getTime();
    if (isNaN(startMs)) return '—';
    const clockDate = new Date(startMs + offsetMs);
    return clockDate.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function FlightMessagesModal({
  isOpen,
  onClose,
  messages,
  flightStartTime,
}: FlightMessagesModalProps) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sorted = [...messages].sort((a, b) => a.timestampMs - b.timestampMs);
  const warnCount = sorted.filter((m) => m.messageType === 'warn').length;
  const tipCount = sorted.filter((m) => m.messageType === 'tip').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div
        ref={modalRef}
        className="relative z-10 w-full max-w-lg bg-drone-dark border border-gray-700 rounded-2xl shadow-2xl flex flex-col max-h-[80vh]"
        role="dialog"
        aria-modal="true"
        aria-label={t('map.messages')}
      >
        {/* Header */}
        <div className="flex items-center px-5 py-4 border-b border-gray-700 flex-shrink-0 gap-3">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            {/* Chat-bubble icon */}
            <svg
              className="w-5 h-5 text-drone-accent flex-shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 10h.01M12 10h.01M16 10h.01M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"
              />
            </svg>
            <h2 className="font-semibold text-white text-base">
              {t('dashboard.flightMessages')}
            </h2>
          </div>

          {/* Summary badges */}
          <div className="flex items-center gap-2">
            {warnCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {warnCount}
              </span>
            )}
            {tipCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {tipCount}
              </span>
            )}
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
            aria-label={t('dashboard.messagesClose')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Column labels */}
        <div className="grid grid-cols-[72px_64px_1fr] gap-x-3 px-5 py-2 border-b border-gray-700/50 flex-shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            {t('dashboard.messagesColTime')}
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            {t('dashboard.messagesColFlight')}
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
            {t('dashboard.messagesColMessage')}
          </span>
        </div>

        {/* Scrollable message list */}
        <div className="overflow-y-auto flex-1 divide-y divide-gray-700/40 px-0">
          {sorted.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
              {t('dashboard.messagesEmpty')}
            </div>
          ) : (
            sorted.map((msg, idx) => {
              const isWarn = msg.messageType === 'warn';
              return (
                <div
                  key={idx}
                  className={`grid grid-cols-[72px_64px_1fr] gap-x-3 items-baseline px-5 py-3 transition-colors ${
                    isWarn ? 'hover:bg-amber-900/10' : 'hover:bg-blue-900/10'
                  }`}
                >
                  {/* Clock time */}
                  <span className="text-[11px] font-medium text-gray-200 tabular-nums leading-tight">
                    {formatClockTime(flightStartTime, msg.timestampMs)}
                  </span>

                  {/* Flight time */}
                  <span className="text-[11px] tabular-nums text-gray-400 leading-tight">
                    {formatFlightTime(msg.timestampMs)}
                  </span>

                  {/* Icon + message */}
                  <div className="flex items-start gap-2 min-w-0">
                    {isWarn ? (
                      <svg
                        className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        />
                      </svg>
                    ) : (
                      <svg
                        className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    )}
                    <span
                      className={`text-sm leading-snug break-words min-w-0 ${
                        isWarn ? 'text-amber-200' : 'text-blue-200'
                      }`}
                    >
                      {msg.message}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

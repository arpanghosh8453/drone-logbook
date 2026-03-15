import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DayPicker, type DateRange, type Matcher } from 'react-day-picker';

function parseIsoDate(value: string): Date | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  parsed.setHours(12, 0, 0, 0);
  return parsed;
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

type BaseProps = {
  isOpen: boolean;
  onClose: () => void;
  isLight?: boolean;
  position?: 'fixed' | 'absolute';
  style?: CSSProperties;
  popoverClassName?: string;
  title?: string;
  showJumpInput?: boolean;
  jumpMaxDate?: Date;
  disabled?: Matcher | Matcher[];
  defaultMonth?: Date;
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  numberOfMonths?: number;
  dayPickerClassName?: string;
  footer?: ReactNode;
};

type SingleProps = BaseProps & {
  mode: 'single';
  selected?: Date;
  onSelect: (date: Date | undefined) => void;
  onJumpDate?: (date: Date) => void;
};

type RangeProps = BaseProps & {
  mode: 'range';
  selected?: DateRange;
  onSelect: (range: DateRange | undefined) => void;
  onJumpRange?: (range: DateRange) => void;
};

type DatePickerPopoverProps = SingleProps | RangeProps;

export function DatePickerPopover({
  isOpen,
  onClose,
  isLight = false,
  position = 'fixed',
  style,
  popoverClassName = '',
  title,
  showJumpInput = true,
  jumpMaxDate,
  disabled,
  defaultMonth,
  weekStartsOn = 1,
  numberOfMonths = 1,
  dayPickerClassName,
  footer,
  ...pickerProps
}: DatePickerPopoverProps) {
  const { t } = useTranslation();
  const [jumpValue, setJumpValue] = useState('');
  const [jumpStartValue, setJumpStartValue] = useState('');
  const [jumpEndValue, setJumpEndValue] = useState('');
  const [jumpError, setJumpError] = useState<string | null>(null);

  const posClass = position === 'absolute' ? 'absolute' : 'fixed';
  const popoverTheme = isLight
    ? 'bg-white border-gray-300'
    : 'bg-drone-surface border-gray-700';

  const maxDateValue = useMemo(() => {
    if (!jumpMaxDate) return undefined;
    const d = new Date(jumpMaxDate);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [jumpMaxDate]);

  const handleJumpSingle = () => {
    if (pickerProps.mode !== 'single' || !pickerProps.onJumpDate) return;
    const parsed = parseIsoDate(jumpValue);
    if (!parsed) {
      setJumpError(t('common.useDateFormat'));
      return;
    }

    if (maxDateValue && parsed > maxDateValue) {
      setJumpError(t('common.dateInFuture'));
      return;
    }

    setJumpError(null);
    pickerProps.onJumpDate(parsed);
  };

  const handleJumpRange = () => {
    if (pickerProps.mode !== 'range' || !pickerProps.onJumpRange) return;
    const start = parseIsoDate(jumpStartValue);
    const end = parseIsoDate(jumpEndValue);

    if (!start || !end) {
      setJumpError(t('common.useDateFormat'));
      return;
    }

    if ((maxDateValue && start > maxDateValue) || (maxDateValue && end > maxDateValue)) {
      setJumpError(t('common.dateInFuture'));
      return;
    }

    const from = start <= end ? start : end;
    const to = start <= end ? end : start;

    setJumpError(null);
    pickerProps.onJumpRange({ from, to });
  };

  useEffect(() => {
    if (!isOpen) return;
    setJumpError(null);

    if (pickerProps.mode === 'single') {
      setJumpValue(pickerProps.selected ? toIsoDate(pickerProps.selected) : '');
      return;
    }

    setJumpStartValue(pickerProps.selected?.from ? toIsoDate(pickerProps.selected.from) : '');
    setJumpEndValue(pickerProps.selected?.to ? toIsoDate(pickerProps.selected.to) : '');
  }, [isOpen, pickerProps.mode, pickerProps.selected]);

  if (!isOpen) return null;

  const effectiveDefaultMonth = (() => {
    if (defaultMonth) return defaultMonth;
    if (pickerProps.mode === 'single') return pickerProps.selected;
    return pickerProps.selected?.from ?? pickerProps.selected?.to;
  })();
  const themeClass = `rdp-theme ${isLight ? 'rdp-light' : 'rdp-dark'}`;
  const resolvedDayPickerClassName = dayPickerClassName
    ? `${dayPickerClassName} ${isLight ? 'rdp-light' : 'rdp-dark'}`
    : themeClass;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className={`${posClass} z-50 rounded-xl border p-3 shadow-xl ${popoverTheme} ${popoverClassName}`}
        style={style}
      >
        {title && (
          <div className={`mb-2 text-xs font-medium ${isLight ? 'text-gray-600' : 'text-gray-400'}`}>
            {title}
          </div>
        )}

        {showJumpInput && pickerProps.mode === 'single' && pickerProps.onJumpDate && (
          <div className="mb-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={jumpValue}
                onChange={(e) => {
                  setJumpValue(e.target.value);
                  if (jumpError) setJumpError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleJumpSingle();
                  }
                }}
                placeholder={t('common.dateJumpPlaceholder')}
                inputMode="numeric"
                maxLength={10}
                className={`h-8 flex-1 rounded-md border px-2 text-xs focus:outline-none focus:ring-1 focus:ring-drone-primary ${isLight
                  ? 'border-gray-300 bg-white text-gray-900 placeholder:text-gray-400'
                  : 'border-gray-600 bg-drone-dark text-gray-100 placeholder:text-gray-500'
                  }`}
              />
              <button
                type="button"
                onClick={handleJumpSingle}
                className={`h-8 rounded-md border px-2.5 text-xs font-medium transition-colors ${isLight
                  ? 'border-gray-300 text-gray-800 hover:bg-gray-100'
                  : 'border-gray-600 text-gray-200 hover:bg-gray-700/60'
                  }`}
              >
                {t('common.go')}
              </button>
            </div>
            {jumpError && (
              <p className={`mt-1 text-[11px] ${isLight ? 'text-red-600' : 'text-red-400'}`}>
                {jumpError}
              </p>
            )}
          </div>
        )}

        {showJumpInput && pickerProps.mode === 'range' && pickerProps.onJumpRange && (
          <div className="mb-2">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={jumpStartValue}
                onChange={(e) => {
                  setJumpStartValue(e.target.value);
                  if (jumpError) setJumpError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleJumpRange();
                  }
                }}
                placeholder={t('common.dateJumpPlaceholder')}
                aria-label={t('overview.selectStartDate')}
                inputMode="numeric"
                maxLength={10}
                className={`h-7 min-w-0 flex-1 rounded-md border px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-drone-primary ${isLight
                  ? 'border-gray-300 bg-white text-gray-900 placeholder:text-gray-400'
                  : 'border-gray-600 bg-drone-dark text-gray-100 placeholder:text-gray-500'
                  }`}
              />
              <input
                type="text"
                value={jumpEndValue}
                onChange={(e) => {
                  setJumpEndValue(e.target.value);
                  if (jumpError) setJumpError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleJumpRange();
                  }
                }}
                placeholder={t('common.dateJumpPlaceholder')}
                aria-label={t('overview.selectEndDate')}
                inputMode="numeric"
                maxLength={10}
                className={`h-7 min-w-0 flex-1 rounded-md border px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-drone-primary ${isLight
                  ? 'border-gray-300 bg-white text-gray-900 placeholder:text-gray-400'
                  : 'border-gray-600 bg-drone-dark text-gray-100 placeholder:text-gray-500'
                  }`}
              />
              <button
                type="button"
                onClick={handleJumpRange}
                className={`h-7 shrink-0 rounded-md border px-2 text-[11px] font-medium transition-colors ${isLight
                  ? 'border-gray-300 text-gray-800 hover:bg-gray-100'
                  : 'border-gray-600 text-gray-200 hover:bg-gray-700/60'
                  }`}
              >
                {t('common.go')}
              </button>
            </div>
            {jumpError && (
              <p className={`mt-1 text-[11px] ${isLight ? 'text-red-600' : 'text-red-400'}`}>
                {jumpError}
              </p>
            )}
          </div>
        )}

        {pickerProps.mode === 'single' ? (
          <DayPicker
            mode="single"
            selected={pickerProps.selected}
            onSelect={pickerProps.onSelect}
            disabled={disabled}
            defaultMonth={effectiveDefaultMonth}
            weekStartsOn={weekStartsOn}
            numberOfMonths={numberOfMonths}
            className={resolvedDayPickerClassName}
          />
        ) : (
          <DayPicker
            mode="range"
            selected={pickerProps.selected}
            onSelect={pickerProps.onSelect}
            disabled={disabled}
            defaultMonth={effectiveDefaultMonth}
            weekStartsOn={weekStartsOn}
            numberOfMonths={numberOfMonths}
            className={resolvedDayPickerClassName}
          />
        )}

        {footer}
      </div>
    </>
  );
}

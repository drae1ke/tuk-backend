const DEFAULT_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Africa/Nairobi';

const formatters = new Map();

const getFormatter = (timeZone) => {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour12: false,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    );
  }

  return formatters.get(timeZone);
};

const getZonedParts = (date = new Date(), timeZone = DEFAULT_TIMEZONE) => {
  const parts = getFormatter(timeZone).formatToParts(date);
  const mapped = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      mapped[part.type] = part.value;
    }
  }

  return {
    weekday: mapped.weekday,
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour: Number(mapped.hour),
    minute: Number(mapped.minute),
    second: Number(mapped.second)
  };
};

const getWeekdayNumber = (weekday) => {
  const days = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return days[weekday] || 1;
};

const getTimeZoneOffsetMinutes = (date = new Date(), timeZone = DEFAULT_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return Math.round((zonedAsUtc - date.getTime()) / 60000);
};

const zonedTimeToUtc = (parts, timeZone = DEFAULT_TIMEZONE) => {
  let utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
    parts.millisecond || 0
  );

  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
    const adjusted = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour || 0,
      parts.minute || 0,
      parts.second || 0,
      parts.millisecond || 0
    ) - offsetMinutes * 60000;

    if (adjusted === utcGuess) {
      break;
    }

    utcGuess = adjusted;
  }

  return new Date(utcGuess);
};

const addDaysToDateParts = (parts, dayOffset) => {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset, 12, 0, 0));

  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate()
  };
};

const getWeekWindow = (referenceDate = new Date(), timeZone = DEFAULT_TIMEZONE) => {
  const parts = getZonedParts(referenceDate, timeZone);
  const weekdayNumber = getWeekdayNumber(parts.weekday);
  const mondayParts = addDaysToDateParts(parts, -(weekdayNumber - 1));
  const sundayParts = addDaysToDateParts(mondayParts, 6);

  const weekStart = zonedTimeToUtc({
    ...mondayParts,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0
  }, timeZone);

  const weekEnd = zonedTimeToUtc({
    ...sundayParts,
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999
  }, timeZone);

  const nextWeekStart = zonedTimeToUtc({
    ...addDaysToDateParts(mondayParts, 7),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0
  }, timeZone);

  const weekKey = `${mondayParts.year}-${String(mondayParts.month).padStart(2, '0')}-${String(mondayParts.day).padStart(2, '0')}`;

  return {
    timeZone,
    weekKey,
    weekStart,
    weekEnd,
    nextWeekStart
  };
};

const getPreviousWeekWindow = (referenceDate = new Date(), timeZone = DEFAULT_TIMEZONE) => {
  const currentWeek = getWeekWindow(referenceDate, timeZone);
  const previousReference = new Date(currentWeek.weekStart.getTime() - 1000);

  return getWeekWindow(previousReference, timeZone);
};

const getWeekRelativeDate = (weekStart, dayOffset, hour, minute, second = 0, millisecond = 0, timeZone = DEFAULT_TIMEZONE) => {
  const parts = getZonedParts(weekStart, timeZone);
  const targetParts = addDaysToDateParts(parts, dayOffset);

  return zonedTimeToUtc({
    ...targetParts,
    hour,
    minute,
    second,
    millisecond
  }, timeZone);
};

const getGraceDeadlineForWeek = (weekStart, timeZone = DEFAULT_TIMEZONE) => (
  getWeekRelativeDate(weekStart, 8, 23, 59, 59, 999, timeZone)
);

const formatTimestampForMpesa = (date = new Date(), timeZone = DEFAULT_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);

  return [
    parts.year,
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
    String(parts.hour).padStart(2, '0'),
    String(parts.minute).padStart(2, '0'),
    String(parts.second).padStart(2, '0')
  ].join('');
};

const getCountdownMs = (targetDate) => {
  if (!targetDate) {
    return 0;
  }

  return Math.max(0, new Date(targetDate).getTime() - Date.now());
};

module.exports = {
  DEFAULT_TIMEZONE,
  getZonedParts,
  getWeekWindow,
  getPreviousWeekWindow,
  getWeekRelativeDate,
  getGraceDeadlineForWeek,
  formatTimestampForMpesa,
  getCountdownMs
};

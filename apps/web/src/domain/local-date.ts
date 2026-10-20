import * as v from "valibot";

/** 端末のタイムゾーンでの日付。`key` は `YYYY-MM-DD` で、文字列の順が日付の順になる */
export type LocalDate = Readonly<{ key: string; year: number; month: number; day: number }>;

/** 端末のタイムゾーンでの日付と、その日の 0:00 からの分 */
export type LocalTime = Readonly<{ date: LocalDate; minuteOfDay: number }>;

const DAY_MS = 86_400_000;

const pad = (value: number, length: number): string => String(value).padStart(length, "0");

const localDateOf = (year: number, month: number, day: number): LocalDate => ({
  key: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
  year,
  month,
  day,
});

/**
 * 時刻を、タイムゾーン `timeZone` での日付と時刻にする。
 *
 * `Intl` は時計も外部も読まず、同じ引数なら同じ結果を返すのでドメインで使ってよい。
 */
export const localTimeIn = (timeZone: string): ((at: Date) => LocalTime) => {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  return (at) => {
    const parts = format.formatToParts(at);
    const numberOf = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    return {
      date: localDateOf(numberOf("year"), numberOf("month"), numberOf("day")),
      minuteOfDay: numberOf("hour") * 60 + numberOf("minute"),
    };
  };
};

/** 時刻を、タイムゾーン `timeZone` での日付にする */
export const localDateIn = (timeZone: string): ((at: Date) => LocalDate) => {
  const timeOf = localTimeIn(timeZone);
  return (at) => timeOf(at).date;
};

/** IANA のタイムゾーン名として `Intl` が受け付けるか */
const isTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** 端末のタイムゾーン（`Asia/Tokyo` のような IANA の名前）。外から受け取るので検証する */
export const TimeZoneSchema = v.pipe(v.string(), v.check(isTimeZone, "タイムゾーンではない"));

/**
 * 暦の日付の計算。タイムゾーンには関わらず、暦の上で日を数えるだけなので UTC の日付として扱う。
 * `dayNumber` は 1970-01-01 からの日数で、日付の差や曜日を求めるのに使う。
 */
export const Calendar = {
  dayNumberOf: (date: LocalDate): number => Date.UTC(date.year, date.month - 1, date.day) / DAY_MS,

  dateOfDayNumber: (dayNumber: number): LocalDate => {
    const at = new Date(dayNumber * DAY_MS);
    return localDateOf(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
  },

  /** 月曜を 0 とする曜日 */
  weekdayOf: (date: LocalDate): number =>
    (new Date(Calendar.dayNumberOf(date) * DAY_MS).getUTCDay() + 6) % 7,

  /** その月の日数 */
  daysInMonth: (year: number, month: number): number =>
    new Date(Date.UTC(year, month, 0)).getUTCDate(),

  firstOfMonth: (year: number, month: number): LocalDate => localDateOf(year, month, 1),
} as const;

/** JSON にした日付を検証して戻す。`key` は年月日から作り直さず、そのまま確かめる */
export const LocalDateJsonSchema: v.GenericSchema<unknown, LocalDate> = v.pipe(
  v.object({
    key: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)),
    year: v.pipe(v.number(), v.integer()),
    month: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)),
    day: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(31)),
  }),
  v.check(
    (date) => date.key === localDateOf(date.year, date.month, date.day).key,
    "key が年月日と合わない",
  ),
);

/**
 * `YYYY-MM-DD` と書いた日付（API のクエリ）を日付にする。暦にない日付（2月30日など）は通さない
 */
export const LocalDateKeySchema = v.pipe(
  v.string(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/),
  v.transform((key) =>
    localDateOf(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Number(key.slice(8, 10))),
  ),
  v.check(
    (date) =>
      date.month >= 1 &&
      date.month <= 12 &&
      date.day >= 1 &&
      date.day <= Calendar.daysInMonth(date.year, date.month),
    "暦にない日付",
  ),
);

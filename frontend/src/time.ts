import { DateTime } from "luxon";
export function toLocal(value: string | null | undefined, zone: string) {
  return value
    ? DateTime.fromISO(value).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm")
    : "";
}
export function toInstant(value: string, zone: string): string | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone });
  if (
    !dt.isValid ||
    dt.toFormat("yyyy-MM-dd'T'HH:mm") !== value ||
    dt.getPossibleOffsets().length > 1
  ) {
    throw new Error("此本地时间不存在或存在夏令时歧义，请选择其他时刻");
  }
  return dt.toISO();
}
export function displayTime(value: string | null | undefined, zone: string) {
  return value
    ? DateTime.fromISO(value).setZone(zone).toFormat("MM-dd HH:mm")
    : "未设置";
}

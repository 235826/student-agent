const labels: Array<[RegExp, string]> = [
  [/^\/plans(?:\/|$)/, "返回计划"],
  [/^\/calendar\/series\//, "返回系列"],
  [/^\/calendar\/courses\//, "返回课程"],
  [/^\/calendar\/events\//, "返回事件"],
  [/^\/calendar(?:\/|$)/, "返回日历"],
  [/^\/inbox\/imports\//, "返回导入记录"],
  [/^\/inbox(?:\/|$)/, "返回收件箱"],
  [/^\/tasks\/[^/]+$/, "返回任务"],
  [/^\/tasks(?:\/|$)/, "返回任务列表"],
  [/^\/settings(?:\/|$)/, "返回设置"],
  [/^\/$/, "返回今日"],
];

export type BackTarget = { to: string; label: string };

export function backTarget(from: string | null, fallback: BackTarget): BackTarget {
  if (!from || !from.startsWith("/") || from.startsWith("//")) return fallback;
  const path = from.split("?")[0].split("#")[0];
  const match = labels.find(([pattern]) => pattern.test(path));
  return { to: from, label: match?.[1] ?? fallback.label };
}

export function withFrom(to: string, from: string) {
  const url = new URL(to, "http://local");
  url.searchParams.set("from", from);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function currentLocation(pathname: string, search: string, hash: string) {
  return `${pathname}${search}${hash}`;
}

import type { components } from "./generated/api";
export type Task = components["schemas"]["TaskOut"];
export type Event = components["schemas"]["EventOut"];
export type Profile = components["schemas"]["ProfileOut"];
export type Auth = components["schemas"]["AuthOut"];
export type TaskInput = components["schemas"]["TaskInput"];
export type EventInput = components["schemas"]["EventInput"];
export type ProfileInput = components["schemas"]["ProfileInput"];
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers:
      body instanceof FormData
        ? { "X-CSRF-Token": csrf }
        : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: "网络请求失败" }));
    throw new ApiError(error.message ?? "请求失败，请重试", response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export type Draft = components["schemas"]["DraftOut"];
export type Course = components["schemas"]["CourseOut"];
export type Rule = components["schemas"]["RuleOut"];
export type RuleInput = components["schemas"]["RuleInput"];
export type Selector = components["schemas"]["Selector"];
export type SeriesInput = components["schemas"]["SeriesInput"];
export type TypePolicy = components["schemas"]["TypePolicyOut"];
export type Compatibility = components["schemas"]["CompatibilityOut"];

export type Plan = components["schemas"]["PlanOut"];

export type ImportJob = components["schemas"]["ImportOut"];
export type ImportCandidate = components["schemas"]["ImportCandidate"];

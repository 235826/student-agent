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
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: "网络请求失败" }));
    throw new ApiError(error.message ?? "请求失败，请重试", response.status);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

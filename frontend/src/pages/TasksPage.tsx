import ImportRecords from "../components/ImportRecords";
import TaskListManager from "../components/TaskListManager";
import TagManager from "../components/TagManager";
import SubtaskChecklist from "../components/SubtaskChecklist";
import AttachmentPanel from "../components/AttachmentPanel";
import {
  Link,
  useNavigate,
  useParams,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import SourceButton from "../components/SourceButton";
import InlineDeadline from "../components/InlineDeadline";
import InlineConfirm from "../components/InlineConfirm";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { backTarget, currentLocation, withFrom } from "../navigation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Popover,
  Select,
  Space,
  Spin,
  Tag,
} from "antd";
import { DateTime } from "luxon";
import { api } from "../api";
import type {
  Draft,
  Profile,
  SavedFilter,
  SavedFilterPayload,
  TagRecord,
  Task,
  TaskInput,
  TaskList,
  TaskListGroup,
} from "../api";
import { displayTime, toInstant, toLocal } from "../time";
import { priorities, priorityLabel } from "../semantics";
import {
  deadlineInstant,
  deadlineLabel,
  quickDeadlineOptions,
  recurrenceLabel,
  toTaskInput,
  type QuickDeadline,
} from "../tasks";

const states = [
  { value: "todo", label: "待开始" },
  { value: "in_progress", label: "进行中" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
];
const policies = [
  { value: "inherit", label: "沿用任务类型设置（未设置则禁止）" },
  { value: "none", label: "明确禁止并行" },
  { value: "allow_selected", label: "接受已明确允许的组合" },
];
const PAGE_SIZE = 50;
const views = [
  ["all", "全部"],
  ["today", "今天"],
  ["scheduled", "已计划"],
  ["unscheduled", "无日期"],
  ["flagged", "已标记"],
  ["done", "已完成"],
  ["trash", "垃圾箱"],
] as const;
type View = (typeof views)[number][0];
const statusValues = ["all", ...states.map((state) => state.value)];
const sortValues = [
  "status",
  "deadline",
  "priority",
  "completed",
  "manual",
] as const;
const sortOptions = [
  { value: "status", label: "按状态分组" },
  { value: "deadline", label: "截止时间" },
  { value: "priority", label: "优先级" },
  { value: "completed", label: "完成时间" },
  { value: "manual", label: "手动排序" },
];
type Editor = { kind: "task"; task?: Task } | { kind: "draft"; draft?: Draft };
type Write = { path: string; method?: string; body?: unknown };
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export default function TasksPage({ profile }: { profile: Profile }) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const paramsRef = useRef(params);
  const viewTabsRef = useRef<HTMLDivElement>(null);
  const inbox = location.pathname === "/inbox";
  const isNew = location.pathname === "/tasks/new";
  useEffect(() => {
    paramsRef.current = params;
  }, [params]);
  const updateParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(paramsRef.current);
      mutate(next);
      paramsRef.current = next;
      setParams(next, { replace: true });
    },
    [setParams],
  );
  const setUrlValue = useCallback(
    (key: string, value: string | null, fallback = "") => {
      updateParams((next) => {
        if (!value || value === fallback) next.delete(key);
        else next.set(key, value);
      });
    },
    [updateParams],
  );
  const viewParam = params.get("view");
  const view: View = views.some(([key]) => key === viewParam)
    ? (viewParam as View)
    : "all";
  const statusParam = params.get("status") ?? "all";
  const status = statusValues.includes(statusParam) ? statusParam : "all";
  const sortParam = params.get("sort") ?? "status";
  const sort = (sortValues as readonly string[]).includes(sortParam)
    ? sortParam
    : "status";
  const listFilter = params.get("list") ?? "all";
  const tagFilter = params.get("tag") ?? "all";
  const debouncedSearch = params.get("q") ?? "";
  const savedFilterId = params.get("saved") ?? undefined;
  const setView = (next: View) => setUrlValue("view", next, "all");
  const setStatus = (next: string) => setUrlValue("status", next, "all");
  const setSort = (next: string) => setUrlValue("sort", next, "status");
  const setListFilter = (next: string) => setUrlValue("list", next, "all");
  const setTagFilter = (next: string) => setUrlValue("tag", next, "all");
  const client = useQueryClient();
  const { message } = App.useApp();
  const [search, setSearch] = useState(debouncedSearch);
  const [listManager, setListManager] = useState(false);
  const [tagManager, setTagManager] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [monthsLoaded, setMonthsLoaded] = useState(1);
  const [dragOverDate, setDragOverDate] = useState<string | null | undefined>(
    undefined,
  );
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"before" | "after">("before");
  const timelineSentinelRef = useRef<HTMLDivElement>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagValues, setBulkTagValues] = useState<string[]>([]);
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [filterName, setFilterName] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "trash"; task: Task }
    | { kind: "purge"; task: Task }
    | { kind: "publish"; draft: Draft }
    | { kind: "deleteDraft"; draft: Draft }
    | { kind: "bulkTrash" }
    | { kind: "clearTrash" }
    | null
  >(null);
  const [pendingCancel, setPendingCancel] = useState<{
    task: Task;
    body: TaskInput;
  } | null>(null);
  const [bulkDeadlineOpen, setBulkDeadlineOpen] = useState(false);
  const [bulkDeadlineValue, setBulkDeadlineValue] = useState("");
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoveList, setBulkMoveList] = useState("inbox");
  const [editor, setEditor] = useState<Editor | null>(
    isNew || params.has("new") ? { kind: "task" } : null,
  );
  const editorRef = useRef<HTMLElement | null>(null);
  const [form] = Form.useForm();
  useEffect(() => {
    if (!editor) return;
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [editor]);
  const recurrenceValue = Form.useWatch("recurrence", form);
  const intervalUnit =
    recurrenceValue === "daily"
      ? "天"
      : recurrenceValue === "weekly"
        ? "周"
        : recurrenceValue === "monthly"
          ? "月"
          : recurrenceValue === "yearly"
            ? "年"
            : "次";
  const detailPage = !!id;
  useEffect(() => {
    setSelectedIds(new Set());
    setExpandedId(null);
    setConfirmAction(null);
    setBulkDeadlineOpen(false);
    setBulkMoveOpen(false);
  }, [view, listFilter, tagFilter, status, debouncedSearch]);
  useEffect(() => {
    if (id) setExpandedId(id);
  }, [id]);
  useEffect(() => {
    const value = search.trim();
    if (value === debouncedSearch) return;
    const timer = setTimeout(
      () => setUrlValue("q", value, ""),
      value ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [search, debouncedSearch, setUrlValue]);
  const timelineMode =
    !inbox && !id && (view === "all" || view === "today" || view === "scheduled");
  useEffect(() => {
    setSearch((current) =>
      current.trim() === debouncedSearch ? current : debouncedSearch,
    );
  }, [debouncedSearch]);
  useEffect(() => {
    viewTabsRef.current
      ?.querySelector<HTMLElement>(".view-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view]);
  useEffect(() => {
    if (!timelineMode || !timelineSentinelRef.current) return;
    const node = timelineSentinelRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setMonthsLoaded((current) => Math.min(12, current + 1));
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [timelineMode, monthsLoaded]);
  const closeEditor = () => {
    setEditor(null);
    setPendingCancel(null);
    if (isNew) {
      const back = backTarget(params.get("from"), {
        to: "/tasks",
        label: "返回任务列表",
      });
      navigate(back.to, { replace: true });
    } else if (params.has("new")) {
      updateParams((next) => next.delete("new"));
    }
  };
  const taskQuery = new URLSearchParams({ view });
  if (listFilter !== "all") taskQuery.set("list_id", listFilter);
  if (tagFilter !== "all") taskQuery.set("tag", tagFilter);
  if (status !== "all") taskQuery.set("status", status);
  if (debouncedSearch) taskQuery.set("q", debouncedSearch);
  const taskQueryString = taskQuery.toString();
  const listTasks = useInfiniteQuery({
    queryKey: [
      "tasks",
      "list",
      view,
      listFilter,
      tagFilter,
      status,
      debouncedSearch,
      timelineMode,
    ],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(taskQueryString);
      if (!timelineMode) {
        params.set("limit", String(PAGE_SIZE + 1));
        params.set("offset", String(pageParam));
      }
      return api<Task[]>(`/tasks?${params.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      !timelineMode && lastPage.length > PAGE_SIZE
        ? lastPageParam + PAGE_SIZE
        : undefined,
    enabled: !inbox && !id,
    placeholderData: (previous) => previous,
  });
  const detailTaskQuery = useQuery({
    queryKey: ["tasks", "detail", id],
    queryFn: () => api<Task>(`/tasks/${id}`),
    enabled: !!id,
  });
  const editorTasks = useQuery({
    queryKey: ["tasks", "editor"],
    queryFn: async () => {
      const [active, trashed] = await Promise.all([
        api<Task[]>("/tasks?view=all"),
        api<Task[]>("/tasks?view=trash"),
      ]);
      return [...active, ...trashed];
    },
    enabled: !!editor,
  });
  const drafts = useQuery({
    queryKey: ["drafts"],
    queryFn: () => api<Draft[]>("/drafts"),
  });
  const lists = useQuery({
    queryKey: ["task-lists"],
    queryFn: () => api<TaskList[]>("/task-lists"),
  });
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<TagRecord[]>("/tags"),
  });
  const listGroups = useQuery({
    queryKey: ["task-list-groups"],
    queryFn: () => api<TaskListGroup[]>("/task-list-groups"),
  });
  const savedFilters = useQuery({
    queryKey: ["saved-filters"],
    queryFn: () => api<SavedFilter[]>("/saved-filters"),
  });
  useEffect(() => {
    if (
      listFilter !== "all" &&
      listFilter !== "inbox" &&
      lists.data &&
      !lists.data.some((list) => list.id === listFilter)
    )
      setUrlValue("list", "all", "all");
  }, [listFilter, lists.data, setUrlValue]);
  useEffect(() => {
    if (
      tagFilter !== "all" &&
      tags.data &&
      !tags.data.some((tag) => tag.name === tagFilter)
    )
      setUrlValue("tag", "all", "all");
  }, [tagFilter, tags.data, setUrlValue]);
  const writeOptions = {
    mutationFn: ({ path, method = "POST", body }: Write) =>
      api(path, method, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["drafts"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      void client.invalidateQueries({ queryKey: ["tags"] });
      closeEditor();
      void message.success("已保存");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  };
  const mutation = useMutation(writeOptions);
  const draftSave = useMutation({
    ...writeOptions,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tasks"] });
      void client.invalidateQueries({ queryKey: ["drafts"] });
      void client.invalidateQueries({ queryKey: ["plans"] });
      closeEditor();
      if (!inbox) {
        message.open({
          type: "success",
          duration: 5,
          content: (
            <Space>
              <span>草稿已保存到收件箱</span>
              <a href="/inbox" onClick={() => message.destroy()}>
                查看
              </a>
            </Space>
          ),
        });
      } else {
        void message.success("草稿已保存");
      }
    },
  });
  const publishWrite = useMutation(writeOptions);
  const draftDelete = useMutation(writeOptions);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["tasks"] });
    void client.invalidateQueries({ queryKey: ["drafts"] });
    void client.invalidateQueries({ queryKey: ["plans"] });
    void client.invalidateQueries({ queryKey: ["tags"] });
  };
  const reopen = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}/reopen`, "POST"),
    onSuccess: () => {
      refresh();
      void message.success("任务已恢复为待办");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const complete = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}/complete`, "POST"),
    onSuccess: (_data, task) => {
      refresh();
      message.open({
        type: "success",
        duration: 8,
        content: (
          <Space wrap>
            <span>
              已完成“{task.title}”
              {task.recurrence ? "，下一次已生成" : ""}
            </span>
            <Button
              type="link"
              size="small"
              onClick={() => reopen.mutate(task)}
            >
              撤销
            </Button>
          </Space>
        ),
      });
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const setDeadline = useMutation({
    mutationFn: ({
      task,
      deadline_at,
      deadline_all_day,
    }: {
      task: Task;
      deadline_at: string | null;
      deadline_all_day: boolean;
    }) =>
      api(`/tasks/${task.id}/deadline`, "PATCH", {
        deadline_at,
        deadline_all_day,
      }),
    onSuccess: () => {
      refresh();
      void message.success("截止时间已更新");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const setFlag = useMutation({
    mutationFn: ({ task, flagged }: { task: Task; flagged: boolean }) =>
      api(`/tasks/${task.id}/flag`, "PATCH", { flagged }),
    onSuccess: () => refresh(),
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const reorder = useMutation({
    mutationFn: (task_ids: string[]) =>
      api("/tasks/reorder", "POST", { task_ids }),
    onSuccess: () => refresh(),
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const planMove = useMutation({
    mutationFn: (body: {
      task_id: string;
      deadline_at: string | null;
      deadline_all_day: boolean;
      ordered_task_ids: string[];
    }) => api<Task[]>("/tasks/plan/move", "POST", body),
    onSuccess: () => refresh(),
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  type BulkAction =
    | "complete"
    | "reopen"
    | "trash"
    | "move"
    | "deadline"
    | "add_tags"
    | "remove_tags";
  type TaskSnapshot = { id: string; input: TaskInput };
  type BulkUndo =
    | { kind: "complete" | "reopen" | "trash"; tasks: Task[] }
    | { kind: "move" | "tags"; snapshots: TaskSnapshot[] }
    | {
        kind: "deadline";
        snapshots: {
          id: string;
          deadline_at: string | null;
          deadline_all_day: boolean;
        }[];
      };
  type BulkPayload = {
    tasks: Task[];
    action: BulkAction;
    list_id?: string | null;
    deadline_at?: string | null;
    deadline_all_day?: boolean;
    tags?: string[];
    undo: BulkUndo;
  };
  const undoBulk = useMutation({
    mutationFn: async (undo: BulkUndo) => {
      let failed = 0;
      let firstError = "";
      const run = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          failed += 1;
          if (!firstError) firstError = errorText(e);
        }
      };
      if ("tasks" in undo) {
        for (const task of undo.tasks) {
          await run(() => {
            if (undo.kind === "complete")
              return api(`/tasks/${task.id}/reopen`, "POST");
            if (undo.kind === "reopen")
              return api(`/tasks/${task.id}/complete`, "POST");
            return api(`/tasks/${task.id}/restore`, "POST");
          });
        }
      } else if (undo.kind === "deadline") {
        for (const snapshot of undo.snapshots) {
          await run(() =>
            api(`/tasks/${snapshot.id}/deadline`, "PATCH", {
              deadline_at: snapshot.deadline_at,
              deadline_all_day: snapshot.deadline_all_day,
            }),
          );
        }
      } else {
        for (const snapshot of undo.snapshots) {
          await run(() => api(`/tasks/${snapshot.id}`, "PUT", snapshot.input));
        }
      }
      if (failed) throw new Error(`撤销时失败 ${failed} 项：${firstError}`);
    },
    onSuccess: () => {
      refresh();
      void message.success("已撤销批量操作");
    },
    onError: (e: Error) => {
      refresh();
      void message.error(e.message);
    },
  });
  const bulk = useMutation({
    mutationFn: async (payload: BulkPayload) => {
      const { tasks, action } = payload;
      let failed = 0;
      let firstError = "";
      for (const task of tasks) {
        try {
          if (action === "complete")
            await api(`/tasks/${task.id}/complete`, "POST");
          else if (action === "reopen")
            await api(`/tasks/${task.id}/reopen`, "POST");
          else if (action === "trash")
            await api(`/tasks/${task.id}/trash?confirm_impact=true`, "POST");
          else if (action === "move")
            await api(`/tasks/${task.id}`, "PUT", {
              ...toTaskInput(task),
              list_id: payload.list_id ?? null,
            });
          else if (action === "deadline")
            await api(`/tasks/${task.id}/deadline`, "PATCH", {
              deadline_at: payload.deadline_at ?? null,
              deadline_all_day: payload.deadline_all_day ?? false,
            });
          else if (action === "add_tags") {
            const nextTags = new Set(task.tags);
            for (const tag of payload.tags ?? []) nextTags.add(tag);
            await api(`/tasks/${task.id}`, "PUT", {
              ...toTaskInput(task),
              tags: [...nextTags],
            });
          } else {
            const remove = new Set(payload.tags ?? []);
            await api(`/tasks/${task.id}`, "PUT", {
              ...toTaskInput(task),
              tags: task.tags.filter((tag) => !remove.has(tag)),
            });
          }
        } catch (e) {
          failed += 1;
          if (!firstError) firstError = errorText(e);
        }
      }
      if (failed) {
        throw new Error(
          `已处理 ${tasks.length - failed} 项，失败 ${failed} 项：${firstError}`,
        );
      }
      return tasks.length;
    },
    onSuccess: (count, payload) => {
      refresh();
      setSelectedIds(new Set());
      message.open({
        type: "success",
        duration: 8,
        content: (
          <Space>
            <span>已处理 {count} 项</span>
            <Button
              type="link"
              size="small"
              onClick={() => undoBulk.mutate(payload.undo)}
            >
              撤销
            </Button>
          </Space>
        ),
      });
    },
    onError: (e: Error) => {
      refresh();
      setSelectedIds(new Set());
      void message.error(e.message);
    },
  });
  const saveFilter = useMutation({
    mutationFn: (body: {
      name: string;
      payload: SavedFilterPayload;
    }) => api<SavedFilter>("/saved-filters", "POST", body),
    onSuccess: (saved) => {
      setUrlValue("saved", saved.id, "");
      setSaveFilterOpen(false);
      setFilterName("");
      void client.invalidateQueries({ queryKey: ["saved-filters"] });
      void message.success("筛选已保存");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  const deleteFilter = useMutation({
    mutationFn: (filterId: string) =>
      api(`/saved-filters/${filterId}`, "DELETE"),
    onSuccess: () => {
      setUrlValue("saved", "", "");
      void client.invalidateQueries({ queryKey: ["saved-filters"] });
      void message.success("筛选已删除");
    },
    onError: (e: Error) => void message.error(e.message),
  });
  const restoreTask = useMutation({
    mutationFn: (task: Task) => api(`/tasks/${task.id}/restore`, "POST"),
    onSuccess: () => {
      refresh();
      void message.success("任务已恢复");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const purgeTask = useMutation({
    mutationFn: (task: Task) =>
      api(`/tasks/${task.id}/permanent`, "DELETE"),
    onSuccess: () => {
      refresh();
      void message.success("任务已永久删除");
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const purgeTrash = useMutation({
    mutationFn: () => api<{ deleted: number }>("/tasks/trash/purge", "POST"),
    onSuccess: (data) => {
      refresh();
      void message.success(`已永久删除 ${data.deleted} 项`);
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const trashTask = useMutation({
    mutationFn: ({ task, confirmed }: { task: Task; confirmed?: boolean }) =>
      api(
        `/tasks/${task.id}/trash${confirmed ? "?confirm_impact=true" : ""}`,
        "POST",
      ),
    onSuccess: (_data, { task }) => {
      refresh();
      message.open({
        type: "success",
        duration: 8,
        content: (
          <Space wrap>
            <span>已移入垃圾箱</span>
            <Button
              type="link"
              size="small"
              onClick={() => restoreTask.mutate(task)}
            >
              撤销
            </Button>
          </Space>
        ),
      });
    },
    onError: (e: unknown) => void message.error(errorText(e)),
  });
  const listItems =
    listTasks.data?.pages.flatMap((page, index, pages) =>
      index < pages.length - 1 || listTasks.hasNextPage
        ? page.slice(0, PAGE_SIZE)
        : page,
    ) ?? [];
  const baseTasks = detailPage
    ? detailTaskQuery.data
      ? [detailTaskQuery.data]
      : []
    : listItems;
  const knownTitles: Record<string, string> = Object.fromEntries(
    baseTasks.map((task) => [task.id, task.title]),
  );
  const relationIds = [
    ...new Set(
      baseTasks.flatMap((task) => [
        ...(task.parent_id ? [task.parent_id] : []),
        ...task.predecessor_ids,
        ...task.dependent_ids,
        ...task.child_ids,
        ...task.blocked_by_ids,
      ]),
    ),
  ]
    .filter((taskId) => !knownTitles[taskId])
    .sort();
  const relationTitles = useQuery({
    queryKey: ["tasks", "titles", relationIds],
    queryFn: () =>
      api<Record<string, string>>("/tasks/titles", "POST", {
        ids: relationIds,
      }),
    enabled: relationIds.length > 0,
  });
  const titleMap: Record<string, string> = {
    ...knownTitles,
    ...(relationTitles.data ?? {}),
  };
  const detailTask = detailTaskQuery.data;
  const titleOf = (taskId: string) => titleMap[taskId] ?? "不可用任务";
  const editorCatalog = editorTasks.data ?? [];
  const open = (next: Editor) => {
    form.resetFields();
    const payload = next.kind === "task" ? next.task : next.draft?.payload;
    form.setFieldsValue({
      ...payload,
      title: payload?.title ?? "",
      description: payload?.description ?? "",
      links: (payload?.links ?? []).join("\n"),
      priority: payload?.priority ?? 2,
      status: payload?.status ?? "todo",
      predecessor_ids: payload?.predecessor_ids ?? [],
      parent_id: payload?.parent_id ?? undefined,
      parallel_policy: payload?.parallel_policy ?? "inherit",
      deadline_at: toLocal(payload?.deadline_at, profile.timezone),
      deadline_all_day: payload?.deadline_all_day ?? false,
      remind_at: toLocal(payload?.remind_at, profile.timezone),
      flagged: payload?.flagged ?? false,
      recurrence: payload?.recurrence ?? undefined,
      recurrence_interval: payload?.recurrence_interval ?? 1,
      recurrence_from_completion:
        payload?.recurrence_from_completion ?? false,
      recurrence_until: payload?.recurrence_until
        ? DateTime.fromISO(payload.recurrence_until)
            .setZone(profile.timezone)
            .toFormat("yyyy-MM-dd")
        : "",
      recurrence_remaining: payload?.recurrence_remaining ?? undefined,
      tags: payload?.tags ?? [],
      list_id:
        payload?.list_id ??
        (next.kind === "task" &&
        !next.task &&
        listFilter !== "all" &&
        listFilter !== "inbox"
          ? listFilter
          : undefined),
    });
    setEditor(next);
  };
  const save = async (asDraft: boolean) => {
    try {
      if (!asDraft && !form.getFieldValue("title")?.trim()) {
        form.setFields([{ name: "title", errors: ["创建任务必须填写标题"] }]);
        return;
      }
      if (asDraft) form.setFields([{ name: "title", errors: [] }]);
      const values = await form.validateFields();
      const body: TaskInput = {
        ...(editor?.kind === "task" && editor.task
          ? toTaskInput(editor.task)
          : {}),
        ...values,
        title: values.title?.trim() ?? "",
        links: (values.links ?? "")
          .split("\n")
          .map((link: string) => link.trim())
          .filter(Boolean),
        deadline_at: deadlineInstant(
          values.deadline_at ?? "",
          values.deadline_all_day ?? false,
          profile.timezone,
        ),
        deadline_all_day: values.deadline_all_day ?? false,
        remind_at: values.remind_at
          ? toInstant(values.remind_at, profile.timezone)
          : null,
        recurrence: values.recurrence ?? null,
        recurrence_interval: values.recurrence_interval ?? 1,
        recurrence_from_completion:
          values.recurrence_from_completion ?? false,
        recurrence_until: values.recurrence_until
          ? DateTime.fromISO(values.recurrence_until, {
              zone: profile.timezone,
            })
              .endOf("day")
              .toISO()
          : null,
        recurrence_remaining: values.recurrence_remaining ?? null,
        task_type: values.task_type?.trim() || null,
        estimate_minutes: values.estimate_minutes ?? null,
        parent_id: values.parent_id ?? null,
        parallel_policy:
          values.parallel_policy === "inherit" ? null : values.parallel_policy,
        predecessor_ids: values.predecessor_ids ?? [],
      };
      if (asDraft) {
        const draft = editor?.kind === "draft" ? editor.draft : undefined;
        draftSave.mutate({
          path: draft ? `/drafts/${draft.id}` : "/drafts",
          method: draft ? "PUT" : "POST",
          body: {
            payload: body,
            ...(draft ? { revision: draft.revision } : {}),
          },
        });
        return;
      }
      if (!body.title) {
        void message.error("正式任务需要填写标题");
        return;
      }
      if (body.recurrence && !body.deadline_at) {
        void message.error("重复任务需要设置截止时间");
        return;
      }
      const task = editor?.kind === "task" ? editor.task : undefined;
      if (
        task &&
        body.status === "cancelled" &&
        task.status !== "cancelled" &&
        (task.dependent_ids.length || task.child_ids.length)
      ) {
        setPendingCancel({ task, body });
        return;
      }
      mutation.mutate({
        path: task ? `/tasks/${task.id}` : "/tasks",
        method: task ? "PUT" : "POST",
        body: { ...body, confirm_impact: false },
      });
    } catch (e) {
      if (e instanceof Error) void message.error(e.message);
    }
  };
  const remove = (task: Task) => {
    if (task.dependent_ids.length || task.child_ids.length) {
      setExpandedId(task.id);
      setConfirmAction({ kind: "trash", task });
    } else {
      trashTask.mutate({ task });
    }
  };
  const publish = (draft: Draft) =>
    setConfirmAction({ kind: "publish", draft });
  const currentQuery = detailPage ? detailTaskQuery : listTasks;
  const listOf = (task: Task) =>
    (lists.data ?? []).find((list) => list.id === task.list_id);
  const groupedListOptions = [
    { value: "all", label: "全部清单" },
    { value: "inbox", label: "收件箱（未分类）" },
    ...(listGroups.data ?? []).map((group) => ({
      label: group.name,
      options: (lists.data ?? [])
        .filter((list) => list.group_id === group.id)
        .map((list) => ({ value: list.id, label: list.name })),
    })),
    {
      label: "未分组",
      options: (lists.data ?? [])
        .filter((list) => !list.group_id)
        .map((list) => ({ value: list.id, label: list.name })),
    },
  ];
  const editorListOptions = [
    ...(listGroups.data ?? []).map((group) => ({
      label: group.name,
      options: (lists.data ?? [])
        .filter((list) => list.group_id === group.id)
        .map((list) => ({ value: list.id, label: list.name })),
    })),
    {
      label: "未分组",
      options: (lists.data ?? [])
        .filter((list) => !list.group_id)
        .map((list) => ({ value: list.id, label: list.name })),
    },
  ];
  const applySavedFilter = (filterId: string) => {
    const saved = (savedFilters.data ?? []).find(
      (item) => item.id === filterId,
    );
    if (!saved) return;
    updateParams((next) => {
      const write = (key: string, value: string, fallback: string) => {
        if (!value || value === fallback) next.delete(key);
        else next.set(key, value);
      };
      write("view", saved.payload.view, "all");
      write("list", saved.payload.list_id ?? "all", "all");
      write("tag", saved.payload.tag ?? "all", "all");
      write("status", saved.payload.status ?? "all", "all");
      write("q", saved.payload.q ?? "", "");
      write("sort", saved.payload.sort, "status");
      next.set("saved", filterId);
    });
    setSearch(saved.payload.q ?? "");
  };
  const submitFilter = () => {
    if (!filterName.trim()) {
      void message.error("请输入筛选名称");
      return;
    }
    saveFilter.mutate({
      name: filterName.trim(),
      payload: {
        view,
        q: search.trim(),
        status:
          status === "all" ? null : (status as SavedFilterPayload["status"]),
        list_id: listFilter === "all" ? null : listFilter,
        tag: tagFilter === "all" ? null : tagFilter,
        sort: sort as SavedFilterPayload["sort"],
      },
    });
  };
  const taskDateKey = (task: Task) =>
    task.deadline_at
      ? DateTime.fromISO(task.deadline_at)
          .setZone(profile.timezone)
          .toISODate()
      : null;
  const visible = (detailPage ? (detailTask ? [detailTask] : []) : listItems)
    .sort((a, b) =>
      timelineMode
        ? (taskDateKey(a) ?? "9999-12-31").localeCompare(
            taskDateKey(b) ?? "9999-12-31",
          ) ||
          a.sort_order - b.sort_order ||
          b.created_at.localeCompare(a.created_at)
        : sort === "deadline"
          ? (a.deadline_at ?? "9999").localeCompare(b.deadline_at ?? "9999")
          : sort === "priority"
            ? b.priority - a.priority
            : sort === "completed"
              ? (b.completed_at ?? "").localeCompare(a.completed_at ?? "")
              : sort === "manual"
                ? a.sort_order - b.sort_order ||
                  b.created_at.localeCompare(a.created_at)
                : a.status.localeCompare(b.status),
    );
  const groupOf = (task: Task) =>
    view === "done" && task.completed_at
      ? DateTime.fromISO(task.completed_at)
          .setZone(profile.timezone)
          .toFormat("yyyy-MM-dd")
      : view === "done"
        ? "unknown"
        : task.status;
  const groupLabel = (task: Task) => {
    if (view === "done")
      return task.completed_at
        ? DateTime.fromISO(task.completed_at)
            .setZone(profile.timezone)
            .toFormat("yyyy年M月d日")
        : "完成时间未知";
    return states.find((state) => state.value === task.status)?.label ?? task.status;
  };
  const canReorder =
    sort === "manual" &&
    !id &&
    view === "all" &&
    status === "all" &&
    !search.trim() &&
    tagFilter === "all" &&
    !listTasks.hasNextPage &&
    !selectionMode;
  const dropTask = (target: Task) => {
    if (!canReorder || !draggingId || draggingId === target.id) return;
    const from = visible.findIndex((task) => task.id === draggingId);
    const to = visible.findIndex((task) => task.id === target.id);
    if (from < 0 || to < 0) return;
    const next = [...visible];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorder.mutate(next.map((task) => task.id));
    setDraggingId(null);
  };
  const moveTask = (task: Task, delta: number) => {
    if (!canReorder) return;
    const from = visible.findIndex((item) => item.id === task.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= visible.length) return;
    const next = [...visible];
    [next[from], next[to]] = [next[to], next[from]];
    reorder.mutate(next.map((item) => item.id));
  };
  const today = DateTime.now().setZone(profile.timezone).startOf("day");
  const todayKey = today.toISODate()!;
  const timelineEnd =
    view === "today"
      ? today
      : today
          .startOf("month")
          .plus({ months: monthsLoaded })
          .minus({ days: 1 });
  const timelineEndKey = timelineEnd.toISODate()!;
  const sortForPlan = (items: Task[]) =>
    [...items].sort(
      (a, b) =>
        a.sort_order - b.sort_order ||
        b.created_at.localeCompare(a.created_at) ||
        a.id.localeCompare(b.id),
    );
  const planDateLabel = (date: DateTime) => {
    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${date.toFormat("M月d日")} ${weekdays[date.weekday % 7]}`;
  };
  const groupByDate = (items: Task[]) => {
    const map = new Map<string, Task[]>();
    for (const task of items) {
      const key = taskDateKey(task);
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(task);
      map.set(key, list);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entries]) => ({
        key,
        label: planDateLabel(
          DateTime.fromISO(key, { zone: profile.timezone }),
        ),
        tasks: sortForPlan(entries),
      }));
  };
  const overdueGroups = groupByDate(
    visible.filter((task) => {
      const key = taskDateKey(task);
      return !!key && key < todayKey;
    }),
  );
  const noDateTasks = sortForPlan(
    visible.filter((task) => !taskDateKey(task)),
  );
  const datedByDate = new Map<string, Task[]>();
  for (const task of visible) {
    const key = taskDateKey(task);
    if (!key || key < todayKey || key > timelineEndKey) continue;
    const list = datedByDate.get(key) ?? [];
    list.push(task);
    datedByDate.set(key, list);
  }
  const timelineMonths: Array<{
    month: string;
    days: Array<{ key: string; label: string; tasks: Task[] }>;
  }> = [];
  for (
    let cursor = today;
    cursor <= timelineEnd;
    cursor = cursor.plus({ days: 1 })
  ) {
    const key = cursor.toISODate()!;
    const month = cursor.toFormat("yyyy年M月");
    let bucket = timelineMonths[timelineMonths.length - 1];
    if (!bucket || bucket.month !== month) {
      bucket = { month, days: [] };
      timelineMonths.push(bucket);
    }
    const diff = cursor.startOf("day").diff(today, "days").days;
    bucket.days.push({
      key,
      label:
        diff === 0
          ? `今天 · ${planDateLabel(cursor)}`
          : diff === 1
            ? `明天 · ${planDateLabel(cursor)}`
            : diff === 2
              ? `后天 · ${planDateLabel(cursor)}`
              : planDateLabel(cursor),
      tasks: sortForPlan(datedByDate.get(key) ?? []),
    });
  }
  const tasksByDateAll = new Map<string, Task[]>();
  for (const task of visible) {
    const key = taskDateKey(task);
    if (!key) continue;
    const list = tasksByDateAll.get(key) ?? [];
    list.push(task);
    tasksByDateAll.set(key, list);
  }
  const resolvePlanDrop = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y) as HTMLElement | null;
    const day = element?.closest<HTMLElement>(
      "[data-plan-date], [data-plan-nodate]",
    );
    if (!day) return { date: undefined as string | null | undefined, beforeId: null, position: "before" as const };
    const date = day.hasAttribute("data-plan-nodate")
      ? null
      : (day.dataset.planDate ?? null);
    const row = element?.closest<HTMLElement>("[data-task-id]");
    let beforeId: string | null = null;
    let position: "before" | "after" = "before";
    if (row && day.contains(row)) {
      beforeId = row.dataset.taskId ?? null;
      const rect = row.getBoundingClientRect();
      position = y < rect.top + rect.height / 2 ? "before" : "after";
    }
    return { date, beforeId, position };
  };
  const startTimelineDrag = (
    event: ReactPointerEvent<HTMLSpanElement>,
    task: Task,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setDraggingId(task.id);
    setDragOverDate(taskDateKey(task));
    setDropBeforeId(null);
    document.body.classList.add("plan-dragging");
    const onMove = (pointerEvent: PointerEvent) => {
      const target = resolvePlanDrop(pointerEvent.clientX, pointerEvent.clientY);
      setDragOverDate(target.date);
      setDropBeforeId(target.beforeId);
      setDropPosition(target.position);
      if (pointerEvent.clientY < 80) window.scrollBy(0, -18);
      else if (pointerEvent.clientY > window.innerHeight - 80)
        window.scrollBy(0, 18);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      document.body.classList.remove("plan-dragging");
      setDraggingId(null);
      setDragOverDate(undefined);
      setDropBeforeId(null);
    };
    const onCancel = () => cleanup();
    const onUp = (pointerEvent: PointerEvent) => {
      const target = resolvePlanDrop(pointerEvent.clientX, pointerEvent.clientY);
      cleanup();
      if (target.date === undefined) return;
      const targetList = sortForPlan(
        target.date === null
          ? noDateTasks
          : [...(tasksByDateAll.get(target.date) ?? [])],
      ).filter((item) => item.id !== task.id);
      let index = targetList.length;
      if (target.beforeId) {
        const beforeIndex = targetList.findIndex(
          (item) => item.id === target.beforeId,
        );
        if (beforeIndex >= 0)
          index = target.position === "before" ? beforeIndex : beforeIndex + 1;
      }
      const ordered = [
        ...targetList.slice(0, index),
        task,
        ...targetList.slice(index),
      ];
      let deadlineAt = task.deadline_at;
      let allDay = task.deadline_all_day;
      if (target.date === null) {
        deadlineAt = null;
        allDay = false;
      } else {
        const targetDay = DateTime.fromISO(target.date, {
          zone: profile.timezone,
        });
        if (!task.deadline_at || task.deadline_all_day) {
          deadlineAt = targetDay.endOf("day").toISO()!;
          allDay = true;
        } else {
          const local = DateTime.fromISO(task.deadline_at).setZone(
            profile.timezone,
          );
          deadlineAt = targetDay
            .set({
              hour: local.hour,
              minute: local.minute,
              second: 0,
              millisecond: 0,
            })
            .toISO()!;
          allDay = false;
        }
      }
      planMove.mutate({
        task_id: task.id,
        deadline_at: deadlineAt,
        deadline_all_day: allDay,
        ordered_task_ids: ordered.map((item) => item.id),
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };
  const selectedTasks = visible.filter((task) => selectedIds.has(task.id));
  const toggleSelected = (taskId: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  const runBulk = (
    action: BulkAction,
    options: {
      listId?: string | null;
      deadline?: QuickDeadline;
      tags?: string[];
    } = {},
  ) => {
    if (!selectedTasks.length) return;
    let undo: BulkUndo;
    if (action === "complete" || action === "reopen" || action === "trash") {
      undo = { kind: action, tasks: selectedTasks };
    } else if (action === "deadline") {
      undo = {
        kind: "deadline",
        snapshots: selectedTasks.map((task) => ({
          id: task.id,
          deadline_at: task.deadline_at,
          deadline_all_day: task.deadline_all_day,
        })),
      };
    } else if (action === "move") {
      undo = {
        kind: "move",
        snapshots: selectedTasks.map((task) => ({
          id: task.id,
          input: toTaskInput(task),
        })),
      };
    } else {
      undo = {
        kind: "tags",
        snapshots: selectedTasks.map((task) => ({
          id: task.id,
          input: toTaskInput(task),
        })),
      };
    }
    bulk.mutate({
      tasks: selectedTasks,
      action,
      list_id: options.listId ?? null,
      deadline_at: options.deadline?.deadline_at,
      deadline_all_day: options.deadline?.deadline_all_day,
      tags: options.tags,
      undo,
    });
  };
  const here = currentLocation(
    location.pathname,
    location.search,
    location.hash,
  );
  const back = backTarget(params.get("from"), {
    to: "/tasks",
    label: "返回任务列表",
  });
  const taskLink = (relationId: string) =>
    withFrom(`/tasks/${relationId}`, here);
  const relations = (ids: string[]) =>
    ids.map((relationId) => (
      <Link key={relationId} to={taskLink(relationId)} style={{ marginRight: 8 }}>
        {titleOf(relationId)}
      </Link>
    ));
  const currentTask = editor?.kind === "task" ? editor.task : undefined;
  const options = editorCatalog
    .filter((t) => t.id !== currentTask?.id)
    .map((t) => ({
      value: t.id,
      label:
        t.title +
        (t.trashed_at
          ? "（垃圾箱）"
          : t.status === "cancelled"
            ? "（已取消）"
            : ""),
      disabled: !!t.trashed_at || t.status === "cancelled",
    }));
  const clearFilter = (key: "q" | "list" | "tag" | "status" | "sort") => {
    if (key === "q") setSearch("");
    setUrlValue(key, "", key === "sort" ? "status" : "all");
  };
  const filterChips: Array<{
    key: string;
    label: string;
    onClose: () => void;
  }> = [];
  if (debouncedSearch)
    filterChips.push({
      key: "q",
      label: `搜索：${debouncedSearch}`,
      onClose: () => clearFilter("q"),
    });
  if (listFilter !== "all")
    filterChips.push({
      key: "list",
      label: `清单：${
        (lists.data ?? []).find((item) => item.id === listFilter)?.name ??
        "已选清单"
      }`,
      onClose: () => clearFilter("list"),
    });
  if (tagFilter !== "all")
    filterChips.push({
      key: "tag",
      label: `标签：${tagFilter}`,
      onClose: () => clearFilter("tag"),
    });
  if (status !== "all")
    filterChips.push({
      key: "status",
      label: `状态：${
        states.find((item) => item.value === status)?.label ?? status
      }`,
      onClose: () => clearFilter("status"),
    });
  if (sort !== "status")
    filterChips.push({
      key: "sort",
      label: `排序：${
        sortOptions.find((item) => item.value === sort)?.label ?? sort
      }`,
      onClose: () => clearFilter("sort"),
    });
  if (savedFilterId)
    filterChips.push({
      key: "saved",
      label: `筛选：${
        (savedFilters.data ?? []).find((item) => item.id === savedFilterId)
          ?.name ?? "已保存筛选"
      }`,
      onClose: () => setUrlValue("saved", "", ""),
    });
  const clearAllFilters = () => {
    setSearch("");
    updateParams((next) => {
      for (const key of ["q", "list", "tag", "status", "sort", "saved"]) {
        next.delete(key);
      }
    });
  };
  const searchInput = (
    <Input.Search
      className="task-search"
      aria-label="搜索任务"
      placeholder="搜索标题、描述、标签、链接或附件名"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
    />
  );
  const actionButtons = (
    <>
      <Button
        type="text"
        className="task-action-inline"
        onClick={() => setListManager(true)}
      >
        管理清单
      </Button>
      <Button
        type="text"
        className="task-action-inline"
        onClick={() => setTagManager(true)}
      >
        管理标签
      </Button>
      <Button
        type="text"
        aria-pressed={selectionMode}
        className={`task-action-inline ${
          selectionMode ? "toolbar-toggle active" : "toolbar-toggle"
        }`}
        onClick={() => {
          setSelectionMode((current) => !current);
          setSelectedIds(new Set());
        }}
      >
        {selectionMode ? "退出批量" : "批量操作"}
      </Button>
      <Button
        type="text"
        className="task-action-inline"
        onClick={() => setSaveFilterOpen(true)}
      >
        保存筛选
      </Button>
      {savedFilterId && (
        <Button
          type="text"
          className="task-action-inline"
          danger
          onClick={() => deleteFilter.mutate(savedFilterId)}
        >
          删除筛选
        </Button>
      )}
      {view === "trash" && (
        <Button
          type="text"
          className="task-action-inline"
          danger
          onClick={() => setConfirmAction({ kind: "clearTrash" })}
        >
          清空垃圾箱
        </Button>
      )}
    </>
  );
  const renderTaskCard = (task: Task, index: number, timeline = false) => {
    const taskList = listOf(task);
    const expanded = expandedId === task.id;
    const statusLabel = states.find(
      (state) => state.value === task.status,
    )?.label;
    const toggle = () => setExpandedId(expanded ? null : task.id);
    return (
              <article
                data-task-id={task.id}
                className={[
                  "task-row",
                  "task-card",
                  expanded ? "expanded" : "",
                  draggingId === task.id ? "dragging" : "",
                  task.status === "done" ? "done" : "",
                  dropBeforeId === task.id
                    ? dropPosition === "before"
                      ? "drop-before"
                      : "drop-after"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onDragOver={(event) => {
                  if (canReorder) event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!canReorder) return;
                  event.preventDefault();
                  dropTask(task);
                }}
              >
                <div className="task-row-check">
                  {selectionMode && !task.trashed_at ? (
                    <Checkbox
                      aria-label={`选择 ${task.title}`}
                      checked={selectedIds.has(task.id)}
                      onChange={() => toggleSelected(task.id)}
                    />
                  ) : !task.trashed_at ? (
                    <Checkbox
                      aria-label={
                        task.status === "done"
                          ? `恢复 ${task.title}`
                          : `完成 ${task.title}`
                      }
                      checked={task.status === "done"}
                      disabled={task.status === "cancelled"}
                      onChange={(event) => {
                        if (task.status === "done") reopen.mutate(task);
                        else if (event.target.checked)
                          complete.mutate(task);
                      }}
                    />
                  ) : null}
                </div>
                <div className="task-row-main">
                  <div className="task-row-titleline">
                    <button
                      type="button"
                      className="row-title-button"
                      onClick={toggle}
                      aria-expanded={expanded}
                    >
                      <h3>{task.title}</h3>
                    </button>
                    {task.trashed_at ? (
                      <span className="row-deadline muted">
                        {deadlineLabel(
                          task.deadline_at,
                          task.deadline_all_day,
                          profile.timezone,
                        )}
                      </span>
                    ) : (
                      <InlineDeadline
                        task={task}
                        timezone={profile.timezone}
                        onChange={(deadline_at, deadline_all_day) =>
                          setDeadline.mutate({
                            task,
                            deadline_at,
                            deadline_all_day,
                          })
                        }
                      />
                    )}
                    {task.remind_at && (
                      <span className="task-row-reminder">
                        提醒 {displayTime(task.remind_at, profile.timezone)}
                      </span>
                    )}
                    {taskList && (
                      <span className="task-row-list">
                        <span
                          className="task-row-list-dot"
                          style={{ background: taskList.color }}
                        />
                        {taskList.name}
                      </span>
                    )}
                    {task.status !== "todo" && statusLabel && (
                      <span className="task-row-list">{statusLabel}</span>
                    )}
                    {task.priority >= 3 && (
                      <span className="task-row-priority">
                        {priorityLabel(task.priority)}
                      </span>
                    )}
                    <button
                      type="button"
                      className={
                        task.flagged
                          ? "text-action task-row-flag active"
                          : "text-action task-row-flag"
                      }
                      aria-label={
                        task.flagged
                          ? `取消标记 ${task.title}`
                          : `标记 ${task.title}`
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        setFlag.mutate({
                          task,
                          flagged: !task.flagged,
                        });
                      }}
                    >
                      {task.flagged ? "★" : "☆"}
                    </button>
                    <span className="row-chevron" aria-hidden="true">
                      {expanded ? "▾" : "▸"}
                    </span>
                  </div>
                  {expanded && (
                    <div
                      className="row-detail"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {task.description && (
                        <p className="description">{task.description}</p>
                      )}
                      {task.tags.length > 0 && (
                        <div className="row-detail-meta">
                          {task.tags.map((tag) => (
                            <span key={tag}>{tag}</span>
                          ))}
                        </div>
                      )}
                      {task.links.length > 0 && (
                        <div className="task-links">
                          {task.links.map((link) => (
                            <a
                              key={link}
                              href={link}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {link}
                            </a>
                          ))}
                        </div>
                      )}
                      {task.parent_id && (
                        <p className="muted">
                          父任务：{relations([task.parent_id])}
                        </p>
                      )}
                      {task.predecessor_ids.length > 0 && (
                        <p className="muted">
                          前置：{relations(task.predecessor_ids)}
                        </p>
                      )}
                      {task.child_ids.length > 0 && !detailPage && (
                        <p className="muted">
                          子任务：{relations(task.child_ids)}
                        </p>
                      )}
                      {task.blocked_by.length > 0 &&
                        task.status !== "done" && (
                          <p className="danger-text">
                            等待前置：{relations(task.blocked_by_ids)}
                          </p>
                        )}
                      <div className="row-detail-meta">
                        <span>
                          预计 {task.estimate_minutes ?? "—"} 分钟
                        </span>
                        <span>{priorityLabel(task.priority)}</span>
                        {task.recurrence &&
                          `重复：${recurrenceLabel(task.recurrence, task.recurrence_interval, task.recurrence_from_completion)}`}
                        {task.completed_at &&
                          `完成于 ${displayTime(task.completed_at, profile.timezone)}`}
                      </div>
                      {!task.trashed_at && (
                        <>
                          <SubtaskChecklist parent={task} />
                          <AttachmentPanel taskId={task.id} />
                        </>
                      )}
                      {confirmAction?.kind === "trash" &&
                        confirmAction.task.id === task.id && (
                          <InlineConfirm
                            message={`子任务和依赖不会被删除。后续任务会标记前置任务不可用：${[
                              ...task.dependent_ids,
                              ...task.child_ids,
                            ]
                              .map(titleOf)
                              .join("、")}`}
                            confirmLabel="确认移入垃圾箱"
                            loading={trashTask.isPending}
                            onCancel={() => setConfirmAction(null)}
                            onConfirm={() => {
                              setConfirmAction(null);
                              trashTask.mutate({
                                task,
                                confirmed: true,
                              });
                            }}
                          />
                        )}
                      {confirmAction?.kind === "purge" &&
                        confirmAction.task.id === task.id && (
                          <InlineConfirm
                            message="附件和关联记录会一并删除，无法恢复。"
                            confirmLabel="确认永久删除"
                            loading={purgeTask.isPending}
                            onCancel={() => setConfirmAction(null)}
                            onConfirm={() => {
                              setConfirmAction(null);
                              purgeTask.mutate(task);
                            }}
                          />
                        )}
                      <div className="row-actions">
                        {task.trashed_at ? (
                          <>
                            <Button
                              type="text"
                              size="small"
                              onClick={() => restoreTask.mutate(task)}
                              loading={
                                restoreTask.isPending &&
                                restoreTask.variables?.id === task.id
                              }
                            >
                              恢复任务
                            </Button>
                            <Button
                              type="text"
                              size="small"
                              danger
                              loading={
                                purgeTask.isPending &&
                                purgeTask.variables?.id === task.id
                              }
                              onClick={() =>
                                setConfirmAction({
                                  kind: "purge",
                                  task,
                                })
                              }
                            >
                              永久删除
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              type="text"
                              size="small"
                              onClick={() =>
                                setFlag.mutate({
                                  task,
                                  flagged: !task.flagged,
                                })
                              }
                              loading={
                                setFlag.isPending &&
                                setFlag.variables?.task.id === task.id
                              }
                            >
                              {task.flagged ? "取消标记" : "标记"}
                            </Button>
                            <SourceButton objectId={task.id} />
                            <Button
                              type="text"
                              size="small"
                              onClick={() =>
                                open({ kind: "task", task })
                              }
                            >
                              编辑
                            </Button>
                            <Button
                              type="text"
                              size="small"
                              danger
                              disabled={
                                trashTask.isPending &&
                                trashTask.variables?.task.id === task.id
                              }
                              onClick={() => remove(task)}
                            >
                              移入垃圾箱
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {timeline && (
                  <span
                    className="drag-handle plan-drag-handle"
                    aria-label={`拖动 ${task.title}`}
                    title="拖动到其他日期或调整顺序"
                    onPointerDown={(event) => startTimelineDrag(event, task)}
                  >
                    ⋮⋮
                  </span>
                )}
                {canReorder && !timeline && (
                  <div className="task-row-reorder">
                    <span
                      className="drag-handle"
                      draggable
                      aria-label={`拖动 ${task.title}`}
                      title="拖动排序"
                      onDragStart={(event) => {
                        setDraggingId(task.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", task.id);
                      }}
                      onDragEnd={() => setDraggingId(null)}
                    >
                      ⋮⋮
                    </span>
                    <Button
                      type="text"
                      size="small"
                      aria-label={`上移 ${task.title}`}
                      disabled={index === 0 || reorder.isPending}
                      onClick={() => moveTask(task, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      aria-label={`下移 ${task.title}`}
                      disabled={
                        index === visible.length - 1 ||
                        reorder.isPending
                      }
                      onClick={() => moveTask(task, 1)}
                    >
                      ↓
                    </Button>
                  </div>
                )}
              </article>
    );
  };

  return (
    <>
      <header>
        <div>
          <h1>{inbox ? "收件箱" : detailPage ? "任务详情" : "任务"}</h1>
          <p className="muted">
            {inbox
              ? "集中处理导入材料与任务草稿。"
              : "记录、完成并推进你的任务。"}
          </p>
        </div>
        {inbox ? (
          <Button type="primary" onClick={() => open({ kind: "draft" })}>
            新建任务草稿
          </Button>
        ) : !detailPage ? (
          <Button type="primary" onClick={() => open({ kind: "task" })}>
            新建任务
          </Button>
        ) : null}
      </header>
      {detailPage && (
        <Space className="toolbar">
          <Link to={back.to}>{back.label}</Link>
          <Link to="/settings/rules?tab=check">查看相关并行规则</Link>
        </Space>
      )}
      {!inbox && !detailPage && (
        <div className="task-toolbar">
          <div className="task-toolbar-head">
            <div
              ref={viewTabsRef}
              className="view-tabs"
              role="group"
              aria-label="任务视图"
            >
              {views.map(([key, label]) => (
                <Button
                  key={key}
                  type="text"
                  aria-pressed={view === key}
                  className={view === key ? "view-tab active" : "view-tab"}
                  onClick={() => setView(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Space wrap className="task-toolbar-actions">
              {actionButtons}
              <Popover
                trigger="click"
                open={mobileActionsOpen}
                onOpenChange={setMobileActionsOpen}
                content={
                  <div
                    className="task-actions-menu"
                    onClick={() => setMobileActionsOpen(false)}
                  >
                    {actionButtons}
                  </div>
                }
              >
                <Button type="text" className="mobile-actions-trigger">
                  更多操作
                </Button>
              </Popover>
              <Button
                type="text"
                aria-label="筛选"
                aria-expanded={mobileFiltersOpen}
                aria-controls="task-filter-panel"
                className={`mobile-filter-trigger ${
                  mobileFiltersOpen ? "toolbar-toggle active" : "toolbar-toggle"
                }`}
                onClick={() => setMobileFiltersOpen((open) => !open)}
              >
                筛选
                {filterChips.length > 0 && (
                  <span className="filter-count">{filterChips.length}</span>
                )}
              </Button>
            </Space>
          </div>
          <div
            id="task-filter-panel"
            className={
              mobileFiltersOpen ? "task-filter-panel open" : "task-filter-panel"
            }
          >
            <div className="task-filter-bar">
              {searchInput}
              <Select
              aria-label="筛选清单"
              value={listFilter}
              onChange={setListFilter}
              options={groupedListOptions}
            />
            <Select
              aria-label="已保存筛选"
              value={savedFilterId}
              onChange={applySavedFilter}
              allowClear
              placeholder="已保存筛选"
              onClear={() => setUrlValue("saved", "", "")}
              options={(savedFilters.data ?? []).map((saved) => ({
                value: saved.id,
                label: saved.name,
              }))}
              style={{ minWidth: 140 }}
            />
            <Select
              aria-label="筛选标签"
              value={tagFilter}
              onChange={setTagFilter}
              options={[
                { value: "all", label: "全部标签" },
                ...(tags.data ?? []).map((tag) => ({
                  value: tag.name,
                  label: tag.name,
                })),
              ]}
            />
            <Select
              aria-label="筛选状态"
              value={status}
              onChange={setStatus}
              options={[{ value: "all", label: "全部状态" }, ...states]}
            />
            {!timelineMode && (
              <Select
                aria-label="任务排序"
                value={sort}
                onChange={setSort}
                options={sortOptions}
              />
            )}
            </div>
          </div>
          {saveFilterOpen && (
            <span className="inline-filter-save">
              <Input
                aria-label="筛选名称"
                value={filterName}
                onChange={(e) => setFilterName(e.target.value)}
                placeholder="筛选名称"
                maxLength={100}
                onPressEnter={submitFilter}
              />
              <Button type="text" onClick={submitFilter}>
                保存
              </Button>
              <Button type="text" onClick={() => setSaveFilterOpen(false)}>
                取消
              </Button>
            </span>
          )}
          {filterChips.length > 0 && (
            <div
              className="filter-summary"
              role="group"
              aria-label="当前筛选"
            >
              <span className="filter-summary-label">当前筛选</span>
              {filterChips.map((chip) => (
                <Tag key={chip.key} closable onClose={chip.onClose}>
                  {chip.label}
                </Tag>
              ))}
              <Button type="link" size="small" onClick={clearAllFilters}>
                清除全部
              </Button>
            </div>
          )}
          {sort === "manual" && !canReorder && (
            <span className="muted">
              {listTasks.hasNextPage
                ? "加载全部任务后可拖动排序"
                : "清除搜索、状态或标签筛选后可拖动排序"}
            </span>
          )}
        </div>
      )}

      {confirmAction?.kind === "clearTrash" && (
        <div className="toolbar">
          <InlineConfirm
            message="垃圾箱中的任务、附件和关联记录将永久删除，无法恢复。"
            confirmLabel="确认清空垃圾箱"
            loading={purgeTrash.isPending}
            onCancel={() => setConfirmAction(null)}
            onConfirm={() =>
              purgeTrash.mutate(undefined, {
                onSuccess: () => setConfirmAction(null),
              })
            }
          />
        </div>
      )}
      {!inbox && !detailPage && selectionMode && (
        <div className="toolbar bulk-bar">
          <Space wrap>
            <span>已选 {selectedIds.size} 项</span>
            <Button
              type="text"
              disabled={!selectedIds.size}
              loading={bulk.isPending}
              onClick={() => runBulk("complete")}
            >
              完成
            </Button>
            <Button
              type="text"
              disabled={!selectedIds.size}
              loading={bulk.isPending}
              onClick={() => runBulk("reopen")}
            >
              恢复待办
            </Button>
            <Button
              type="text"
              disabled={!selectedIds.size || bulk.isPending}
              onClick={() => {
                setBulkDeadlineValue("");
                setBulkDeadlineOpen((open) => !open);
              }}
            >
              改期
            </Button>
            {bulkDeadlineOpen && (
              <span className="inline-filter-save">
                {quickDeadlineOptions(
                  DateTime.now().setZone(profile.timezone),
                ).map((option) => (
                  <Button
                    key={option.key}
                    type="text"
                    size="small"
                    disabled={!selectedIds.size || bulk.isPending}
                    onClick={() => {
                      runBulk("deadline", { deadline: option });
                      setBulkDeadlineOpen(false);
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
                <input
                  type="datetime-local"
                  aria-label="批量截止时间"
                  value={bulkDeadlineValue}
                  onChange={(event) =>
                    setBulkDeadlineValue(event.target.value)
                  }
                />
                <Button
                  type="text"
                  size="small"
                  disabled={!bulkDeadlineValue || bulk.isPending}
                  onClick={() => {
                    if (!bulkDeadlineValue) return;
                    const value = deadlineInstant(
                      bulkDeadlineValue,
                      false,
                      profile.timezone,
                    );
                    if (!value) return;
                    runBulk("deadline", {
                      deadline: {
                        key: "custom",
                        label: "自定义",
                        deadline_at: value,
                        deadline_all_day: false,
                      },
                    });
                    setBulkDeadlineOpen(false);
                  }}
                >
                  应用
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() => setBulkDeadlineOpen(false)}
                >
                  取消
                </Button>
              </span>
            )}
            <Button
              type="text"
              disabled={!selectedIds.size || bulk.isPending}
              onClick={() => {
                setBulkTagValues([]);
                setBulkTagOpen(true);
              }}
            >
              标签
            </Button>
            {bulkTagOpen && (
              <span className="inline-filter-save">
                <Select
                  mode="tags"
                  value={bulkTagValues}
                  onChange={setBulkTagValues}
                  options={(tags.data ?? []).map((tag) => ({
                    value: tag.name,
                    label: tag.name,
                  }))}
                  placeholder="输入或选择标签"
                  style={{ minWidth: 180 }}
                />
                <Button
                  type="text"
                  disabled={!bulkTagValues.length}
                  onClick={() => {
                    if (!bulkTagValues.length) return;
                    runBulk("remove_tags", { tags: bulkTagValues });
                    setBulkTagOpen(false);
                  }}
                >
                  移除标签
                </Button>
                <Button
                  type="text"
                  disabled={!bulkTagValues.length}
                  onClick={() => {
                    if (!bulkTagValues.length) return;
                    runBulk("add_tags", { tags: bulkTagValues });
                    setBulkTagOpen(false);
                  }}
                >
                  添加标签
                </Button>
                <Button type="text" onClick={() => setBulkTagOpen(false)}>
                  取消
                </Button>
              </span>
            )}
            <Button
              type="text"
              disabled={!selectedIds.size || bulk.isPending}
              onClick={() => setBulkMoveOpen((open) => !open)}
            >
              移动清单
            </Button>
            {bulkMoveOpen && (
              <span className="inline-filter-save">
                <Select
                  aria-label="批量移动到清单"
                  value={bulkMoveList}
                  onChange={setBulkMoveList}
                  options={[
                    { value: "inbox", label: "收件箱（未分类）" },
                    ...(lists.data ?? []).map((list) => ({
                      value: list.id,
                      label: list.name,
                    })),
                  ]}
                  style={{ minWidth: 180 }}
                />
                <Button
                  type="text"
                  size="small"
                  disabled={bulk.isPending}
                  onClick={() => {
                    runBulk("move", {
                      listId: bulkMoveList === "inbox" ? null : bulkMoveList,
                    });
                    setBulkMoveOpen(false);
                  }}
                >
                  应用
                </Button>
                <Button
                  type="text"
                  size="small"
                  onClick={() => setBulkMoveOpen(false)}
                >
                  取消
                </Button>
              </span>
            )}
            <Button
              type="text"
              danger
              disabled={!selectedIds.size}
              loading={bulk.isPending}
              onClick={() => setConfirmAction({ kind: "bulkTrash" })}
            >
              移入垃圾箱
            </Button>
            <Button
              type="text"
              onClick={() => {
                setSelectionMode(false);
                setSelectedIds(new Set());
              }}
            >
              退出批量
            </Button>
          </Space>
          {confirmAction?.kind === "bulkTrash" && (
            <InlineConfirm
              message={`将选中的 ${selectedIds.size} 个任务移入垃圾箱？有关联任务可能被阻塞。`}
              confirmLabel="确认移入垃圾箱"
              loading={bulk.isPending}
              onCancel={() => setConfirmAction(null)}
              onConfirm={() => {
                setConfirmAction(null);
                runBulk("trash");
              }}
            />
          )}
        </div>
      )}
      {editor && (
        <section className="section inline-editor" ref={editorRef}>
          <div className="section-inline-heading">
            <h3>
              {editor.kind === "draft"
                ? editor.draft
                  ? "编辑任务草稿"
                  : "新建任务草稿"
                : currentTask
                  ? "编辑任务"
                  : "新建任务"}
            </h3>
            <Button type="text" onClick={closeEditor}>
              收起
            </Button>
          </div>
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            title: "",
            status: "todo",
            priority: 2,
            flagged: false,
            parallel_policy: "inherit",
            deadline_all_day: false,
            recurrence_interval: 1,
            recurrence_from_completion: false,
          }}
        >
          <Form.Item
            name="title"
            label="任务标题"
            extra="创建正式任务必填；保存草稿可留空"
            rules={[{ max: 200 }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="description" label="任务描述">
            <Input.TextArea rows={3} maxLength={20000} />
          </Form.Item>
          <Form.Item
            name="links"
            label="相关链接"
            extra="每行一个 http/https 链接，最多 20 个。"
          >
            <Input.TextArea
              rows={3}
              placeholder={"https://example.com/资料\nhttps://example.com/作业"}
            />
          </Form.Item>
          <div className="form-grid">
            <Form.Item name="status" label="执行状态">
              <Select options={states} />
            </Form.Item>
            <Form.Item name="priority" label="优先级">
              <Select options={priorities} />
            </Form.Item>
          </div>
          <Form.Item name="flagged" valuePropName="checked">
            <Checkbox>标记为重点</Checkbox>
          </Form.Item>
          <Form.Item
            name="deadline_at"
            label={`截止时间（${profile.timezone}）`}
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item
            name="deadline_all_day"
            valuePropName="checked"
            extra="仅显示日期，不展示具体时刻；清除截止时间时自动关闭。"
          >
            <Checkbox>仅日期（全天）</Checkbox>
          </Form.Item>
          <Form.Item
            name="remind_at"
            label={`提醒时间（${profile.timezone}）`}
            extra="独立于截止时间，仅显示提醒，不发送系统通知。"
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item
            name="recurrence"
            label="重复"
            extra="重复任务需要设置截止时间；完成当前任务后自动生成下一次。"
          >
            <Select
              allowClear
              placeholder="不重复"
              options={[
                { value: "daily", label: "每天" },
                { value: "weekly", label: "每周" },
                { value: "monthly", label: "每月" },
                { value: "yearly", label: "每年" },
                { value: "weekdays", label: "工作日" },
              ]}
            />
          </Form.Item>
          {recurrenceValue && (
            <>
              {recurrenceValue !== "weekdays" && (
                <Form.Item
                  name="recurrence_interval"
                  label={`重复间隔（每 ${intervalUnit}）`}
                >
                  <InputNumber min={1} max={52} precision={0} />
                </Form.Item>
              )}
              <Form.Item
                name="recurrence_from_completion"
                valuePropName="checked"
              >
                <Checkbox>按完成日计算下一次</Checkbox>
              </Form.Item>
              <div className="form-grid">
                <Form.Item
                  name="recurrence_until"
                  label="重复结束日期（可选）"
                >
                  <Input type="date" />
                </Form.Item>
                <Form.Item
                  name="recurrence_remaining"
                  label="剩余次数（可选）"
                >
                  <InputNumber
                    min={0}
                    max={100000}
                    precision={0}
                    placeholder="不限"
                  />
                </Form.Item>
              </div>
            </>
          )}
          <Form.Item name="estimate_minutes" label="预计用时（分钟，可留空）">
            <InputNumber min={1} max={100000} precision={0} />
          </Form.Item>
          <Form.Item name="task_type" label="任务类型（可选）">
            <Input placeholder="例如 reading / coding" maxLength={100} />
          </Form.Item>
          <Form.Item name="list_id" label="所属清单">
            <Select
              allowClear
              placeholder="收件箱（未分类）"
              options={editorListOptions}
            />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Select
              mode="tags"
              tokenSeparators={[",", "，"]}
              placeholder="输入标签后回车"
              options={(tags.data ?? []).map((tag) => ({
                value: tag.name,
                label: tag.name,
              }))}
            />
          </Form.Item>
          <Form.Item name="parent_id" label="父任务（可选）">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              options={options}
            />
          </Form.Item>
          <Form.Item name="predecessor_ids" label="前置任务">
            <Select
              mode="multiple"
              optionFilterProp="label"
              options={options}
            />
          </Form.Item>
          <Form.Item name="parallel_policy" label="任务并行设置">
            <Select options={policies} />
          </Form.Item>
          <p className="muted">
            父子关系用于组织任务；执行先后由前置任务决定。允许并行仍须有匹配的组合规则。
          </p>
        </Form>
          {pendingCancel && (
            <InlineConfirm
              message={`关联子任务和依赖会保留，后续任务将被阻塞。受影响任务：${[
                ...pendingCancel.task.dependent_ids,
                ...pendingCancel.task.child_ids,
              ]
                .map(titleOf)
                .join("、")}`}
              confirmLabel="确认取消任务"
              loading={mutation.isPending}
              onCancel={() => setPendingCancel(null)}
              onConfirm={() => {
                mutation.mutate({
                  path: `/tasks/${pendingCancel.task.id}`,
                  method: "PUT",
                  body: { ...pendingCancel.body, confirm_impact: true },
                });
                setPendingCancel(null);
              }}
            />
          )}
          <div className="row-actions">
            <Button type="text" onClick={closeEditor}>
              取消
            </Button>
            {editor.kind === "task" && !currentTask && (
              <Button
                type="text"
                disabled={draftSave.isPending}
                onClick={() => void save(true)}
              >
                保存草稿
              </Button>
            )}
            <Button
              type="primary"
              loading={
                editor.kind === "draft" ? draftSave.isPending : mutation.isPending
              }
              onClick={() => void save(editor.kind === "draft")}
            >
              {editor.kind === "draft"
                ? "保存草稿"
                : currentTask
                  ? "保存修改"
                  : "创建任务"}
            </Button>
          </div>
        </section>
      )}
      <TaskListManager
        open={listManager}
        onClose={() => setListManager(false)}
      />
      <TagManager open={tagManager} onClose={() => setTagManager(false)} />
      {inbox ? (
        <>
          <section className="section toolbar">
            <h2>材料待处理</h2>
            <Space wrap>
              <Link to="/inbox/imports">提交新材料</Link>
              <Link to="/inbox/imports">查看全部导入记录</Link>
            </Space>
            <ImportRecords timezone={profile.timezone} pendingOnly />
          </section>
          <h2>手动任务草稿</h2>
          {drafts.error && (
            <Alert type="error" message={errorText(drafts.error)} />
          )}
          {drafts.error ? null : drafts.isPending ? (
            <Spin />
          ) : !drafts.data?.length ? (
            <div className="empty-state">
              <Empty description="没有待发布的任务草稿" />
            </div>
          ) : (
            <div className="rows">
              {drafts.data.map((draft) => (
                <article key={draft.id} className="task-row">
                  <div className="task-row-main">
                    <h3>{draft.payload.title || "未命名草稿"}</h3>
                    <p className="muted">任务草稿 · 版本 {draft.revision}</p>
                    <p className="description">
                      {draft.payload.description ||
                        "可以继续补充内容，草稿不会参与排程。"}
                    </p>
                    <div className="row-actions">
                      <Button
                        type="text"
                        size="small"
                        onClick={() => open({ kind: "draft", draft })}
                      >
                        编辑任务草稿
                      </Button>
                      <Button
                        type="text"
                        size="small"
                        disabled={
                          publishWrite.isPending &&
                          publishWrite.variables?.path.includes(draft.id)
                        }
                        onClick={() => publish(draft)}
                      >
                        发布任务
                      </Button>
                      <Button
                        type="text"
                        size="small"
                        danger
                        onClick={() =>
                          setConfirmAction({ kind: "deleteDraft", draft })
                        }
                      >
                        删除任务草稿
                      </Button>
                    </div>
                    {confirmAction?.kind === "publish" &&
                      confirmAction.draft.id === draft.id && (
                        <InlineConfirm
                          message={`将“${draft.payload.title || "未命名草稿"}”（版本 ${draft.revision}）发布为正式任务。发布前会再次检查字段和依赖。`}
                          confirmLabel="确认发布任务"
                          danger={false}
                          loading={publishWrite.isPending}
                          onCancel={() => setConfirmAction(null)}
                          onConfirm={() => {
                            setConfirmAction(null);
                            publishWrite.mutate({
                              path: `/drafts/${draft.id}/publish`,
                              body: {
                                revision: draft.revision,
                                idempotency_key: `draft-${draft.id}-r${draft.revision}`,
                              },
                            });
                          }}
                        />
                      )}
                    {confirmAction?.kind === "deleteDraft" &&
                      confirmAction.draft.id === draft.id && (
                        <InlineConfirm
                          message="任务草稿将被删除，不会影响正式任务。"
                          confirmLabel="确认删除草稿"
                          loading={draftDelete.isPending}
                          onCancel={() => setConfirmAction(null)}
                          onConfirm={() => {
                            setConfirmAction(null);
                            draftDelete.mutate({
                              path: `/drafts/${draft.id}?revision=${draft.revision}`,
                              method: "DELETE",
                            });
                          }}
                        />
                      )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {currentQuery.error && (
            <Alert type="error" message={errorText(currentQuery.error)} />
          )}{" "}
          {currentQuery.error ? null : currentQuery.isPending ? (
            <Spin />
          ) : timelineMode && visible.length ? (
            <div className="plan-timeline">
              {overdueGroups.length > 0 && (
                <section className="plan-overdue">
                  <h2 className="plan-section-title">逾期</h2>
                  {overdueGroups.map((group) => (
                    <div
                      key={group.key}
                      data-plan-date={group.key}
                      className={
                        dragOverDate === group.key
                          ? "plan-day drag-over"
                          : "plan-day"
                      }
                    >
                      <div className="plan-day-heading">
                        <strong>{group.label}</strong>
                        <span>{group.tasks.length} 项</span>
                      </div>
                      <div className="plan-day-tasks">
                        {group.tasks.map((task) => (
                          <Fragment key={task.id}>
                            {renderTaskCard(
                              task,
                              visible.findIndex((item) => item.id === task.id),
                              true,
                            )}
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              )}
              <div
                data-plan-nodate
                className={
                  dragOverDate === null
                    ? "plan-day plan-no-date drag-over"
                    : "plan-day plan-no-date"
                }
              >
                <div className="plan-day-heading">
                  <strong>无日期</strong>
                  <span>
                    {noDateTasks.length > 0 ? `${noDateTasks.length} 项` : ""}
                  </span>
                </div>
                {noDateTasks.length > 0 ? (
                  <div className="plan-day-tasks">
                    {noDateTasks.map((task) => (
                      <Fragment key={task.id}>
                        {renderTaskCard(
                          task,
                          visible.findIndex((item) => item.id === task.id),
                          true,
                        )}
                      </Fragment>
                    ))}
                  </div>
                ) : (
                  <div className="plan-day-empty">拖到这里可清除日期</div>
                )}
              </div>
              {timelineMonths.map((month) => (
                <section className="plan-month" key={month.month}>
                  <h2 className="plan-month-title">{month.month}</h2>
                  {month.days.map((day) => (
                    <div
                      key={day.key}
                      data-plan-date={day.key}
                      className={
                        dragOverDate === day.key
                          ? "plan-day drag-over"
                          : "plan-day"
                      }
                    >
                      <div className="plan-day-heading">
                        <strong>{day.label}</strong>
                        <span>
                          {day.tasks.length > 0
                            ? `${day.tasks.length} 项`
                            : ""}
                        </span>
                      </div>
                      {day.tasks.length > 0 ? (
                        <div className="plan-day-tasks">
                          {day.tasks.map((task) => (
                            <Fragment key={task.id}>
                              {renderTaskCard(
                                task,
                                visible.findIndex((item) => item.id === task.id),
                                true,
                              )}
                            </Fragment>
                          ))}
                        </div>
                      ) : (
                        <div className="plan-day-empty" />
                      )}
                    </div>
                  ))}
                </section>
              ))}
              {view !== "today" && monthsLoaded < 12 && (
                <div ref={timelineSentinelRef} className="plan-sentinel">
                  加载更多月份…
                </div>
              )}
            </div>
          ) : !visible.length ? (
            <div className="empty-state">
              <Empty
                description={
                  id
                    ? "任务不存在或已删除"
                    : view === "trash"
                      ? "垃圾箱为空"
                      : view === "done"
                        ? "还没有已完成任务"
                        : view === "today"
                          ? "今天没有要做的任务"
                          : view === "scheduled"
                            ? "还没有设置截止时间的任务"
                            : view === "unscheduled"
                              ? "没有未设置截止时间的任务"
                              : view === "flagged"
                              ? "还没有标记的重点任务"
                              : "还没有任务，先添加一件想完成的事"
                }
              />
            </div>
          ) : (
            <div className={draggingId ? "rows dragging" : "rows"}>
              {visible.map((task, index) => (
                <Fragment key={task.id}>
                  {!detailPage &&
                    sort === "status" &&
                    (index === 0 ||
                      groupOf(visible[index - 1]) !== groupOf(task)) && (
                      <h2 style={{ margin: "18px 0 4px" }}>
                        {groupLabel(task)}
                      </h2>
                    )}
                  {renderTaskCard(task, index)}
                </Fragment>
              ))}
            </div>
          )}
          {!detailPage && listTasks.hasNextPage && (
            <div className="toolbar" style={{ textAlign: "center" }}>
              <Button
                loading={listTasks.isFetchingNextPage}
                onClick={() => void listTasks.fetchNextPage()}
              >
                加载更多
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

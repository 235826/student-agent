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
import { Fragment, useEffect, useState } from "react";
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
  Card,
  Checkbox,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
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
import { displayTime, toLocal } from "../time";
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
type Editor = { kind: "task"; task?: Task } | { kind: "draft"; draft?: Draft };
type Write = { path: string; method?: string; body?: unknown };
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请重试";

export default function TasksPage({ profile }: { profile: Profile }) {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const inbox = location.pathname === "/inbox";
  const isNew = location.pathname === "/tasks/new";
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("status");
  const client = useQueryClient();
  const { message, modal } = App.useApp();
  const [view, setView] = useState<
    "all" | "today" | "scheduled" | "unscheduled" | "flagged" | "done" | "trash"
  >("all");
  const [listFilter, setListFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [listManager, setListManager] = useState(false);
  const [tagManager, setTagManager] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagValues, setBulkTagValues] = useState<string[]>([]);
  const [savedFilterId, setSavedFilterId] = useState<string | undefined>();
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [filterName, setFilterName] = useState("");
  const [isWide, setIsWide] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 701px)").matches,
  );
  const [editor, setEditor] = useState<Editor | null>(
    isNew || params.has("new") ? { kind: "task" } : null,
  );
  const [form] = Form.useForm();
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
  const drawerRequested = params.get("drawer") === "1";
  const drawerOpen = !!id && drawerRequested && isWide;
  const detailPage = !!id && !drawerOpen;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const query = window.matchMedia("(min-width: 701px)");
    const update = () => setIsWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    setSelectedIds(new Set());
  }, [view, listFilter, tagFilter, status, debouncedSearch]);
  useEffect(() => {
    const value = search.trim();
    const timer = setTimeout(
      () => setDebouncedSearch(value),
      value ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [search]);
  const closeEditor = () => {
    setEditor(null);
    if (isNew) {
      const back = backTarget(params.get("from"), {
        to: "/tasks",
        label: "返回任务列表",
      });
      navigate(back.to, { replace: true });
    } else if (params.has("new")) {
      const next = new URLSearchParams(params);
      next.delete("new");
      setParams(next, { replace: true });
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
    ],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(taskQueryString);
      params.set("limit", String(PAGE_SIZE + 1));
      params.set("offset", String(pageParam));
      return api<Task[]>(`/tasks?${params.toString()}`);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.length > PAGE_SIZE ? lastPageParam + PAGE_SIZE : undefined,
    enabled: !inbox && (!id || drawerOpen),
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
      setListFilter("all");
  }, [listFilter, lists.data]);
  useEffect(() => {
    if (
      tagFilter !== "all" &&
      tags.data &&
      !tags.data.some((tag) => tag.name === tagFilter)
    )
      setTagFilter("all");
  }, [tagFilter, tags.data]);
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
        void message.success("草稿已保存到收件箱");
        navigate("/inbox");
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
      setSavedFilterId(saved.id);
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
      setSavedFilterId(undefined);
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
      const submit = (confirmed = false) =>
        mutation.mutate({
          path: task ? `/tasks/${task.id}` : "/tasks",
          method: task ? "PUT" : "POST",
          body: { ...body, confirm_impact: confirmed },
        });
      if (
        task &&
        body.status === "cancelled" &&
        task.status !== "cancelled" &&
        (task.dependent_ids.length || task.child_ids.length)
      ) {
        modal.confirm({
          title: "确认取消关联任务",
          content:
            "关联子任务和依赖会保留，后续任务将被阻塞。受影响任务：" +
            [...task.dependent_ids, ...task.child_ids].map(titleOf).join("、"),
          onOk: () => submit(true),
        });
      } else submit();
    } catch (e) {
      if (e instanceof Error) void message.error(e.message);
    }
  };
  const remove = (task: Task) => {
    if (task.dependent_ids.length || task.child_ids.length)
      modal.confirm({
        title: "确认移入垃圾箱",
        content:
          "子任务和依赖不会被删除。后续任务会标记前置任务不可用：" +
          [...task.dependent_ids, ...task.child_ids].map(titleOf).join("、"),
        onOk: () => trashTask.mutate({ task, confirmed: true }),
      });
    else trashTask.mutate({ task });
  };
  const publish = (draft: Draft) =>
    modal.confirm({
      title: "确认发布任务草稿",
      content: `将“${draft.payload.title || "未命名草稿"}”（版本 ${draft.revision}）发布为正式任务。发布前会再次检查字段和依赖。`,
      onOk: () =>
        publishWrite.mutateAsync({
          path: `/drafts/${draft.id}/publish`,
          body: {
            revision: draft.revision,
            idempotency_key: `draft-${draft.id}-r${draft.revision}`,
          },
        }),
    });
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
    setSavedFilterId(filterId);
    setView(saved.payload.view);
    setListFilter(saved.payload.list_id ?? "all");
    setTagFilter(saved.payload.tag ?? "all");
    setStatus(saved.payload.status ?? "all");
    setSearch(saved.payload.q ?? "");
    setSort(saved.payload.sort);
  };
  const visible = (detailPage ? (detailTask ? [detailTask] : []) : listItems)
    .sort((a, b) =>
      sort === "deadline"
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
      {!inbox && !detailPage && (
        <Space className="toolbar" wrap>
          {views.map(([key, label]) => (
            <Button
              key={key}
              type={view === key ? "primary" : "default"}
              onClick={() => setView(key)}
            >
              {label}
            </Button>
          ))}
        </Space>
      )}
      {detailPage && (
        <Space className="toolbar">
          <Link to={back.to}>{back.label}</Link>
          <Link to="/settings/rules?tab=check">查看相关并行规则</Link>
        </Space>
      )}
      {!inbox && !detailPage && (
        <Space wrap className="toolbar">
          <Select
            aria-label="筛选清单"
            value={listFilter}
            onChange={setListFilter}
            options={groupedListOptions}
          />
          <Button onClick={() => setListManager(true)}>管理清单</Button>
          <Button onClick={() => setTagManager(true)}>管理标签</Button>
          <Button
            type={selectionMode ? "primary" : "default"}
            onClick={() => {
              setSelectionMode((current) => !current);
              setSelectedIds(new Set());
            }}
          >
            {selectionMode ? "退出批量" : "批量操作"}
          </Button>
          {view === "trash" && (
            <Button
              danger
              onClick={() =>
                modal.confirm({
                  title: "清空垃圾箱？",
                  content:
                    "垃圾箱中的任务、附件和关联记录将永久删除，无法恢复。",
                  okText: "清空垃圾箱",
                  cancelText: "取消",
                  onOk: () => purgeTrash.mutate(),
                })
              }
            >
              清空垃圾箱
            </Button>
          )}
          <Select
            aria-label="已保存筛选"
            value={savedFilterId}
            onChange={applySavedFilter}
            allowClear
            placeholder="已保存筛选"
            onClear={() => setSavedFilterId(undefined)}
            options={(savedFilters.data ?? []).map((saved) => ({
              value: saved.id,
              label: saved.name,
            }))}
            style={{ minWidth: 140 }}
          />
          <Button onClick={() => setSaveFilterOpen(true)}>保存筛选</Button>
          {savedFilterId && (
            <Button danger onClick={() => deleteFilter.mutate(savedFilterId)}>
              删除筛选
            </Button>
          )}
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
          <Input.Search
            aria-label="搜索任务"
            placeholder="搜索标题、描述、标签、链接或附件名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            aria-label="筛选状态"
            value={status}
            onChange={setStatus}
            options={[{ value: "all", label: "全部状态" }, ...states]}
          />
          <Select
            aria-label="任务排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: "status", label: "按状态分组" },
              { value: "deadline", label: "截止时间" },
              { value: "priority", label: "优先级" },
              { value: "completed", label: "完成时间" },
              { value: "manual", label: "手动排序" },
            ]}
          />
          {sort === "manual" && !canReorder && (
            <span className="muted">
              {listTasks.hasNextPage
                ? "加载全部任务后可拖动排序"
                : "清除搜索、状态或标签筛选后可拖动排序"}
            </span>
          )}
        </Space>
      )}
      {!inbox && !detailPage && selectionMode && (
        <Card className="toolbar">
          <Space wrap>
            <span>已选 {selectedIds.size} 项</span>
            <Button
              disabled={!selectedIds.size}
              loading={bulk.isPending}
              onClick={() => runBulk("complete")}
            >
              完成
            </Button>
            <Button
              disabled={!selectedIds.size}
              loading={bulk.isPending}
              onClick={() => runBulk("reopen")}
            >
              恢复待办
            </Button>
            <Dropdown
              menu={{
                items: quickDeadlineOptions(
                  DateTime.now().setZone(profile.timezone),
                ).map(({ key, label }) => ({ key, label })),
                onClick: ({ key }) => {
                  const option = quickDeadlineOptions(
                    DateTime.now().setZone(profile.timezone),
                  ).find((item) => item.key === key);
                  if (option) runBulk("deadline", { deadline: option });
                },
              }}
            >
              <Button disabled={!selectedIds.size || bulk.isPending}>
                改期
              </Button>
            </Dropdown>
            <Button
              disabled={!selectedIds.size || bulk.isPending}
              onClick={() => {
                setBulkTagValues([]);
                setBulkTagOpen(true);
              }}
            >
              标签
            </Button>
            <Dropdown
              menu={{
                items: [
                  { key: "inbox", label: "收件箱（未分类）" },
                  ...(lists.data ?? []).map((list) => ({
                    key: list.id,
                    label: list.name,
                  })),
                ],
                onClick: ({ key }) =>
                  runBulk("move", { listId: key === "inbox" ? null : key }),
              }}
            >
              <Button disabled={!selectedIds.size || bulk.isPending}>
                移动清单
              </Button>
            </Dropdown>
            <Button
              danger
              disabled={!selectedIds.size}
              loading={bulk.isPending}
              onClick={() =>
                modal.confirm({
                  title: "移入垃圾箱",
                  content: `将选中的 ${selectedIds.size} 个任务移入垃圾箱？有关联任务可能被阻塞。`,
                  okText: "移入垃圾箱",
                  cancelText: "取消",
                  onOk: () => runBulk("trash"),
                })
              }
            >
              移入垃圾箱
            </Button>
            <Button
              onClick={() => {
                setSelectionMode(false);
                setSelectedIds(new Set());
              }}
            >
              退出批量
            </Button>
          </Space>
        </Card>
      )}
      {inbox ? (
        <>
          <Card title="材料待处理" className="toolbar">
            <Space wrap>
              <Link to="/inbox/imports">提交新材料</Link>
              <Link to="/inbox/imports">查看全部导入记录</Link>
            </Space>
            <ImportRecords timezone={profile.timezone} pendingOnly />
          </Card>
          <h2>手动任务草稿</h2>
          {drafts.error && (
            <Alert type="error" message={errorText(drafts.error)} />
          )}
          {drafts.error ? null : drafts.isPending ? (
            <Spin />
          ) : !drafts.data?.length ? (
            <Card>
              <Empty description="没有待发布的任务草稿" />
            </Card>
          ) : (
            <div className="cards">
              {drafts.data.map((draft) => (
                <Card key={draft.id}>
                  <h3>{draft.payload.title || "未命名草稿"}</h3>
                  <Tag>任务草稿 · 版本 {draft.revision}</Tag>
                  <p className="description">
                    {draft.payload.description ||
                      "可以继续补充内容，草稿不会参与排程。"}
                  </p>
                  <Space wrap>
                    <Button onClick={() => open({ kind: "draft", draft })}>
                      编辑任务草稿
                    </Button>
                    <Button
                      type="primary"
                      disabled={
                        publishWrite.isPending &&
                        publishWrite.variables?.path.includes(draft.id)
                      }
                      onClick={() => publish(draft)}
                    >
                      发布任务
                    </Button>
                    <Button
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: "删除任务草稿？",
                          content: "任务草稿将被删除，不会影响正式任务。",
                          onOk: () =>
                            draftDelete.mutateAsync({
                              path: `/drafts/${draft.id}?revision=${draft.revision}`,
                              method: "DELETE",
                            }),
                        })
                      }
                    >
                      删除任务草稿
                    </Button>
                  </Space>
                </Card>
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
          ) : !visible.length ? (
            <Card>
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
            </Card>
          ) : (
            <div className={draggingId ? "cards dragging" : "cards"}>
              {visible.map((task, index) => {
                const taskList = listOf(task);
                return (
                <Fragment key={task.id}>
                  {!detailPage &&
                    sort === "status" &&
                    (index === 0 ||
                      groupOf(visible[index - 1]) !== groupOf(task)) && (
                      <h2 style={{ gridColumn: "1 / -1", margin: 0 }}>
                        {groupLabel(task)}
                      </h2>
                    )}
                  <Card
                    className={
                      draggingId === task.id ? "task-card dragging" : "task-card"
                    }
                    onDragOver={(e) => {
                      if (canReorder) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      if (!canReorder) return;
                      e.preventDefault();
                      dropTask(task);
                    }}
                  >
                    <div className="card-heading">
                      <div className="card-heading-main">
                        {selectionMode && !task.trashed_at && (
                          <Checkbox
                            aria-label={`选择 ${task.title}`}
                            checked={selectedIds.has(task.id)}
                            onChange={() => toggleSelected(task.id)}
                          />
                        )}
                        {canReorder && (
                          <>
                            <span
                              className="drag-handle"
                              draggable
                              aria-label={`拖动 ${task.title}`}
                              title="拖动排序"
                              onDragStart={(e) => {
                                setDraggingId(task.id);
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", task.id);
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
                          </>
                        )}
                        {!task.trashed_at && !selectionMode && (
                          <Checkbox
                            aria-label={
                              task.status === "done"
                                ? `恢复 ${task.title}`
                                : `完成 ${task.title}`
                            }
                            checked={task.status === "done"}
                            disabled={task.status === "cancelled"}
                            onChange={(e) => {
                              if (task.status === "done") reopen.mutate(task);
                              else if (e.target.checked) complete.mutate(task);
                            }}
                          />
                        )}
                        <h3>
                          <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                        </h3>
                      </div>
                      <Space size={4} wrap>
                        {taskList && (
                          <Tag
                            color={taskList.color}
                            style={{ cursor: "pointer" }}
                            onClick={() =>
                              setListFilter(
                                listFilter === taskList.id ? "all" : taskList.id,
                              )
                            }
                          >
                            {taskList.name}
                          </Tag>
                        )}
                        <Tag
                          color={task.status === "done" ? "green" : "default"}
                        >
                          {states.find((s) => s.value === task.status)?.label}
                        </Tag>
                      </Space>
                    </div>
                    <p className="description">
                      {task.description || "暂无描述"}
                    </p>
                    {task.tags.length > 0 && (
                      <Space size={4} wrap style={{ marginBottom: 8 }}>
                        {task.tags.map((tag) => (
                          <Tag
                            key={tag}
                            style={{ cursor: "pointer" }}
                            onClick={() =>
                              setTagFilter(tagFilter === tag ? "all" : tag)
                            }
                          >
                            {tag}
                          </Tag>
                        ))}
                      </Space>
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
                    {task.blocked_by.length > 0 && task.status !== "done" && (
                      <Alert
                        type="warning"
                        message={
                          <span>等待前置：{relations(task.blocked_by_ids)}</span>
                        }
                      />
                    )}
                    <div className="meta">
                      截止：
                      {deadlineLabel(
                        task.deadline_at,
                        task.deadline_all_day,
                        profile.timezone,
                      )}{" "}
                      · 预计 {task.estimate_minutes ?? "—"} 分钟 ·{" "}
                      {priorityLabel(task.priority)}
                      {task.recurrence &&
                        ` · 重复：${recurrenceLabel(task.recurrence, task.recurrence_interval, task.recurrence_from_completion)}`}
                      {task.completed_at &&
                        ` · 完成于 ${displayTime(task.completed_at, profile.timezone)}`}
                    </div>
                    <Space wrap>
                      {task.trashed_at ? (
                        <>
                          <Button
                            onClick={() => restoreTask.mutate(task)}
                            loading={
                              restoreTask.isPending &&
                              restoreTask.variables?.id === task.id
                            }
                          >
                            恢复任务
                          </Button>
                          <Button
                            danger
                            loading={
                              purgeTask.isPending &&
                              purgeTask.variables?.id === task.id
                            }
                            onClick={() =>
                              modal.confirm({
                                title: "永久删除任务？",
                                content:
                                  "附件和关联记录会一并删除，无法恢复。",
                                okText: "永久删除",
                                cancelText: "取消",
                                onOk: () => purgeTask.mutate(task),
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
                            className={
                              task.flagged ? "flag-button active" : "flag-button"
                            }
                            aria-label={
                              task.flagged
                                ? `取消标记 ${task.title}`
                                : `标记 ${task.title}`
                            }
                            loading={
                              setFlag.isPending &&
                              setFlag.variables?.task.id === task.id
                            }
                            onClick={() =>
                              setFlag.mutate({
                                task,
                                flagged: !task.flagged,
                              })
                            }
                          >
                            {task.flagged ? "★" : "☆"}
                          </Button>
                          <SourceButton objectId={task.id} />
                          {isWide && (
                            <Button
                              onClick={() =>
                                navigate(`/tasks/${task.id}?drawer=1`)
                              }
                            >
                              快速查看
                            </Button>
                          )}
                          <Button onClick={() => open({ kind: "task", task })}>
                            编辑
                          </Button>
                          <Dropdown
                            disabled={["done", "cancelled"].includes(
                              task.status,
                            )}
                            menu={{
                              items: quickDeadlineOptions(
                                DateTime.now().setZone(profile.timezone),
                              ).map(({ key, label }) => ({ key, label })),
                              onClick: ({ key }) => {
                                const option = quickDeadlineOptions(
                                  DateTime.now().setZone(profile.timezone),
                                ).find((item) => item.key === key);
                                if (option)
                                  setDeadline.mutate({
                                    task,
                                    deadline_at: option.deadline_at,
                                    deadline_all_day: option.deadline_all_day,
                                  });
                              },
                            }}
                          >
                            <Button>改期</Button>
                          </Dropdown>
                          <Button
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
                    </Space>
                  </Card>
                </Fragment>
                );
              })}
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
          {detailPage && detailTask && !detailTask.trashed_at && (
            <>
              <SubtaskChecklist parent={detailTask} />
              <AttachmentPanel taskId={detailTask.id} />
            </>
          )}
        </>
      )}
      <Modal
        title={
          editor?.kind === "draft"
            ? editor.draft
              ? "编辑任务草稿"
              : "新建任务草稿"
            : currentTask
              ? "编辑任务"
              : "新建任务"
        }
        open={!!editor}
        onCancel={closeEditor}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={closeEditor}>取消</Button>
            {editor?.kind === "task" && !currentTask && (
              <Button
                disabled={draftSave.isPending}
                onClick={() => void save(true)}
              >
                保存草稿
              </Button>
            )}
            <Button
              type="primary"
              loading={
                editor?.kind === "draft"
                  ? draftSave.isPending
                  : mutation.isPending
              }
              onClick={() => void save(editor?.kind === "draft")}
            >
              {editor?.kind === "draft"
                ? "保存草稿"
                : currentTask
                  ? "保存修改"
                  : "创建任务"}
            </Button>
          </Space>
        }
      >
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
      </Modal>
      <Drawer
        title="任务详情"
        open={drawerOpen}
        onClose={() => navigate(back.to)}
        width={720}
        destroyOnHidden
      >
        {detailTaskQuery.error ? (
          <Alert type="error" message={errorText(detailTaskQuery.error)} />
        ) : detailTaskQuery.isPending ? (
          <Spin />
        ) : detailTask ? (
          <div className="quick-view">
            <h2>{detailTask.title}</h2>
            <Space wrap>
              <Tag>
                {states.find((state) => state.value === detailTask.status)?.label}
              </Tag>
              <Tag>{priorityLabel(detailTask.priority)}</Tag>
              {detailTask.flagged && <Tag color="gold">已标记</Tag>}
              {listOf(detailTask) && (
                <Tag color={listOf(detailTask)!.color}>
                  {listOf(detailTask)!.name}
                </Tag>
              )}
              {detailTask.recurrence && (
                <Tag>
                  {recurrenceLabel(
                    detailTask.recurrence,
                    detailTask.recurrence_interval,
                    detailTask.recurrence_from_completion,
                  )}
                </Tag>
              )}
            </Space>
            <p className="meta">
              截止：
              {deadlineLabel(
                detailTask.deadline_at,
                detailTask.deadline_all_day,
                profile.timezone,
              )}{" "}
              · 预计 {detailTask.estimate_minutes ?? "—"} 分钟
              {detailTask.completed_at &&
                ` · 完成于 ${displayTime(detailTask.completed_at, profile.timezone)}`}
            </p>
            {detailTask.description && (
              <p className="description">{detailTask.description}</p>
            )}
            {detailTask.tags.length > 0 && (
              <Space size={4} wrap className="toolbar">
                {detailTask.tags.map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </Space>
            )}
            {detailTask.links.length > 0 && (
              <div className="task-links">
                {detailTask.links.map((link) => (
                  <a key={link} href={link} target="_blank" rel="noreferrer">
                    {link}
                  </a>
                ))}
              </div>
            )}
            <Space wrap className="toolbar">
              <Button
                onClick={() => open({ kind: "task", task: detailTask })}
              >
                编辑任务
              </Button>
              <Button onClick={() => navigate(`/tasks/${detailTask.id}`)}>
                打开完整详情
              </Button>
            </Space>
            {!detailTask.trashed_at && (
              <>
                <SubtaskChecklist parent={detailTask} />
                <AttachmentPanel taskId={detailTask.id} />
              </>
            )}
          </div>
        ) : (
          <Empty description="任务不存在或已删除" />
        )}
      </Drawer>
      <Modal
        open={saveFilterOpen}
        title="保存当前筛选"
        onCancel={() => setSaveFilterOpen(false)}
        okText="保存"
        cancelText="取消"
        onOk={() => {
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
                status === "all"
                  ? null
                  : (status as SavedFilterPayload["status"]),
              list_id: listFilter === "all" ? null : listFilter,
              tag: tagFilter === "all" ? null : tagFilter,
              sort: sort as SavedFilterPayload["sort"],
            },
          });
        }}
      >
        <Input
          aria-label="筛选名称"
          value={filterName}
          onChange={(e) => setFilterName(e.target.value)}
          placeholder="例如：本周数学作业"
          maxLength={100}
        />
      </Modal>
      <Modal
        open={bulkTagOpen}
        title="批量标签"
        onCancel={() => setBulkTagOpen(false)}
        footer={
          <Space>
            <Button
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
              type="primary"
              disabled={!bulkTagValues.length}
              onClick={() => {
                if (!bulkTagValues.length) return;
                runBulk("add_tags", { tags: bulkTagValues });
                setBulkTagOpen(false);
              }}
            >
              添加标签
            </Button>
            <Button onClick={() => setBulkTagOpen(false)}>取消</Button>
          </Space>
        }
      >
        <Select
          mode="tags"
          value={bulkTagValues}
          onChange={setBulkTagValues}
          options={(tags.data ?? []).map((tag) => ({
            value: tag.name,
            label: tag.name,
          }))}
          placeholder="输入或选择标签"
          style={{ width: "100%" }}
        />
      </Modal>
      <TaskListManager
        open={listManager}
        onClose={() => setListManager(false)}
      />
      <TagManager open={tagManager} onClose={() => setTagManager(false)} />
    </>
  );
}

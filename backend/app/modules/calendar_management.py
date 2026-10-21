from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import EventInput, EventOut, SeriesInput, SeriesOut
from app.db.models import Course, Event, EventOverride, EventSeries, User
from app.modules.idempotency import remember, replay
from app.modules.records import owned, record_change


def instance_override(db: Session, event: Event, *, create: bool = False) -> EventOverride | None:
    if not event.series_id:
        return None
    override = db.scalar(
        select(EventOverride).where(
            EventOverride.series_id == event.series_id,
            EventOverride.occurrence_local_date == event.occurrence_local_date,
        )
    )
    if override is None and create:
        override = EventOverride(
            workspace_id=event.workspace_id,
            series_id=event.series_id,
            occurrence_local_date=event.occurrence_local_date,
            is_skipped=False,
            policy_revision=0,
        )
        db.add(override)
    return override


def event_view(db: Session, event: Event) -> EventOut:
    data: dict[str, Any] = {
        c.name: getattr(event, c.name)
        for c in Event.__table__.columns
        if c.name in EventOut.model_fields
    }
    data["original_start_at"] = event.start_at
    data["original_end_at"] = event.end_at
    override = instance_override(db, event)
    if override:
        data["updated_at"] = max(event.updated_at, override.updated_at)
        data["is_skipped"] = override.is_skipped
        data["parallel_policy_override"] = override.parallel_policy_override
        for key in ("title", "location", "start_at", "end_at", "timezone"):
            value = getattr(override, key)
            if value is not None:
                data[key] = value
    return EventOut.model_validate(data)


def update_event_record(db: Session, user: User, event: Event, body: EventInput) -> None:
    if body.course_id:
        owned(db, Course, body.course_id, user)
    data = body.model_dump()
    data["start_at"] = int(body.start_at.timestamp() * 1000)
    data["end_at"] = int(body.end_at.timestamp() * 1000)
    if event.series_id:
        if (body.course_id, body.kind, body.locked) != (event.course_id, event.kind, event.locked):
            raise HTTPException(409, "单次课程修改不能改变课程归属、类型或锁定设置")
        override = instance_override(db, event, create=True)
        for key in ("title", "location", "start_at", "end_at", "timezone"):
            setattr(override, key, data[key])
    else:
        if body.kind != "course" and event.is_skipped:
            raise HTTPException(409, "请先恢复参加，再修改课程类型")
        for key, value in data.items():
            setattr(event, key, value)
    record_change(db, user, "event.update", event)


def unambiguous_instant(local: datetime, zone: ZoneInfo) -> datetime:
    candidates: dict[datetime, datetime] = {}
    for fold in (0, 1):
        aware = local.replace(tzinfo=zone, fold=fold)
        utc = aware.astimezone(UTC)
        if utc.astimezone(zone).replace(tzinfo=None) == local:
            candidates[utc] = aware
    if len(candidates) != 1:
        raise HTTPException(
            422,
            f"{local.isoformat()} 在 {zone.key} 不存在或有夏令时歧义；"
            "请调整时间或拆分日期范围后确认，尚未创建任何课程",
        )
    return next(iter(candidates))


def series_view(db: Session, series: EventSeries) -> SeriesOut:
    return SeriesOut(
        id=series.id,
        course_id=series.course_id,
        timezone=series.timezone,
        dtstart_local=series.dtstart_local,
        duration_minutes=series.duration_minutes,
        recurrence_rule=series.recurrence_rule,
        event_ids=list(
            db.scalars(
                select(Event.id).where(Event.series_id == series.id).order_by(Event.start_at)
            )
        ),
    )


def create_series(
    db: Session, user: User, body: SeriesInput, *, commit: bool = True
) -> EventSeries:
    payload = {
        "operation": "series.create",
        **body.model_dump(mode="json", exclude={"idempotency_key"}),
    }
    existing = replay(db, user, body.idempotency_key, payload)
    if existing:
        return owned(db, EventSeries, existing, user)
    course = owned(db, Course, body.course_id, user)
    dates: list[tuple[date, datetime, datetime]] = []
    day = body.start_date
    zone = ZoneInfo(body.timezone)
    while day <= body.end_date:
        if day.weekday() in body.weekdays:
            start = unambiguous_instant(datetime.combine(day, body.start_time), zone)
            end = unambiguous_instant(datetime.combine(day, body.end_time), zone)
            dates.append((day, start, end))
        day += timedelta(days=1)
    if not dates:
        raise HTTPException(422, "日期范围内没有选定星期的课程")
    labels = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    rule = "FREQ=WEEKLY;BYDAY=" + ",".join(labels[i] for i in body.weekdays)
    rule += ";UNTIL=" + body.end_date.strftime("%Y%m%d")
    duration = int(
        (
            datetime.combine(day, body.end_time) - datetime.combine(day, body.start_time)
        ).total_seconds()
        / 60
    )
    series = EventSeries(
        workspace_id=user.workspace_id,
        course_id=course.id,
        timezone=body.timezone,
        dtstart_local=datetime.combine(dates[0][0], body.start_time).isoformat(),
        duration_minutes=duration,
        recurrence_rule=rule,
    )
    db.add(series)
    db.flush()
    for occurrence, start, end in dates:
        db.add(
            Event(
                workspace_id=user.workspace_id,
                course_id=course.id,
                series_id=series.id,
                occurrence_local_date=occurrence.isoformat(),
                kind="course",
                title=course.name,
                timezone=body.timezone,
                location=body.location,
                locked=True,
                start_at=int(start.timestamp() * 1000),
                end_at=int(end.timestamp() * 1000),
            )
        )
    remember(db, user, body.idempotency_key, payload, series.id)
    if commit:
        record_change(db, user, "series.create", series)
    else:
        db.flush()
    return series

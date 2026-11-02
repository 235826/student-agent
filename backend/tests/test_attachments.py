import base64

from app.config import Settings


def create_task(client, title: str = "带附件") -> dict[str, object]:
    response = client.post("/api/v1/tasks", json={"title": title})
    assert response.status_code == 201, response.text
    return response.json()


def test_attachment_upload_list_download_delete(authenticated, settings: Settings):
    c = authenticated
    task = create_task(c)
    uploaded = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("../作业说明.txt", b"hello", "text/plain")},
    )
    assert uploaded.status_code == 201, uploaded.text
    attachment = uploaded.json()
    assert attachment["filename"] == "作业说明.txt"
    assert attachment["media_type"] == "text/plain"
    assert attachment["size_bytes"] == 5

    files = [path for path in settings.attachment_dir.rglob("*") if path.is_file()]
    assert len(files) == 1 and files[0].read_bytes() == b"hello"

    listed = c.get(f"/api/v1/tasks/{task['id']}/attachments")
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [attachment["id"]]

    download = c.get(f"/api/v1/attachments/{attachment['id']}")
    assert download.status_code == 200
    assert download.content == b"hello"
    assert download.headers["content-disposition"].startswith("attachment;")
    assert download.headers["x-content-type-options"] == "nosniff"

    assert c.delete(f"/api/v1/attachments/{attachment['id']}").status_code == 204
    assert c.get(f"/api/v1/tasks/{task['id']}/attachments").json() == []
    assert not [path for path in settings.attachment_dir.rglob("*") if path.is_file()]


def test_attachment_limits_empty_and_trashed(authenticated, settings: Settings, monkeypatch):
    c = authenticated
    task = create_task(c, "受限制附件")
    monkeypatch.setattr("app.api.attachments.MAX_ATTACHMENT_BYTES", 4)
    too_big = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("big.txt", b"12345", "text/plain")},
    )
    assert too_big.status_code == 413
    monkeypatch.setattr("app.api.attachments.MAX_ATTACHMENT_BYTES", 1024)
    empty = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert empty.status_code == 422
    assert not [path for path in settings.attachment_dir.rglob("*") if path.is_file()]

    monkeypatch.setattr("app.api.attachments.MAX_ATTACHMENTS_PER_TASK", 1)
    first = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("one.txt", b"ok", "text/plain")},
    )
    assert first.status_code == 201
    second = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("two.txt", b"ok", "text/plain")},
    )
    assert second.status_code == 409

    c.post(f"/api/v1/tasks/{task['id']}/trash")
    trashed = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("three.txt", b"ok", "text/plain")},
    )
    assert trashed.status_code == 409


def test_attachment_inline_preview_only_safe_types(authenticated):
    c = authenticated
    task = create_task(c, "预览附件")
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    image = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("pixel.png", png, "image/png")},
    )
    assert image.status_code == 201, image.text
    inline_image = c.get(f"/api/v1/attachments/{image.json()['id']}?inline=true")
    assert inline_image.status_code == 200
    assert inline_image.headers["content-disposition"] == "inline"
    assert inline_image.headers["content-type"] == "image/png"

    text = c.post(
        f"/api/v1/tasks/{task['id']}/attachments",
        files={"file": ("note.txt", b"hello", "text/plain")},
    )
    assert text.status_code == 201
    inline_text = c.get(f"/api/v1/attachments/{text.json()['id']}?inline=true")
    assert inline_text.headers["content-disposition"].startswith("attachment;")

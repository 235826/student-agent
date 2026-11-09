from io import BytesIO
from pathlib import Path

from docx import Document
from pypdf import PdfReader

MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_TEXT_CHARS = 20000
TEXT_SUFFIXES = {".txt", ".md", ".markdown"}
SUPPORTED = "PDF、DOCX、TXT 或 Markdown"


def normalize(text: str) -> str:
    value = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value:
        raise ValueError("文件中没有可提取的文字")
    if len(value) > MAX_TEXT_CHARS:
        raise ValueError(f"提取文字超过 {MAX_TEXT_CHARS} 字，请拆分文件后重试")
    return value


def extract_text(filename: str | None, media_type: str, data: bytes) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix == ".pdf" or media_type == "application/pdf":
        try:
            reader = PdfReader(BytesIO(data))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
        except Exception:
            raise ValueError("PDF 读取失败，请确认文件未损坏") from None
        try:
            return normalize(text)
        except ValueError:
            raise ValueError("未提取到 PDF 文字；扫描版 PDF 暂不支持，请改用图片导入") from None
    if suffix == ".docx" or media_type in {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    }:
        try:
            document = Document(BytesIO(data))
        except Exception:
            raise ValueError("Word 文档读取失败，请确认文件为 .docx 格式") from None
        blocks = [paragraph.text for paragraph in document.paragraphs]
        for table in document.tables:
            for row in table.rows:
                blocks.append("\t".join(cell.text for cell in row.cells))
        return normalize("\n".join(blocks))
    if suffix in TEXT_SUFFIXES or media_type.startswith("text/"):
        try:
            return normalize(data.decode("utf-8-sig"))
        except UnicodeDecodeError:
            try:
                return normalize(data.decode("gb18030"))
            except UnicodeDecodeError:
                raise ValueError("文本文件编码无法识别，请使用 UTF-8") from None
    raise ValueError(f"仅支持 {SUPPORTED} 文件")

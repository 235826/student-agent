from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SA_", env_file=".env", extra="ignore")
    database_url: str = "sqlite:///../data/student_agent.db"
    allowed_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]
    cookie_secure: bool = False
    session_hours: int = 24
    llm_base_url: str = ""
    llm_model: str = ""
    llm_api_key: SecretStr = SecretStr("")
    llm_supports_images: bool = False
    llm_timeout_seconds: int = Field(default=60, ge=5, le=180)
    source_dir: Path = Path("../data/sources")

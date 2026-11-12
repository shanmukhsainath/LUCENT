import json
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic_settings.sources import DotEnvSettingsSource, EnvSettingsSource


def _parse_env_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []

        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                pass

        if "," in stripped:
            return [item.strip().strip("\"'") for item in stripped.split(",") if item.strip()]

        return [stripped.strip().strip("\"'")]

    return [str(value)]


class FlexibleEnvSettingsSource(EnvSettingsSource):
    def prepare_field_value(self, field_name: str, field, value, value_is_complex: bool):
        if field_name in {"cors_origins", "stun_urls", "turn_urls"} and value is not None:
            return _parse_env_list(value)
        return super().prepare_field_value(field_name, field, value, value_is_complex)


class FlexibleDotEnvSettingsSource(DotEnvSettingsSource):
    def prepare_field_value(self, field_name: str, field, value, value_is_complex: bool):
        if field_name in {"cors_origins", "stun_urls", "turn_urls"} and value is not None:
            return _parse_env_list(value)
        return super().prepare_field_value(field_name, field, value, value_is_complex)


class Settings(BaseSettings):
    database_url: str = Field(
        default="postgresql+psycopg://postgres:postgres@localhost:5432/postgres",
        description="SQLAlchemy PostgreSQL connection URL. For Supabase use the pooler URI with ?sslmode=require.",
    )
    next_public_supabase_url: str | None = Field(
        default=None,
        description="Supabase project URL exposed to the browser for optional auth helpers.",
    )
    next_public_supabase_publishable_key: str | None = Field(
        default=None,
        description="Supabase publishable key exposed to browser-side clients.",
    )
    echo_sql: bool = False
    pool_pre_ping: bool = True
    jwt_secret: str = Field(
        default="dev-only-insecure-secret-change-me-32chars",
        min_length=32,
        description="Signing key for access tokens. Override with JWT_SECRET in .env for any real deployment.",
    )
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60
    cors_origins: list[str] = [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ]
    stun_urls: list[str] = ["stun:stun.l.google.com:19302"]
    turn_urls: list[str] = []
    turn_username: str | None = None
    turn_credential: str | None = None
    turn_shared_secret: str | None = None
    speech_enabled: bool = False
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"
    whisper_compute_type: str = "int8_float16"
    llm_provider: str = "disabled"
    llm_api_key: str | None = None
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    llm_timeout_seconds: float = 60.0

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls,
        init_settings,
        env_settings,
        dotenv_settings,
        file_secret_settings,
    ):
        env_settings = FlexibleEnvSettingsSource(
            settings_cls,
            case_sensitive=env_settings.case_sensitive,
            env_prefix=env_settings.env_prefix,
            env_prefix_target=env_settings.env_prefix_target,
            env_nested_delimiter=env_settings.env_nested_delimiter,
            env_nested_max_split=env_settings.env_nested_max_split,
            env_ignore_empty=env_settings.env_ignore_empty,
            env_parse_none_str=env_settings.env_parse_none_str,
            env_parse_enums=env_settings.env_parse_enums,
            _init_state=env_settings._init_state,
        )
        dotenv_settings = FlexibleDotEnvSettingsSource(
            settings_cls,
            env_file=dotenv_settings.env_file,
            env_file_encoding=dotenv_settings.env_file_encoding,
            dotenv_filtering=dotenv_settings.dotenv_filtering,
            case_sensitive=dotenv_settings.case_sensitive,
            env_prefix=dotenv_settings.env_prefix,
            env_prefix_target=dotenv_settings.env_prefix_target,
            env_nested_delimiter=dotenv_settings.env_nested_delimiter,
            env_nested_max_split=dotenv_settings.env_nested_max_split,
            env_ignore_empty=dotenv_settings.env_ignore_empty,
            env_parse_none_str=dotenv_settings.env_parse_none_str,
            env_parse_enums=dotenv_settings.env_parse_enums,
            _init_state=dotenv_settings._init_state,
        )
        return init_settings, env_settings, dotenv_settings, file_secret_settings

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

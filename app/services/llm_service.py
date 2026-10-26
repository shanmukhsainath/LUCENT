import json
from typing import Any, Protocol

import httpx

from app.database.config import settings


class LLMServiceError(RuntimeError):
    """Raised when the configured language model cannot produce a response."""


class LLMService(Protocol):
    async def generate_structured(self, *, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        """Generate a JSON object without inventing unsupported facts."""


class OpenAICompatibleLLMService:
    def __init__(self) -> None:
        if not settings.llm_api_key:
            raise LLMServiceError("LLM_API_KEY is not configured.")

    async def generate_structured(self, *, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        url = f"{settings.llm_base_url.rstrip('/')}/chat/completions"
        body = {
            "model": settings.llm_model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=settings.llm_timeout_seconds) as client:
                response = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {settings.llm_api_key}"},
                    json=body,
                )
                response.raise_for_status()
                data = response.json()
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                raise LLMServiceError("The LLM returned a JSON value instead of an object.")
            return parsed
        except LLMServiceError:
            raise
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise LLMServiceError("The configured LLM failed to return valid structured output.") from error


class DisabledLLMService:
    async def generate_structured(self, *, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        raise LLMServiceError("LLM summarization is disabled. Configure LLM_PROVIDER and LLM_API_KEY.")


def get_llm_service() -> LLMService:
    if settings.llm_provider.lower() in {"openai", "openai_compatible"}:
        return OpenAICompatibleLLMService()
    return DisabledLLMService()

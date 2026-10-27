import asyncio
import logging
import threading
from functools import lru_cache

from app.database.config import settings

logger = logging.getLogger(__name__)

NLLB_LANGUAGES = {
    "en": "eng_Latn",
    "ml": "mal_Mlym",
    "te": "tel_Telu",
    "hi": "hin_Deva",
    "ta": "tam_Taml",
    "kn": "kan_Knda",
}


class TranslationServiceError(RuntimeError):
    """Raised when a live caption cannot be translated."""


class NllbTranslationService:
    def __init__(self) -> None:
        self._tokenizer = None
        self._model = None
        self._device = "cpu"
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    def _load_model(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return

            try:
                import torch
                from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
            except ImportError as error:
                raise TranslationServiceError(
                    "Translation is unavailable. Install the project requirements."
                ) from error

            self._device = "cuda" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if self._device == "cuda" else torch.float32
            model_name = "facebook/nllb-200-distilled-600M"
            logger.info(
                "Loading translation model %s on %s. The initial download may take several minutes.",
                model_name,
                self._device,
            )
            tokenizer = AutoTokenizer.from_pretrained(model_name)
            model = AutoModelForSeq2SeqLM.from_pretrained(model_name, torch_dtype=dtype)
            try:
                model.to(self._device)
            except torch.cuda.OutOfMemoryError:
                if self._device != "cuda":
                    raise
                logger.warning(
                    "GPU memory is insufficient for NLLB alongside Whisper; loading NLLB on CPU."
                )
                del model
                torch.cuda.empty_cache()
                self._device = "cpu"
                model = AutoModelForSeq2SeqLM.from_pretrained(
                    model_name,
                    torch_dtype=torch.float32,
                )
            model.eval()
            self._tokenizer = tokenizer
            self._model = model
            logger.info("Translation model %s is ready on %s.", model_name, self._device)

    async def initialize(self) -> None:
        await asyncio.to_thread(self._load_model)

    def _translate_sync(self, text: str, source: str, target: str) -> str:
        if source not in NLLB_LANGUAGES or target not in NLLB_LANGUAGES:
            raise TranslationServiceError("Unsupported live translation language.")
        if source == target or not text.strip():
            return text.strip()

        self._load_model()
        tokenizer = self._tokenizer
        model = self._model
        if tokenizer is None or model is None:
            raise TranslationServiceError("Translation model did not initialize.")

        try:
            with self._inference_lock:
                tokenizer.src_lang = NLLB_LANGUAGES[source]
                inputs = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
                inputs = inputs.to(self._device)
                output = model.generate(
                    **inputs,
                    forced_bos_token_id=tokenizer.convert_tokens_to_ids(NLLB_LANGUAGES[target]),
                    max_length=256,
                    num_beams=4,
                )
                translated = tokenizer.batch_decode(output, skip_special_tokens=True)[0].strip()
                if not translated:
                    raise TranslationServiceError("The translation model returned an empty caption.")
                return translated
        except TranslationServiceError:
            raise
        except Exception as error:
            logger.exception("Live caption translation failed.")
            raise TranslationServiceError(f"Live translation failed: {error}") from error

    async def translate(self, text: str, source: str, target: str) -> str:
        return await asyncio.to_thread(self._translate_sync, text, source, target)


@lru_cache
def get_translation_service() -> NllbTranslationService:
    if not settings.speech_enabled:
        raise TranslationServiceError(
            "Live translation is disabled. Set SPEECH_ENABLED=true to enable it."
        )
    return NllbTranslationService()

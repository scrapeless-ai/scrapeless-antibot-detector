"""Scrapeless Anti-Bot Detector — Python SDK.

Ask a page whether it is protected, from a Playwright script::

    from scrapeless_detector import ScrapelessDetector

    async with ScrapelessDetector.launch("/path/to/scrapeless-extension") as session:
        result = await session.detect("https://example.com/checkout")
        if result.is_antibot:
            print([d.name for d in result.of_category("antibot")])

Python cannot hear the extension directly. The extension talks to the *page*, by
dispatching CustomEvents at `window`, so this SDK drives a real Chrome with the
extension loaded and reads the result back out of the document. That is the only
honest way to reach it from Python — there is no window and no extension in a
bare interpreter.

Two things decide whether you get an answer, and neither announces itself:

  * The page API ships **disabled**. The user must switch on
    *Settings -> Detection -> Page signals*.
  * Chrome must actually have loaded the extension.

Neither is distinguishable from "nothing was detected" by listening, so every
wait is bounded and returns a Result carrying ``available=False`` instead of
hanging. **Check ``available`` before trusting a False.**
"""

from contextlib import asynccontextmanager, contextmanager
from typing import Any, Dict, Optional

from ._bridge import (
    AWAIT_DETECTION,
    INIT_SCRIPT,
    INSTALLED,
    READY,
    SNAPSHOT,
    chromium_extension_args,
)
from ._core import (
    DEFAULT_TIMEOUT_MS,
    EVENTS,
    UNAVAILABLE,
    Detection,
    Result,
    build_result,
    category_key_of,
    unavailable,
)

__all__ = [
    "ScrapelessDetector",
    "SyncScrapelessDetector",
    "Result",
    "Detection",
    "category_key_of",
    "EVENTS",
    "DEFAULT_TIMEOUT_MS",
]

__version__ = "1.0.1"


class _DetectorBase:
    """Shared surface; the async and sync classes differ only in awaiting."""

    def __init__(self, page: Any, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self._page = page
        self._timeout_ms = int(timeout_ms)

    @property
    def page(self) -> Any:
        return self._page

    @staticmethod
    def _result_from(detail: Optional[Dict[str, Any]]) -> Result:
        if detail is None:
            return unavailable(UNAVAILABLE)
        return build_result(True, detail)


class ScrapelessDetector(_DetectorBase):
    """Async Playwright. See :class:`SyncScrapelessDetector` for the sync API."""

    @classmethod
    async def attach(
        cls, page: Any, timeout_ms: int = DEFAULT_TIMEOUT_MS
    ) -> "ScrapelessDetector":
        """Install the listener on ``page``.

        Attach **before** navigating. The listener goes in as an init script so
        it runs at document_start on every subsequent document; it is also
        evaluated against the current document so attaching to an already-loaded
        page still works, at the cost of possibly having missed the detection
        that already fired.
        """
        detector = cls(page, timeout_ms)
        await page.add_init_script(INIT_SCRIPT)
        try:
            await page.evaluate(INIT_SCRIPT)
        except Exception:
            # No document yet (about:blank before any goto) — the init script
            # will cover every real navigation, which is the case that matters.
            pass
        return detector

    @classmethod
    @asynccontextmanager
    async def launch(
        cls,
        extension_path: str,
        user_data_dir: Optional[str] = None,
        headless: bool = False,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        **launch_kwargs: Any,
    ):
        """Launch Chromium with the extension loaded and yield a session.

        Extensions require a **persistent** context, so a ``user_data_dir`` is
        used (a temporary one when not supplied). Classic headless Chrome cannot
        load extensions at all; leave ``headless`` False unless you are on a
        Chrome new-headless build that supports them.
        """
        from tempfile import TemporaryDirectory

        from playwright.async_api import async_playwright

        holder = None
        if user_data_dir is None:
            holder = TemporaryDirectory(prefix="scrapeless-sdk-")
            user_data_dir = holder.name

        args = list(launch_kwargs.pop("args", [])) + chromium_extension_args(extension_path)
        try:
            async with async_playwright() as driver:
                context = await driver.chromium.launch_persistent_context(
                    user_data_dir, headless=headless, args=args, **launch_kwargs
                )
                try:
                    await context.add_init_script(INIT_SCRIPT)
                    yield _AsyncSession(context, timeout_ms)
                finally:
                    await context.close()
        finally:
            if holder is not None:
                holder.cleanup()

    async def detect(self, timeout_ms: Optional[int] = None) -> Result:
        """Wait for the detection result, bounded. Replays if it already fired."""
        budget = self._timeout_ms if timeout_ms is None else int(timeout_ms)
        if not await self._page.evaluate(INSTALLED):
            return unavailable(UNAVAILABLE)
        detail = await self._page.evaluate(AWAIT_DETECTION, budget)
        return self._result_from(detail)

    async def snapshot(self) -> Optional[Result]:
        """The last result already seen, or None. Never waits."""
        if not await self._page.evaluate(INSTALLED):
            return None
        detail = await self._page.evaluate(SNAPSHOT)
        return None if detail is None else build_result(True, detail)

    async def ready(self) -> Dict[str, Any]:
        """What the extension announced about itself, if anything."""
        if not await self._page.evaluate(INSTALLED):
            return {"available": False, "version": None}
        detail = await self._page.evaluate(READY)
        if not detail:
            return {"available": False, "version": None}
        return {"available": True, "version": detail.get("version")}

    async def is_antibot(self, timeout_ms: Optional[int] = None) -> bool:
        return (await self.detect(timeout_ms)).is_antibot

    async def is_captcha(self, timeout_ms: Optional[int] = None) -> bool:
        return (await self.detect(timeout_ms)).is_captcha

    async def is_fingerprinted(self, timeout_ms: Optional[int] = None) -> bool:
        return (await self.detect(timeout_ms)).is_fingerprinted

    async def is_protected(self, timeout_ms: Optional[int] = None) -> bool:
        return (await self.detect(timeout_ms)).is_protected


class _AsyncSession:
    """A launched browser plus the one call most callers want: URL -> Result."""

    def __init__(self, context: Any, timeout_ms: int) -> None:
        self._context = context
        self._timeout_ms = timeout_ms

    @property
    def context(self) -> Any:
        return self._context

    async def detect(self, url: str, timeout_ms: Optional[int] = None, **goto: Any) -> Result:
        page = await self._context.new_page()
        try:
            detector = await ScrapelessDetector.attach(page, self._timeout_ms)
            await page.goto(url, **goto)
            return await detector.detect(timeout_ms)
        finally:
            await page.close()


class SyncScrapelessDetector(_DetectorBase):
    """Sync Playwright. Same semantics as :class:`ScrapelessDetector`."""

    @classmethod
    def attach(
        cls, page: Any, timeout_ms: int = DEFAULT_TIMEOUT_MS
    ) -> "SyncScrapelessDetector":
        detector = cls(page, timeout_ms)
        page.add_init_script(INIT_SCRIPT)
        try:
            page.evaluate(INIT_SCRIPT)
        except Exception:
            pass
        return detector

    @classmethod
    @contextmanager
    def launch(
        cls,
        extension_path: str,
        user_data_dir: Optional[str] = None,
        headless: bool = False,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        **launch_kwargs: Any,
    ):
        from tempfile import TemporaryDirectory

        from playwright.sync_api import sync_playwright

        holder = None
        if user_data_dir is None:
            holder = TemporaryDirectory(prefix="scrapeless-sdk-")
            user_data_dir = holder.name

        args = list(launch_kwargs.pop("args", [])) + chromium_extension_args(extension_path)
        try:
            with sync_playwright() as driver:
                context = driver.chromium.launch_persistent_context(
                    user_data_dir, headless=headless, args=args, **launch_kwargs
                )
                try:
                    context.add_init_script(INIT_SCRIPT)
                    yield _SyncSession(context, timeout_ms)
                finally:
                    context.close()
        finally:
            if holder is not None:
                holder.cleanup()

    def detect(self, timeout_ms: Optional[int] = None) -> Result:
        budget = self._timeout_ms if timeout_ms is None else int(timeout_ms)
        if not self._page.evaluate(INSTALLED):
            return unavailable(UNAVAILABLE)
        return self._result_from(self._page.evaluate(AWAIT_DETECTION, budget))

    def snapshot(self) -> Optional[Result]:
        if not self._page.evaluate(INSTALLED):
            return None
        detail = self._page.evaluate(SNAPSHOT)
        return None if detail is None else build_result(True, detail)

    def ready(self) -> Dict[str, Any]:
        if not self._page.evaluate(INSTALLED):
            return {"available": False, "version": None}
        detail = self._page.evaluate(READY)
        if not detail:
            return {"available": False, "version": None}
        return {"available": True, "version": detail.get("version")}

    def is_antibot(self, timeout_ms: Optional[int] = None) -> bool:
        return self.detect(timeout_ms).is_antibot

    def is_captcha(self, timeout_ms: Optional[int] = None) -> bool:
        return self.detect(timeout_ms).is_captcha

    def is_fingerprinted(self, timeout_ms: Optional[int] = None) -> bool:
        return self.detect(timeout_ms).is_fingerprinted

    def is_protected(self, timeout_ms: Optional[int] = None) -> bool:
        return self.detect(timeout_ms).is_protected


class _SyncSession:
    def __init__(self, context: Any, timeout_ms: int) -> None:
        self._context = context
        self._timeout_ms = timeout_ms

    @property
    def context(self) -> Any:
        return self._context

    def detect(self, url: str, timeout_ms: Optional[int] = None, **goto: Any) -> Result:
        page = self._context.new_page()
        try:
            detector = SyncScrapelessDetector.attach(page, self._timeout_ms)
            page.goto(url, **goto)
            return detector.detect(timeout_ms)
        finally:
            page.close()

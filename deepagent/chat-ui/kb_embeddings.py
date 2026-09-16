"""硅基流动 Embedding 客户端 —— Qwen/Qwen3-Embedding-0.6B。

知识库的「文本 → 向量」环节。只负责调用远程 API，不含任何存储逻辑。

为什么单写一层
--------------
1. **批量**：API 支持数组输入，实测 n=64 时约 16.6 ms/条（n=8 时 78.7 ms/条），
   批量能省一个数量级的往返开销；
2. **base64**：1024 维用 `encoding_format=base64` 返回 4096 字节，
   比 JSON float 数组小一大截，解析也更快；
3. **重试**：免费额度下 429 / 503 是常态，必须退避重试而不是直接失败；
4. **空文本守卫**：实测 API 收到空字符串 **不报错**，而是返回一个无意义的向量。
   这种"静默成功"最危险，必须由客户端拦掉。

模型特性（实测确认）
--------------------
- 输出维度：1024（原生），`dimensions` 支持 64/128/256/512/768/1024 截断
- 向量已做 **L2 归一化**（范数 = 1.000000），因此余弦相似度 == 点积
- 上下文 32768 token，实测约 1.67 字符/token（中文），超长需显式 `truncate`
- 检索场景推荐给 **查询** 加指令前缀：``Instruct: {任务}\\nQuery: {问题}``；
  文档侧不加。实测加与不加的向量余弦相似度约 0.92（指令确实改变了向量）

环境变量（`chat-ui/.env`）
--------------------------
``SILICONFLOW_API_KEY``、``SILICONFLOW_BASE_URL``、
``KB_EMBEDDING_MODEL``、``KB_EMBEDDING_DIM``、``KB_QUERY_INSTRUCTION``
"""

from __future__ import annotations

import base64
import json
import os
import random
import struct
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

DEFAULT_MODEL = "Qwen/Qwen3-Embedding-0.6B"
DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
DEFAULT_DIM = 1024
DEFAULT_BATCH = 64
DEFAULT_TIMEOUT = 60
DEFAULT_MAX_RETRIES = 4

# 查询侧的指令前缀。Qwen3-Embedding 是「非对称检索」模型：
# 查询与文档用不同写法效果更好。文档侧不加前缀。
DEFAULT_QUERY_INSTRUCTION = "给定一个用户问题，检索能够回答该问题的知识库片段"

# 允许的截断维度（服务端白名单，提前拦住无效请求）
ALLOWED_DIMS = (64, 128, 256, 512, 768, 1024)

_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


class EmbeddingError(RuntimeError):
    """Embedding 调用失败（重试耗尽、鉴权失败、参数非法等）。"""

    def __init__(self, message: str, *, status: int | None = None, code: object = None):
        super().__init__(message)
        self.status = status
        self.code = code


def _load_env_file(path: Path | None = None) -> None:
    """与 server.py 相同的 .env 读取方式（不覆盖已有环境变量）。"""
    env_file = path or (Path(__file__).resolve().parent / ".env")
    if not env_file.is_file():
        return
    with open(env_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


@dataclass
class EmbeddingConfig:
    api_key: str = ""
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    dim: int = DEFAULT_DIM
    batch_size: int = DEFAULT_BATCH
    timeout: int = DEFAULT_TIMEOUT
    max_retries: int = DEFAULT_MAX_RETRIES
    query_instruction: str = DEFAULT_QUERY_INSTRUCTION

    @classmethod
    def from_env(cls) -> "EmbeddingConfig":
        _load_env_file()
        dim = int(os.environ.get("KB_EMBEDDING_DIM") or DEFAULT_DIM)
        return cls(
            api_key=os.environ.get("SILICONFLOW_API_KEY", ""),
            base_url=(os.environ.get("SILICONFLOW_BASE_URL") or DEFAULT_BASE_URL).rstrip("/"),
            model=os.environ.get("KB_EMBEDDING_MODEL") or DEFAULT_MODEL,
            dim=dim,
            batch_size=int(os.environ.get("KB_EMBEDDING_BATCH") or DEFAULT_BATCH),
            query_instruction=os.environ.get("KB_QUERY_INSTRUCTION") or DEFAULT_QUERY_INSTRUCTION,
        )

    def validate(self) -> None:
        if not self.api_key:
            raise EmbeddingError(
                "缺少 SILICONFLOW_API_KEY。请在 chat-ui/.env 中配置，"
                "或设置同名环境变量。"
            )
        if self.dim not in ALLOWED_DIMS:
            raise EmbeddingError(
                f"KB_EMBEDDING_DIM={self.dim} 不被支持，可选：{list(ALLOWED_DIMS)}"
            )
        if self.batch_size < 1:
            raise EmbeddingError("KB_EMBEDDING_BATCH 必须 ≥ 1")


@dataclass
class EmbeddingResult:
    vectors: list[list[float]] = field(default_factory=list)
    total_tokens: int = 0
    requests: int = 0

    def __len__(self) -> int:
        return len(self.vectors)


def _decode_one(raw, dim: int) -> list[float]:
    """把单条 embedding 解成 float 列表。支持 base64 与 float 两种返回格式。"""
    if isinstance(raw, str):
        try:
            blob = base64.b64decode(raw)
        except Exception as e:  # pragma: no cover - 正常不会走到
            raise EmbeddingError(f"base64 解码失败：{e}") from e
        if len(blob) != dim * 4:
            raise EmbeddingError(
                f"向量长度不符：解码得到 {len(blob)} 字节，期望 {dim * 4} 字节（dim={dim}）"
            )
        return list(struct.unpack(f"{dim}f", blob))
    if isinstance(raw, (list, tuple)):
        if len(raw) != dim:
            raise EmbeddingError(f"向量维度不符：返回 {len(raw)}，期望 {dim}")
        return [float(x) for x in raw]
    raise EmbeddingError(f"无法识别的 embedding 类型：{type(raw).__name__}")


class EmbeddingClient:
    """Qwen3-Embedding-0.6B 客户端。线程安全（无共享可变状态）。"""

    def __init__(self, config: EmbeddingConfig | None = None):
        self.config = config or EmbeddingConfig.from_env()
        self.config.validate()

    # ---------------- 底层 HTTP ----------------

    def _request(self, texts: list[str], dimensions: int) -> tuple[list[list[float]], int]:
        payload = {
            "model": self.config.model,
            "input": texts,
            "encoding_format": "base64",
            "dimensions": dimensions,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        url = f"{self.config.base_url}/embeddings"

        last_err: Exception | None = None
        for attempt in range(self.config.max_retries + 1):
            req = urllib.request.Request(
                url,
                data=body,
                headers={
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=self.config.timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                items = sorted(data.get("data", []), key=lambda d: d.get("index", 0))
                if len(items) != len(texts):
                    raise EmbeddingError(
                        f"返回条数不符：请求 {len(texts)} 条，返回 {len(items)} 条"
                    )
                vecs = [_decode_one(it["embedding"], dimensions) for it in items]
                tokens = int((data.get("usage") or {}).get("total_tokens") or 0)
                return vecs, tokens

            except urllib.error.HTTPError as e:
                raw = e.read().decode("utf-8", "replace")
                status = e.code
                # 401/403 是鉴权问题，重试无意义，直接抛出
                if status in (401, 403):
                    raise EmbeddingError(
                        f"鉴权失败（HTTP {status}）：{raw[:200]}", status=status
                    ) from e
                if status not in _RETRYABLE_STATUS:
                    raise EmbeddingError(
                        f"请求被拒绝（HTTP {status}）：{raw[:300]}", status=status
                    ) from e
                last_err = EmbeddingError(
                    f"HTTP {status}：{raw[:200]}", status=status
                )
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last_err = EmbeddingError(f"网络错误：{e}")
            except json.JSONDecodeError as e:
                last_err = EmbeddingError(f"响应不是合法 JSON：{e}")

            if attempt < self.config.max_retries:
                # 指数退避 + 抖动，避免多个批次同时重试再次撞上限流
                delay = min(2 ** attempt, 16) * (0.75 + random.random() * 0.5)
                time.sleep(delay)

        raise EmbeddingError(
            f"重试 {self.config.max_retries} 次后仍失败：{last_err}"
        )

    # ---------------- 对外接口 ----------------

    def embed(
        self,
        texts: list[str],
        *,
        dimensions: int | None = None,
        as_query: bool = False,
        instruction: str | None = None,
        on_batch: Callable[[int, int], None] | None = None,
    ) -> EmbeddingResult:
        """批量向量化。空批次直接返回空结果（不发起请求）。

        :param as_query: 为 True 时给每条加查询指令前缀（检索场景用于**查询侧**）
        :param on_batch: 每完成一批回调 ``(已完成条数, 总条数)``。
            供「上传后展示处理进度」使用；不传则完全不产生额外开销。
            注意重试（429 退避）发生在单批内部，回调感知不到，所以进度条
            可能出现"卡住不动"的观感——这是真实的等待，不是前端故障。
        """
        dim = dimensions or self.config.dim
        if dim not in ALLOWED_DIMS:
            raise EmbeddingError(f"dimensions={dim} 不被支持，可选：{list(ALLOWED_DIMS)}")

        cleaned: list[str] = []
        empty_at: list[int] = []
        for i, t in enumerate(texts):
            if not isinstance(t, str):
                raise EmbeddingError(f"第 {i} 项不是字符串：{type(t).__name__}")
            if not t.strip():
                empty_at.append(i)
            cleaned.append(t)
        if empty_at:
            # 实测 API 对空串返回 200 + 垃圾向量，必须在这里拦住
            raise EmbeddingError(
                f"第 {empty_at} 项是空白文本。API 对空文本不报错而是返回无意义向量，"
                "请先过滤空片段。"
            )
        if not cleaned:
            return EmbeddingResult()

        if as_query:
            instr = (instruction if instruction is not None else self.config.query_instruction) or ""
            if instr.strip():
                cleaned = [f"Instruct: {instr.strip()}\nQuery: {t}" for t in cleaned]

        out: list[list[float]] = []
        tokens = 0
        requests_ = 0
        n = self.config.batch_size
        for start in range(0, len(cleaned), n):
            batch = cleaned[start : start + n]
            vecs, tk = self._request(batch, dim)
            out.extend(vecs)
            tokens += tk
            requests_ += 1
            if on_batch is not None:
                try:
                    on_batch(len(out), len(cleaned))
                except Exception:
                    # 进度回调永远不能让入库失败
                    pass

        return EmbeddingResult(vectors=out, total_tokens=tokens, requests=requests_)

    def embed_documents(
        self,
        texts: list[str],
        *,
        on_batch: Callable[[int, int], None] | None = None,
    ) -> EmbeddingResult:
        """文档侧：不加指令前缀。"""
        return self.embed(texts, as_query=False, on_batch=on_batch)

    def embed_query(self, text: str, *, instruction: str | None = None) -> list[float]:
        """查询侧：加指令前缀，返回单条向量。"""
        res = self.embed([text], as_query=True, instruction=instruction)
        return res.vectors[0]


_CLIENT: EmbeddingClient | None = None
_CLIENT_LOCK_SENTINEL = object()


def get_client(force_new: bool = False) -> EmbeddingClient:
    """进程内复用单例（避免每次调用都重读 .env）。"""
    global _CLIENT
    if _CLIENT is None or force_new:
        _CLIENT = EmbeddingClient()
    return _CLIENT


def embed_texts(texts: list[str]) -> EmbeddingResult:
    """便捷函数：文档侧批量向量化。"""
    return get_client().embed_documents(texts)


def embed_one(text: str) -> list[float]:
    """便捷函数：文档侧单条向量化。"""
    return get_client().embed_documents([text]).vectors[0]


def query_vector(text: str, *, instruction: str | None = None) -> list[float]:
    """便捷函数：查询侧向量化（带指令前缀）。"""
    return get_client().embed_query(text, instruction=instruction)


def describe() -> dict:
    """给 /api/context 或自检用的配置快照（不含密钥明文）。"""
    cfg = EmbeddingConfig.from_env()
    return {
        "model": cfg.model,
        "base_url": cfg.base_url,
        "dim": cfg.dim,
        "batch_size": cfg.batch_size,
        "api_key_configured": bool(cfg.api_key),
        "api_key_hint": (cfg.api_key[:6] + "…" + cfg.api_key[-4:]) if cfg.api_key else "",
    }


def _self_check() -> int:
    import sys

    print("配置：")
    for k, v in describe().items():
        print(f"  {k}: {v}")

    print("\n向量化自检：")
    client = get_client()
    docs = ["华宇科技的采购意向是工业物联网网关。", "王小明的订单金额为 128000 元。"]
    r = client.embed_documents(docs)
    print(f"  文档侧：{len(r)} 条，dim={len(r.vectors[0])}，tokens={r.total_tokens}，请求={r.requests}")

    q = client.embed_query("华宇科技想买什么？")
    print(f"  查询侧：dim={len(q)}")

    def cos(a, b):
        return sum(x * y for x, y in zip(a, b))

    sims = [cos(q, v) for v in r.vectors]
    print(f"  余弦相似度：{['%.4f' % s for s in sims]}")
    ok = 0 if sims[0] > sims[1] else 1
    print(f"\n  [{'PASS' if ok == 0 else 'FAIL'}] 相关文档排在前面")

    try:
        client.embed_documents(["正常", "   "])
        print("  [FAIL] 空文本未被拦截")
        ok = 1
    except EmbeddingError:
        print("  [PASS] 空文本被拦截")

    try:
        client.embed(["x"], dimensions=777)
        print("  [FAIL] 非法维度未被拦截")
        ok = 1
    except EmbeddingError:
        print("  [PASS] 非法维度被拦截")

    return ok


if __name__ == "__main__":
    import sys

    sys.exit(_self_check())

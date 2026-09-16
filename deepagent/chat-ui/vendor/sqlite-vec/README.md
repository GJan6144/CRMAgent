# vendor/sqlite-vec

本地部署的 **sqlite-vec**（vec0）可加载扩展。Agent 的知识库向量检索能力依赖它。

## 这是什么

`sqlite-vec` 是一个纯 C 编写的 SQLite 扩展，提供 `vec0` 虚拟表：

- 支持 `float32` / `int8` / `bit` 三种向量类型
- 支持元数据列、辅助列（`+col`）、分区键
- KNN 查询：`where embedding match ? order by distance limit k`
- 距离函数：`vec_distance_l2` / `vec_distance_cosine` / `vec_distance_l1`

元数据列可进 KNN 的 `WHERE`（用于按 `doc_id` 之类收窄范围）；辅助列 `+col` 虽然
不建索引，但**能随结果集直接取回**（免 JOIN，这正是它的意义），代价是
**不能用于 KNN 的 `WHERE`**。

它只做"向量的存与查"，**不负责把文本转成向量**——那部分由 Embedding 模型完成，
调用方拿到向量后传进来。

## 版本与来源

| 项目 | 值 |
|---|---|
| vec0 版本 | `v0.1.10-alpha.4` |
| 扩展文件 | `vec0.dll`（Windows x86_64，307,712 bytes） |
| SHA-256 | `5abd97cbc11858322b020eb0d9b6c1027d7b6fe3541eaa2a97b6cfe66549ab9c` |
| 下载地址 | `https://github.com/asg017/sqlite-vec/releases/download/v0.1.10-alpha.4/sqlite-vec-0.1.10-alpha.4-loadable-windows-x86_64.tar.gz` |
| 上游仓库 | https://github.com/asg017/sqlite-vec |
| 本地源码 | `C:\Users\Administrator\Documents\deepagent\sqlite-vec`（git clone，HEAD = `v0.1.10-alpha.4`） |

选 `v0.1.10-alpha.4` 是为了与本地 clone 的仓库 HEAD 版本号完全对齐。本机没有
C 编译器（无 MSVC / gcc），所以用的是官方预编译产物，而非从源码构建。

## 更新方式

```bash
# 1. 更新源码仓库
cd C:/Users/Administrator/Documents/deepagent/sqlite-vec && git fetch --tags && git checkout <新 tag>

# 2. 下载同版本的 Windows 预编译包（tag 里的 . 在文件名中变成 -）
curl -L -o dist/vec0.tar.gz \
  "https://github.com/asg017/sqlite-vec/releases/download/<tag>/sqlite-vec-<tag>-loadable-windows-x86_64.tar.gz"
tar -xzf dist/vec0.tar.gz -C dist/

# 3. 同步到项目并回归
cp dist/vec0.dll C:/Users/Administrator/Documents/deepagent/deepagents/chat-ui/vendor/sqlite-vec/vec0.dll
python ../vec_extension.py                 # 加载器自检
python ../../../../sqlite-vec/dist/smoke_test.py   # 扩展能力冒烟测试
```

## 加载方式

统一走 `chat-ui/vec_extension.py`，不要在各处手写 `load_extension`：

```python
from vec_extension import connect, serialize_f32

with connect("kb/vectors.db") as db:
    db.execute("create virtual table if not exists chunks using vec0(embedding float[1024])")
```

扩展文件的解析优先级、以及为什么加载后会关闭 `enable_load_extension`，
见 `chat-ui/vec_extension.py` 的模块 docstring。

## 两个容易踩的坑

1. **`int8` / `bit` 向量必须显式标注类型**。直接传裸 BLOB，vec0 会一律按 `float32`
   解释，报 `expected to be of type int8, but a float32 vector was provided`。
   写入与查询都要用 `vec_int8(?)` / `vec_bit(?)` 包一层。
2. **`bit[N]` 的 N 是位数不是字节数**。`bit[8]` 对应 1 字节，
   传 8 字节的 BLOB 会报长度错误。

"""验证 langchain-mcp-adapters 能加载 bing-cn-mcp 并调用工具。

两种命令形态都测一遍，确认 Windows 下哪种能跑通：
  A) node 绝对路径 + build/index.js（推荐，绕过 npx 与 .cmd）
  B) cmd /c npx -y bing-cn-mcp（用户给的 npx 配置的 Windows 适配）
"""
import asyncio
import sys

NODE = r"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
ENTRY = r"C:\Users\Administrator\Documents\deepagent\deepagents\chat-ui\mcp_servers\node_modules\bing-cn-mcp\build\index.js"


async def try_config(label: str, cfg: dict) -> list:
    from langchain_mcp_adapters.client import MultiServerMCPClient
    print(f"\n===== 配置: {label} =====")
    print("  连接配置:", cfg)
    try:
        client = MultiServerMCPClient({"bing-search": cfg})
        tools = await client.get_tools()
        print(f"  ✓ 加载到 {len(tools)} 个工具:")
        for t in tools:
            print(f"    - {t.name}: {t.description[:80] if t.description else '(无描述)'}")
        return tools
    except Exception as e:
        print(f"  ✗ 加载失败: {type(e).__name__}: {e}")
        return []


async def call_search(tool) -> None:
    print("\n===== 实际调用 bing_search('无锡天气') =====")
    try:
        # 工具可能是同步或异步的，统一用 ainvoke 尝试
        if hasattr(tool, "ainvoke"):
            res = await tool.ainvoke({"query": "无锡天气"})
        else:
            res = tool.invoke({"query": "无锡天气"})
        print("  结果类型:", type(res).__name__)
        txt = str(res)
        print("  前 600 字:\n", txt[:600])
    except Exception as e:
        print(f"  ✗ 调用失败: {type(e).__name__}: {e}")


async def main():
    # A) node 绝对路径
    tools_a = await try_config("A node 绝对路径", {
        "command": NODE,
        "args": [ENTRY],
        "transport": "stdio",
    })
    # B) cmd /c npx
    await try_config("B cmd /c npx", {
        "command": "cmd",
        "args": ["/c", "npx", "-y", "bing-cn-mcp"],
        "transport": "stdio",
    })

    if tools_a:
        # 找 bing_search 工具
        search = next((t for t in tools_a if t.name == "bing_search"), tools_a[0])
        await call_search(search)
    else:
        print("\n（A 方案失败，跳过调用测试）")


if __name__ == "__main__":
    asyncio.run(main())

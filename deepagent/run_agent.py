"""
Deep Agents 编码助手 - Python SDK 版本
无需 dcode TUI，直接通过 Python 调用 SDK

环境变量:
  OPENAI_API_KEY  - DeepSeek API Key
  OPENAI_BASE_URL - DeepSeek API 地址 (默认: https://api.deepseek.com/v1)

使用方法:
  python run_agent.py "你的问题或任务描述"

示例:
  python run_agent.py "阅读当前目录下的 README.md 并总结"
  python run_agent.py (不带参数进入交互模式)
"""

import os
import sys

# 检查环境变量
if not os.environ.get("OPENAI_API_KEY"):
    print("[ERROR] 请先设置 OPENAI_API_KEY 环境变量")
    print("  set OPENAI_API_KEY=你的deepseek_api_key")
    sys.exit(1)
if not os.environ.get("OPENAI_BASE_URL"):
    os.environ["OPENAI_BASE_URL"] = "https://api.deepseek.com/v1"

from deepagents import (
    create_deep_agent,
    register_provider_profile,
    ProviderProfile,
)

# 注册 DeepSeek 提供商（关闭 Responses API）
register_provider_profile(
    "openai",
    ProviderProfile(
        init_kwargs={
            "base_url": os.environ["OPENAI_BASE_URL"],
            "use_responses_api": False,
        }
    ),
)


def run(prompt: str):
    agent = create_deep_agent(
        model="openai:deepseek-v4-flash",
        system_prompt="你是一个专业的编码助手，请简洁清晰地回答。",
    )
    print(f"\n>>> {prompt}\n")
    result = agent.invoke({"messages": prompt})
    for msg in result["messages"]:
        if hasattr(msg, "content") and msg.content:
            role = "AI" if msg.type == "ai" else msg.type
            print(f"[{role}] {msg.content[:2000]}")
            if len(msg.content) > 2000:
                print("... (内容已截断)")
            print()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run(" ".join(sys.argv[1:]))
    else:
        print("=" * 50)
        print("  Deep Agents Coding Assistant (DeepSeek)")
        print("  Type 'exit' or 'quit' to quit")
        print("=" * 50)
        while True:
            try:
                prompt = input("\n>>> ")
                if prompt.lower() in ("exit", "quit"):
                    break
                if prompt.strip():
                    run(prompt)
            except (EOFError, KeyboardInterrupt):
                break
        print("\nBye!")

"""
Deep Agents SDK 演示脚本 - 展示如何使用 DeepSeek 模型

使用方法:
  1. 设置环境变量 DEEPSEEK_API_KEY
  2. 运行: python run_demo.py

或创建 .env 文件并写入:
  DEEPSEEK_API_KEY=your_key_here

然后运行此脚本。
"""

import os
from pathlib import Path

# 加载 .env 文件（如果有）
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text().strip().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")

if not DEEPSEEK_API_KEY:
    print("⚠️  未设置 DEEPSEEK_API_KEY 环境变量")
    print("   创建 .env 文件并写入: DEEPSEEK_API_KEY=your_key_here")
    print("   或运行: set DEEPSEEK_API_KEY=your_key_here")
    exit(1)


def demo_using_dcode():
    """
    方案一：使用 dcode 命令行（推荐）
    
    run_dcode.bat -M "openai:deepseek-chat" -y -n "你好，请介绍一下自己"
    
    参数说明:
      -M: 指定模型 (openai: 开头表示 OpenAI 兼容 API)
      -y: 自动批准工具调用
      -n: 非交互模式，执行单个任务
    """
    print("=" * 60)
    print("📌 使用 dcode 命令行方式:")
    print("=" * 60)
    print("""
    run_dcode.bat -M "openai:deepseek-chat" -y
    
    需要先设置环境变量 (Windows PowerShell):
    $env:OPENAI_API_KEY = "你的deepseek_api_key"
    $env:OPENAI_BASE_URL = "https://api.deepseek.com"
    """)


def demo_using_sdk():
    """
    方案二：使用 Python SDK 直接调用
    """
    from deepagents import (
        create_deep_agent,
        register_provider_profile,
        ProviderProfile,
    )

    # 注册 DeepSeek 作为 OpenAI 兼容提供商
    register_provider_profile(
        "openai",
        ProviderProfile(init_kwargs={
            "base_url": "https://api.deepseek.com",
            "api_key": DEEPSEEK_API_KEY,
        }),
    )

    print("\n" + "=" * 60)
    print("📌 使用 Python SDK 方式:")
    print("=" * 60)
    print(f"模型: openai:deepseek-chat")
    print(f"API Key: {DEEPSEEK_API_KEY[:8]}...")
    print()

    # 创建 Deep Agent 实例
    agent = create_deep_agent(
        model="openai:deepseek-chat",
        system_prompt="你是一个有用的 AI 助手。",
    )

    # 执行一次对话
    result = agent.invoke({"messages": "你好！请用中文简单介绍一下 Deep Agents 是什么。"})
    
    for msg in result["messages"]:
        if hasattr(msg, "content") and msg.content:
            print(f"\n[{msg.type}]: {msg.content}")


if __name__ == "__main__":
    print("=" * 60)
    print("  Deep Agents 本地部署 - 演示脚本")
    print("=" * 60)
    print(f"  Python: 3.13")
    print(f"  SDK版本: deepagents 0.6.12")
    print(f"  dcode:   deepagents-code 0.1.41")
    print("=" * 60)

    demo_using_dcode()
    
    # 提示用户后续操作
    print("\n" + "=" * 60)
    print("✅ 部署完成! 后续步骤:")
    print("=" * 60)
    print("""
    1️⃣  配置 DeepSeek API Key (PowerShell):
        $env:OPENAI_API_KEY = "你的deepseek_api_key"
        $env:OPENAI_BASE_URL = "https://api.deepseek.com"
    
    2️⃣  启动交互式编码助手:
        run_dcode.bat -M "openai:deepseek-chat"
    
    3️⃣  或运行一次性任务:
        run_dcode.bat -M "openai:deepseek-chat" -n "阅读当前目录的 README"
    
    4️⃣  设置默认模型（保存到配置）:
        run_dcode.bat --default-model "openai:deepseek-chat"
    """)

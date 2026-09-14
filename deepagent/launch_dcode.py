"""
Deep Agents Code launcher with DeepSeek v4 Flash.
Registers the DeepSeek provider profile, then starts dcode.
"""
import os
import sys

if "OPENAI_API_KEY" not in os.environ:
    print("[ERROR] 请先设置 OPENAI_API_KEY 环境变量")
    print("  set OPENAI_API_KEY=你的deepseek_api_key")
    sys.exit(1)
os.environ.setdefault("OPENAI_BASE_URL", "https://api.deepseek.com/v1")

# Register DeepSeek provider profile before dcode starts
from deepagents import register_provider_profile, ProviderProfile

register_provider_profile(
    "openai",
    ProviderProfile(
        init_kwargs={
            "base_url": "https://api.deepseek.com/v1",
            "use_responses_api": False,  # DeepSeek uses Chat Completions, not Responses API
        }
    ),
)

# Now launch dcode with the CLI args
# Override sys.argv[0] to dcode so argparse works correctly
script_args = sys.argv[1:]  # any extra args after launch_dcode.py

# If no custom model specified, default to deepseek-v4-flash
has_model = any(a.startswith("-M") or a.startswith("--model") for a in script_args)
if not has_model:
    sys.argv = ["dcode", "-M", "openai:deepseek-v4-flash"] + script_args
else:
    sys.argv = ["dcode"] + script_args

from deepagents_code import cli_main
cli_main()

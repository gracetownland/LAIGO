# bedrock_client shared Lambda layer
# Provides common utilities for Bedrock-invoking Lambda functions

from bedrock_client.sanitizer import sanitize_prompt_input

__all__ = ["sanitize_prompt_input"]

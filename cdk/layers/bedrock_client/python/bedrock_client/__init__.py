# bedrock_client shared Lambda layer
# Provides common utilities for Bedrock-invoking Lambda functions

import boto3
from botocore.config import Config

from bedrock_client.sanitizer import sanitize_prompt_input

# Adaptive retry configuration for Bedrock API calls.
# Handles throttling (ThrottlingException, TooManyRequestsException) and
# transient errors with exponential backoff.
_BEDROCK_RETRY_CONFIG = Config(
    retries={
        "mode": "adaptive",  # Adaptive retry with token bucket for throttling
        "max_attempts": 5,   # Up to 5 attempts (1 initial + 4 retries)
    },
    read_timeout=120,        # 2 min read timeout for streaming responses
    connect_timeout=10,      # 10 sec connection timeout
)


def get_bedrock_runtime_client(region_name=None):
    """
    Create a Bedrock Runtime client with adaptive retry configuration.

    Uses adaptive retry mode which:
    - Automatically retries on throttling and transient errors
    - Uses exponential backoff with jitter
    - Maintains a token bucket to avoid overwhelming the service

    Args:
        region_name: AWS region. If None, uses the SDK default (Lambda env or config).

    Returns:
        boto3 Bedrock Runtime client with retry configuration.
    """
    kwargs = {"config": _BEDROCK_RETRY_CONFIG}
    if region_name:
        kwargs["region_name"] = region_name
    return boto3.client("bedrock-runtime", **kwargs)


__all__ = ["sanitize_prompt_input", "get_bedrock_runtime_client"]

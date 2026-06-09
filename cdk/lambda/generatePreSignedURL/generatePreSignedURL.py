import os, json
import boto3
from botocore.config import Config
from aws_lambda_powertools import Logger

BUCKET = os.environ["BUCKET"]
REGION = os.environ["REGION"]

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)
logger = Logger()

def s3_key_exists(bucket, key):
    try:
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False


def get_cors_origin(event):
    allowed_origin = os.environ.get("ALLOWED_ORIGIN", "")
    if not allowed_origin:
        return "*"
    return allowed_origin


def create_response(status_code, body, event=None):
    origin = get_cors_origin(event or {})
    serialized_body = body if isinstance(body, str) else json.dumps(body)
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "*",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none';",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        },
        "body": serialized_body,
    }


@logger.inject_lambda_context(log_event=False)
def lambda_handler(event, context):
    # Use .get() to safely extract query string parameters
    query_params = event.get("queryStringParameters", {})

    if not query_params:
        return create_response(400, "Missing queries to generate pre-signed URL", event)

    audio_file_id = query_params.get("audio_file_id", "")
    file_type = query_params.get("file_type", "").lower()
    file_name = query_params.get("file_name", "")

    if not audio_file_id:
        return create_response(400, "Missing required parameter: audio_file_id", event)

    if not file_name:
        return create_response(400, "Missing required parameter: file_name", event)

    # Allowed audio file types for Amazon Transcribe with their corresponding MIME types
    allowed_audio_types = {
        "mp3": "audio/mpeg",
        "mp4": "audio/mp4",
        "wav": "audio/wav",
        "flac": "audio/flac",
        "amr": "audio/amr",
        "ogg": "audio/ogg",
        "webm": "audio/webm",
        "m4a": "audio/m4a"
    }

    if file_type not in allowed_audio_types:
        return create_response(
            400,
            f'Unsupported audio file type. Allowed types: {", ".join(allowed_audio_types.keys())}',
            event,
        )

    # Modified key path to remove the "audio" subdirectory
    key = f"{audio_file_id}/{file_name}.{file_type}"
    content_type = allowed_audio_types[file_type]

    try:
        presigned_url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": BUCKET,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=120,
            HttpMethod="PUT",
        )

        return create_response(200, {"presignedurl": presigned_url}, event)

    except Exception as e:
        logger.error(f"Error generating presigned URL: {e}")
        return create_response(500, "Internal server error", event)
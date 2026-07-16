import os, json
import boto3
import psycopg
from botocore.config import Config
from aws_lambda_powertools import Logger

BUCKET = os.environ["BUCKET"]
REGION = os.environ["REGION"]
DB_SECRET_NAME = os.environ.get("SM_DB_CREDENTIALS")
RDS_PROXY_ENDPOINT = os.environ.get("RDS_PROXY_ENDPOINT")

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"
    ),
)
secrets_manager_client = boto3.client("secretsmanager")
logger = Logger()

# Cached database connection and secret
connection = None
db_secret = None


def get_secret(secret_name):
    """Retrieve and cache database credentials from AWS Secrets Manager."""
    global db_secret
    if db_secret is None:
        try:
            raw = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
            db_secret = json.loads(raw)
        except Exception as e:
            logger.error(f"Error fetching DB secret: {e}")
            raise
    return db_secret


def connect_to_db():
    """Establish (or reuse) a connection to the RDS database via the Proxy."""
    global connection
    if connection is None or connection.closed:
        secret = get_secret(DB_SECRET_NAME)
        params = {
            "dbname": secret["dbname"],
            "user": secret["username"],
            "password": secret["password"],
            "host": RDS_PROXY_ENDPOINT,
            "port": secret["port"],
        }
        conn_str = " ".join(f"{k}={v}" for k, v in params.items())
        try:
            connection = psycopg.connect(conn_str)
            logger.info("Connected to the database.")
        except Exception as e:
            logger.error(f"Database connection failed: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection


def check_audio_file_ownership(audio_file_id, user_id):
    """
    Verify the authenticated user owns the case associated with the audio file.
    Returns True if authorized, False otherwise.
    """
    try:
        conn = connect_to_db()
        cur = conn.cursor()
        cur.execute(
            'SELECT 1 FROM audio_files af JOIN cases c ON af.case_id = c.case_id WHERE af.audio_file_id = %s AND c.student_id = %s',
            (audio_file_id, user_id),
        )
        result = cur.fetchone()
        cur.close()
        return result is not None
    except Exception as e:
        logger.error(f"Ownership check failed: {e}")
        if connection:
            connection.rollback()
        return False

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

    # Ownership verification: ensure the authenticated user owns the audio file's case
    user_id = event.get("requestContext", {}).get("authorizer", {}).get("principalId")
    if not user_id:
        return create_response(403, {"error": "Forbidden: unable to identify user"}, event)

    if not check_audio_file_ownership(audio_file_id, user_id):
        return create_response(403, {"error": "Forbidden: you do not have access to this resource"}, event)

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
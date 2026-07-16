"""
Shared authorization utilities for Python Lambda functions.

Provides reusable ownership verification functions that mirror the
JavaScript `authorizeCaseAccess()` / `authorizeObjectAccess()` patterns
in cdk/lambda/handlers/utils/authorization.js.
"""

import logging

_logger = logging.getLogger(__name__)


def verify_case_ownership(user_id, case_id, connection):
    """
    Verify that a user owns a case OR is an instructor for the case owner.

    Args:
        user_id (str): Database user ID of the authenticated user.
        case_id (str): UUID of the case to check.
        connection: psycopg database connection object.

    Returns:
        dict: Result with keys:
            - authorized (bool): Whether access is granted.
            - code (str): "OK", "NOT_FOUND", or "FORBIDDEN".
            - reason (str): Human-readable explanation.
    """
    if not user_id:
        return {"authorized": False, "code": "FORBIDDEN", "reason": "Missing user identity"}

    if not case_id:
        return {"authorized": False, "code": "NOT_FOUND", "reason": "Missing case identifier"}

    try:
        with connection.cursor() as cur:
            cur.execute(
                """
                SELECT 1 FROM cases c
                WHERE c.case_id = %s
                AND (
                    c.student_id = %s
                    OR EXISTS (
                        SELECT 1 FROM instructor_students
                        WHERE instructor_id = %s AND student_id = c.student_id
                    )
                );
                """,
                (case_id, user_id, user_id),
            )
            result = cur.fetchone()

        if result is not None:
            return {"authorized": True, "code": "OK", "reason": "Access granted"}

        # Distinguish between not found and forbidden
        with connection.cursor() as cur:
            cur.execute("SELECT 1 FROM cases WHERE case_id = %s;", (case_id,))
            exists = cur.fetchone()

        if exists is None:
            return {"authorized": False, "code": "NOT_FOUND", "reason": "Case not found"}

        return {"authorized": False, "code": "FORBIDDEN", "reason": "You do not have access to this case"}

    except Exception as e:
        _logger.error("Authorization check failed: %s", e)
        # Fail closed on error
        return {"authorized": False, "code": "FORBIDDEN", "reason": "Authorization check failed"}


def verify_audio_file_ownership(user_id, audio_file_id, connection):
    """
    Verify that a user owns the case associated with an audio file.

    Args:
        user_id (str): Database user ID of the authenticated user.
        audio_file_id (str): UUID of the audio file to check.
        connection: psycopg database connection object.

    Returns:
        dict: Result with keys:
            - authorized (bool): Whether access is granted.
            - code (str): "OK", "NOT_FOUND", or "FORBIDDEN".
            - reason (str): Human-readable explanation.
    """
    if not user_id:
        return {"authorized": False, "code": "FORBIDDEN", "reason": "Missing user identity"}

    if not audio_file_id:
        return {"authorized": False, "code": "NOT_FOUND", "reason": "Missing audio file identifier"}

    try:
        with connection.cursor() as cur:
            cur.execute(
                """
                SELECT 1 FROM audio_files af
                JOIN cases c ON af.case_id = c.case_id
                WHERE af.audio_file_id = %s AND c.student_id = %s;
                """,
                (audio_file_id, user_id),
            )
            result = cur.fetchone()

        if result is not None:
            return {"authorized": True, "code": "OK", "reason": "Access granted"}

        # Distinguish not found vs forbidden
        with connection.cursor() as cur:
            cur.execute("SELECT 1 FROM audio_files WHERE audio_file_id = %s;", (audio_file_id,))
            exists = cur.fetchone()

        if exists is None:
            return {"authorized": False, "code": "NOT_FOUND", "reason": "Audio file not found"}

        return {"authorized": False, "code": "FORBIDDEN", "reason": "You do not have access to this resource"}

    except Exception as e:
        _logger.error("Audio file ownership check failed: %s", e)
        # Fail closed on error
        return {"authorized": False, "code": "FORBIDDEN", "reason": "Authorization check failed"}

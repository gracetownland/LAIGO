
import logging

logger = logging.getLogger()


def check_and_increment_usage(connection, user_id):
    """
    Atomically checks and increments the daily message usage for a user.
    Uses UPDATE ... RETURNING to prevent race conditions (TOCTOU).

    The single atomic SQL statement handles:
    - Resetting counter to 1 when last_activity is NULL (first-ever usage)
      or when last_activity date differs from current UTC date (new day)
    - Incrementing counter by 1 when last_activity date matches current UTC date

    Returns the new usage count for today.
    Raises ValueError if the database connection is None or user is not found.
    """
    if connection is None:
        logger.error("Database connection is None")
        raise ValueError("Database connection failed")

    cur = connection.cursor()
    try:
        cur.execute("""
            UPDATE "users"
            SET activity_counter = CASE
                WHEN last_activity IS NULL
                     OR last_activity::date != CURRENT_DATE
                THEN 1
                ELSE activity_counter + 1
            END,
            last_activity = NOW() AT TIME ZONE 'UTC'
            WHERE user_id = %s
            RETURNING activity_counter
        """, (user_id,))

        result = cur.fetchone()

        if not result:
            raise ValueError(f"User not found: {user_id}")

        connection.commit()
        new_count = result[0]
        logger.info(f"Updated usage for user {user_id}: {new_count}")
        return new_count
    except Exception:
        connection.rollback()
        raise
    finally:
        cur.close()

import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.services.cron.repository import SQLiteCronRepository


class CronRepositorySchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "cron.sqlite3"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _meta_sql(self) -> str:
        connection = sqlite3.connect(self.path)
        try:
            row = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name = 'cron_meta'"
            ).fetchone()
            return str(row[0]) if row else ""
        finally:
            connection.close()

    def test_fresh_database_uses_singleton_schema(self):
        repository = SQLiteCronRepository(self.path)
        self.assertEqual(repository.revision(), 0)
        self.assertIn("singleton", self._meta_sql())

    def test_legacy_key_value_meta_is_migrated_with_revision(self):
        connection = sqlite3.connect(self.path)
        try:
            connection.execute(
                "CREATE TABLE cron_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO cron_meta VALUES ('revision', '17')")
            connection.commit()
        finally:
            connection.close()

        repository = SQLiteCronRepository(self.path)
        self.assertEqual(repository.revision(), 17)
        self.assertIn("singleton", self._meta_sql())

        # Reopening must keep the migrated revision without re-running jobs.
        self.assertEqual(SQLiteCronRepository(self.path).revision(), 17)

    def test_legacy_meta_without_revision_starts_at_zero(self):
        connection = sqlite3.connect(self.path)
        try:
            connection.execute(
                "CREATE TABLE cron_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO cron_meta VALUES ('other', 'ignored')")
            connection.commit()
        finally:
            connection.close()

        self.assertEqual(SQLiteCronRepository(self.path).revision(), 0)


if __name__ == "__main__":
    unittest.main()

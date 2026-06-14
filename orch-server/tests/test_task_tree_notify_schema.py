"""Task Tree DB notification schema guard."""

from pathlib import Path


def test_task_tree_schema_notifies_on_item_and_operation_changes():
    schema = (
        Path(__file__).resolve().parents[2]
        / "packages"
        / "db-schema"
        / "sql"
        / "schema.sql"
    ).read_text(encoding="utf-8")

    assert "pg_notify('task_tree_changed'" in schema
    assert "trg_task_items_notify" in schema
    assert "trg_task_operations_notify" in schema

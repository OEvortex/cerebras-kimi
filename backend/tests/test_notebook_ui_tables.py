"""Compiled notebook tables must open in the BlockNote editor.

BlockNote rejects a table whose content is not tagged ``type: tableContent``
or whose cells are not plain inline-content arrays. Both mistakes surfaced to
learners as "Error creating document from blocks passed as `initialContent`".
"""

from __future__ import annotations

from app.agent.notebook_agent.document import compile_body

DOCUMENT = """# Water Cycle

| Stage | Output |
| ----- | ------ |
| Light | ATP |
| Dark | Sugar |
"""


def test_pipe_table_compiles_to_blocknote_table_content():
    warnings: list[str] = []
    blocks = compile_body(DOCUMENT, warnings)

    assert not warnings
    table = next(block for block in blocks if block["type"] == "table")
    content = table["content"]
    assert content["type"] == "tableContent"
    assert len(content["rows"]) == 3
    for row in content["rows"]:
        for cell in row["cells"]:
            assert isinstance(cell, list)
            assert all(isinstance(item, dict) for item in cell)

"""CI smoke test: verify that a folder and session row exist in the SQLite DB."""

import argparse
import sqlite3
import sys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, help="Path to soulstream.db")
    parser.add_argument("--folder-id", required=True)
    parser.add_argument("--session-id", required=True)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    cur = conn.cursor()

    cur.execute("SELECT id, name FROM folders WHERE id=?", (args.folder_id,))
    frow = cur.fetchone()
    if not frow:
        print(f"FAIL: folder '{args.folder_id}' not found in DB", file=sys.stderr)
        sys.exit(1)
    print(f"  folder  OK : id={frow[0]}  name={frow[1]}")

    cur.execute(
        "SELECT session_id, status, folder_id FROM sessions WHERE session_id=?",
        (args.session_id,),
    )
    srow = cur.fetchone()
    if not srow:
        print(f"FAIL: session '{args.session_id}' not found in DB", file=sys.stderr)
        sys.exit(1)
    print(f"  session OK : id={srow[0]}  status={srow[1]}  folder_id={srow[2]}")

    conn.close()
    print("SQLite verification passed")


if __name__ == "__main__":
    main()

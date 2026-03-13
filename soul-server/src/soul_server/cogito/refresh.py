"""Manual brief refresh CLI.

Usage::

    python -m soul_server.cogito.refresh --manifest <path> --output <dir>

Both arguments fall back to environment variables when omitted:

- ``--manifest`` → ``COGITO_MANIFEST_PATH``
- ``--output``   → ``{WORKSPACE_DIR}/.claude/rules/cogito/``
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from soul_server.cogito.brief_composer import BriefComposer


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Refresh cogito service brief",
    )
    parser.add_argument(
        "--manifest",
        default=os.getenv("COGITO_MANIFEST_PATH"),
        help="Path to cogito-manifest.yaml (default: $COGITO_MANIFEST_PATH)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Output directory for brief.yaml (default: $WORKSPACE_DIR/.claude/rules/cogito/)",
    )
    args = parser.parse_args()

    if not args.manifest:
        print(
            "Error: --manifest is required or set COGITO_MANIFEST_PATH",
            file=sys.stderr,
        )
        sys.exit(1)

    output_dir = args.output
    if not output_dir:
        workspace_dir = os.getenv("WORKSPACE_DIR")
        if not workspace_dir:
            print(
                "Error: --output is required or set WORKSPACE_DIR",
                file=sys.stderr,
            )
            sys.exit(1)
        output_dir = os.path.join(workspace_dir, ".claude", "rules", "cogito")

    composer = BriefComposer(manifest_path=args.manifest, output_dir=output_dir)
    path = asyncio.run(composer.write_brief())
    print(f"Brief written to: {path}")


if __name__ == "__main__":
    main()

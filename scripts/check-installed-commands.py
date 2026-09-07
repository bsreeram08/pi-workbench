#!/usr/bin/env python3
"""Verify that Pi discovers this installed Workbench through its user profile."""
import argparse
import json
import os
import pathlib
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", required=True)
    parser.add_argument("--agent-dir", required=True)
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    env = {key: os.environ[key] for key in ("HOME", "PATH", "TMPDIR") if key in os.environ}
    env.update(PI_CODING_AGENT_DIR=args.agent_dir, PI_OFFLINE="1", NO_COLOR="1")
    with tempfile.TemporaryDirectory(prefix="workbench-discovery-") as cwd:
        try:
            result = subprocess.run(
                [args.pi, "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates"],
                input=json.dumps({"type": "get_commands", "id": "installed-commands"}) + "\n",
                text=True, capture_output=True, cwd=cwd, env=env, timeout=45,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SystemExit(f"error: installed Pi discovery could not finish: {error}") from error
    responses = []
    for line in result.stdout.splitlines():
        try:
            responses.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    response = next((item for item in responses if isinstance(item, dict)
                     and item.get("id") == "installed-commands" and item.get("command") == "get_commands"), {})
    if result.returncode or not response.get("success"):
        raise SystemExit("error: installed Pi command discovery failed; inspect Pi startup errors for this agent directory")
    expected = pathlib.Path(args.root, "index.ts").resolve()
    commands = response.get("data", {}).get("commands", [])
    required = {"enhance", "improveprompt", "reprompt", "prompt-use", "plan", "start-work"}
    found = set()
    for command in commands:
        source = command.get("sourceInfo", {}).get("path")
        if command.get("source") == "extension" and isinstance(source, str) and pathlib.Path(source).resolve() == expected:
            found.add(command.get("name"))
    missing = sorted(required - found)
    if missing:
        raise SystemExit(f"error: Pi did not discover this Workbench's commands: {', '.join(missing)}. Check disabled extensions and PI_CODING_AGENT_DIR; installer links will be rolled back.")
    print("Native user-profile command discovery passed.")


if __name__ == "__main__":
    main()

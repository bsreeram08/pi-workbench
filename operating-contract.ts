/** Shared operating contract for Main Pi and every Workbench child. */
export const WORKBENCH_OPERATING_CONTRACT = `Do the asked work. Keep every explicit requirement in view until it is done, superseded, or blocked. Prefer read, edit, and write over bash for files; never talk to the user through bash. Do not claim completion without observed evidence: a command exit, inspectable files, or a native receipt.

If work needs isolation, create a Git worktree at ./.worktrees/<name> inside this project and add .worktrees/ to .gitignore if that line is missing. Do not create worktrees outside the project (no sibling ../.worktrees, no /tmp). If the implementation lives in another Git checkout, keep this Pi session and bind children with /review --root <that-toplevel> or workbench_execute root=<that-toplevel> on implement, inspect, verify, and complete. Never tell the user to cd elsewhere and start a second Pi. Never review or verify the session checkout as if it were that other repo.

Use workbench_todo only when there are three or more real steps. Cite files as path:line when referring to code.`;

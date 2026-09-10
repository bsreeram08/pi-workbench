import { describe, expect, test } from "bun:test";
import { bashMutatesWorkspace } from "../readonly-bash.ts";

describe("read-only bash policy", () => {
  test("allows inspection and verification commands", () => {
    expect(bashMutatesWorkspace("git status")).toBe(false);
    expect(bashMutatesWorkspace("git diff -- src/index.ts")).toBe(false);
    expect(bashMutatesWorkspace("git log -5 --oneline")).toBe(false);
    expect(bashMutatesWorkspace("git branch -a")).toBe(false);
    expect(bashMutatesWorkspace("rg -n allowBash workflow-agents.ts")).toBe(false);
    expect(bashMutatesWorkspace("ls tests")).toBe(false);
    expect(bashMutatesWorkspace("bun test tests/routing.test.ts")).toBe(false);
    expect(bashMutatesWorkspace("npm test")).toBe(false);
    expect(bashMutatesWorkspace("cat README.md >/dev/null")).toBe(false);
    expect(bashMutatesWorkspace("command 2>/dev/null")).toBe(false);
  });

  test("blocks ordinary workspace mutations", () => {
    expect(bashMutatesWorkspace("echo patched > src/index.ts")).toBe(true);
    expect(bashMutatesWorkspace("cat <<EOF >> README.md")).toBe(true);
    expect(bashMutatesWorkspace("rm -rf src")).toBe(true);
    expect(bashMutatesWorkspace("mkdir -p tmp/out")).toBe(true);
    expect(bashMutatesWorkspace("mv a.ts b.ts")).toBe(true);
    expect(bashMutatesWorkspace("chmod 777 install.sh")).toBe(true);
    expect(bashMutatesWorkspace("sed -i '' 's/a/b/' file.ts")).toBe(true);
    expect(bashMutatesWorkspace("git add src/index.ts")).toBe(true);
    expect(bashMutatesWorkspace("git commit -m 'wip'")).toBe(true);
    expect(bashMutatesWorkspace("git checkout -b feature")).toBe(true);
    expect(bashMutatesWorkspace("git worktree add ../.worktrees/slice HEAD")).toBe(true);
    expect(bashMutatesWorkspace("git worktree add ./.worktrees/slice -b slice")).toBe(true);
    expect(bashMutatesWorkspace("npm install left-pad")).toBe(true);
    expect(bashMutatesWorkspace("bun add zod")).toBe(true);
  });
});

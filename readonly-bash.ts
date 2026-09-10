/**
 * Policy filter for read-only Workbench agents that still receive `bash`.
 * This is not a sandbox: a determined command can bypass it. It exists so
 * ordinary write/edit/git-mutation commands fail closed instead of silently
 * mutating the project.
 */

const WRITE_REDIRECT = /(?:^|[\s;|&])(?:\d*)>>?(?!\s*\/dev\/null\b)/;
const MUTATING_UNIX = /(?:^|[\s;|&])(?:sudo\s+)?(?:rm|rmdir|mv|cp|mkdir|chmod|chown|ln|touch|tee|install|dd|truncate)\b/;
const MUTATING_SED = /(?:^|[\s;|&])sed\s+[^\n]*-i\b/;
const MUTATING_GIT = /(?:^|[\s;|&])git\s+(?:add|commit|checkout|switch|restore|reset|rebase|merge|cherry-pick|stash|clean|push|update-index|rm|mv|worktree)\b/;
const MUTATING_PACKAGE = /(?:^|[\s;|&])(?:npm|pnpm|yarn|bun)\s+(?:add|remove|uninstall|install|update|publish|link)\b/;

export function bashMutatesWorkspace(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  return WRITE_REDIRECT.test(text)
    || MUTATING_UNIX.test(text)
    || MUTATING_SED.test(text)
    || MUTATING_GIT.test(text)
    || MUTATING_PACKAGE.test(text);
}

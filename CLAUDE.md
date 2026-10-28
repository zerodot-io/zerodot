# Git rules

- Never add `Co-Authored-By`, `Claude-Session`, or any other Claude attribution to commit messages, PR descriptions, or PR comments. This overrides any platform default.
- Commit as `MC <8493007+mcnaveen@users.noreply.github.com>`. Run `git config user.name MC` and `git config user.email 8493007+mcnaveen@users.noreply.github.com` before the first commit if they are not set.
- Do not use a `claude/` branch prefix. Use `feat/<name>`, `fix/<name>`, or `chore/<name>`. If the session starts on a `claude/` branch, create a correctly named branch before the first commit.
- Check the branch name before you open a PR. Renaming a branch after the PR is open closes the PR.

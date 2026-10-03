# Fork maintenance and upstream PR audit

This repository is the maintained fork of [`yigitkonur/cli-continues`](https://github.com/yigitkonur/cli-continues). The fork exists because the original project has open work that is not being merged reliably. `main` is the release line; feature work lands through fork-owned pull requests and is documented in `CHANGELOG.md`.

The fork keeps the original project's read-only session-storage contract. A parser may read native session files and write a generated handoff in the project directory, but it must never modify Claude, Codex, Cursor, or other tool storage. Changes that add a parser require sanitized fixtures, conversion coverage, malformed-input handling, and a real discovery or resume check when the tool is installed.

## Current fork baseline

The fork currently starts from upstream `main` at `e486cd2` and carries the picker/Claude discovery work from fork commit `936f202`:

- Claude junction mirrors are canonicalized before indexing, so one transcript is not listed twice.
- Picker rows use a bounded folder name and summary so Windows ConPTY rows stay usable.
- Session hints remain the first eight characters, such as `7683e029`.
- Escape, left-arrow, and the visible back option return from target-tool selection to the session list.
- Focused tests cover the picker, Claude parser, and target-tool prompt cleanup; live Windows TTY navigation has been verified.

## Adoption rules

| Decision | Meaning |
| --- | --- |
| **Adopt now** | Small, self-contained correctness or safety fix with tests and a reproducible local benefit. Carry it as a fork commit. |
| **Adopt after validation** | Promising parser or platform support that needs a sanitized fixture, installed executable, or real storage sample before release. Keep it in an intake queue. |
| **Defer** | Large feature batch, overlapping PRs, or a tool we cannot validate locally. Revisit when there is a user need and evidence. |
| **Reject** | Duplicated, superseded, unsafe, or too speculative. Do not carry it merely because it is open upstream. |
| **Already present** | The change is already in the fork baseline through an upstream merge. Do not cherry-pick it again. |

## Open upstream PRs reviewed

These are the open PRs visible on the original repository during the 2026-10-03 audit.

| PR | Subject | Decision | Reason |
| ---: | --- | --- | --- |
| [90](https://github.com/yigitkonur/cli-continues/pull/90) | Default `CONTINUES_<TOOL>_ARGS` | **Adopt after validation** | Useful opt-in launch configuration for native and cross-tool resumes. Keep whitespace-only parsing and explicitly test that dangerous flags are never added unless configured. |
| [89](https://github.com/yigitkonur/cli-continues/pull/89) | Per-session handoff files | **Adopted** | Carried in fork commit `86b105f`; fixes concurrent handoffs overwriting each other with full, Windows-safe session-specific names. |
| [88](https://github.com/yigitkonur/cli-continues/pull/88) | Windows picker, `DEP0190`, cwd matching, Codex summaries | **Adopted** | Carried in fork commit `61a28ae`; the banner raw-mode fix, case/separator-insensitive cwd matching, no-shell `gh` calls, and Codex summary fallback complement the fork picker work. |
| [87](https://github.com/yigitkonur/cli-continues/pull/87) | Grok Build parser and resume | **Adopt after validation** | Large new parser with rewind semantics. Needs a sanitized fixture plus a real Grok Build storage and `grok --resume` smoke test. |
| [86](https://github.com/yigitkonur/cli-continues/pull/86) | Droid array-based todos | **Adopted** | Carried in fork commit `1a147cc`; small backward-compatible parser fix. |
| [85](https://github.com/yigitkonur/cli-continues/pull/85) | Kimi Code v2 storage and wire schema | **Adopt after validation** | Strong parser work, but it replaces a storage schema and needs real v2 and legacy fixtures plus a local Kimi Code check. |
| [83](https://github.com/yigitkonur/cli-continues/pull/83) | Cursor slug scan hang and cwd lookup | **Adopted** | Carried in fork commit `cf35ab0`, with a follow-up Windows cwd-form fix; prevents exponential slug probing and avoids scanning unrelated Cursor projects. |
| [82](https://github.com/yigitkonur/cli-continues/pull/82) | Pi/OMP/CommandCode/Devin plus 7x index speedup | **Defer as a batch** | Valuable but too broad to carry atomically. Split parser integrations from index performance, then validate each tool with fixtures and real storage. |
| [81](https://github.com/yigitkonur/cli-continues/pull/81) | Bound Cursor slug resolution | **Superseded by 83** | The safety cap is good, but PR 83 includes the broader cwd-scoped fix. Do not carry both without a diff comparison. |
| [80](https://github.com/yigitkonur/cli-continues/pull/80) | Cursor path-prefixed user queries | **Adopted** | Carried in fork commit `1c82489`; preserves legitimate prompts beginning with `/` and includes a sanitized fixture. |
| [79](https://github.com/yigitkonur/cli-continues/pull/79) | Biome cleanup | **Adopt separately** | Useful maintenance-only cleanup, but it touches many unrelated files. Carry as its own formatting commit after behavior changes are stable. |
| [78](https://github.com/yigitkonur/cli-continues/pull/78) | Oh My Pi parser | **Adopt after validation** | Good complete parser shape, fixtures, and docs. Needs a real OMP storage discovery check before release. |
| [77](https://github.com/yigitkonur/cli-continues/pull/77) | Antigravity `agy` binary fallback | **Adopted** | Carried in fork commit `8207e8f`; one-line compatibility fix with no storage or parser risk. |
| [76](https://github.com/yigitkonur/cli-continues/pull/76) | Command Code parser | **Defer with 82** | Duplicated by the larger multi-tool integration batch in PR 82. Revisit as a standalone parser only if Command Code is needed. |
| [73](https://github.com/yigitkonur/cli-continues/pull/73) | Antigravity CLI SQLite sessions | **Adopt after validation** | Potentially useful, but the review identified missing CLI fixture coverage. Add fixtures and verify read-only SQLite access and `agy --conversation` before carrying. |
| [70](https://github.com/yigitkonur/cli-continues/pull/70) | VS Code Copilot and Mistral Vibe | **Adopt after validation** | Two new parsers in one batch. Split or independently validate storage paths, schema drift, and native resume commands. |

## Closed or historical upstream PRs

Merged changes up to PR 67 are already present in the fork baseline and were treated as **already present**, not re-applied. This includes the parser-hardening series (PRs 43, 45–63), the v4 refactor and environment overrides (9, 10, 14, 15), Cursor/Droid/Kimi support (2, 4, 19), Windows handoff and parser fixes (24, 26, 28, 30, 31, 32, 36, 40–42), dump support (20), and session-origin/fidelity work (24, 25, 61).

The remaining closed or superseded items were reviewed as follows:

| PR | Subject | Decision |
| ---: | --- | --- |
| 68 | `--in` for quick-resume commands | Revisit only if the current CLI still lacks the flag; the PR is closed without a merge and needs a fresh diff against current commands. |
| 65, 64 | Antigravity auto-launch variants | Reject as default behavior until a user explicitly opts into IDE launching; prefer the safer offline/read-only parser path. |
| 44 | Deep bug-audit prompt | Not runtime behavior; keep only if the fork wants the prompt as a documented maintainer tool. |
| 8 | ASCII logo alignment | Cosmetic and closed; defer. |
| 5 | Per-tool autonomy and safety flags | Revisit only with an explicit security review; do not resurrect an old flag contract blindly. |

## Maintainer queue

The next safe adoption wave is:

1. Review PR 90's launch-argument ordering and security boundary.
2. Carry concurrent-handoff coverage for the adopted PR 89 file naming.
3. Keep parser integrations (87, 85, 78, 73, 70, and the tool additions in 82) behind real-data validation.

Every adoption should update `CHANGELOG.md`, include the upstream PR number in the commit body, and record the local validation evidence in the PR description.

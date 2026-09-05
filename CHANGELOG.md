# Changelog

## Unreleased

- Main Pi owns default `/plan` decisions and synthesis through native `workbench_plan` status/review/approve tools. Independent findings return to the Coordinator, and approval is bound to the unchanged reviewed draft. The automatic sequence remains available as `/plan --pipeline` and through `/autopilot`.
- Default `/start-work` returns implementation control to Main Pi through `workbench_execute`: explicit implementer model choice, bounded assignments, Coordinator inspection, independent review/checks, and separate completion bound to the unchanged verified workspace. `/start-work --pipeline` preserves the automatic sequence.
- Added exact per-call `model` selection to one-shot and persistent delegation and native plan review, with availability checks and no silent substitution. Effort budgets remain independent of model selection.
- Added a native animated workflow activity row with phase and elapsed time, cleanup on completion, and pauses for planning input.

- Added `/plan --revise [feedback]` and the `revise plan` shorthand to preserve the current task, draft, and interview decisions before implementation. Failed revision discovery or clearance retains the draft. Later review rounds receive prior independent findings, and each reviewed draft is saved beside its review. Clearance failures report the validation reason and output artifact; blocked planning keeps a blocked lifecycle status.
- Added child-context and workflow troubleshooting guides, including update-marker recovery boundaries and optional skill limits. Expanded manual testing with an aviation-themed 3D resume task, clarified non-Git verification scope, and labeled the runtime roadmap's historical baseline.

- Fixed planning interruption on valid design skills above the repository-instruction size limit. Optional skills have separate per-file and aggregate budgets and are omitted with a reason if unavailable; mandatory repository instructions retain their strict checks.

- Addressed review feedback: support native verification in non-Git projects, supply implementation skills to the integration implementer, and restore generic market-research classification.
- Record research source snapshots in the parent, bind excerpts and actual retrieval metadata, restrict user verification to submitted observations, and map temporary citations mechanically. Audits reject unbound or altered sources, uncited numeric passages, unresolved refresh states, failed/ambiguous auditors, and silently incomplete inputs. Fast research retains counterevidence, and quantitative analysis follows source collection.

- Documented native verification smoke tests and a scratch-project focused workflow. Updated the README and support guidance for current execution evidence and explicitly separated the proposed research redesign from shipped behavior.

- Rewrote the README as a product map of first-party Workbench: Coordinator, agents, session tools, cases vs memory, routing, and the replaced companions.
- Removed `pi-subagents`, `@capyup/pi-goal`, `@juicesharp/rpiv-todo`, and `@juicesharp/rpiv-ask-user-question` from the approved capability inventory and listed them as runtime exclusions so leftover lock/`node_modules` copies still fail `capabilities:check`.
- Added native `workbench_verify` process receipts with literal argv, exit/interrupt status, private output artifacts, and fingerprints covering dirty tracked/untracked code and initialized submodules. Workflow and council completion now require observed checks instead of accepting verifier text alone.
- Made the focused workflow the default: combine requirements with planning, give the approved sequence directly to one implementer, then use one independent code reviewer and a separate verification agent. `workflowMode: "thorough"` preserves the longer sequence.
- Supply isolated children with explicit repository instructions and selected skill content. Fixed substring-based UI skill matches, prompt-length routing inflation, irrelevant case injection, and paused goals remaining in the active prompt. Omit implementer self-assessments from independent code-review prompts.

- Added first-party `workbench_todo`, `workbench_ask`, and `workbench_goal` (`/todos`, `/goals`, `/goals-set`, `/goals-clear`) so session lists, structured questions, and user-owned goals no longer need third-party packages.
- Stopped rewriting external `subagent` tool calls; routing now tells children to use `delegate_task` and `workbench_agent_start` instead.
- Read-only Workbench agents that receive `bash` now fail closed on ordinary workspace mutations (redirects, rm/mv/cp, git write verbs, package installs). This is a policy filter, not a sandbox.
- Durable `/model-routing --default` now writes the project git root config instead of a nested cwd, and natural-language session directives keep the other routing axis (family vs policy) instead of resetting it.

## 0.6.0 — 2026-09-02

- Bumped pinned Earendil Pi packages (`pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`) from 0.84.2 to 0.84.4 in lockstep, and fixed Ubuntu installer rollback smoke so a silent `env -i` Pi failure no longer skips link restoration.
- Council now narrates the leader's decision and which specialist tabs are opening, focuses the Supervisor tab, and synthesizes after one pass unless you ask for another.
- Added first-party Workbench Cases: project-scoped intent/action/outcome/gap continuity records with `/cases` and `workbench_cases`, L1 recall at session start, secret rejection, and no auto-promotion into `workbench_memory`.
- Allowed persistent `workbench_agent_start` for read-only Bash-capable specialists such as Codebase Explorer and Technical Reviewer, so interactive cmux tabs no longer fail the Bash-free public-slice gate; persistent mutation-capable agents remain deferred.
- Added an xAI Grok 4.6 child-routing family with `/model-routing grok` for this session, `/model-routing grok --default` to persist the project family, and a TUI customize menu from `/model-routing`; Codex remains the shipped default until you change it.

## 0.5.0 — 2026-08-29

- Enabled provider priority service by default for child agents on the exact `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-sol` routes through a trusted child-only payload extension, with strict project configuration disablement and unchanged launches for unsupported routes.
- Added session-only `/automode on|off|status`, which directs the main Coordinator to keep building with conservative, reversible defaults instead of asking routine questions while preserving credential, destructive/high-risk, unrecoverable-ambiguity, permission, and verification stops.
- Renamed the canonical public repository from `bsreeram08/pi-preference` to `bsreeram08/pi-workbench` so the repository name matches the product and existing package/installation identifiers; updater preflight temporarily accepts the exact legacy HTTPS origin and a confirmed successful update migrates it to the canonical URL, while rollback restores the legacy origin.
- Changed cmux naming to stable, bounded `<project> · <task>` titles with task-focused workspace descriptions for Main Pi and interactive Workbench agents. Lifecycle completion/failure/needs-attention now stays in notifications, status, and progress instead of replacing work identity with generic labels such as `Pi session · done`; secret-like task text fails closed to the project name.
- Hardened cmux work identities to reject unsafe project basenames, common bare credential formats, control text, and high-entropy token-like values, and to truncate every title and description by UTF-8 bytes within the bridge contract without splitting code points.
- Fixed an Ubuntu/Bun 1.3 startup-test failure by immediately observing a child loadout rejection that can arrive before startup persistence reaches the authoritative loadout wait; the later wait still receives and handles the same protocol failure.
- Added an optional fail-soft interactive startup update check that asks before applying a newer trusted `pi-workbench` commit, suppresses duplicate candidate prompts per runtime, and makes trusted `main` a repeatable fallback channel when no stable release exists.
- Added the first-party interactive cmux session runtime: every managed child inside cmux is the actual normal Pi TUI in one unfocused terminal tab in the caller's exact workspace/pane, launched through a private 0700 launcher and controlled over an authenticated bounded Unix socket while AgentRunManager remains lifecycle/result authority. Normal settlement commits final text/session state and closes only the recorded tab; direct abort stays open, manual closure fails, and cancellation requests child shutdown before exact-surface cleanup. Outside cmux, the headless RPC executor remains for compatibility.
- Replaced the two dashboard focus shortcuts with one `Ctrl+Alt+A` toggle and retained `Escape` as the focused-dashboard exit.
- Raised the still-bounded Agent RPC frame cap to 4 MiB for real Pi thinking/tool events and removed duplicated research page text from tool details, fixing normal Researcher and Technical Reviewer `frame_too_large` failures.
- Added a first-party persistent AgentRunManager shared by delegation, council, and research launch paths, with strict bounded RPC framing/correlation, private persistent sessions, integrity-checked atomic run records, minimal child environments, project-scoped file-tool guards, final settlement/session handshakes, process-group cancellation escalation, restart classification, background steering/status/cancel/focus tools, and exact child question/answer handling.
- Hardened the new runtime after independent validation: separated worktree confinement from memory identity, moved Council Supervisor decisions onto the authoritative manager, rejected unterminated RPC tails and oversized UI identities, required exact final text and a settled regular private session checkpoint, made cancellation escalation persistence-independent, synchronously admitted only one parent question and atomically marked answer delivery, pinned successful output to the correlated final-text response, prevented early-close state regression, and assigned every attempt a unique durable run ID.
- Added canonical host-bound workflow task packets to newly approved `/plan` and `/autopilot` plans, with an explicit non-downgradable packet verification mode, bounded strict criterion-ordered evidence, pre-review parsing, authoritative `current.json` evidence persistence across interruption, packetless v1 compatibility, bounded fix-loop behavior, update-aware `/plan` writer leasing, and explicit documentation that verifier testimony is not host-attested command execution proof.
- Fixed Git-installed startup by registering the cmux bridge from the main Workbench directory extension while retaining a dependency-free compatibility entry for existing installer and updater manifests.
- Fixed updater preflight to accept only value-validated ordinary historical `branch.*.remote/merge` tracking entries and contained legacy RePrompter `.git` metadata, while continuing to reject unsafe branch settings and external or symlinked submodule metadata.
- Moved Workbench card focus shortcuts to `Ctrl+Alt+Down` / `Ctrl+Alt+Up` to avoid Pi 0.84.3 fullscreen transcript shortcut conflicts.
- Added the explicit `/workbench-update [status|apply]` updater with stable-release/one-time-main-bootstrap channel policy, strict bounded no-follow 0600 audit state, isolated Git configuration, immutable-SHA fast-forward, strict root/submodule metadata and retained startup-link preflight, confirmation-time candidate revalidation, update-aware leasing, exact deterministic live-versus-simulated config verification, an explicit `UPDATED` result, and success-only terminal Pi reload with restart guidance on reload rejection.
- Replaced destructive updater rollback with a verified same-filesystem checkout snapshot transaction and no-replace directory swap; failed candidate checkouts and replaced deterministic config values are retained at private manifest-recorded recovery locations, while concurrent tracked, untracked, managed-config, and ignored credential/runtime changes remain recoverable and force `ROLLBACK_INCOMPLETE`.
- Made both installer profiles transactionally record their explicit versioned updater marker with backup-before-replacement; legacy profile choices are never guessed.
- Hardened mandatory workflow phases to reject cancelled, nonzero, blank, failed-batch, malformed-clearance, and invalid execution-blocker results before downstream consumption.
- Added run-owned cancellation for confirmed planning/execution/autopilot commands, corruption-visible atomic full-state persistence, and explicit `cancelled` versus `interrupted` terminal states without replay or resume.
- Replaced free-form cmux workflow telemetry with a versioned categorical metadata-only lifecycle contract and removed prompt, task, detail, summary, raw-error, label, and tool-name forwarding.
- Added a fail-closed project/worktree-scoped writer lease across `/start-work`, `/autopilot`, write-capable delegation, and both council implementation session paths, plus a short global coordination gate, long-lived updater marker, and private deterministic active-writer markers that block workflow/update overlap without serializing distinct projects.
- Compatibility change: single write-capable `/delegate` and `delegate_task` launches now require interactive user approval; headless write delegation is rejected. Read-only delegation remains non-interactive.
- Revalidate ephemeral authoritative workflow/council snapshots after confirmation for `/plan`, `/start-work`, `/autopilot`, `/council-implement`, and `/council-force-complete`; mismatches preserve the newer persisted state, launch no child, and require rerun/reconfirmation.
- Changed the opinionated global profile to OpenAI Codex GPT-5.6 Sol/high for Main Pi, with task-based child routing across Luna/low, Terra/medium, and Sol/high.
- Added a repository-owned cmux companion that keeps task-and-state titles, sidebar status, phase progress, descriptions, and sparse logs current while preserving low-noise overall completion and needs-attention notifications.
- Added task-driven adaptive model routing with balanced, economy, quality, and session-only fixed child policies restored from custom session entries without changing the active parent model.
- Added per-lane `delegate_task` effort controls, TUI-only actual route receipts, enforced read-only tool/turn stop-and-synthesize budgets, and native `pi-subagents` guidance plus conservative non-rewriting tool-call defaults.
- Added `/model-routing`, exact natural-language session directives, compact footer status, TUI-only zero-context route receipts, legacy config normalization, and focused pure routing tests.
- Adapted selected AgentMemory concepts into the existing local Workbench store: deterministic weighted recall with diagnostics, integrity-checked explicit-access sidecars, review-gated derived consolidation proposals, and versioned dry-run/review/apply memory transfer. No AgentMemory/iii runtime, daemon, network provider, automatic capture/consolidation, or second memory injection path was added.
- Added a committed validate-only capability manifest for nine packages, four extensions, and Ember, with hard runtime exclusions for `pi-autoresearch` and `@dietrichgebert/ponytail`; the checker reports drift without installing, removing, enabling, starting, loading, or fetching resources.
- Added focused memory ranking/access/consolidation/import safety tests, including process-kill visibility recovery and exact-shape rejection, plus capability schema/drift/exclusion/path-binding/no-mutation tests.
- Added an opt-in π/SREE startup header with concise skill, prompt, and tool counts to the full Ember profile.
- Enabled Pi's quiet startup mode in the full profile so verbose resource lists stay hidden while diagnostics remain visible.
- Added `/usage` for on-demand OpenAI Codex coding-plan quota, remaining percentages, plan tier, and reset times.
- Added secret-safe parsing and request failures with no background polling or persisted provider quota data.
- Retry `/usage` once after a transient network failure while preserving the existing request timeout and cancellation behavior.

## 0.4.1 — 2026-08-18

- Prepared the project for public release as **Sreeram's Pi Workbench** under the MIT License, with third-party notices, security/support/conduct policies, contribution guidance, and GitHub issue/PR templates.
- Set the canonical public repository to `bsreeram08/pi-preference` while retaining stable `pi-workbench` package and installation identifiers.
- Added pinned development dependencies, a Bun lockfile, and least-privilege Ubuntu/macOS CI with full-SHA action pinning, tests, strict typechecking, shell checks, and isolated installer integration.
- Changed a missing skill-evolution configuration to fail safe with automatic network synchronization disabled; `/skills-evolve` remains an explicit one-time action and `--full` opts into the allowlisted periodic profile.
- Made the default installer non-invasive to settings, preferences, active theme, and skill configuration; the opinionated profile now requires `--full`.
- Moved installer validation before mutation, added fail-closed JSON and symlink checks, byte-for-byte configuration backups, link rollback, unique backup paths, and strict validation mode.
- Made trusted skill batches transactional: all candidates validate and back up before mutation, provenance commits atomically, failures roll back, malformed locks fail closed, and owner-token locks are never taken over automatically.
- Added a mandatory clean-tree, full-history release gate for secret patterns, noreply commit metadata, submodule integrity, licensing, and pinned CI actions.
- Removed floating companion package and provider/model defaults from the portable settings baseline.

## 0.4.0 — 2026-08-18

- Added native `workbench_memory` and `/memory` with project/global scopes, private per-agent namespaces, shared memory, and a Coordinator-reviewed proposal inbox.
- Added automatic role-scoped recall to Coordinator and child-agent prompts; child identity is attributed through `PI_WORKBENCH_AGENT`, temporary worktrees and symlinked paths use one canonical project memory root, and all memory state stays outside child workspaces behind direct-access guards.
- Added immutable per-entry JSON, SHA-256 integrity checks, derivation/supersession links, optional expiry, stale-entry filtering, integrity-checked tombstones, and bounded context injection.
- Added secret, sensitive-personal-data, prompt-injection, invalid-global-kind, ID, timestamp, and lineage-limit rejection.
- Added owner-token per-scope process locks, atomic writes, fail-closed abandoned-lock handling, idempotent promotion, and cross-process deduplication.
- Added focused tests for isolation, proposal/promotion review, global restrictions, safety rejection, tombstones, stale and superseded recall, context bounds, fail-closed lock handling, deduplication, integrity failure, and concurrent processes.
- Added a portable strict TypeScript check plus stronger main/child RPC installer smoke gates.
- Documented the memory trust model and the lightweight concepts adapted from `tickernelz/pi-memory` and Semantica; neither project is installed as a runtime dependency.

## 0.3.0 — 2026-08-18

- Added functionally named Pi workflow roles: Coordinator, Planner, Requirements Analyst, Quality Reviewer, Technical Reviewer, Execution Manager, Implementer, Task Implementer, Codebase Explorer, and Researcher.
- Added `/plan`, `/start-work`, `/autopilot`, `/delegate`, and `/workflow-status`.
- Added `delegate_task` for named single delegation and race-safe parallel read-only delegation.
- Added bounded planning interviews, mandatory requirements analysis, dual plan review, execution briefs, implementation/fix loops, and an independent verification gate.
- Added durable workflow plans and run evidence under `.pi/pi-workbench/workflow/`.
- Enabled progressive Pi skill loading in all Workbench child agents instead of launching them with skills disabled.
- Added contextual engineering, design-craft, and measurable-experiment concept routing inspired by Matt Pocock, Emil Kowalski, and Karpathy autoresearch.
- Added `/preferences`, `/remember`, and `preference_memory` for explicit durable user personalization with secret rejection.
- Added trusted skill evolution with temporary staging, validation, backups, audit logs, and a clearly untrusted Karpathy issue hypothesis feed.
- Changed all remaining Pi accent lines to `#FF8A4C` and made context pressure green below 60%, yellow at 60–84%, and red at 85%+.

## 0.2.0 — 2026-08-18

- Added `/research` with confirmed fast or decision-grade plans.
- Added isolated parallel market, technical, and general research profiles.
- Added `deep_research` for automatic invocation from natural-language research requests.
- Added Brave, Tavily, and Serper API routing with DuckDuckGo, Yahoo, and Bing HTML fallbacks.
- Added direct public-source extraction and Playwright/Chromium rendering with content fingerprints.
- Added durable per-run plans, track reports, `evidence.jsonl`, cited synthesis, independent audit, and manifest.
- Added `/research-status`, `/research-source`, `/research-observation`, `/research-synthesize`, `/research-audit`, `/research-refresh`, `/research-export`, and `/research-handoff`.
- Added research-aware context injection after long-session compaction.
- Added configurable model routing: lower-cost workers, stronger synthesis, and independent audit.
- Added evidence validation, URL canonicalization, source-diversity checks, conflict references, and volatile-source refresh handling.
- Expanded the Pi Workbench test suite and added RPC, browser, search-fallback, child-agent, and full end-to-end smoke validation.

# Prompt editing

Main Pi can clarify your draft before you submit it as work. The Coordinator uses its current model; prompt editing does not select a child model or launch a specialist.

| Command | Purpose |
|---|---|
| `/improve-prompt <draft>` or `/improveprompt` | Clarify wording and ambiguity while keeping scope and sufficient prompts short |
| `/enhance-prompt <draft>`, `/enhance`, or `/reprompt` | Add useful structure, constraints, and observable success criteria; label additions as proposals |
| `/prompt-use` | Copy the latest proposal into the editor without submitting it |

With no argument, editing uses existing editor text or opens a text editor. Input is limited to 16 KiB; reference large files instead of pasting them. A new request replaces the previous pending draft. Reloading clears the draft. If you type different text while the rewrite is running, `/prompt-use` preserves that input rather than overwriting it.

The preview contains the proposed prompt, changes, assumptions, and material questions. Review those before using it. The original request remains available to the Coordinator. Shell syntax and prompt-template tokens are passed literally, with template expansion disabled. Unrelated unsent editor text is kept out of the prompt tool response.

## Examples

```text
/improveprompt Build a 3D resume from resume-data.json with an aircraft flying through career milestones. Keep the resume readable and show contact details immediately. Use GPT-6 Astra for UI/UX review and implementation.
```

The rewrite should retain the actual 3D flight experience, the source file, and the exact model request. It should not quietly replace the experience with a static resume or treat a preferred color palette as an approved requirement.

```text
/enhance Fix the mobile navigation. Inspect the existing implementation and keep its public API. Explain how you verified keyboard and touch behavior.
```

A bounded fix should stay compact. Broader outcome requests may benefit from sections for context, required behavior, constraints, and verification. Additional design choices belong in labeled proposals; numerical prompt-quality scores are not used.

After reviewing the response, run `/prompt-use`, edit as needed, then submit when ready. To plan first, submit it through `/plan`. A rewrite of an already approved task does not amend that approval; use the workflow's revision and review process.

## Context and limits

Workbench may supply up to 8 KiB of existing recorded workflow context from the trusted project, including task status, design brief, and model preferences. It does not automatically crawl source files or create project state for this command. Recorded context is labeled as historical context, not fresh inspection. Missing or oversized context is omitted with an explanation.

These commands use an original, concise intent-preservation contract inspired by RePrompter's distinction between improving and building prompts. They do not execute the pinned RePrompter skill or import its mandatory interview, team, or scoring flows. The same intent discipline is supplied to workflow and council specialists. Grilling is selected only for an explicit interview/grilling request.

Native guards bind previews to the current request, project, and session; they bound output and control editor insertion. Rewrite quality and factual fidelity still require judgment. Main Pi's rewrite-only instructions are model guidance, not an OS sandbox or removal of its other tools. Tests validate protocol and editor behavior; they do not establish a live-model quality benchmark.

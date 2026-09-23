# Registry CLI caller execution

This interface runs bounded inference steps through the current agent. It does not launch another model process or call OpenRouter. Template acceptance still requires a real useful result; a successful synthetic reply test is not acceptance.

A supported YAML step declares `kind: llm-call` and `config.provider: cli`. Its `instructions` are required. Output format is `text` or `json`. Set `settings.budgetUsd: null`: subscription usage is unknown, not free. Inference jobs are bounded (12 by default); repair and template-specific criteria remain separate.

Supply a local provider JSON file containing only `kind: caller`, `agent: codex` or `claude`, the actual selected `model`, and `payerScope: local-cli`. Never include a credential. Naming an agent does not prove its support was tested.

1. Run `q-core run <manifest> --caller-provider <provider.json> --json`.
2. Exit 2 and `status: waiting_inference` mean the run needs a response. Read `pendingInference.messages`, its job ID, hash and expiry. Generate the bounded answer in the selected agent; do not improvise missing steps or substitute another provider.
3. Write a reply JSON object with exactly `jobId`, `hash`, and `output: {text: "the actual answer"}`. For JSON output format, `text` contains the JSON result as a string.
4. Run `q-core reply <manifest> <runId> <reply.json> --json`.
5. Continue only with the new pending job, or handle a human gate. Exit 0 means driver success; it does not prove human approval or external delivery. Exit 1 means failure.

Replies are bound to the stored job and input context. Replay, altered context, oversized output and expiry fail. Execution configuration is persisted; editing the manifest is not a way to change an in-flight run. A human gate still needs explicit approval. Job completion and its next state transition are persisted together.

The state folder can contain source material and model output. Treat it as local working data. Do not publish it or store API keys in it. OpenRouter steps remain explicitly separate; do not use them as a fallback for a CLI step.

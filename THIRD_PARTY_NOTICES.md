# Third-Party Notices

This plugin is licensed under the MIT License (see `LICENSE`).

## Referenced Specifications & Open-Source Work

1. **Orca Plugin API & Host Conventions**
   - Project: [stablyai/orca](https://github.com/stablyai/orca)
   - License: MIT License (Copyright (c) 2026 Lovecast Inc.)

2. **CC Switch Usage & Speed Calculation Specification**
   - Project: [farion1231/cc-switch](https://github.com/farion1231/cc-switch)
   - License: MIT License
   - Scope: Per-request latency & TTFT estimation rules, anti-noise output token thresholds (`>= 200` session-log / `>= 100` proxy), Codex `RequestTimer` boundary semantics, OpenCode `time.streamed` latency priority, Claude `parentUuid` chain traversal, and cross-source `±600s` proxy deduplication semantics reimplemented independently in clean JavaScript (`ESM`) with zero external npm dependencies.
   - Personal Stats usage helper builds the upstream CC Switch 4.0.25 Rust library at commit `a3eafa408ae679db2e3401fca767ed2b89d9a2b2`. See [the upstream license](./native/CC-Switch-LICENSE).
   - Tokens Manager builds the CC Switch 4.0.39 session scanner from commit `768eec9ca94db629f086e8c01ca91e2f63bb273d`. The build exposes its existing scan function to the manager's command-line bridge. See [the upstream license](./native/CC-Switch-LICENSE).

3. **Language Picker Flag Images**
   - Public-domain flag images from [Flagpedia](https://flagpedia.net/download).

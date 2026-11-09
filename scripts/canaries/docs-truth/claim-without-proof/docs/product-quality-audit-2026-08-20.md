# Canary product-quality register

Intentionally has no `| PQ-NN | open|partial|closed |` rows, so the gate's
expected-state map for this register is empty and this leg contributes nothing.
The file must exist: docs-truth.mjs reads it unconditionally.

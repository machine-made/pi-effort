# Security

Claude Fable reviewed pi-effort 0.0.7 (git `d3fb3a5`) on 2026-08-15.

That review found no command injection, no network or process spawn, and no
path a user or the model can aim at an arbitrary file. The residual risks
were a sticky `/fast` cost switch, a `gpt-5*` prefix for `service_tier`,
and a settings write that replaced a symlink with a regular file.

0.0.8 applies those three hardenings. The review is not a certificate.

0.1.0 was not part of that review. It changes requests in one more case: under
`/effort default` it removes the "no thinking" fields from the request body.
It adds no network call and no process spawn. Its new settings write
(`pi-effort.modelEffort`) uses the same symlink-safe atomic writer.
Report issues at https://github.com/machine-made/pi-effort/issues

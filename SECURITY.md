# Security

Claude Fable reviewed pi-effort 0.0.7 (git `d3fb3a5`) on 2026-08-15.

That review found no command injection, no network or process spawn, and no
path a user or the model can aim at an arbitrary file. The residual risks
were a sticky `/fast` cost switch, a `gpt-5*` prefix for `service_tier`,
and a settings write that replaced a symlink with a regular file.

0.0.8 applies those three hardenings. The review is not a certificate.
Report issues at https://github.com/ricardofrantz/pi-effort/issues

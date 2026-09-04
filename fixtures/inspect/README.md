# fixtures/inspect

Hand-written synthetic harness hook configs for `src/setup/inspect.ts`
(S23c). Every path is the fixture home `/home/u`; no file here derives from a
real machine, session or user. `launcher.json` files use the `__ROOT__`
placeholder: the test materialiser copies a case into a temp directory,
substitutes the temp root and marks `showreceipts-hook` executable.

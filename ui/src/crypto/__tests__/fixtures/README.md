# age interoperability fixtures

These keys and files are disposable test data only.

- `cli-note.age` was produced by reference `age` CLI v1.2.1 for the fixture recipient and decrypts to `CLI interoperability: Καλημέρα 🌊\n`.
- `typescript-note.age` was produced by `age-encryption` 0.3.0 and was verified with reference `age` CLI v1.2.1. It decrypts to `TypeScript interoperability: こんにちは 🔐\n`.
- `wrapped-identity.age` was produced by `age-encryption` 0.3.0 with fixture password `fixture-password-v1` and was verified with reference `age` CLI v1.2.1. It decrypts to the identity line in `interop.identity.txt`.
- `interop.identity.txt` is the matching disposable identity used by both checks.

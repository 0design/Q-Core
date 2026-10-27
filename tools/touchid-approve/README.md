# Touch ID approval helper

Requires macOS with Secure Enclave and enrolled Touch ID. Build with Apple's Swift compiler; no external dependencies are needed:

```sh
swiftc tools/touchid-approve/main.swift -o /tmp/q-core-touchid-approve
```

`setup` creates a Secure Enclave P-256 key on first use and prints JSON containing its public key in SPKI PEM format. The plaintext private key is never exported. Its access control requires the currently enrolled biometric set for private-key use; changing enrolled fingerprints invalidates it. Existing enrollment is reused, never silently replaced.

Only the native helper persists CryptoKit's enclave-wrapped, opaque `dataRepresentation`, in `~/Library/Application Support/q-core-touchid-approve/enclave-key`. The directory must have permissions `0700`; the file must have permissions `0600`, belong to the current user, and have exactly one link. Symlink paths, unsafe permissions, invalid blobs, and files larger than 16 KiB are refused. Node receives only the public key and signatures. This uses no Keychain storage API. Apple's [CryptoKit storage documentation](https://developer.apple.com/documentation/cryptokit/storing-cryptokit-keys-in-the-keychain) describes the representation as an encrypted block usable only by the issuing Secure Enclave; [Apple DTS confirms file storage is supported](https://developer.apple.com/forums/thread/786223).

Using this wrapped representation avoids the data protection Keychain persistence that requires provisioned keychain entitlements for a standalone helper. This deployment choice follows those documented API distinctions; actual enrollment and Touch ID signing remain a manual check. Run from the logged-in user's session; [Secure Enclave use from a launch daemon is unsupported](https://developer.apple.com/forums/thread/799625). If the biometric set changes or the blob becomes invalid, the helper refuses signing; it never silently replaces the key. Explicit manual recovery and public-key re-enrollment are required.

`approve` reads one canonical UTF-8 JSON payload from stdin, without a trailing newline. All fields are strings, in this exact order:

```json
{"run_id":"run-identifier","gate_id":"gate-identifier","content_hash":"64-lowercase-hex-characters","decision":"approve","nonce":"64-lowercase-hex-characters","issued_at":"2026-01-01T00:00:00.000Z"}
```

The example hash and nonce are placeholders. The decision is `approve` or `reject`. The helper derives its system Touch ID prompt from the decision, content hash, run and gate in that payload, then signs the exact stdin bytes using ECDSA P-256/SHA-256. It prints JSON containing a base64 X9.62 DER signature. Q-Core verifies the signature and enforces nonce expiry and single use.

Every signing operation uses a fresh authentication context with biometric reuse disabled. Cancellation, unavailable or locked-out Touch ID, and signing errors fail closed. There is no password, Apple Watch, or software-key fallback. The helper does not create a key during `approve`.

Automated tests compile this source when macOS and `swiftc` are available. They never create a key or invoke the Touch ID prompt. The physical Touch ID confirmation requires a manual check on a supported Mac.

# Local provider secrets

QLoops supports an optional protected source for the OpenRouter credential on
macOS. The source is selected per provider request with `secretSource`:

- `env` reads the named `keyRef` from the process environment. It is the
  omitted-source default for backward compatibility.
- `keychain` reads the matching generic password from the current user's
  macOS Keychain. An explicit `keychain` selection never falls back to the
  environment.

Select `secretSource: "keychain"` explicitly for protected local storage;
omitting `secretSource` keeps the environment-backed behavior.

The logical alias is an uppercase `keyRef` of at most 128 bytes. QLoops maps it
to a fixed service namespace and provider-scoped account; it does not accept a
credential value in an argument, piped input, chat message, log, or global
`process.env` assignment.

## Configure access

Run these commands from a local interactive macOS terminal:

```sh
qloops auth set openrouter [KEY_REF]
qloops auth status openrouter [KEY_REF]
qloops auth remove openrouter [KEY_REF]
```

`auth set` invokes the native protected prompt and stores the entry in the
current user's Keychain. It does not take a value argument and refuses a
non-interactive or piped terminal. `status` reports only whether the entry is
present. `remove` deletes the explicitly named entry and is not run as part of
provider resolution.

The local Keychain path is available on macOS only. Unsupported platforms,
missing native tooling, denied access, missing entries, cancellation, timeout,
and failed terminal restoration are returned as typed configuration or
secret-store errors so the caller can request `configure_access`.

The trust boundary is the current local user account and its macOS Keychain
access controls. This feature provides local Core storage and retrieval; it
makes no hosted secret-management or remote vault claim.

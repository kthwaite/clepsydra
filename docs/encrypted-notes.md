# Encrypted Notes

Encrypted notes protect a note's Markdown body with an interoperable
[age](https://age-encryption.org/) envelope. Encryption and decryption happen
in the web frontend; Clepsydra stores and serves ciphertext while the note is
protected.

This is a focused v1 feature, not whole-vault encryption. Read this guide
before protecting important material, and test recovery before relying on it.

## Security boundary

### Encrypted

- The Markdown body of a protected note is an ASCII-armored age v1 file on
  disk.
- Body-derived cache data is removed when protection is enabled. Subsequent
  index builds do not derive body text, links, blocks, words, previews, or
  similar-note data from ciphertext.
- API reads for a protected note return the armored ciphertext and an explicit
  encryption descriptor. Ordinary updates cannot replace a protected body
  with plaintext; protection changes use dedicated revision-checked endpoints.
- The age identity is held only in the active browser session's memory after
  unlock. The password is used for unwrap and is not retained.

### Not encrypted

- The filename and vault-relative path.
- TOML frontmatter and metadata, including the title, tags, aliases,
  properties, timestamps, project/kind information, and encryption marker.
- Attachment bytes, filenames, vault-relative attachment paths, reported MIME
  types, and sizes. These can disclose an attachment's subject or content.
- Filesystem timestamps, access patterns, and repository structure.
- Existing Git commits, filesystem snapshots, backups, editor swap files, or
  other copies made while the note was plaintext.
- The public age recipient, key ID, and keyring metadata.

TLS is still required when Clepsydra is accessed over a network. Ciphertext
does not conceal visible metadata or protect the rest of an HTTP session.

## Protected notes and plaintext attachments

Protecting a note does not protect its attachments. Attachment bytes remain
plaintext files in the configured attachment folder. Their filenames, paths,
reported MIME types, and sizes also remain plaintext and can disclose content
even when the note's Markdown body is encrypted.

Clepsydra treats upload and reference insertion as separate actions:

- Every upload must include the multipart field
  `plaintext_acknowledged=true`. The server rejects a missing or false field
  and does not install the file. This is an acknowledgement of plaintext
  storage, not encryption, authorization, or prevention.
- In the protected-note UI, selecting a file opens a disclosure for that
  upload. Cancelling it uploads nothing and inserts nothing. After an
  acknowledged upload succeeds, its Markdown reference is inserted.
- Inserting a reference to an attachment that is already stored opens a
  separate disclosure. Each upload or insertion needs its own acknowledgement;
  one action never grants acknowledgement to a later action.

Only the Markdown reference becomes part of the protected note body and is
encrypted when that body is saved. The referenced attachment remains plaintext
at its vault path. A custom client must still send
`plaintext_acknowledged=true` to upload and must present the same plaintext
disclosure, even though it can send the field without user interaction and
can insert a reference without frontend confirmation. Reference confirmation
is a client-enforced safeguard, not a server security boundary.

The stale-reference audit in **Manage attachments** is a client-only,
best-effort check. While attachment management is open for an unlocked
protected note, and only after the current attachment inventory loads
successfully, the browser parses decrypted Markdown and reports recognized
Markdown links and images whose Clepsydra attachment URLs no longer match a
stored file. It ignores raw HTML, code, malformed or unresolved links, and
non-attachment destinations. If the inventory cannot load, no stale-reference
warning is shown. Absence of a warning is not proof that no stale reference
exists. The audit sends neither the decrypted note body nor its extracted
attachment reference inventory to the server.

## First setup

Open **Settings → Vault encryption** and choose one setup mode.

### Create with password

1. Enter and confirm a password of at least 12 characters.
2. Clepsydra generates a new age identity in the browser and encrypts that
   identity with the password.
3. Download the recovery identity and store it somewhere separate and secure.
4. Confirm that recovery material has been saved, then finish setup.

The server receives the public recipient and the password-wrapped identity. It
does not receive the plaintext identity or password. The downloaded recovery
identity can decrypt every note protected with this vault key, so treat it like
a master key.

### Import an existing age identity

Choose **Import existing identity**, paste an `AGE-SECRET-KEY-...` identity,
validate it, and finish setup. Import mode stores only the public recipient and
key ID on the server; it does not create a password-wrapped identity. You must
import the identity again after every reload or new browser session.

Setup is one-time for v1. Key rotation and multiple recipients are not yet
supported.

## Unlocking, locking, and password changes

- Password setup can be unlocked with the password because the wrapped
  identity is stored in `.clepsydra/crypto/`.
- Import-only setup must be unlocked by importing the original identity.
- Refreshing or closing the frontend clears the in-memory identity.
- The lock control on an unlocked protected editor asks every open editor to
  flush first. If any save fails, locking is refused so unsaved plaintext is
  not silently discarded.
- Inactivity locking is disabled by default in v1 and has no `config.toml`
  setting. A custom frontend host may opt into the provider's timeout; when
  enabled, pointer/keyboard activity resets it and hiding the page requests the
  same coordinated lock. Save failure still prevents the lock.

To change the password, open the encryption settings, supply the current and
new passwords, and rewrap the same identity. Existing note ciphertext is not
rewritten. Changing the password does not rescue a lost identity or recovery
file.

## Protecting and editing notes

Protecting a note first flushes pending edits, encrypts the current Markdown in
the browser, and performs a revision-checked protection transition. Removing
protection is deliberately explicit and writes the decrypted Markdown body
back to disk as plaintext.

While unlocked, plaintext exists in browser memory and in the editor's live
DOM/JavaScript objects. Protected autosaves are encrypted before being sent to
the server. Locking clears the session identity and remounts protected editors
into their locked state.

Encrypted bodies are intentionally opaque to Git and line-oriented tools. A
small edit produces a new age envelope, so meaningful line diffs, merges, and
blame for the body are lost. Frontmatter remains diffable.

## Features unavailable for protected bodies in v1

- Server-side full-text search and snippets.
- Body-derived outlinks, backlinks, unresolved links, blocks, word counts,
  similar-note data, and content-index descriptions.
- Body-aware CLI mutations and task/journal helpers.
- LSP symbols, hover body details, completion, references, and rename.
- Native iOS reading, decryption, or editing. iOS shows metadata and a locked
  message without exposing the armor as editable Markdown.

These features fail explicitly or return empty body-derived results rather
than treating ciphertext as Markdown.

## Cache scrubbing and storage limits

When a note becomes protected, Clepsydra deletes its previously derived rows,
overwrites searchable body projections, and checkpoints/scrubs the SQLite
database, WAL, and shared-memory sidecars. This prevents known plaintext from
remaining in Clepsydra's live cache files.

Scrubbing cannot guarantee physical erasure from SSD wear-leveling, copy-on-
write filesystems, snapshots, forensic remnants, or backups. If stronger
device-level guarantees are required, use full-disk encryption and manage
snapshots/backups accordingly.

## Git, backups, and recovery

Protection affects the current note file and Clepsydra's current cache. It does
not rewrite Git history or old backups. Purge historical plaintext separately
if your threat model requires it, understanding that history rewriting is a
destructive repository operation.

Back up all of the following:

- the vault, including `.clepsydra/crypto/keyring.toml`;
- any `<key-id>.identity.age` password-wrapped identity;
- at least one separately stored plaintext recovery identity.

The wrapped identity is sensitive ciphertext. It is designed to be backed up,
but its security depends on the password and it should not be published.

Recovery is impossible if every usable identity is lost: for password mode,
that means losing both the recovery identity and either the wrapped identity or
its password; for import-only mode, losing the imported identity is final.
Clepsydra has no escrow or password-reset backdoor.

## Browser and malicious-client limitations

Clepsydra does not persist the plaintext identity, password, or decrypted note
body in localStorage, sessionStorage, or serialized Zustand state. Other UI
preferences may still use browser storage. Browser developer tools, extensions,
accessibility software, crash capture, or malware with access to the page can
observe plaintext while the vault is unlocked.

The production Content Security Policy reduces accidental script injection,
but it cannot defend against a malicious or compromised Clepsydra frontend. A
client that runs in the unlocked page can read the identity and plaintext.
Likewise, do not paste secrets into logs, bug reports, screenshots, or browser
consoles; application logging is designed not to include note bodies, but
external tooling is outside that boundary.

## Interoperability

The body is one canonical ASCII-armored age v1 file. A recovery identity can
decrypt it with a compatible age CLI. Re-encrypted external content must use
the keyring's active recipient, remain canonical armor, and keep the note's
TOML encryption metadata consistent. Keep a backup before replacing files by
hand.

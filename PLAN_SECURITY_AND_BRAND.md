# Plan: security, privacy and the "take back" brand

There are two goals:

1. **Security that holds up when an agency's security team reviews it.**
2. **A brand that says plainly what LLMesh is for:** taking back control of your compute and your data from cloud AI.

This plan builds on [PLAN_MULTI_GPU_AND_RELEASES.md](PLAN_MULTI_GPU_AND_RELEASES.md) and [CODE_REVIEW.md](CODE_REVIEW.md).

---

## 0. Read this first: what we can and can't promise

**No software is "impossible to hack"**, and no honest vendor says so. Agency security reviewers treat claims like that as a red flag. In the US, an overstated security claim can also be a deceptive-practices problem: the FTC acted against Zoom over its 2020 "end-to-end encryption" claims. The goal here is the next best thing, and it's what government buyers actually want:

> **Verifiable privacy.** Every request has a privacy level the user chose. The software enforces it and fails closed. You can prove afterwards where the data went, and security reviewers can check the design.

Here are the hard limits we design around:

- **A GPU has to see plaintext to run a model.** Encryption protects data *in transit* and *at rest*, but the machine doing inference sees the prompt. So there are only three ways to keep a prompt private from someone:
  1. **Run it locally.** Nobody else sees it.
  2. **Run it on machines you trust.** Your own group, behind authentication and encryption.
  3. **Run it in hardware-isolated confidential computing** (TEE) with **remote attestation.** This works today on data-center GPUs (NVIDIA H100/H200/Blackwell in confidential-computing mode, inside AMD SEV-SNP or Intel TDX virtual machines). Consumer RTX cards don't support it.
- **Fully homomorphic encryption and secure multi-party computation** (inference on encrypted data) are many orders of magnitude too slow for LLMs today. Keep them as research only. Don't market them.
- **Some design choices are disqualifying for most government use as they stand:**
  - The **public blockchain** publishes metadata: who paid which worker, and when.
  - The **public Hyperswarm DHT** exposes IP addresses and topic membership to strangers.
  - The current crypto (Noise with ChaCha20/BLAKE2, Nostr secp256k1 Schnorr signatures) uses **algorithms that aren't FIPS-approved**.
  - The default models are **Qwen**, which Alibaba develops in China. Several US states and agencies restrict AI models of Chinese origin.

  None of this is a bug for the community edition. All of it needs a separate mode for government use (§4).

---

## 1. Threat model (write it down first)

Create `docs/security/threat-model.md` using STRIDE per component: desktop app, local API, coordinator, worker, mesh, Ollama runtime, payments, update channel, build pipeline.

| Adversary | Examples | What we defend |
| --- | --- | --- |
| Network observer | ISP, Wi-Fi attacker, state-level passive collection | Content and as much metadata as possible |
| Untrusted mesh peer | A stranger on the DHT topic, a peer that has been removed from the group | Content, connection slots, the trusted-member list |
| Malicious or compromised worker | A group member's machine with malware | Content is visible to that worker by design, unless the request uses the attested tier. Limit it with policy plus audit. |
| Malicious coordinator | Wrong payouts, free work | Payment integrity (CODE_REVIEW P1-1, R1) |
| Local malware on the user's machine | Infostealer | Keys in hardware, encrypted history, no secrets in the renderer |
| Supply chain | A compromised npm package, a tampered release or model file | Signed, reproducible, provenance-attested builds and models |
| Future quantum adversary | "Harvest now, decrypt later" | Hybrid post-quantum key exchange |

Each finding gets an ID and an owner, and links to a test or an accepted-risk entry.

---

## 2. Privacy levels: the core feature

Every request carries a **privacy level**. The router enforces it and **fails closed**: if no route meets the level, the request errors. It never quietly falls back to a lower level.

| Level | Where the prompt may go | Protection |
| --- | --- | --- |
| `local` | This machine only | Never leaves the device. History is encrypted at rest. |
| `trusted` | Members of your group, which you approved | Mutually authenticated, end-to-end encrypted, workers don't keep data, audited |
| `attested` | Workers whose hardware proves they run unmodified LLMesh in a TEE | As `trusted`, plus a cryptographic check of the worker's hardware and software before any data is sent |
| `open` | *(future)* Any paid worker | Community only, never for sensitive data, off by default |

How it's set and shown:

- **API:** `llmesh_privacy: "local" | "trusted" | "attested"` on the request, an `X-LLMesh-Privacy` header, or a per-API-key default. Admin policy can enforce a minimum level per key or per user.
- **Desktop:** a privacy selector next to the chat box, plus a **privacy receipt** on every answer. The receipt says where the request ran, what encryption was used, the attestation result, and the retention policy. This is a security feature and also the brand's main visual (§6).
- **Code:** `planRoute()` filters on the level before it ranks anything. Add property tests: a route never has a lower privacy level than the request asked for.

---

## 3. Cryptographic architecture

### 3.1 Two crypto profiles, one interface

Add `src/core/crypto/` with a small, audited interface (`kem`, `aead`, `sign`, `verify`, `hash`, `kdf`, `random`) and two implementations:

| Profile | Key exchange | Encryption | Signatures | Hash | Used by |
| --- | --- | --- | --- | --- | --- |
| **community** | X25519 + **ML-KEM-768** hybrid | ChaCha20-Poly1305 | Ed25519 | BLAKE2b / SHA-256 | Default build |
| **fips** | ECDHE **P-384** + **ML-KEM-1024** hybrid | **AES-256-GCM** | **ECDSA P-384** (later ML-DSA-87) | **SHA-384** | Government mode |

The FIPS column follows NSA's CNSA suite. ML-KEM is NIST FIPS 203 and ML-DSA is FIPS 204. Notes:

- **The FIPS profile must run on a validated module.** Node's bundled OpenSSL **isn't** a FIPS 140-3 validated module. Build or ship the Linux server against the OS's validated OpenSSL: RHEL, Ubuntu Pro FIPS, or Windows CNG in FIPS mode. Check the active module at startup (`crypto.getFips()`) and refuse to start in FIPS mode without it. Only claim "FIPS 140-3 validated" by naming the module's certificate number, never for our own code.
- **Post-quantum:** use hybrid key exchange in *both* profiles, so recorded traffic stays safe even against a future quantum computer. Check which Node and OpenSSL versions expose ML-KEM before relying on it. Otherwise use an audited library (e.g. `@noble/post-quantum`) for the community profile only.
- **No home-made crypto.** Use standard constructions: **TLS 1.3 with mutual TLS** for the FIPS mesh transport, **Noise** for community, **HPKE (RFC 9180)** for sealing data to a key, and **COSE/JOSE or EIP-712** for signed objects. Get the protocol reviewed (§5).

### 3.2 End-to-end encryption to the worker

Today the coordinator decrypts and re-encrypts every request.
- **For external clients:** seal the request with **HPKE to the selected worker's public key**. For `attested` workers, that key comes from the attestation report. The coordinator and any relay only see ciphertext plus routing metadata. The response comes back sealed the same way.
- **Pad** prompt and response sizes to buckets (e.g. powers of two, max 64 KiB of padding) so the ciphertext length gives away less about the content. Add optional timing jitter for streaming.

### 3.3 Group identity and keys

- **Group membership as signed certificates.** Today membership is an environment variable list of trusted keys. Replace it with a group CA key held by the group admin, ideally on a hardware key.
  - Each member device gets a short-lived certificate (default 30 days, auto-renewed) that lists its roles: `requester`, `worker`, `coordinator`, `admin`.
  - The admin publishes a **signed revocation list** that every node checks on connect and every 5 minutes.
  - In government mode this becomes **X.509 PKI**: an agency CA, PIV/CAC smartcards for users, device certificates for servers.
- **Keys in hardware wherever possible:**
  - Windows: TPM 2.0 via the CNG Platform Crypto Provider.
  - macOS: Secure Enclave.
  - Linux servers: TPM 2.0 (`tpm2-pkcs11`) or an HSM through PKCS#11.
  - Users: YubiKey or other FIDO2/PIV keys.

  Software key files remain only as a fallback in the community edition, encrypted with a passphrase (*CODE_REVIEW P1-8*).
- **Key rotation:** session keys are ephemeral, per connection. Device keys rotate on certificate renewal. Rotation must work without manual re-pairing.
- **Recovery:** encrypted backups use a recovery key the user prints or stores. The admin can split it with Shamir secret sharing among several people. Recovery lets you regain access; it never lets an admin decrypt users' history.

### 3.4 Confidential computing for the `attested` level

1. Workers run in a **confidential VM** (AMD SEV-SNP or Intel TDX) with an NVIDIA GPU in **confidential-computing mode**.
2. At boot the worker creates an ephemeral HPKE key and requests a CPU attestation report, putting a hash of that public key in the report data. It also gets a GPU attestation report (NVIDIA's attestation SDK/service).
3. The worker image is a **reproducible, signed build**. Its measurement (launch digest) and the **model digest** are published with each release.
4. Before sending anything, the client verifies:
   - the hardware vendor's certificate chain
   - the measurement against the published list
   - the model digest
   - that the report is recent

   Then it seals the request to that key. If any check fails, the request fails closed.
5. Show the verification result in the privacy receipt, and record it in the audit log.

Consumer and gaming GPUs can't do this, so `attested` is a data-center and agency-server feature. The UI must say so plainly.

### 3.5 Data at rest and data retention

- **Workers keep nothing by default.** They never write prompts or outputs to disk, log content or cache conversations. The code enforces it with a test that runs a request and then greps the data directory, logs and temp folder for the prompt text. Ollama debug logging must stay off. Recommend encrypted swap, and turn off crash dumps (Electron `crashReporter` off; Windows WER and Linux `core_pattern` guidance in the hardening guide).
- **Requester history** (desktop chat, SQLite) is encrypted with a key wrapped by the OS keystore or TPM. Use AES-256-GCM per record, or SQLCipher. History can be turned off. There's "delete everything", plus a default auto-delete after 30 days.
- Wipe secrets from memory where the platform allows. Treat this as a best effort and document it as such.

### 3.6 Metadata privacy

- **Government and enterprise mode turns off the public DHT and the blockchain entirely.** Peers are found through organization-run bootstrap nodes or a static peer list, over mTLS. Payments and accounting become an off-chain internal ledger, or are switched off.
- **Community mode:** use a private topic derived from the group secret (*CODE_REVIEW P1-4*). Send the minimal hello until the peer is authenticated (*P1-3*). Note that on-chain payments are public. Prefer payment channels (*R1*) so the chain only sees channel opens and closes.

---

## 4. Government mode ("LLMesh Sovereign")

The same codebase, built with `--edition sovereign` and locked by a **signed policy file** from the organization's admin.

**Turned off:**
- the token, wallet and blockchain
- the public DHT
- Nostr identities
- auto-installing runtimes
- any outbound connection that isn't allowlisted (updates come from an internal mirror)

**Turned on:**
- the FIPS crypto profile
- PKI and PIV/CAC sign-in
- RBAC: admin, operator, user, auditor
- a minimum privacy level per role
- the audit log (§4.1)
- encrypted history, or history off
- air-gapped install and model import

**Model allowlist by provenance.** The catalog gets fields for `origin`, `license` and `digest`. Policy can restrict models by origin. Offer non-Chinese-origin options such as Llama, Gemma, Mistral, IBM Granite, Microsoft Phi and OpenAI gpt-oss, after checking each license. Each agency decides what it allows; we provide the controls and the documentation.

### 4.1 Audit log
- An append-only log where each entry is **chained by hash** to the previous one and **signed** by the node key. Every hour, a checkpoint is cross-signed by another node so tampering shows up.
- By default it records **metadata only**: who, when, privacy level, worker, model, tokens, attestation result, policy decisions. Logging content is a separate, explicit, admin-only policy.
- Export to a SIEM via syslog/CEF or JSON, plus `llmesh audit verify` to check the chain.

### 4.2 What "legally usable by an agency" actually takes
We can't certify ourselves. An agency grants its own **authority to operate (ATO)** under the NIST Risk Management Framework. Our job is to make that easy and fast by supplying:
- **NIST SP 800-53 Rev. 5 control mapping** for the software (`docs/compliance/800-53.md`): which controls LLMesh meets, which it supports, and which belong to the agency.
- **System Security Plan inputs**, a **hardening guide** in STIG style, and the **FIPS module statement**.
- An **SBOM** (CycloneDX) and **SLSA build provenance** with every release, plus the **CISA secure software self-attestation form** (required for software sold to US federal agencies under OMB M-22-18 / M-23-16).
- An **independent penetration test report** and **crypto protocol review** (§5).
- **Section 508** accessibility conformance (a VPAT) for the desktop app.
- **FedRAMP** applies only if *we host* LLMesh as a cloud service. Self-hosted software doesn't need it. If a hosted offering is planned, that's a separate, large project.
- **Export controls:** encryption software is controlled. Publicly available open-source encryption usually needs a one-time email notification to the US Commerce Department's export agency (BIS, which also goes to NSA) under EAR §742.15(b). **Have counsel confirm this before the public release.**
- **DoD use** (CMMC, Impact Levels 4/5, classified networks) goes much further. Treat it as out of scope until a sponsor asks, and build nothing that prevents it later.

---

## 5. Assurance: proving it, not just claiming it

- **Supply chain:**
  - Pin GitHub Actions by commit SHA, and generate **SLSA level 3 provenance** with GitHub artifact attestations.
  - Sign releases and container images with **Sigstore/cosign**.
  - Make builds **reproducible**: an independent rebuild must give byte-identical artifacts, and CI checks this.
  - Scan dependencies with `osv-scanner` and `npm audit` on every PR.
  - Keep dependencies few. Every new runtime dependency needs a justification in the PR.
- **Signed models:** pin each model by digest in a signed catalog. Verify after pull and after offline import. The existing bundle verifier (`model-bundle.js`) is a good start; extend it to every pull.
- **Fuzzing:** run continuous fuzzing on the mesh frame parser, API request validation, the NDJSON stream parser, certificate and attestation parsing, and the policy file parser.
- **Formal checks:** model the handshake and the group-certificate protocol in **Tamarin or ProVerif**. Prove mutual authentication, key secrecy and that a removed member can't get back in.
- **External reviews:** before claiming sovereign readiness, get an independent **penetration test** (app, API, mesh), a **cryptography review**, and a **smart contract audit** (community edition only). Publish summaries.
- **Disclosure:**
  - `SECURITY.md` with a security contact and a PGP key or GitHub private advisories.
  - A **90-day disclosure policy**.
  - A bug bounty once the external reviews are done.
  - A published security changelog.
- **Desktop hardening:** in addition to what exists (sandbox, contextIsolation, CSP):
  - Set Electron **fuses**: `RunAsNode` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on.
  - Tighten the CSP: `connect-src` must not allow all `https:`.
  - Verify update signatures.
  - Never send the API key to the renderer (*P1-7*).
  - Offer the local API over a named pipe or unix socket with per-client scoped, expiring keys.
- **Server hardening:** use the systemd sandboxing from the release plan, plus a seccomp allowlist and AppArmor/SELinux profiles shipped in the packages.

---

## 6. Brand: "Take back your compute"

### 6.1 The message
LLMesh is how people and organizations **take back** AI. They run it on hardware they own, with data that never goes to a cloud they don't control.

- **Primary line:** **Take back your compute.**
- **Supporting lines:**
  - Your hardware. Your data. Your AI.
  - Private by default. Provable by design.
  - The cloud is optional.
  - AI that answers to you.
- **What the brand stands for:** **ownership** (your machines, your models), **privacy you can verify** (receipts, attestation, open code), and **solidarity** (pool your GPUs with people you trust instead of renting from a hyperscaler).
- The existing tagline **"The people's compute"** fits the community edition. Keep it.

### 6.2 Two editions, one core

| | **LLMesh** (community) | **LLMesh Sovereign** (government / enterprise) |
| --- | --- | --- |
| Voice | Bold, populist: "take back" | Calm and precise: "sovereign AI on infrastructure you control" |
| Main promise | Your data never feeds someone else's cloud | Your data stays inside your boundary, with an audit trail |
| Features | Mesh with friends, token rewards, energy tracking | FIPS, PKI/CAC, RBAC, audit, air-gapped install, no token |
| Look | Electric blue on near-black (current) | Same mark, a restrained navy/slate palette, no token visuals |

A government buyer must never see token or "earn" messaging in Sovereign. Remove it at build time, not just hide it.

### 6.3 Rules for claims (enforced in copy review)
- **Never say:** "unhackable", "impossible to hack", "military-grade", "100% secure", "zero risk", "NSA-proof", "anonymous" (we aren't), or "FIPS-certified" for our own code.
- **Say instead:** "end-to-end encrypted", "never leaves the machines you choose", "hardware-attested", "uses FIPS 140-3 validated cryptography (certificate #…)", "independently pen-tested (date, firm)".
- Every security claim on the website, in the README or in the UI must link to the doc or test that backs it. Add `docs/claims.md` mapping each claim to its evidence, and review it every release.

### 6.4 Visual and product work
- **Logo:** the current `assets/branding/logo.png` has stray pixel speckles around the shape (it looks traced or AI-generated). Redraw it as a clean **SVG** and export the PNG/ICO sizes from it: 16, 32, 48, 256, 512, 1024. Add a monochrome version for the Sovereign edition and for print.
- **Privacy receipt and shield:** a consistent badge system: 🔒 Local, 🛡 Trusted group, ✓ Attested. It appears on every answer, in the worker list and in the API response (`llmesh_receipt.privacy`). This is the most important brand element, because it shows the promise in action.
- **UI copy:**
  - Overview headline → **"Take back your compute."**
  - Subhead → "Run AI on hardware you own. Share it only with people you trust."
  - Wallet copy stays community-only.
- **README and website hero:** the logo, "Take back your compute", three proof points (local by default · end-to-end encrypted mesh · verifiable privacy receipts), then downloads.
- **Manifesto page** (`docs/why.md`): why owning your compute matters, in plain language and without fear-mongering. Cover cost, privacy, resilience and control.
- **Voice guide** (`docs/brand/voice.md`): direct, confident, honest about limits. Avoid hype and crypto-bro vocabulary. Name limitations openly; that honesty *is* the brand.

---

## Phases and done criteria

| Phase | Scope | Done when |
| --- | --- | --- |
| **S0. Foundations** | Threat model, `SECURITY.md`, claims rules, CODE_REVIEW P1-3/4/7/8 | Threat model merged; no secrets in the renderer; mesh sends only a minimal hello before authentication |
| **S1. Privacy levels** | §2 routing, receipts, fail-closed | A property test proves no downgrade; the receipt shows in the UI and API |
| **S2. Group PKI** | §3.3 certificates, revocation, hardware keys on Windows/Linux | A revoked member is rejected within 5 minutes; keys sit in the TPM on a test machine |
| **S3. Crypto profiles + PQ** | §3.1 interface, community profile with hybrid ML-KEM | Every crypto call goes through the interface (lint rule); hybrid handshake interop-tested |
| **S4. E2E + no-retention** | §3.2 HPKE sealing, padding; §3.5 | The coordinator only sees ciphertext on external requests; the grep test finds no prompt on worker disk |
| **S5. Sovereign edition** | §4: FIPS profile, mTLS, RBAC, audit log, policy file, no token/DHT, model provenance | Starts in RHEL FIPS mode; `llmesh audit verify` passes; build contains no wallet code |
| **S6. Attested level** | §3.4 on a confidential-computing VM with an H100 | The client rejects a modified image and accepts the published measurement |
| **S7. Assurance** | §5: SLSA, reproducible builds, fuzzing, Tamarin model, external pentest + crypto review | Reports received; critical/high findings fixed; summaries published |
| **S8. Compliance package** | §4.2: 800-53 mapping, hardening guide, SBOM, self-attestation, VPAT | A pilot agency's security team can start an ATO review with only our documents |
| **B1. Brand** | §6: SVG logo, receipts/shield, copy, README hero, voice guide, claims map | Copy review passes the §6.3 rules; both editions build with the right branding |

S0–S1 and B1 can start now. S2–S4 are the core engineering. S5–S8 are needed before any agency pilot.

## Open decisions for the owner

1. **Which government market first?** State and local, federal civilian, or defense? This sets how strict S5–S8 must be.
2. **Should Sovereign be a separate product name** ("LLMesh Sovereign") or just a "Government mode" switch inside LLMesh?
3. **Default models:** keep Qwen for community and add non-Chinese-origin options for Sovereign? Or switch the default for everyone?
4. **Budget for external reviews:** a penetration test, a cryptography review and a contract audit usually each cost tens of thousands of dollars or more. Get quotes before committing to dates.
5. **Confidential-computing hardware for S6:** rent H100 confidential VMs from a cloud, or partner with an agency that has them?

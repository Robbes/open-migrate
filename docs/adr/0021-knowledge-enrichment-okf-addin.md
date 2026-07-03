# ADR-0021: Optional knowledge-enrichment add-in (OKF) — a parallel, opt-in `KnowledgeSink`

- **Status:** Accepted — **planned / optional; NOT in the MVP**
- **Date:** 2026-06-22
- **Relates to:** ADR-0007 (reuse/engines), ADR-0009 (repo strategy), ADR-0011 (sovereignty), ADR-0015 (backup/data scope), ADR-0020 (rebuildable cache / natural-key idempotency).

## Context
We already extract every item during migration (the `SourceConnector` reads content; the reconcile loop touches each one). A recurring ask is to produce, **in parallel**, an agent-readable knowledge bundle alongside the migrated data — "knowledge files with an ontology," as an add-in.

The **Open Knowledge Format (OKF)** — an open spec published by Google Cloud (v0.1, June 2026) — represents knowledge as a **directory of markdown files with YAML frontmatter**, where the **file path is a concept's identity** and **markdown links between files form the graph**; the only required field is `type`. It is deliberately far lighter than OWL/RDF (which are more expressive but need schema registries, tooling, and expertise). That makes a knowledge/ontology side-output cheap to produce from our TypeScript stack — but it is a **different concern** from migration and is **privacy-sensitive** (it derives relationships/topics from personal mailboxes).

## Decision
1. **Optional, opt-in, parallel — never on the migration's critical path, and NOT in the MVP.** Migration correctness must never depend on it; sink failures are logged and non-fatal.
2. **Seam:** a `KnowledgeSink` port (in `@openmig/shared`) that the reconcile loop fans each fetched item out to, as a zero-or-more observer; an optional `@openmig/enrich` package implements it. When no sink is registered, the hook is a no-op (zero impact when off).
3. **Pluggable writers behind the sink:** an **OKF writer** (markdown + YAML frontmatter; file path = concept identity) first; optional **JSON-LD / RDF (Turtle)** writers later for a *formal* ontology. Same entities, multiple serializations.
4. **Ontology = a small, producer-defined vocabulary.** OKF gives structural interoperability only; semantics are ours: a minimal type set (Person, Organization, Thread, Message, Document, Folder, Topic) plus link conventions. That lightweight vocabulary *is* the ontology; a formal OWL/SKOS export is an optional extra, not the default.
5. **Deterministic-first.** Metadata-level concepts (senders/recipients, threads, dates, folders, attachment types) are pure deterministic parsing — **no AI**. LLM/NLP enrichment (topics, summaries, entity/relationship extraction) is a **separate, further opt-in layer**, never bundled into the migration path.
6. **Idempotent & rebuildable.** Concept identity reuses the same natural key (Message-ID / contact email / folder path), so re-runs **update, not duplicate** (aligns ADR-0020); a lost bundle is rebuilt from the migrated target.
7. **Local-only by default.** Output goes to a user-controlled directory / git repo, never transmitted off the device; explicit consent; honors the sovereignty stance (ADR-0011).
8. **Isolate behind the writer interface.** OKF is v0.1 (a v0.2 is expected) and there is even a name collision with an unrelated `OKF-SCIS` supply-chain spec — so avoid lock-in; emit JSON-LD/RDF alongside if OKF shifts.

## Consequences
- Users can get a portable, agent-ready "digital brain" of their migrated corpus with no heavy ontology tooling — an SMB-leaning differentiator.
- Adds an optional package plus a guarded fan-out hook in `core`; **zero impact when disabled**.
- The privacy surface grows (derived/inferred data), so it must be opt-in, local, and consented — to be documented in `SECURITY.md` / the threat model when built.
- Format-churn risk (OKF v0.1) is contained by the writer abstraction.
- **Sequencing:** after the file-migration slices (mail is 0001; files are 0003+), though the sink can also attach to the mail path. Tracked in §25 backlog.

## Alternatives considered
- **Formal ontology (OWL/RDF) as the primary output:** rejected as default — heavy tooling/expertise, poor fit for families/SMBs; kept as an optional writer.
- **Bake enrichment into the migration path:** rejected — couples a different concern to migration correctness and adds cost/non-determinism.
- **LLM-first extraction:** rejected as default — expensive, non-deterministic, dependency-heavy; deterministic metadata-first, LLM as an opt-in layer.
- **Process bundles in a managed/cloud service:** rejected — violates the local-only/sovereignty stance.

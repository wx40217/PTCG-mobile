# Frozen card data tooling

Two entry points, both dependency-free (Node >= 20):

```sh
node tools/card-data/build-card-data.mjs           # validate the committed data
node tools/card-data/build-card-data.mjs --write   # regenerate derived files

node --test tools/card-data/identity.test.mjs           # identity policy: same-name vs same-effect
node --test tools/card-data/build-card-data.test.mjs    # validator: declared same-name variants + name cap
node --test tools/asar-inspect/asar-lib.test.mjs        # asar reader regression tests
```

## Identity model (`identity.mjs`)

Card identity is split into three independent axes so that a same-name
different-effect print, and a true same-effect reprint, can never be
confused:

| field | meaning |
| --- | --- |
| `effect_identity` | `fx:<class>:<name>:<sha256-12>` of the canonical rule payload (class, category/tags, stats, abilities/attacks, special-card rule text, trainer effect text). Two printings share it only when that payload is byte-identical. |
| `print_identity` | `print:<product code>:<printed number>` for one concrete printing. |
| `name_group_key` | Key for the at-most-4 same-name construction rule. Official rules may declare different names to be one group (e.g. the 博士的研究 variants); such declarations are evidence and live in the identity registry, not in name-string logic. A group whose prints have *different* effects must additionally be declared in `environment.name_variant_declarations`; the builder resolves each declared variant to its computed `effect_identity`, so the name cap merges the variants while the effects stay distinct. |

`composeFullText(card)` is the deterministic card-face reading stored in
`full_text_zh`: effect text exactly once, plus the printed class rule for
trainers (and both the printed and the 2025-01-17 effective class rule for a
Pokémon Tool printed as an Item). The validator recomputes it and rejects
duplicate paragraphs, so a stale "dedupe" cannot hide a missing rule.

## What `build-card-data.mjs` checks

- details / index / decks / matrix all carry the three identity references and they agree;
- effect identities merge printings only with an identical canonical payload (none in the current evidence set), and `card-identities.json` records every mapping;
- a name group with more than one effect identity only passes when `environment.name_variant_declarations` declares each variant (card ids + label); the declaration must cover every effect identity exactly once, reference real cards inside the group, and is rejected when stale or incomplete. The same-name cap still counts all declared variants together;
- each deck is exactly 60 cards, same-name <= 4 by `name_group_key` (basic Energy exempt), at least one Basic Pokémon, E/F/G marks, no ACE SPEC/Radiant/Prism Star, and every `evolves_from` has its pre-evolution in the deck;
- the effect matrix is exactly the union of the four decks, with text, mechanics, source, per-deck counts and `effect_acceptance` matching the details and deck lists;
- the environment records the dated 2024-12-22 / 17144 rule change and no longer presents the 2025-05-20 / 17127 product-image notice as a rules erratum;
- the environment also records the pre-cutoff rules-body evidence: the 2024-08-18 `basic_rules07` snapshot, the official `tcg/pdf/basic_rules08.pdf` guide asset, and the versioned `advanced_rules_manual` (version, date, PDF hash).

`--write` refuses to run while source-level checks fail. Redundant fields
(index refs, deck metadata, matrix, registry, per-card identity fields) are
regenerated, then validated again against the files on disk.

`identity.test.mjs` pins the same-name-different-effect and same-effect-reprint
behaviour with synthetic cards, so the policy is exercised, not just described.
`build-card-data.test.mjs` drives the real `computeIdentities`/`validateSources`
entry points with a synthetic evidence set: declared variants pass, an undeclared
or incomplete declaration fails, and the name cap still merges 3+2 copies.

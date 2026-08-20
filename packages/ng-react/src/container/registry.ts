// The provider registry (task 2.1): the store that records `ProviderRecord`s
// against a kernel-assigned owning module, and enforces every
// registration-time rule (C5, C6, C9). No resolution here — instance
// construction, scopes, and disposal are the resolution engine (task 2.2);
// reactive notification and contribution ordering are task 2.3.
//
// `ProviderRegistry` is internal: it is not exported from `index.ts`. The
// kernel (a later stage) is the only intended caller.

import {
  DuplicateProviderError,
  DuplicateRegistrationError,
  InvalidDescriptorError,
  ProviderKindConflictError,
} from '../errors';
import type { AnyProviderRecord, ProviderRecord } from '../provider';
import type { Scope } from '../types';
import type { AnyToken, Token } from '../token';

/**
 * A `ProviderRecord` together with the module that registered it.
 *
 * **C9** — provenance is kernel-assigned: `owner` is never read off the
 * record (`ProviderRecord` deliberately carries no owner field, see
 * `provider.ts`) and is instead the `moduleId` argument the caller passed to
 * `register()`. A module can no more misreport its own identity here than
 * it can fabricate a `ProviderRecord` by hand.
 */
export interface RegisteredProvider<T = unknown> {
  readonly record: ProviderRecord<T>;
  readonly owner: string;
}

/** One row of `inspect()`'s provider table — see `RegistrySnapshot`. */
export interface ProviderSnapshotEntry {
  readonly tokenLabel: string;
  readonly kind: 'provide' | 'contribute';
  readonly scope: Scope;
  readonly owner: string;
  readonly override: boolean;
}

/** One row of `inspect()`'s per-module table — see `RegistrySnapshot`. */
export interface ModuleSnapshotEntry {
  readonly moduleId: string;
  /** Labels of every token this module provides or contributes to, sorted. */
  readonly tokenLabels: readonly string[];
}

/**
 * **G3** data source: a plain, JSON-serialisable snapshot of everything the
 * registry knows. Both arrays are sorted deterministically (`providers` by
 * `tokenLabel` then `owner`; `modules` by `moduleId`) so that registering the
 * same set of modules in a different order produces byte-identical output —
 * this is what makes graph snapshot tests (dev tools, later stages) safe
 * against non-determinism instead of flaky.
 */
export interface RegistrySnapshot {
  readonly providers: readonly ProviderSnapshotEntry[];
  readonly modules: readonly ModuleSnapshotEntry[];
}

/** Renders a value for an error message, matching `provider.ts`/`define-module.ts`. */
function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return `string '${value}'`;
  }
  return typeof value;
}

/** A single planned action from pass 1 of `register()` — see the comment there. */
type PlannedAction =
  | { readonly kind: 'provide'; readonly token: AnyToken; readonly entry: RegisteredProvider }
  | { readonly kind: 'contribute'; readonly token: AnyToken; readonly entry: RegisteredProvider };

/**
 * Shared, frozen "no contributions" sentinel. Returned by `getContributions`
 * for a token that has never had one, instead of allocating a fresh `[]`
 * per call — same reasoning as the copy-on-write below: a stable reference
 * across repeated calls is what lets a caller's identity-based
 * change-detection treat "still nothing" as "unchanged".
 */
const EMPTY_CONTRIBUTIONS: readonly RegisteredProvider[] = Object.freeze([]);

export class ProviderRegistry {
  /**
   * `provide`d tokens: at most one `RegisteredProvider` per token. Keyed by
   * `AnyToken` (ADR-10) — `Token<T>` is invariant in `T`, so a single `Map`
   * cannot be keyed by `Token<unknown>` and still accept the differently-typed
   * tokens real providers use; `AnyToken` is the erased form built for
   * exactly this "heterogeneous collection" case. `Token<T>` is directly
   * assignable to `AnyToken` for any `T` (unlike `Token<unknown>`), so no
   * cast is needed when a caller's concretely-typed token is stored or
   * looked up here — see `getProvider`/`hasToken`/`ownerOf` below.
   */
  private readonly providers = new Map<AnyToken, RegisteredProvider>();
  /**
   * `contribute`d tokens: an ordered, **frozen** list of `RegisteredProvider`
   * per token. Every array stored here is replaced wholesale (copy-on-write)
   * rather than mutated in place — see the comment in `register()`'s commit
   * pass — so a reference to one of these arrays, once handed out by
   * `getContributions`, is safe to cache and compare by identity.
   */
  private readonly contributions = new Map<AnyToken, readonly RegisteredProvider[]>();
  /** Every token (provided or contributed) a module currently owns — drives `withdraw` and `inspect`. */
  private readonly moduleTokens = new Map<string, Set<AnyToken>>();
  /**
   * Module ids currently registered. Tracked separately from `moduleTokens`
   * so a module registered with zero records (a legal, if unusual,
   * descriptor with no `providers`) still counts as registered for the
   * idempotence check below.
   */
  private readonly registeredModules = new Set<string>();
  /** Populated by `setKnownModules` — backs `findModuleByTokenLabelPrefix`. */
  private knownModules = new Set<string>();

  /**
   * Records every provider/contribution in `records` as owned by
   * `moduleId` (C9 — `moduleId` is the *only* source of provenance; nothing
   * on a `ProviderRecord` is consulted for it).
   *
   * Registration is atomic: `records` is validated in a first pass against
   * both the registry's existing state and the records already accepted
   * earlier in this same call (so a module conflicting with itself inside
   * one `records` array is caught too), and nothing is written to the
   * registry's state until every record in the batch has passed. This
   * matters for HMR: without it, a batch that fails on its third record
   * would leave the first two silently registered, corrupting the registry
   * for the retry that follows.
   *
   * @throws {InvalidDescriptorError} for a malformed `moduleId` or `records`.
   * @throws {DuplicateRegistrationError} if `moduleId` is already registered
   *   (call `withdraw(moduleId)` first — e.g. before an HMR re-activation).
   * @throws {DuplicateProviderError} (C6) for a second unconditional
   *   `provide()` of a token some module already provides.
   * @throws {ProviderKindConflictError} (C5) for a `provide()`/`contribute()`
   *   of a token the registry already holds under the other kind.
   */
  register(moduleId: string, records: readonly AnyProviderRecord[]): void {
    if (typeof moduleId !== 'string' || moduleId.trim().length === 0) {
      throw new InvalidDescriptorError(
        `ProviderRegistry.register() requires a non-empty module id, got ${describeValue(moduleId)}.`,
      );
    }
    if (!Array.isArray(records)) {
      throw new InvalidDescriptorError(
        `ProviderRegistry.register(${moduleId}): records must be an array, got ${describeValue(records)}.`,
        moduleId,
      );
    }
    if (this.registeredModules.has(moduleId)) {
      throw new DuplicateRegistrationError(moduleId);
    }

    // Pass 1 — validate. `batchProviders` overlays the real `providers` map
    // for the duration of this call so that later records in the same batch
    // see the effect of earlier ones (e.g. a plain provide() followed by an
    // override provide() for the same token, both in this batch, is legal
    // and the override must win — same rule as across separate calls).
    // `batchContributionOwners` overlays `contributions` the same way.
    const batchProviders = new Map<AnyToken, RegisteredProvider>();
    const batchContributionOwners = new Map<AnyToken, string[]>();
    const plan: PlannedAction[] = [];

    for (const record of records) {
      const token = record.token;
      const existingProvider = batchProviders.get(token) ?? this.providers.get(token);
      const contributionOwners = [
        ...(this.contributions.get(token) ?? []).map((entry) => entry.owner),
        ...(batchContributionOwners.get(token) ?? []),
      ];

      if (record.kind === 'provide') {
        // C5: provide() is rejected outright if the token already has any
        // contributions — mixing kinds on one token is never allowed,
        // override or not.
        if (contributionOwners.length > 0) {
          throw new ProviderKindConflictError(
            record.token.label,
            'contribute',
            [...new Set(contributionOwners)].sort(),
            'provide',
            moduleId,
          );
        }
        // C6: override precedence. The rule is deliberately one-sided and
        // order-independent: a registration with `override: true` always
        // replaces whatever is there (nothing to reject — there's nothing
        // for `override: true` to conflict with, by definition); a
        // registration *without* `override: true` only succeeds when the
        // slot is empty. This makes the outcome independent of registration
        // order: whichever provide() call ever set `override: true` for a
        // token stays the effective provider — either because it replaced
        // an earlier plain provider, or because a later plain provider that
        // tried to replace it is rejected here.
        if (existingProvider !== undefined && !record.override) {
          throw new DuplicateProviderError(record.token.label, existingProvider.owner, moduleId);
        }
        const entry: RegisteredProvider = Object.freeze({ record, owner: moduleId });
        batchProviders.set(token, entry);
        plan.push({ kind: 'provide', token, entry });
      } else {
        // C5: contribute() is rejected if the token already has a single
        // provider — the reverse direction of the check above.
        if (existingProvider !== undefined) {
          throw new ProviderKindConflictError(
            record.token.label,
            'provide',
            [existingProvider.owner],
            'contribute',
            moduleId,
          );
        }
        const entry: RegisteredProvider = Object.freeze({ record, owner: moduleId });
        const owners = batchContributionOwners.get(token) ?? [];
        owners.push(moduleId);
        batchContributionOwners.set(token, owners);
        plan.push({ kind: 'contribute', token, entry });
      }
    }

    // Pass 2 — commit. Every entry in `plan` already passed validation, so
    // this loop cannot throw.
    //
    // Copy-on-write for contributions: build a *new* array rather than
    // pushing into the one already stored, then replace the map entry.
    // `getContributions` hands its return value out by reference (see
    // below), and task 2.3's reactive collections need to tell "unchanged"
    // from "changed" by comparing the reference they cached last time
    // against the one they get now. Mutating the stored array in place
    // would make every such comparison see the *same* object — reporting
    // "unchanged" even immediately after an addition — and silently break
    // C5 reactivity with no failing test. `withdraw` (below) already builds
    // a fresh array via `.filter`, so only this push-based path needed the
    // fix; the asymmetry between them is intentional, not an oversight.
    const ownedTokens = new Set<AnyToken>();
    for (const action of plan) {
      if (action.kind === 'provide') {
        this.providers.set(action.token, action.entry);
      } else {
        const existing = this.contributions.get(action.token) ?? EMPTY_CONTRIBUTIONS;
        this.contributions.set(action.token, Object.freeze([...existing, action.entry]));
      }
      ownedTokens.add(action.token);
    }
    this.moduleTokens.set(moduleId, ownedTokens);
    this.registeredModules.add(moduleId);
  }

  /**
   * Removes every provider and contribution owned by `moduleId` (F3
   * quarantine; A4 disposal cascades here too) and returns the distinct set
   * of tokens that were affected, so the caller (task 2.3's reactive
   * contribution collections) knows which subscribers to notify.
   *
   * Withdrawing a module that was never registered, or was already
   * withdrawn, is a no-op that returns an empty set — HMR and quarantine
   * code paths call `withdraw` defensively and should not have to guard
   * against "was this ever registered" themselves.
   */
  withdraw(moduleId: string): ReadonlySet<AnyToken> {
    const tokens = this.moduleTokens.get(moduleId);
    if (tokens === undefined) {
      return new Set();
    }

    for (const token of tokens) {
      const provider = this.providers.get(token);
      if (provider !== undefined && provider.owner === moduleId) {
        this.providers.delete(token);
      }

      const contributors = this.contributions.get(token);
      if (contributors !== undefined) {
        // `.filter` on a `readonly` array already returns a brand-new
        // (mutable) array — never `contributors` itself — so this path was
        // already copy-on-write; it only needed the same `Object.freeze` as
        // `register()`'s commit pass for the immutability guarantee to be
        // enforced, not just typed.
        const remaining = Object.freeze(contributors.filter((entry) => entry.owner !== moduleId));
        if (remaining.length > 0) {
          this.contributions.set(token, remaining);
        } else {
          this.contributions.delete(token);
        }
      }
    }

    this.moduleTokens.delete(moduleId);
    this.registeredModules.delete(moduleId);
    return tokens;
  }

  /**
   * The single provider for `token`, if any. Never returns a contribution.
   *
   * The `as RegisteredProvider<T> | undefined` here is the one cast this
   * class still needs, and it is a narrowing, not a widening: the `Map` is
   * keyed and valued by the erased `AnyToken`/`RegisteredProvider` (ADR-10),
   * so a lookup only ever hands back the erased shape; recovering the
   * caller's own `T` (which `register()` already guaranteed matches, because
   * a `RegisteredProvider<X>` can only ever have been stored under its own
   * `Token<X>`) is not something the type system can verify from inside a
   * generic method — `token: Token<T>` alone doesn't prove which concrete
   * `RegisteredProvider` a `Map<AnyToken, RegisteredProvider>` maps it to.
   */
  getProvider<T>(token: Token<T>): RegisteredProvider<T> | undefined {
    return this.providers.get(token) as RegisteredProvider<T> | undefined;
  }

  /**
   * Every contribution registered for `token`, in registration order. Empty
   * if none.
   *
   * The returned array is frozen — enforced, not merely typed `readonly` —
   * and is a *stable reference* for as long as the collection is unchanged,
   * becoming a *fresh* reference the instant a contribution is added or
   * removed (see the copy-on-write comment in `register()` and the `.filter`
   * in `withdraw()`). That combination is deliberate: task 2.3's reactive
   * contribution collections need a sound identity-based change signal to
   * skip notifying when nothing actually changed.
   */
  getContributions<T>(token: Token<T>): readonly RegisteredProvider<T>[] {
    // Returns the stored array by reference (never a fresh copy here) — the
    // stability guarantee above only holds if repeated calls that observe
    // no change return the *same* object, not merely an equal one.
    return (this.contributions.get(token) ?? EMPTY_CONTRIBUTIONS) as readonly RegisteredProvider<T>[];
  }

  /** Whether `token` has a provider or at least one contribution registered. */
  hasToken<T>(token: Token<T>): boolean {
    return this.providers.has(token) || (this.contributions.get(token)?.length ?? 0) > 0;
  }

  /**
   * The owning module of `token`'s single provider. Returns `undefined` both
   * when `token` is unknown and when it is a contribution token — a
   * contribution collection has potentially many owners, so there is no
   * single answer "ownerOf" can give; callers that need every contributor
   * use `getContributions` instead.
   */
  ownerOf<T>(token: Token<T>): string | undefined {
    return this.providers.get(token)?.owner;
  }

  /**
   * C8 suggestion support: given a token label such as
   * `'payments/PaymentGateway'`, returns `'payments'` — but only if a
   * module with that id is known to the registry (via `setKnownModules`).
   * This is what keeps the C8 "did you forget to list it in dependsOn?"
   * suggestion honest: a label prefix that merely *looks* like a module id
   * (or that names a module the composition root never registered at all)
   * must not be offered as a fix.
   */
  findModuleByTokenLabelPrefix(label: string): string | undefined {
    const separatorIndex = label.indexOf('/');
    if (separatorIndex <= 0) {
      return undefined;
    }
    const prefix = label.slice(0, separatorIndex);
    return this.knownModules.has(prefix) ? prefix : undefined;
  }

  /**
   * Tells the registry the full universe of module ids the kernel knows
   * about — registered *or* merely declared (e.g. via `dependsOn`) but not
   * yet activated — so `findModuleByTokenLabelPrefix` can distinguish a real
   * module id from an unrelated token label that happens to contain a `/`.
   * Replaces the previous set; the kernel calls this once after it finishes
   * registering descriptors, not incrementally.
   */
  setKnownModules(ids: readonly string[]): void {
    this.knownModules = new Set(ids);
  }

  /**
   * **G3**: a plain, deterministic snapshot of the registry's state. Sorted
   * explicitly (see `RegistrySnapshot`) — insertion order into the
   * underlying `Map`s depends on registration order, which callers must not
   * be able to observe, or graph snapshot tests would flake depending on
   * unrelated composition-root ordering.
   */
  inspect(): RegistrySnapshot {
    const providerRows: ProviderSnapshotEntry[] = [];
    for (const provided of this.providers.values()) {
      providerRows.push({
        tokenLabel: provided.record.token.label,
        kind: 'provide',
        scope: provided.record.scope,
        owner: provided.owner,
        override: provided.record.override,
      });
    }
    for (const contributors of this.contributions.values()) {
      for (const contributed of contributors) {
        providerRows.push({
          tokenLabel: contributed.record.token.label,
          kind: 'contribute',
          scope: contributed.record.scope,
          owner: contributed.owner,
          override: contributed.record.override,
        });
      }
    }
    providerRows.sort((a, b) => a.tokenLabel.localeCompare(b.tokenLabel) || a.owner.localeCompare(b.owner));

    const moduleRows: ModuleSnapshotEntry[] = [];
    for (const [moduleId, tokens] of this.moduleTokens) {
      const tokenLabels = [...tokens].map((token) => token.label).sort();
      moduleRows.push({ moduleId, tokenLabels });
    }
    moduleRows.sort((a, b) => a.moduleId.localeCompare(b.moduleId));

    return Object.freeze({
      providers: Object.freeze(providerRows),
      modules: Object.freeze(moduleRows),
    });
  }
}

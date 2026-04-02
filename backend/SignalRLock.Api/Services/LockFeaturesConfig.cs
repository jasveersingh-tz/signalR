namespace SignalRLock.Api.Services;

/// <summary>
/// Root configuration for the locking system.
/// Bound from the "LockFeatures" section in appsettings.json.
///
/// Structure:
///   LockFeatures:Default         → timings used by any feature with no explicit entry
///   LockFeatures:Features:{key}  → timings for a specific featureKey (e.g. "purchase-orders")
/// </summary>
public class LockFeaturesConfig
{
    /// <summary>Fallback timings used when no feature-specific entry exists.</summary>
    public LockStoreOptions Default { get; set; } = new();

    /// <summary>Per-feature timing overrides, keyed by featureKey (case-insensitive).</summary>
    public Dictionary<string, LockStoreOptions> Features { get; set; } =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Returns the options for the given feature key.
    /// Falls back to <see cref="Default"/> when the key is absent or null.
    /// </summary>
    public LockStoreOptions GetOptionsFor(string? featureKey) =>
        featureKey != null && Features.TryGetValue(featureKey, out var opts) ? opts : Default;
}
